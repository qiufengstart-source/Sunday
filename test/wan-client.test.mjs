import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as wanClient from "../wan-client.mjs";
import {
  assertGenerateRequest,
  buildWanPayload,
  downloadImage,
  extractImageUrls,
  requestWanImages,
  WAN_ENDPOINT,
  WanApiError,
} from "../wan-client.mjs";

function fakeResponse({
  ok = true,
  status = 200,
  headers = {},
  jsonValue = null,
  bytes = new Uint8Array(),
  body = null,
  arrayBufferImpl = null,
  redirected = false,
  url = "",
} = {}) {
  return {
    ok,
    status,
    redirected,
    url,
    body,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] || null;
      },
    },
    async json() {
      if (jsonValue instanceof Error) throw jsonValue;
      return jsonValue;
    },
    async arrayBuffer() {
      if (arrayBufferImpl) return arrayBufferImpl();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

test("text generation defaults count to one for qwen-image-2.0-pro", () => {
  const payload = buildWanPayload({
    prompt: "一只陶瓷杯",
    images: [],
    size: "1024*1024",
  });
  assert.equal(payload.model, "qwen-image-2.0-pro");
  assert.equal(payload.parameters.n, 1);
  assert.equal(payload.parameters.size, "1024*1024");
  assert.equal(payload.parameters.watermark, false);
  assert.equal(payload.parameters.prompt_extend, true);
  assert.equal("thinking_mode" in payload.parameters, false);
  assert.equal("enable_sequential" in payload.parameters, false);
  assert.deepEqual(payload.input.messages[0].content, [{ text: "一只陶瓷杯" }]);
});

test("references are before text and preserve explicit count", () => {
  const payload = buildWanPayload({
    prompt: "改成咖啡馆背景",
    images: ["data:image/png;base64,AA==", "data:image/webp;base64,BB=="],
    count: 3,
    size: "1K",
  });
  assert.equal(payload.parameters.n, 3);
  assert.equal(payload.parameters.size, "1024*1024");
  assert.equal("enable_sequential" in payload.parameters, false);
  assert.equal("thinking_mode" in payload.parameters, false);
  assert.deepEqual(payload.input.messages[0].content, [
    { image: "data:image/png;base64,AA==" },
    { image: "data:image/webp;base64,BB==" },
    { text: "改成咖啡馆背景" },
  ]);
});

test("2K tier maps to pixel size for qwen-image", () => {
  const payload = buildWanPayload({
    prompt: "一只陶瓷杯",
    images: [],
    count: 1,
    size: "2K",
  });
  assert.equal(payload.model, "qwen-image-2.0-pro");
  assert.equal(payload.parameters.size, "2048*2048");
  assert.equal(payload.parameters.prompt_extend, true);
});

test("only counts one to four are valid", () => {
  assert.equal(assertGenerateRequest({
    prompt: "商品",
    images: [],
    count: undefined,
    size: "1K",
  }).count, 1);
  assert.equal(assertGenerateRequest({
    prompt: "商品",
    images: [],
    count: 4,
    size: "1K",
  }).count, 4);
  for (const count of [0, 5, 1.5, "3"]) {
    assert.throws(() => assertGenerateRequest({
      prompt: "商品",
      images: [],
      count,
      size: "1K",
    }), WanApiError);
  }
});

test("image URLs are extracted only when the exact requested count is returned", () => {
  const data = {
    output: {
      choices: [
        { message: { content: [{ type: "image", image: "https://aliyuncs.com/a.png" }] } },
        { message: { content: [{ type: "image", image: "https://images.example.aliyuncs.com/b.png" }] } },
      ],
    },
  };
  assert.deepEqual(extractImageUrls(data, 2), [
    "https://aliyuncs.com/a.png",
    "https://images.example.aliyuncs.com/b.png",
  ]);
  assert.deepEqual(extractImageUrls(data, 3, { sequential: true }), [
    "https://aliyuncs.com/a.png",
    "https://images.example.aliyuncs.com/b.png",
  ]);
});

test("image URL extraction rejects fewer, more, and duplicate results with status 502", () => {
  const responseWith = (...urls) => ({
    request_id: "result-request-123",
    output: {
      choices: urls.map((image) => ({ message: { content: [{ image }] } })),
    },
  });
  const one = "https://oss-cn-beijing.aliyuncs.com/a.png";
  const two = "https://oss-cn-beijing.aliyuncs.com/b.png";

  for (const response of [
    responseWith(one),
    responseWith(one, two, "https://oss-cn-beijing.aliyuncs.com/c.png"),
    responseWith(one, one),
    responseWith(`${one}#first`, `${one}#second`),
  ]) {
    assert.throws(
      () => extractImageUrls(response, 2),
      (error) => {
        assert.ok(error instanceof WanApiError);
        assert.equal(error.status, 502);
        assert.equal(error.requestId, "result-request-123");
        return true;
      },
    );
  }
});

test("image URL extraction rejects non-HTTPS, IP, and lookalike result hosts", () => {
  for (const image of [
    "http://oss-cn-beijing.aliyuncs.com/a.png",
    "https://127.0.0.1/a.png",
    "https://aliyuncs.com.example.test/a.png",
    "https://evilaliyuncs.com/a.png",
  ]) {
    assert.throws(
      () => extractImageUrls({
        output: { choices: [{ message: { content: [{ image }] } }] },
      }, 1),
      (error) => error instanceof WanApiError && error.status === 502,
    );
  }
});

test("Wan request boundary enforces exact unique result cardinality from mocked responses", async () => {
  const url = (name) => `https://oss-cn-beijing.aliyuncs.com/${name}.png`;
  const requestWith = (...urls) => requestWanImages({
    apiKey: "local-test-key",
    prompt: "商品图",
    images: [],
    count: 2,
    size: "1K",
    sequential: false,
    fetchImpl: async () => fakeResponse({
      jsonValue: {
        request_id: "cardinality-request-123",
        output: {
          choices: urls.map((image) => ({ message: { content: [{ image }] } })),
        },
      },
    }),
  });

  assert.deepEqual(await requestWith(url("a"), url("b")), [url("a"), url("b")]);
  for (const result of [
    [url("a")],
    [url("a"), url("b"), url("c")],
    [url("a"), url("a")],
  ]) {
    await assert.rejects(
      requestWith(...result),
      (error) => error instanceof WanApiError
        && error.status === 502
        && error.requestId === "cardinality-request-123",
    );
  }
});

test("Wan requests use the expected POST payload and never expose the API key in errors", async () => {
  const apiKey = "test-api-key-should-not-leak";
  let call;
  const fetchImpl = async (...args) => {
    call = args;
    return fakeResponse({
      ok: false,
      status: 401,
      headers: { "x-request-id": "request-123" },
      jsonValue: { message: `Authorization: Bearer ${apiKey}` },
    });
  };

  await assert.rejects(
    requestWanImages({
      apiKey,
      prompt: "一只陶瓷杯",
      images: [],
      size: "1K",
      fetchImpl,
    }),
    (error) => {
      assert.ok(error instanceof WanApiError);
      assert.equal(error.status, 401);
      assert.equal(error.requestId, "request-123");
      assert.equal(error.message.includes(apiKey), false);
      return true;
    },
  );

  const [url, options] = call;
  assert.equal(url, WAN_ENDPOINT);
  assert.equal(options.method, "POST");
  assert.deepEqual(options.headers, {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  });
  assert.deepEqual(JSON.parse(options.body), buildWanPayload({
    prompt: "一只陶瓷杯",
    images: [],
    size: "1K",
  }));
  assert.ok(options.signal instanceof AbortSignal);
});

test("Wan request cancels upstream when external signal aborts", async () => {
  const external = new AbortController();
  let upstreamSignal;
  const pending = requestWanImages({
    apiKey: "local-test-key",
    prompt: "一只陶瓷杯",
    images: [],
    size: "1K",
    signal: external.signal,
    fetchImpl: async (_url, options) => {
      upstreamSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      });
    },
  });
  await Promise.resolve();
  external.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof WanApiError && error.status === 499 && error.message === "请求已取消。",
  );
  assert.equal(upstreamSignal?.aborted, true);
});

