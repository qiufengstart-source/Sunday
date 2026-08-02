import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export const WAN_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
export const IMAGE_MODEL = "qwen-image-2.0-pro";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const SINGLE_GENERATE_TIMEOUT_MS = 120_000;
/** 图生图/编辑往往比纯文生图慢，单独放宽避免上游仍在算却被本地 abort */
const IMAGE_EDIT_GENERATE_TIMEOUT_MS = 240_000;
/** 组图/多张更慢：按张数放宽，避免上游已出图却被前端 abort */
const MULTI_GENERATE_TIMEOUT_MS = 240_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const GENERATED_FILENAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

export class WanApiError extends Error {
  constructor(message, { status = 502, requestId = null } = {}) {
    super(message);
    this.name = "WanApiError";
    this.status = status;
    this.requestId = requestId;
  }
}

export function assertGenerateRequest({ prompt, images = [], count, size, sequential }) {
  const normalizedPrompt = String(prompt || "").trim();
  if (!normalizedPrompt || normalizedPrompt.length > 5000) {
    throw new WanApiError("请输入 1 到 5000 字的生成描述。", { status: 400 });
  }
  if (!Array.isArray(images) || images.length > 2 || images.some((item) => typeof item !== "string")) {
    throw new WanApiError("图片输入格式不正确。", { status: 400 });
  }
  const normalizedCount = count === undefined ? 1 : count;
  if (!Number.isInteger(normalizedCount) || normalizedCount < 1 || normalizedCount > 4) {
    throw new WanApiError("生成数量仅支持 1 到 4 张。", { status: 400 });
  }
  if (typeof size !== "string" || !size.trim()) {
    throw new WanApiError("输出尺寸不正确。", { status: 400 });
  }
  const useSequential = sequential === undefined ? normalizedCount > 1 : !!sequential;
  return {
    prompt: normalizedPrompt,
    images,
    count: normalizedCount,
    size: size.trim(),
    sequential: useSequential,
  };
}

/** qwen-image 需要 width*height；兼容前端仍可能传入的 1K/2K 档位 */
export function normalizeQwenSize(size) {
  const raw = String(size || "").trim();
  if (raw === "1K") return "1024*1024";
  if (raw === "2K") return "2048*2048";
  return raw;
}

export function buildWanPayload(input) {
  const request = assertGenerateRequest(input);
  const content = request.images.map((image) => ({ image }));
  content.push({ text: request.prompt });
  // qwen-image-2.0-pro：n / size / watermark / prompt_extend（不再使用万相 thinking_mode / enable_sequential）
  const parameters = {
    n: request.count,
    size: normalizeQwenSize(request.size),
    watermark: false,
    prompt_extend: true,
  };
  return {
    model: IMAGE_MODEL,
    input: { messages: [{ role: "user", content }] },
    parameters,
  };
}

