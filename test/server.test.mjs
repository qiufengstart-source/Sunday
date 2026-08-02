import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, generateAndPersist, resolveInputImages } from "../server.mjs";
import { WanApiError } from "../wan-client.mjs";

async function start(t, generateImages, {
  apiKey = "test-key",
  maxConcurrentGenerations,
} = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "wan-server-"));
  const generatedDir = join(rootDir, "generated");
  const uploadsDir = join(rootDir, "uploads");
  await mkdir(generatedDir);
  await mkdir(uploadsDir);
  const server = createServer({
    rootDir,
    generatedDir,
    uploadsDir,
    apiKey,
    generateImages,
    maxConcurrentGenerations,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    baseUrl: "http://127.0.0.1:" + server.address().port,
    generatedDir,
    rootDir,
    uploadsDir,
  };
}

function apiHeaders(baseUrl, extra = {}) {
  return {
    "content-type": "application/json",
    origin: baseUrl,
    ...extra,
  };
}

function rawRequest(baseUrl, path, method = "GET", { body, headers } = {}) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, port, path, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks),
        headers: response.headers,
        status: response.statusCode,
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("API defaults count to one and returns local URLs", async (t) => {
  let received;
  const { baseUrl } = await start(t, async (request) => {
    received = request;
    return { images: ["/generated/result.png"] };
  });
  const response = await fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({
      prompt: "白底产品图",
      images: [],
      size: "1024*1024",
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    images: ["/generated/result.png"],
    inputImages: [],
  });
  assert.equal(received.count, 1);
});

test("API rejects invalid body without model invocation", async (t) => {
  let calls = 0;
  const { baseUrl } = await start(t, async () => {
    calls += 1;
    return { images: [] };
  });
  const response = await fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({ prompt: "", images: [], count: 5, size: "1K" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /提示词|数量/);
  assert.equal(calls, 0);
});

test("API rejects unsafe content type and request origins before generator invocation", async (t) => {
  let calls = 0;
  const { baseUrl } = await start(t, async () => {
    calls += 1;
    return { images: [] };
  });
  const requestBody = "not valid JSON";
  const cases = [
    {
      name: "text/plain",
      headers: { "content-type": "text/plain", origin: baseUrl },
      status: 415,
    },
    {
      name: "absent Origin",
      headers: { "content-type": "application/json" },
      status: 403,
    },
    {
      name: "foreign Origin",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      status: 403,
    },
    {
      name: "cross-site fetch metadata",
      headers: apiHeaders(baseUrl, { "sec-fetch-site": "cross-site" }),
      status: 403,
    },
  ];

  for (const entry of cases) {
    const response = await rawRequest(baseUrl, "/api/generate", "POST", {
      body: requestBody,
      headers: entry.headers,
    });
    assert.equal(response.status, entry.status, entry.name);
    assert.equal(response.headers["cache-control"], "no-store", entry.name);
    assert.equal(response.headers["x-content-type-options"], "nosniff", entry.name);
    assert.equal(typeof JSON.parse(response.body).error, "string", entry.name);
  }
  assert.equal(calls, 0);
});

test("API limits concurrent generations and releases the slot after completion", async (t) => {
  let calls = 0;
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const firstPending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const { baseUrl } = await start(t, async () => {
    calls += 1;
    if (calls === 1) {
      markStarted();
      await firstPending;
    }
    return { images: ["/generated/result.png"] };
  }, { maxConcurrentGenerations: 1 });
  const options = {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({ prompt: "白底产品图", images: [], size: "1024*1024" }),
  };

  const firstResponsePromise = fetch(baseUrl + "/api/generate", options);
  await started;
  const busyResponse = await fetch(baseUrl + "/api/generate", options);
  releaseFirst();
  const firstResponse = await firstResponsePromise;
  assert.equal(busyResponse.status, 429);
  assert.equal(calls, 1);
  assert.equal(typeof (await busyResponse.json()).error, "string");

  assert.equal(firstResponse.status, 200);
  assert.equal((await fetch(baseUrl + "/api/generate", options)).status, 200);
  assert.equal(calls, 2);
});

test("API releases the generation slot when the client aborts", async (t) => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let calls = 0;
  const { baseUrl } = await start(t, async ({ signal } = {}) => {
    calls += 1;
    if (calls === 1) {
      markStarted();
      await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      });
    }
    return { images: ["/generated/after-abort.png"] };
  }, { maxConcurrentGenerations: 1 });

  const controller = new AbortController();
  const pending = fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({ prompt: "白底产品图", images: [], size: "1024*1024" }),
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await pending.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 40));

  const retry = await fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({ prompt: "重试产品图", images: [], size: "1024*1024" }),
  });
  assert.equal(retry.status, 200);
  assert.equal(calls, 2);
});