test("upstream errors strip data URLs, Bearer values, API-key-like values, and control characters", async () => {
  const upstreamBearer = "upstream-bearer-secret";
  const upstreamKey = "upstream-api-key-secret";

  await assert.rejects(
    requestWanImages({
      apiKey: "local-test-key",
      prompt: "一只陶瓷杯",
      images: [],
      size: "1K",
      fetchImpl: async () => fakeResponse({
        ok: false,
        status: 400,
        jsonValue: {
          message: `\u0000bad data:image/png;base64,SECRETDATA Bearer ${upstreamBearer} api_key=${upstreamKey}\u0007`,
        },
      }),
    }),
    (error) => {
      assert.ok(error instanceof WanApiError);
      assert.equal(error.message.includes("data:"), false);
      assert.equal(error.message.includes(upstreamBearer), false);
      assert.equal(error.message.includes(upstreamKey), false);
      assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(error.message), false);
      return true;
    },
  );
});

test("upstream errors redact space-separated API key labels alongside Data URLs and Bearer values", async () => {
  const apiKey = "sk-example-secret";
  const bearer = "Bearer example-bearer-secret";
  const dataUrl = "data:image/png;base64,EXAMPLEIMAGESECRET";

  await assert.rejects(
    requestWanImages({
      apiKey: "local-test-key",
      prompt: "一只陶瓷杯",
      images: [],
      size: "1K",
      fetchImpl: async () => fakeResponse({
        ok: false,
        status: 400,
        jsonValue: { message: `upload failed: api key=${apiKey}; ${bearer}; ${dataUrl}` },
      }),
    }),
    (error) => {
      assert.ok(error instanceof WanApiError);
      for (const secret of ["api key", apiKey, bearer, dataUrl, "EXAMPLEIMAGESECRET"]) {
        assert.equal(error.message.includes(secret), false);
      }
      return true;
    },
  );
});