function normalizeResultImageUrl(imageUrl) {
  if (typeof imageUrl !== "string") return null;

  try {
    const parsed = new URL(imageUrl);
    const hostname = parsed.hostname.toLowerCase();
    const allowedHost = hostname === "aliyuncs.com" || hostname.endsWith(".aliyuncs.com");
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.hash
      || !allowedHost
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function extractImageUrls(response, expectedCount, { sequential = false } = {}) {
  const urls = (response?.output?.choices || [])
    .flatMap((choice) => choice?.message?.content || [])
    .map((item) => item?.image)
    .filter((url) => url !== undefined);
  const normalizedUrls = urls.map(normalizeResultImageUrl);
  const validExpectedCount = Number.isInteger(expectedCount) && expectedCount >= 1 && expectedCount <= 4;
  const countOk = sequential
    ? normalizedUrls.length >= 1 && normalizedUrls.length <= expectedCount
    : normalizedUrls.length === expectedCount;
  if (
    !validExpectedCount
    || !countOk
    || normalizedUrls.some((url) => !url)
    || new Set(normalizedUrls).size !== normalizedUrls.length
  ) {
    throw new WanApiError("生图返回的图片结果不正确。", {
      status: 502,
      requestId: response?.request_id || null,
    });
  }
  return normalizedUrls;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const GENERIC_UPSTREAM_ERROR = "万相模型服务异常。";

function normalizeUpstreamMessage(message) {
  if (typeof message !== "string") return GENERIC_UPSTREAM_ERROR;

  const normalized = message
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\bdata:[^\s"'<>]+/gi, "")
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, "")
    .replace(/\b(?:x[-_ ]?api[-_ ]?key|api[-_ ]?key|apikey|access[-_]?token|client[-_]?secret|secret)\b\s*(?:[:=]\s*|\s+)["']?[a-z0-9._~+/%=-]{8,}["']?/gi, "")
    .replace(/\b(?:sk|ak|rk|pk|api)[-_][a-z0-9_-]{8,}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const stillUnsafe = /\bdata\s*:/i.test(normalized)
    || /\bbearer\s+\S+/i.test(normalized)
    || /\b(?:x[-_ ]?api[-_ ]?key|api[-_ ]?key|apikey|access[-_]?token|client[-_]?secret|secret)\b\s*(?:[:=]\s*|\s+)\S+/i.test(normalized)
    || /\b(?:sk|ak|rk|pk|api)[-_][a-z0-9_-]{8,}\b/i.test(normalized);
  if (!normalized || normalized.length > 500 || stillUnsafe) {
    return GENERIC_UPSTREAM_ERROR;
  }
  return normalized;
}

export async function requestWanImages({
  apiKey,
  prompt,
  images,
  count,
  size,
  sequential,
  signal = null,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") {
    throw new WanApiError("生图服务不可用。");
  }

  const payload = buildWanPayload({ prompt, images, count, size, sequential });
  const multiShot = payload.parameters.n > 1;
  const hasInputImages = Array.isArray(images) && images.length > 0;
  const timeoutMs = multiShot
    ? MULTI_GENERATE_TIMEOUT_MS
    : hasInputImages
      ? IMAGE_EDIT_GENERATE_TIMEOUT_MS
      : SINGLE_GENERATE_TIMEOUT_MS;
  const controller = new AbortController();
  let cancelledByClient = false;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => {
    cancelledByClient = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const startedAt = Date.now();
  console.log(
    `[qwen-image] request start model=${IMAGE_MODEL} images=${hasInputImages ? images.length : 0} n=${payload.parameters.n} size=${payload.parameters.size} timeoutMs=${timeoutMs} promptChars=${String(prompt || "").length}`,
  );

  try {
    const response = await fetchImpl(WAN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await readJson(response);
    const requestId = response.headers?.get("x-request-id") || data?.request_id || null;

    if (!response.ok) {
      console.log(`[qwen-image] upstream error status=${response.status} ms=${Date.now() - startedAt} requestId=${requestId || "-"}`);
      throw new WanApiError(normalizeUpstreamMessage(data?.message), {
        status: response.status,
        requestId,
      });
    }

    // qwen-image 按 parameters.n 精确返回张数，不做万相组图的宽松计数
    const urls = extractImageUrls(data, payload.parameters.n, {
      sequential: false,
    });
    console.log(`[qwen-image] request ok ms=${Date.now() - startedAt} images=${urls.length} requestId=${requestId || "-"}`);
    return urls;
  } catch (error) {
    if (error instanceof WanApiError) throw error;
    if (error?.name === "AbortError" || controller.signal.aborted) {
      const clientCancelled = cancelledByClient || !!signal?.aborted;
      if (clientCancelled) {
        console.log(`[qwen-image] client cancelled ms=${Date.now() - startedAt}`);
        throw new WanApiError("请求已取消。", { status: 499 });
      }
      console.log(`[qwen-image] local abort timeout ms=${Date.now() - startedAt} timeoutMs=${timeoutMs}`);
      throw new WanApiError(
        multiShot
          ? "多图生成超时，请稍后重试，或先改为 2 张再试。"
          : hasInputImages
            ? "图生图超时（上游计算较慢），请稍后重试；也可先缩短描述或去掉引用图再试。"
            : "生成超时，请稍后重试，或简化描述后再试。",
        { status: 504 },
      );
    }
    const detail = String(error?.message || error?.name || "网络异常").slice(0, 120);
    console.log(`[qwen-image] request failed ms=${Date.now() - startedAt} name=${error?.name || "Error"} detail=${detail}`);
    throw new WanApiError(`生图请求失败（${detail}），请稍后重试。`);
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
}

function getDeclaredImageLength(response) {
  const value = response.headers?.get("content-length");
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized) || BigInt(normalized) > BigInt(MAX_IMAGE_BYTES)) {
    throw new WanApiError("下载图片超过 20 MB 限制。", { status: 502 });
  }
  return Number(normalized);
}

async function writeAll(fileHandle, bytes) {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await fileHandle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (!bytesWritten) throw new Error("Unable to write image data");
    offset += bytesWritten;
  }
}

export async function downloadImage({
  imageUrl,
  outputDir,
  fetchImpl = globalThis.fetch,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
}) {
  let controller;
  let timeout;
  let fileHandle;
  let reader;
  let temporaryPath;

  try {
    const normalizedImageUrl = normalizeResultImageUrl(imageUrl);
    if (typeof fetchImpl !== "function" || !normalizedImageUrl) {
      throw new WanApiError("图片下载地址不正确。", { status: 502 });
    }

    controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchImpl(normalizedImageUrl, {
      redirect: "error",
      signal: controller.signal,
    });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new WanApiError("图片下载地址不正确。", { status: 502 });
    }
    if (!response.ok) {
      throw new WanApiError("图片下载失败。", { status: response.status });
    }
    const contentType = response.headers?.get("content-type") || "";
    if (contentType.split(";", 1)[0].trim().toLowerCase() !== "image/png") {
      throw new WanApiError("下载内容不是 PNG 图片。", { status: 502 });
    }
    const declaredLength = getDeclaredImageLength(response);

    const filename = `${randomUUID()}.png`;
    const temporaryFilename = `.${randomUUID()}.tmp`;
    temporaryPath = join(outputDir, temporaryFilename);
    await mkdir(outputDir, { recursive: true });
    fileHandle = await open(temporaryPath, "wx", 0o600);

    let receivedBytes = 0;
    if (response.body && typeof response.body.getReader === "function") {
      reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error("Invalid image stream chunk");
        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_IMAGE_BYTES) {
          throw new WanApiError("下载图片超过 20 MB 限制。", { status: 502 });
        }
        await writeAll(fileHandle, value);
      }
    } else {
      if (declaredLength === null || typeof response.arrayBuffer !== "function") {
        throw new WanApiError("图片下载响应无法安全读取。", { status: 502 });
      }
      const arrayBuffer = await response.arrayBuffer();
      if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
        throw new WanApiError("下载图片超过 20 MB 限制。", { status: 502 });
      }
      receivedBytes = arrayBuffer.byteLength;
      await writeAll(fileHandle, new Uint8Array(arrayBuffer));
    }

    await fileHandle.close();
    fileHandle = undefined;
    await rename(temporaryPath, join(outputDir, filename));
    temporaryPath = undefined;
    return filename;
  } catch (error) {
    controller?.abort();
    if (reader && typeof reader.cancel === "function") {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original download error and continue temporary-file cleanup.
      }
    }
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
    if (temporaryPath) {
      await unlink(temporaryPath).catch(() => {});
    }
    if (error instanceof WanApiError) throw error;
    throw new WanApiError("图片下载失败。");
  } finally {
    if (timeout) clearTimeout(timeout);
    if (reader && typeof reader.releaseLock === "function") {
      try {
        reader.releaseLock();
      } catch {
        // The stream may already be cancelled after a download error.
      }
    }
  }
}

export async function removeDownloadedImage({ outputDir, filename }) {
  if (typeof outputDir !== "string" || !outputDir || !GENERATED_FILENAME_PATTERN.test(filename)) {
    throw new WanApiError("生成图片文件名不正确。", { status: 400 });
  }
  try {
    await unlink(join(outputDir, filename));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new WanApiError("生成图片清理失败。");
  }
}