test("API releases the generation slot when the generator throws", async (t) => {
  let calls = 0;
  const { baseUrl } = await start(t, async () => {
    calls += 1;
    if (calls === 1) throw new Error("private failure");
    return { images: ["/generated/recovered.png"] };
  });
  const options = {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({ prompt: "白底产品图", images: [], size: "1024*1024" }),
  };

  assert.equal((await fetch(baseUrl + "/api/generate", options)).status, 500);
  assert.equal((await fetch(baseUrl + "/api/generate", options)).status, 200);
  assert.equal(calls, 2);
});

test("generated routes cannot traverse out of their directory", async (t) => {
  const { baseUrl } = await start(t, async () => ({ images: [] }));
  const response = await fetch(baseUrl + "/generated/%2e%2e/server.mjs");
  assert.equal(response.status, 404);
});

test("API rejects unsupported methods with no-store and nosniff headers", async (t) => {
  const { baseUrl } = await start(t, async () => ({ images: [] }));
  const response = await fetch(baseUrl + "/api/generate");
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { error: "请求方法不支持。" });
});

test("API converts unexpected generator failures to a generic 500", async (t) => {
  const { baseUrl } = await start(t, async () => {
    throw new Error("private implementation detail");
  });
  const response = await fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({ prompt: "白底产品图", images: [], size: "1024*1024" }),
  });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { error: "服务暂时不可用，请稍后重试。" });
});

test("API preserves a safe 400 WanApiError response", async (t) => {
  const { baseUrl } = await start(t, async () => {
    throw new WanApiError("输入内容不正确。", { status: 400, requestId: "req_123-abc" });
  });
  const response = await fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({ prompt: "白底产品图", images: [], size: "1024*1024" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "输入内容不正确。",
    requestId: "req_123-abc",
  });
});

test("generated references are lowercase exact matches and reject final newlines", async () => {
  const generatedDir = await mkdtemp(join(tmpdir(), "wan-generated-"));
  const uploadsDir = await mkdtemp(join(tmpdir(), "wan-uploads-"));
  const filename = "123e4567-e89b-12d3-a456-426614174000.png";
  await writeFile(join(generatedDir, filename), "png-bytes");

  assert.deepEqual(
    await resolveInputImages([`/generated/${filename}`], { generatedDir, uploadsDir }),
    {
      modelImages: [`data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`],
      localImages: [`/generated/${filename}`],
    },
  );
  await assert.rejects(
    resolveInputImages([`/generated/${filename.toUpperCase()}`], { generatedDir, uploadsDir }),
    /图片输入格式不正确/,
  );
  await assert.rejects(
    resolveInputImages([`/GENERATED/${filename}`], { generatedDir, uploadsDir }),
    /图片输入格式不正确/,
  );
  await assert.rejects(
    resolveInputImages([`/generated/${filename}\n`], { generatedDir, uploadsDir }),
    /图片输入格式不正确/,
  );
});

test("generated references reject symlinks", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "wan-symlink-"));
  const generatedDir = join(rootDir, "generated");
  const uploadsDir = join(rootDir, "uploads");
  const outsideFile = join(rootDir, "outside.png");
  const filename = "123e4567-e89b-12d3-a456-426614174000.png";
  await mkdir(generatedDir);
  await mkdir(uploadsDir);
  await writeFile(outsideFile, "outside");
  await symlink(outsideFile, join(generatedDir, filename));

  await assert.rejects(
    resolveInputImages([`/generated/${filename}`], { generatedDir, uploadsDir }),
    /图片输入格式不正确/,
  );
});

test("Data URLs require supported MIME, valid Base64, and an exact full-string match", async () => {
  const generatedDir = await mkdtemp(join(tmpdir(), "wan-data-url-"));
  const uploadsDir = await mkdtemp(join(tmpdir(), "wan-data-upload-"));
  const valid = "data:image/png;base64,YQ==";
  const resolved = await resolveInputImages([valid], { generatedDir, uploadsDir });
  assert.deepEqual(resolved.modelImages, [valid]);
  assert.match(resolved.localImages[0], /^\/uploads\/[0-9a-f-]{36}\.png$/);
  assert.equal(await readFile(join(uploadsDir, resolved.localImages[0].slice(9)), "utf8"), "a");

  for (const invalid of [
    `${valid}\n`,
    `${valid}!`,
    "data:image/svg+xml;base64,YQ==",
    "data:image/png;base64,Y===",
  ]) {
    await assert.rejects(
      resolveInputImages([invalid], { generatedDir, uploadsDir }),
      /图片输入格式不正确/,
    );
  }
});

