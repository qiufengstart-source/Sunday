import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertGenerateRequest,
  downloadImage,
  removeDownloadedImage,
  requestWanImages,
  WanApiError,
} from "./wan-client.mjs";
import { optimizePromptWithQwen } from "./qwen-client.mjs";

const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
const DATA_IMAGE_PATTERN = /^data:image\/(jpeg|jpg|png|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i;
const UUID_PNG_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;
const GENERATED_PATH_PATTERN = /^\/generated\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png)$/;
const UPLOAD_PATH_PATTERN = /^\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp))$/;
const UPLOAD_MIME_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["webp", "image/webp"],
]);
const GENERIC_PUBLIC_ERROR = "服务暂时不可用，请稍后重试。";
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/generation-helpers.mjs", ["generation-helpers.mjs", "text/javascript; charset=utf-8"]],
  ["/zip-store.mjs", ["zip-store.mjs", "text/javascript; charset=utf-8"]],
  ["/qa-restore.html", ["qa-restore.html", "text/html; charset=utf-8"]],
  ["/qa-acceptance-state.json", ["qa-acceptance-state.json", "application/json; charset=utf-8"]],
]);

function inputError(message, status = 400) {
  return new WanApiError(message, { status });
}

async function readRegularFileNoFollow(pathname, maxBytes = Infinity) {
  let handle;
  try {
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) {
      throw inputError("图片输入格式不正确。");
    }
    return await handle.readFile();
  } finally {
    await handle?.close();
  }
}

export async function readJsonBody(request, maxBytes = 56 * 1024 * 1024) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw inputError("请求内容过大。", 413);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw inputError("请求内容过大。", 413);
    }
    chunks.push(buffer);
  }

  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TypeError("JSON object required");
    }
    return body;
  } catch {
    throw inputError("请求内容不是有效的 JSON。");
  }
}

async function persistUpload(bytes, extension, uploadsDir) {
  const filename = `${randomUUID()}.${extension}`;
  const temporaryPath = join(uploadsDir, `.${filename}.${randomUUID()}.tmp`);
  await mkdir(uploadsDir, { recursive: true });
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, join(uploadsDir, filename));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return filename;
}

/**
 * Resolve transient model inputs separately from browser-safe local references.
 * Data URLs stay unchanged for the immediate model request but are persisted as
 * upload routes; existing generated/upload routes are read back into Data URLs.
 */
export async function resolveInputImages(images, { generatedDir, uploadsDir }) {
  const modelImages = [];
  const localImages = [];

  for (const image of images) {
    const dataMatch = exactMatch(DATA_IMAGE_PATTERN, image);
    if (dataMatch) {
      const base64 = dataMatch[2];
      const bytes = Buffer.from(base64, "base64");
      if (!base64 || bytes.length > MAX_INPUT_IMAGE_BYTES) {
        throw inputError("图片输入格式不正确。");
      }
      const sourceType = dataMatch[1].toLowerCase();
      const extension = sourceType === "jpeg" ? "jpg" : sourceType;
      let filename;
      try {
        filename = await persistUpload(bytes, extension, uploadsDir);
      } catch {
        throw inputError("图片输入格式不正确。");
      }
      modelImages.push(image);
      localImages.push(`/uploads/${filename}`);
      continue;
    }

    const generatedMatch = exactMatch(GENERATED_PATH_PATTERN, image);
    const uploadMatch = exactMatch(UPLOAD_PATH_PATTERN, image);
    if (!generatedMatch && !uploadMatch) {
      throw inputError("图片输入格式不正确。");
    }

    try {
      const filename = generatedMatch?.[1] || uploadMatch[1];
      const directory = generatedMatch ? generatedDir : uploadsDir;
      const mimeType = generatedMatch ? "image/png" : UPLOAD_MIME_TYPES.get(uploadMatch[2]);
      const bytes = await readRegularFileNoFollow(
        join(directory, filename),
        MAX_INPUT_IMAGE_BYTES,
      );
      modelImages.push(`data:${mimeType};base64,${bytes.toString("base64")}`);
      localImages.push(image);
    } catch (error) {
      if (error instanceof WanApiError) throw error;
      throw inputError("图片输入格式不正确。");
    }
  }

  return { modelImages, localImages };
}