test("redirected image downloads reject without following the redirect", async () => {
  let options;
  await assert.rejects(
    downloadImage({
      imageUrl: "https://images.example.aliyuncs.com/result.png",
      outputDir: tmpdir(),
      fetchImpl: async (_url, receivedOptions) => {
        options = receivedOptions;
        return fakeResponse({
          redirected: true,
          url: "http://127.0.0.1/private.png",
          headers: { "content-type": "image/png" },
        });
      },
    }),
    WanApiError,
  );
  assert.equal(options.redirect, "error");
});

test("image downloads reject non-HTTPS and non-allowlisted hosts before fetch", async () => {
  let fetchCalls = 0;
  for (const imageUrl of [
    "http://oss-cn-beijing.aliyuncs.com/result.png",
    "https://127.0.0.1/result.png",
    "https://aliyuncs.com.example.test/result.png",
  ]) {
    await assert.rejects(
      downloadImage({
        imageUrl,
        outputDir: tmpdir(),
        fetchImpl: async () => {
          fetchCalls += 1;
          return fakeResponse();
        },
      }),
      (error) => error instanceof WanApiError && error.status === 502,
    );
  }
  assert.equal(fetchCalls, 0);
});

test("image downloads supply an AbortSignal and abort at the configured timeout", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "wan-timeout-"));
  let receivedSignal;

  try {
    await assert.rejects(
      downloadImage({
        imageUrl: "https://images.example.aliyuncs.com/stalled.png",
        outputDir,
        timeoutMs: 5,
        fetchImpl: async (_url, options) => {
          receivedSignal = options.signal;
          if (!(receivedSignal instanceof AbortSignal)) {
            throw new Error("missing abort signal");
          }
          return new Promise((_resolve, reject) => {
            receivedSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      }),
      (error) => error instanceof WanApiError && receivedSignal?.aborted === true,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("image download timeout interrupts a stalled body and removes its temporary file", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "wan-body-timeout-"));
  let signal;
  let reads = 0;
  const body = {
    getReader() {
      return {
        async read() {
          reads += 1;
          if (reads === 1) return { done: false, value: new Uint8Array([137, 80]) };
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
          });
        },
        cancel() {},
        releaseLock() {},
      };
    },
  };

  try {
    await assert.rejects(downloadImage({
      imageUrl: "https://images.example.aliyuncs.com/stalled-body.png",
      outputDir,
      timeoutMs: 5,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return fakeResponse({
          headers: { "content-type": "image/png" },
          body,
        });
      },
    }), WanApiError);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await readdir(outputDir), []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("image downloads reject oversized Content-Length before reading the body", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "wan-declared-size-"));
  let bodyRead = false;

  try {
    await assert.rejects(
      downloadImage({
        imageUrl: "https://images.example.aliyuncs.com/large.png",
        outputDir,
        fetchImpl: async () => fakeResponse({
          headers: {
            "content-type": "image/png",
            "content-length": String(20 * 1024 * 1024 + 1),
          },
          arrayBufferImpl: async () => {
            bodyRead = true;
            return new ArrayBuffer(0);
          },
        }),
      }),
      (error) => error instanceof WanApiError && error.status === 502,
    );
    assert.equal(bodyRead, false);
    assert.deepEqual(await readdir(outputDir), []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("arrayBuffer fallback rejects oversized actual bytes and removes temporary output", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "wan-fallback-size-"));

  try {
    await assert.rejects(
      downloadImage({
        imageUrl: "https://images.example.aliyuncs.com/fallback-large.png",
        outputDir,
        fetchImpl: async () => fakeResponse({
          headers: {
            "content-type": "image/png",
            "content-length": "1",
          },
          arrayBufferImpl: async () => new ArrayBuffer(20 * 1024 * 1024 + 1),
        }),
      }),
      (error) => error instanceof WanApiError && error.status === 502,
    );
    assert.deepEqual(await readdir(outputDir), []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("image downloads enforce the 20 MB ceiling while consuming a chunked body", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "wan-chunked-size-"));
  const chunk = new Uint8Array(1024 * 1024);
  let chunksRead = 0;
  const body = {
    getReader() {
      return {
        async read() {
          chunksRead += 1;
          if (chunksRead <= 21) return { done: false, value: chunk };
          return { done: true, value: undefined };
        },
        releaseLock() {},
      };
    },
  };

  try {
    await assert.rejects(
      downloadImage({
        imageUrl: "https://images.example.aliyuncs.com/chunked.png",
        outputDir,
        fetchImpl: async () => fakeResponse({
          headers: { "content-type": "image/png" },
          body,
        }),
      }),
      (error) => error instanceof WanApiError && error.status === 502,
    );
    assert.equal(chunksRead, 21);
    assert.deepEqual(await readdir(outputDir), []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("image downloads accept PNG parameters but reject other image MIME types", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "wan-content-type-"));

  try {
    const filename = await downloadImage({
      imageUrl: "https://images.example.aliyuncs.com/result.png",
      outputDir,
      fetchImpl: async () => fakeResponse({
        headers: {
          "content-type": "image/png; charset=binary",
          "content-length": "4",
        },
        bytes: new Uint8Array([137, 80, 78, 71]),
      }),
    });
    assert.match(filename, /^[0-9a-f-]+\.png$/);

    await assert.rejects(
      downloadImage({
        imageUrl: "https://images.example.aliyuncs.com/result.jpg",
        outputDir,
        fetchImpl: async () => fakeResponse({
          headers: { "content-type": "image/jpeg" },
          bytes: new Uint8Array([255, 216, 255]),
        }),
      }),
      (error) => error instanceof WanApiError && error.status === 502,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("image downloads remove temporary output when streaming fails", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "wan-stream-error-"));
  let reads = 0;
  const body = {
    getReader() {
      return {
        async read() {
          reads += 1;
          if (reads === 1) return { done: false, value: new Uint8Array([137, 80]) };
          throw new Error("stream failed");
        },
        cancel() {},
        releaseLock() {},
      };
    },
  };

  try {
    await assert.rejects(downloadImage({
      imageUrl: "https://images.example.aliyuncs.com/broken.png",
      outputDir,
      fetchImpl: async () => fakeResponse({
        headers: { "content-type": "image/png" },
        body,
      }),
    }), WanApiError);
    assert.deepEqual(await readdir(outputDir), []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("successful image download writes a UUID PNG filename to the output directory", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "wan-client-"));
  const bytes = new Uint8Array([137, 80, 78, 71]);

  try {
    const filename = await downloadImage({
      imageUrl: "https://images.example.aliyuncs.com/result.png",
      outputDir,
      fetchImpl: async () => fakeResponse({
        headers: {
          "content-type": "image/png",
          "content-length": String(bytes.byteLength),
        },
        bytes,
      }),
    });
    assert.match(filename, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i);
    assert.deepEqual(await readFile(join(outputDir, filename)), Buffer.from(bytes));
    assert.deepEqual(await readdir(outputDir), [filename]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("completed-image rollback removes only a validated UUID PNG filename", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "wan-rollback-"));
  const outputDir = join(rootDir, "generated");
  const filename = "123e4567-e89b-42d3-a456-426614174000.png";
  const outsidePath = join(rootDir, "outside.png");
  await mkdir(outputDir);
  await writeFile(join(outputDir, filename), "generated");
  await writeFile(outsidePath, "outside");

  try {
    assert.equal(typeof wanClient.removeDownloadedImage, "function");
    await wanClient.removeDownloadedImage({ outputDir, filename });
    assert.deepEqual(await readdir(outputDir), []);
    await assert.rejects(
      wanClient.removeDownloadedImage({ outputDir, filename: "../outside.png" }),
      WanApiError,
    );
    assert.equal(await readFile(outsidePath, "utf8"), "outside");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