test("API persists Data URL inputs and reuses upload routes without exposing Base64", async (t) => {
  const receivedImages = [];
  const source = "data:image/jpeg;base64,aGVsbG8=";
  const { baseUrl } = await start(t, async ({ images }) => {
    receivedImages.push(images);
    return { images: ["/generated/result.png"] };
  });
  const makeRequest = (images) => fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({ prompt: "白底产品图", images, size: "1024*1024" }),
  });

  const first = await makeRequest([source]);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(firstBody.images, ["/generated/result.png"]);
  assert.match(firstBody.inputImages[0], /^\/uploads\/[0-9a-f-]{36}\.jpg$/);
  assert.deepEqual(receivedImages[0], [source]);

  const uploaded = await fetch(baseUrl + firstBody.inputImages[0]);
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.headers.get("content-type"), "image/jpeg");
  assert.equal(uploaded.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await uploaded.text(), "hello");

  const second = await makeRequest(firstBody.inputImages);
  assert.equal(second.status, 200);
  assert.deepEqual((await second.json()).inputImages, firstBody.inputImages);
  assert.deepEqual(receivedImages[1], [source]);
});

test("createServer defaults uploadsDir to the root uploads directory", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "wan-default-upload-"));
  const generatedDir = join(rootDir, "generated");
  await mkdir(generatedDir);
  const server = createServer({
    rootDir,
    generatedDir,
    apiKey: "test-key",
    generateImages: async () => ({ images: ["/generated/result.png"] }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({
      prompt: "白底产品图",
      images: ["data:image/png;base64,YQ=="],
      size: "1024*1024",
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(
    await readFile(join(rootDir, body.inputImages[0].slice(1)), "utf8"),
    "a",
  );
});

test("upload routes are exact, lowercase, no-sniff, and reject aliases", async (t) => {
  const { baseUrl, uploadsDir } = await start(t, async () => ({ images: [] }));
  const filename = "123e4567-e89b-12d3-a456-426614174000.webp";
  await writeFile(join(uploadsDir, filename), "webp");

  const exact = await rawRequest(baseUrl, `/uploads/${filename}`);
  assert.equal(exact.status, 200);
  assert.equal(exact.headers["content-type"], "image/webp");
  assert.equal(exact.headers["x-content-type-options"], "nosniff");
  for (const path of [
    `/UPLOADS/${filename}`,
    `/uploads/${filename.toUpperCase()}`,
    `/uploads/${filename}%0A`,
    `/x/../uploads/${filename}`,
    `/uploads/${filename}/`,
  ]) {
    assert.equal((await rawRequest(baseUrl, path)).status, 404, path);
  }
});

test("generateAndPersist downloads sequentially and rolls back completed batch files", async () => {
  const generatedDir = await mkdtemp(join(tmpdir(), "wan-rollback-"));
  const firstUrl = "https://images.aliyuncs.com/first.png";
  const secondUrl = "https://images.aliyuncs.com/second.png";
  let secondStartedBeforeFirstCompleted = false;
  let allowFirst;
  const firstMayComplete = new Promise((resolve) => {
    allowFirst = resolve;
  });
  const fetchImpl = async (url) => {
    if (!String(url).startsWith("https://images.aliyuncs.com/")) {
      return new Response(JSON.stringify({
        output: {
          choices: [{ message: { content: [
            { image: firstUrl },
            { image: secondUrl },
          ] } }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === firstUrl) {
      return {
        ok: true,
        status: 200,
        redirected: false,
        headers: {
          get(name) {
            if (name === "content-type") return "image/png";
            if (name === "content-length") return "11";
            return null;
          },
        },
        async arrayBuffer() {
          await Promise.race([
            firstMayComplete,
            new Promise((resolve) => setTimeout(resolve, 100)),
          ]);
          const bytes = Buffer.from("first-image");
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    }
    secondStartedBeforeFirstCompleted = !(await readdir(generatedDir))
      .some((filename) => filename.endsWith(".png"));
    allowFirst();
    return new Response("download failed", {
      status: 502,
      headers: { "content-type": "image/png" },
    });
  };

  await assert.rejects(generateAndPersist({
    prompt: "白底产品图",
    images: [],
    count: 2,
    size: "1024*1024",
    apiKey: "test-key",
    generatedDir,
    fetchImpl,
  }), WanApiError);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondStartedBeforeFirstCompleted, false);
  assert.deepEqual(await readdir(generatedDir), []);
});

test("raw traversal aliases to known static and generated files return 404", async (t) => {
  const { baseUrl, generatedDir, rootDir } = await start(t, async () => ({ images: [] }));
  const filename = "123e4567-e89b-12d3-a456-426614174000.png";
  await writeFile(join(rootDir, "index.html"), "index");
  await writeFile(join(generatedDir, filename), "png");

  for (const path of [
    "/x/../index.html",
    "/x/%2e%2e/index.html",
    `/x/../generated/${filename}`,
  ]) {
    const response = await rawRequest(baseUrl, path);
    assert.equal(response.status, 404, path);
  }
});

test("generated routes are exact and case-sensitive", async (t) => {
  const { baseUrl, generatedDir } = await start(t, async () => ({ images: [] }));
  const filename = "123e4567-e89b-12d3-a456-426614174000.png";
  await writeFile(join(generatedDir, filename), "png");

  assert.equal((await rawRequest(baseUrl, `/generated/${filename}`)).status, 200);
  assert.equal((await rawRequest(baseUrl, `/GENERATED/${filename}`)).status, 404);
  assert.equal((await rawRequest(baseUrl, `/generated/${filename.toUpperCase()}`)).status, 404);
  assert.equal((await rawRequest(baseUrl, `/generated/${filename}%0A`)).status, 404);
});

test("API redacts the configured key and omits an unsafe request ID", async (t) => {
  const apiKey = "odd.key-Value_123";
  const { baseUrl } = await start(t, async ({ prompt }) => {
    if (prompt === "only key") {
      throw new WanApiError(apiKey, { status: 502 });
    }
    throw new WanApiError(`upstream echoed ${apiKey}`, {
      status: 502,
      requestId: `req:${apiKey}`,
    });
  }, { apiKey });
  const response = await fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({ prompt: "白底产品图", images: [], size: "1024*1024" }),
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(JSON.stringify(body).includes(apiKey), false);
  assert.equal(Object.hasOwn(body, "requestId"), false);
  assert.equal(typeof body.error, "string");
  assert.notEqual(body.error.length, 0);

  const emptyAfterRedaction = await fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: apiHeaders(baseUrl),
    body: JSON.stringify({ prompt: "only key", images: [], size: "1024*1024" }),
  });
  assert.deepEqual(await emptyAfterRedaction.json(), {
    error: "服务暂时不可用，请稍后重试。",
  });
});

test("API omits non-string, non-ASCII, unsafe-character, and oversized request IDs", async (t) => {
  const requestIds = [42, "请求-123", "bad id", "x".repeat(129)];
  let call = 0;
  const { baseUrl } = await start(t, async () => {
    throw new WanApiError("上游错误。", { status: 502, requestId: requestIds[call++] });
  });

  for (const requestId of requestIds) {
    const response = await fetch(baseUrl + "/api/generate", {
      method: "POST",
      headers: apiHeaders(baseUrl),
      body: JSON.stringify({ prompt: "白底产品图", images: [], size: "1024*1024" }),
    });
    assert.equal(response.status, 502, String(requestId));
    assert.deepEqual(await response.json(), { error: "上游错误。" });
  }
});

test("generation helper module is allowlisted while unknown extensions return 404", async (t) => {
  const { baseUrl, rootDir } = await start(t, async () => ({ images: [] }));
  await writeFile(join(rootDir, "generation-helpers.mjs"), "export const loaded = true;\n");
  await writeFile(join(rootDir, "private.xyz"), "private");

  const moduleResponse = await fetch(baseUrl + "/generation-helpers.mjs");
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get("content-type"), /javascript/);
  assert.equal(await moduleResponse.text(), "export const loaded = true;\n");
  assert.equal((await fetch(baseUrl + "/private.xyz")).status, 404);
});

test("the production entrypoint binds explicitly to IPv4 loopback", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(source, /server\.listen\(port,\s*"127\.0\.0\.1"/);
});