export async function generateAndPersist({
  prompt,
  images,
  count,
  size,
  sequential,
  apiKey,
  generatedDir,
  fetchImpl,
  signal = null,
}) {
  const imageUrls = await requestWanImages({
    apiKey,
    prompt,
    images,
    count,
    size,
    sequential,
    signal,
    fetchImpl,
  });
  const filenames = [];
  try {
    for (const imageUrl of imageUrls) {
      const filename = await downloadImage({
        imageUrl,
        outputDir: generatedDir,
        fetchImpl,
      });
      if (!exactMatch(UUID_PNG_PATTERN, filename)) {
        throw new Error("Unsafe generated filename");
      }
      filenames.push(filename);
    }
  } catch (error) {
    await Promise.all(filenames.map((filename) => removeDownloadedImage({
      outputDir: generatedDir,
      filename,
    })));
    throw error;
  }
  return { images: filenames.map((filename) => `/generated/${filename}`) };
}

function exactMatch(pattern, value) {
  if (typeof value !== "string") return null;
  const match = pattern.exec(value);
  return match && match[0].length === value.length ? match : null;
}

function normalizeRequestPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) {
    return null;
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return posix.normalize(decoded);
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}

function sendNotFound(response) {
  response.writeHead(404, {
    "Content-Length": 0,
    "X-Content-Type-Options": "nosniff",
  });
  response.end();
}

async function sendFile(response, pathname, contentType, method) {
  try {
    const body = await readRegularFileNoFollow(pathname);
    response.writeHead(200, {
      "Content-Length": body.length,
      "Content-Type": contentType,
      // 原型迭代频繁：禁止缓存 HTML/JS/CSS，避免页面看起来「改了不生效」
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(method === "HEAD" ? undefined : body);
  } catch {
    sendNotFound(response);
  }
}

function safeWanStatus(status) {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function publicWanMessage(error, apiKey) {
  if (error.status === 400 && error.message === "请输入 1 到 5000 字的生成描述。") {
    return "请输入 1 到 5000 字的提示词。";
  }

  let message = typeof error.message === "string" ? error.message : "";
  if (typeof apiKey === "string" && apiKey) {
    message = message.split(apiKey).join("");
  }
  message = message
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return message && message.length <= 500 ? message : GENERIC_PUBLIC_ERROR;
}

function publicWanRequestId(requestId, apiKey) {
  if (typeof requestId !== "string"
    || requestId.length < 1
    || requestId.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
    return null;
  }
  if (typeof apiKey === "string" && apiKey && requestId.includes(apiKey)) {
    return null;
  }
  return requestId;
}

function hasJsonContentType(request) {
  const contentType = request.headers["content-type"];
  return typeof contentType === "string"
    && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function hasTrustedOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;

  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:"
      && parsed.origin === origin
      && parsed.host === host
      && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function hasSafeFetchSite(request) {
  const fetchSite = request.headers["sec-fetch-site"];
  return fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none";
}

export function createServer({
  rootDir,
  generatedDir,
  uploadsDir = join(rootDir, "uploads"),
  apiKey,
  generateImages,
  maxConcurrentGenerations = 1,
}) {
  if (!Number.isInteger(maxConcurrentGenerations) || maxConcurrentGenerations < 1) {
    throw new TypeError("maxConcurrentGenerations must be a positive integer");
  }
  const generator = typeof generateImages === "function" ? generateImages : generateAndPersist;
  let activeGenerations = 0;

  return createHttpServer(async (request, response) => {
    const requestTarget = request.url || "/";
    const queryIndex = requestTarget.indexOf("?");
    const rawPathname = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex);
    const pathname = normalizeRequestPath(rawPathname);

    if (pathname === "/api/optimize-prompt") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "请求方法不支持。" });
        return;
      }
      if (!hasJsonContentType(request)) {
        request.resume();
        sendJson(response, 415, { error: "请求内容类型不支持。" });
        return;
      }
      if (!hasTrustedOrigin(request) || !hasSafeFetchSite(request)) {
        request.resume();
        sendJson(response, 403, { error: "请求来源不受信任。" });
        return;
      }

      try {
        const body = await readJsonBody(request, 256 * 1024);
        const result = await optimizePromptWithQwen({
          apiKey,
          userText: body?.userText,
          guidePrompt: body?.guidePrompt,
          negative: body?.negative,
        });
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof WanApiError) {
          sendJson(response, safeWanStatus(error.status), {
            error: publicWanMessage(error, apiKey),
          });
        } else {
          sendJson(response, 500, { error: GENERIC_PUBLIC_ERROR });
        }
      }
      return;
    }

    if (pathname === "/api/generate") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "请求方法不支持。" });
        return;
      }
      if (!hasJsonContentType(request)) {
        request.resume();
        sendJson(response, 415, { error: "请求内容类型不支持。" });
        return;
      }
      if (!hasTrustedOrigin(request) || !hasSafeFetchSite(request)) {
        request.resume();
        sendJson(response, 403, { error: "请求来源不受信任。" });
        return;
      }
      if (activeGenerations >= maxConcurrentGenerations) {
        request.resume();
        sendJson(response, 429, { error: "生成任务正在处理中，请稍后重试。" });
        return;
      }

      activeGenerations += 1;
      const startedAt = Date.now();
      // 浏览器点「终止」会断开 fetch；必须同步取消上游并释放并发槽，否则会一直 429
      const clientAbort = new AbortController();
      const abortFromClient = () => {
        if (!clientAbort.signal.aborted) clientAbort.abort();
      };
      request.once("aborted", abortFromClient);
      response.once("close", () => {
        if (!response.writableEnded) abortFromClient();
      });
      try {
        const body = await readJsonBody(request);
        if (clientAbort.signal.aborted) {
          console.log(`[generate] client aborted before generate totalMs=${Date.now() - startedAt}`);
          return;
        }
        const validated = assertGenerateRequest(body);
        console.log(
          `[generate] accepted images=${validated.images.length} n=${validated.count} size=${validated.size} promptChars=${validated.prompt.length}`,
        );
        const resolveStarted = Date.now();
        const { modelImages, localImages } = await resolveInputImages(validated.images, {
          generatedDir,
          uploadsDir,
        });
        console.log(`[generate] inputs ready ms=${Date.now() - resolveStarted}`);
        const result = await generator({
          ...validated,
          images: modelImages,
          apiKey,
          generatedDir,
          signal: clientAbort.signal,
        });
        if (clientAbort.signal.aborted || response.writableEnded) {
          console.log(`[generate] client aborted after generate totalMs=${Date.now() - startedAt}`);
          return;
        }
        console.log(`[generate] done totalMs=${Date.now() - startedAt} out=${result.images.length}`);
        sendJson(response, 200, { images: result.images, inputImages: localImages });
      } catch (error) {
        const cancelled =
          clientAbort.signal.aborted ||
          error?.status === 499 ||
          error?.name === "AbortError" ||
          /请求已取消|aborted|AbortError/i.test(String(error?.message || ""));
        console.log(
          `[generate] failed totalMs=${Date.now() - startedAt} status=${error?.status || 500} message=${error?.message || "unknown"} cancelled=${cancelled}`,
        );
        if (cancelled || response.writableEnded) return;
        if (error instanceof WanApiError) {
          const body = { error: publicWanMessage(error, apiKey) };
          const requestId = publicWanRequestId(error.requestId, apiKey);
          if (requestId) body.requestId = requestId;
          sendJson(response, safeWanStatus(error.status), body);
        } else {
          sendJson(response, 500, { error: GENERIC_PUBLIC_ERROR });
        }
      } finally {
        request.off("aborted", abortFromClient);
        activeGenerations -= 1;
      }
      return;
    }

    if (pathname?.startsWith("/api/")) {
      sendJson(response, 404, { error: "接口不存在。" });
      return;
    }

    if (!pathname || (request.method !== "GET" && request.method !== "HEAD")) {
      sendNotFound(response);
      return;
    }

    const generatedMatch = exactMatch(GENERATED_PATH_PATTERN, pathname);
    if (generatedMatch) {
      await sendFile(
        response,
        join(generatedDir, generatedMatch[1]),
        "image/png",
        request.method,
      );
      return;
    }

    const uploadMatch = exactMatch(UPLOAD_PATH_PATTERN, pathname);
    if (uploadMatch) {
      await sendFile(
        response,
        join(uploadsDir, uploadMatch[1]),
        UPLOAD_MIME_TYPES.get(uploadMatch[2]),
        request.method,
      );
      return;
    }

    const staticFile = STATIC_FILES.get(pathname);
    if (!staticFile) {
      sendNotFound(response);
      return;
    }
    await sendFile(response, join(rootDir, staticFile[0]), staticFile[1], request.method);
  });
}

async function loadDotEnv(pathname) {
  let contents;
  try {
    contents = await readFile(pathname, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === resolve(process.argv[1])) {
  const rootDir = dirname(modulePath);
  await loadDotEnv(join(rootDir, ".env"));
  if (!process.env.DASHSCOPE_API_KEY) {
    console.error("DASHSCOPE_API_KEY is required.");
    process.exitCode = 1;
  } else {
    const generatedDir = join(rootDir, "generated");
    const uploadsDir = join(rootDir, "uploads");
    await mkdir(generatedDir, { recursive: true });
    await mkdir(uploadsDir, { recursive: true });
    const server = createServer({
      rootDir,
      generatedDir,
      uploadsDir,
      apiKey: process.env.DASHSCOPE_API_KEY,
    });
    const port = Number(process.env.PORT || 5000);
    server.listen(port, "127.0.0.1", () => {
      console.log(`Server listening on http://localhost:${port}`);
    });
  }
}
