# 万相对话式生图接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace placeholder generation with a secure Node.js backend that invokes Wan 2.7, saves real PNGs locally, and retains the current conversation/version workflow.

**Architecture:** A dependency-free Node 18 HTTP server serves the existing static UI and one same-origin POST /api/generate endpoint. A focused Wan client builds the native multimodal request and persists temporary output images. Browser helpers keep generation count, ratio mapping, and request construction testable before app.js uses them.

**Tech Stack:** Node.js 18+, native http/fetch/node:test, vanilla browser ES modules, Alibaba Cloud Model Studio Wan wan2.7-image.

## Global Constraints

- Call POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation with wan2.7-image. Do not use the OpenAI-compatible chat URL for image generation.
- Read DASHSCOPE_API_KEY only in the server process. Never return, log, hard-code, or document a real value.
- Default count is 1. Only explicitly selected integer counts from 1 through 4 are valid.
- Preserve source uploads, quoted drafts, versions, templates, existing localStorage data, and UI language.
- Download each model image under generated/ immediately. Do not trust a browser supplied filesystem path.
- Add no third-party dependencies.
- The supplied folder is not a Git repository: do not initialize one and do not attempt commits.

---

## File Structure

| File | Responsibility |
| --- | --- |
| package.json | Node start/test scripts, no dependencies |
| .gitignore | Ignore .env and generated output |
| .env.example | Empty DASHSCOPE_API_KEY example |
| wan-client.mjs | Wan payload, upstream fetch, output URL extraction, result download |
| server.mjs | Static server, API validation, local-reference resolution, safe errors |
| generation-helpers.mjs | Pure count/ratio/browser-request helpers |
| app.js | Real generate call, task status/errors/retry, PNG download |
| index.html | Count control and ES module script |
| README.md | Safe configuration and launch instructions |
| test/wan-client.test.mjs | Wan client unit tests |
| test/server.test.mjs | HTTP endpoint tests |
| test/generation-helpers.test.mjs | Browser helper unit tests |

## Task 1: Create the secure runtime boundary

**Files:**
- Create: package.json
- Create: .gitignore
- Create: .env.example
- Create: generated/.gitkeep
- Modify: README.md

**Interfaces:**
- Produces: npm start runs node server.mjs.
- Produces: npm test runs Node's built-in test runner over test/*.test.mjs.
- Produces: DASHSCOPE_API_KEY as the sole server credential name.

- [ ] **Step 1: Create the package contract**

Create package.json:

~~~json
{
  "name": "ai-visual-workbench",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.mjs",
    "test": "node --test test/*.test.mjs"
  },
  "engines": {
    "node": ">=18"
  }
}
~~~

- [ ] **Step 2: Protect secret and model output files**

Create .gitignore:

~~~gitignore
.env
generated/*
!generated/.gitkeep
~~~

Create .env.example:

~~~dotenv
# Copy to .env and put a newly rotated Model Studio key here.
DASHSCOPE_API_KEY=
~~~

Create an empty generated/.gitkeep file.

- [ ] **Step 3: Update README startup instructions**

Replace the direct-file opening instruction with:

~~~~markdown
## 本地启动

需要 Node.js 18 或更高版本。请先在百炼控制台重置任何曾被公开的 Key。

~~~bash
cp .env.example .env
# 编辑 .env，填入新 Key；不要提交该文件
npm start
~~~

打开 http://localhost:3000。不要双击 index.html：真实生图需要同源的本地后端。
默认一次生成 1 张；在“快捷参数输入”中可选择 1–4 张。生成图片保存在 generated/。
~~~~

- [ ] **Step 4: Verify setup without calling Wan**

Run:

~~~bash
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --version
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" -e "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8'))"
~~~

Expected: Node reports version 18 or newer. The package file exists and contains no dependencies. Do not run a billable API request.

## Task 2: Implement the Wan client with failing tests first

**Files:**
- Create: test/wan-client.test.mjs
- Create: wan-client.mjs

**Interfaces:**
- Produces: buildWanPayload({ prompt, images, count, size }): object.
- Produces: assertGenerateRequest({ prompt, images, count, size }): normalized request.
- Produces: extractImageUrls(response): string[].
- Produces: requestWanImages({ apiKey, prompt, images, count, size, fetchImpl }): Promise<string[]>.
- Produces: downloadImage({ imageUrl, outputDir, fetchImpl }): Promise<string> returning a safe PNG filename.

- [ ] **Step 1: Write the failing payload/response tests**

Create test/wan-client.test.mjs before the client exists:

~~~js
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGenerateRequest,
  buildWanPayload,
  extractImageUrls,
  WanApiError,
} from "../wan-client.mjs";

test("text generation defaults count to one and enables thinking", () => {
  const payload = buildWanPayload({
    prompt: "一只陶瓷杯",
    images: [],
    size: "1024*1024",
  });
  assert.equal(payload.model, "wan2.7-image");
  assert.equal(payload.parameters.n, 1);
  assert.equal(payload.parameters.thinking_mode, true);
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
  assert.equal("thinking_mode" in payload.parameters, false);
  assert.deepEqual(payload.input.messages[0].content, [
    { image: "data:image/png;base64,AA==" },
    { image: "data:image/webp;base64,BB==" },
    { text: "改成咖啡馆背景" },
  ]);
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

test("image URLs are extracted and empty output is rejected", () => {
  const data = {
    output: {
      choices: [
        { message: { content: [{ type: "image", image: "https://example.test/a.png" }] } },
        { message: { content: [{ type: "image", image: "https://example.test/b.png" }] } },
      ],
    },
  };
  assert.deepEqual(extractImageUrls(data), [
    "https://example.test/a.png",
    "https://example.test/b.png",
  ]);
  assert.throws(() => extractImageUrls({ output: { choices: [] } }), WanApiError);
});
~~~

- [ ] **Step 2: Run the test and confirm RED**

Run:

~~~bash
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --test test/wan-client.test.mjs
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND for wan-client.mjs.

- [ ] **Step 3: Write the minimal client to make tests green**

Create wan-client.mjs with the following public structure:

~~~js
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const WAN_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

export class WanApiError extends Error {
  constructor(message, { status = 502, requestId = null } = {}) {
    super(message);
    this.name = "WanApiError";
    this.status = status;
    this.requestId = requestId;
  }
}

export function assertGenerateRequest({ prompt, images = [], count, size }) {
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
  return { prompt: normalizedPrompt, images, count: normalizedCount, size: size.trim() };
}

export function buildWanPayload(input) {
  const request = assertGenerateRequest(input);
  const content = request.images.map((image) => ({ image }));
  content.push({ text: request.prompt });
  const parameters = { n: request.count, size: request.size, watermark: false };
  if (!request.images.length) parameters.thinking_mode = true;
  return {
    model: "wan2.7-image",
    input: { messages: [{ role: "user", content }] },
    parameters,
  };
}

export function extractImageUrls(response) {
  const urls = (response?.output?.choices || [])
    .flatMap((choice) => choice?.message?.content || [])
    .map((item) => item?.image)
    .filter((url) => typeof url === "string" && url.startsWith("https://"));
  if (!urls.length) {
    throw new WanApiError("万相未返回可用图片。", {
      requestId: response?.request_id || null,
    });
  }
  return urls;
}
~~~

Add requestWanImages: POST buildWanPayload with JSON content type, Bearer auth, and a 120-second AbortController. For a non-2xx response, parse JSON if possible, then throw WanApiError with only the upstream message, status, and request ID. Never include an Authorization value or Data URL in an error.

Add downloadImage: fetch an HTTPS model URL; require image/* content type; create outputDir; write the binary as a randomUUID plus .png; return only that filename. Wrap download errors in WanApiError.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

~~~bash
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --test test/wan-client.test.mjs
~~~

Expected: PASS, 4 tests, 0 failures.

## Task 3: Create a safe same-origin HTTP server

**Files:**
- Create: test/server.test.mjs
- Create: server.mjs

**Interfaces:**
- Produces: createServer({ rootDir, generatedDir, apiKey, generateImages }): http.Server.
- Consumes: POST /api/generate JSON { prompt, images, count, size }.
- Produces: JSON { images: ["/generated/<uuid>.png"] }.

- [ ] **Step 1: Write the failing public endpoint tests**

Create test/server.test.mjs:

~~~js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server.mjs";

async function start(t, generateImages) {
  const rootDir = await mkdtemp(join(tmpdir(), "wan-server-"));
  const generatedDir = join(rootDir, "generated");
  await mkdir(generatedDir);
  const server = createServer({
    rootDir,
    generatedDir,
    apiKey: "test-key",
    generateImages,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return "http://127.0.0.1:" + server.address().port;
}

test("API defaults count to one and returns local URLs", async (t) => {
  let received;
  const baseUrl = await start(t, async (request) => {
    received = request;
    return { images: ["/generated/result.png"] };
  });
  const response = await fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "白底产品图",
      images: [],
      size: "1024*1024",
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { images: ["/generated/result.png"] });
  assert.equal(received.count, 1);
});

test("API rejects invalid body without model invocation", async (t) => {
  let calls = 0;
  const baseUrl = await start(t, async () => {
    calls += 1;
    return { images: [] };
  });
  const response = await fetch(baseUrl + "/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "", images: [], count: 5, size: "1K" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /提示词|数量/);
  assert.equal(calls, 0);
});

test("generated routes cannot traverse out of their directory", async (t) => {
  const baseUrl = await start(t, async () => ({ images: [] }));
  const response = await fetch(baseUrl + "/generated/%2e%2e/server.mjs");
  assert.equal(response.status, 404);
});
~~~

- [ ] **Step 2: Run the endpoint tests and confirm RED**

Run:

~~~bash
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --test test/server.test.mjs
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND for server.mjs.

- [ ] **Step 3: Implement server.mjs**

Use only Node built-ins and export these functions:

~~~js
export function createServer({ rootDir, generatedDir, apiKey, generateImages });
export async function readJsonBody(request, maxBytes = 56 * 1024 * 1024);
export async function resolveInputImages(images, generatedDir);
export async function generateAndPersist({
  prompt, images, count, size, apiKey, generatedDir, fetchImpl,
});
~~~

Implementation rules:

1. POST /api/generate reads a JSON body, calls assertGenerateRequest, resolves its image strings, then invokes generateImages. Tests pass a generator stub; production defaults to generateAndPersist.
2. resolveInputImages allows only JPEG/JPG/PNG/WEBP Base64 Data URLs up to 20 MB decoded, or paths that exactly match /generated/<UUID>.png. It reads matching files only from generatedDir and converts them to data:image/png;base64 values. Reject SVG placeholders, external URLs, arbitrary paths, bad Base64, non-PNG extensions, and any path outside generatedDir.
3. generateAndPersist calls requestWanImages then downloadImage for every returned image URL. It returns /generated/ plus each returned safe filename.
4. Convert WanApiError into its safe status and JSON { error, requestId? }. Convert all other exceptions to status 500 and JSON { error: "服务暂时不可用，请稍后重试。" }.
5. Return 405 JSON for other API methods. Set Cache-Control: no-store on every API response and X-Content-Type-Options: nosniff on every response.
6. For static requests, map / only to index.html; serve known files beneath rootDir with correct MIME type; serve only UUID-named PNGs beneath generatedDir. Decode and normalize paths before resolution, and return 404 for traversal or unknown paths.
7. Add a minimal loadDotEnv function: parse optional local .env lines, do not overwrite process.env, and never log its values. If server.mjs is the entry module, require DASHSCOPE_API_KEY and listen at Number(process.env.PORT || 3000). Missing keys must stop startup with a key-name-only error.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run:

~~~bash
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --test test/server.test.mjs
~~~

Expected: PASS, 3 tests, 0 failures.

## Task 4: Add count/ratio helpers and wire the real UI flow

**Files:**
- Create: test/generation-helpers.test.mjs
- Create: generation-helpers.mjs
- Modify: index.html
- Modify: app.js

**Interfaces:**
- Produces: normalizeCount(value), chooseOutputSize({ ratio, hasReference }), buildGenerateRequest({ prompt, sourceImage, referenceImage, count, ratio }).
- Consumes: task.params.count, task.params.ratio, task.sourceImage, and selected reference.
- Produces: server request { prompt, images, count, size } and real draft image URLs.

- [ ] **Step 1: Write failing pure helper tests**

Create test/generation-helpers.test.mjs:

~~~js
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGenerateRequest,
  chooseOutputSize,
  normalizeCount,
} from "../generation-helpers.mjs";

test("count defaults to one and preserves valid selections", () => {
  assert.equal(normalizeCount(undefined), 1);
  assert.equal(normalizeCount("1"), 1);
  assert.equal(normalizeCount("4"), 4);
  assert.equal(normalizeCount("5"), 1);
});

test("ratio maps for text and references force 1K", () => {
  assert.equal(chooseOutputSize({ ratio: "16:9", hasReference: false }), "1344*768");
  assert.equal(chooseOutputSize({ ratio: "3:4", hasReference: false }), "896*1152");
  assert.equal(chooseOutputSize({ ratio: "unknown", hasReference: false }), "1024*1024");
  assert.equal(chooseOutputSize({ ratio: "16:9", hasReference: true }), "1K");
});

test("request sends source and quote once with the selected count", () => {
  const request = buildGenerateRequest({
    prompt: "保持包的外观，将背景改为咖啡馆",
    sourceImage: "data:image/png;base64,source",
    referenceImage: "data:image/png;base64,draft",
    count: 2,
    ratio: "3:4",
  });
  assert.deepEqual(request, {
    prompt: "保持包的外观，将背景改为咖啡馆",
    images: ["data:image/png;base64,source", "data:image/png;base64,draft"],
    count: 2,
    size: "1K",
  });
});
~~~

- [ ] **Step 2: Run the helper tests and confirm RED**

Run:

~~~bash
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --test test/generation-helpers.test.mjs
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND for generation-helpers.mjs.

- [ ] **Step 3: Implement helpers and confirm GREEN**

Create generation-helpers.mjs:

~~~js
const RATIO_SIZES = Object.freeze({
  "1:1": "1024*1024",
  "2:3": "832*1248",
  "3:4": "896*1152",
  "4:3": "1152*896",
  "16:9": "1344*768",
  "9:16": "768*1344",
});

export function normalizeCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 4 ? count : 1;
}

export function chooseOutputSize({ ratio, hasReference }) {
  return hasReference ? "1K" : RATIO_SIZES[ratio] || "1024*1024";
}

export function buildGenerateRequest({
  prompt, sourceImage, referenceImage, count, ratio,
}) {
  const images = [sourceImage, referenceImage].filter(
    (image, index, values) => image && values.indexOf(image) === index,
  );
  return {
    prompt,
    images,
    count: normalizeCount(count),
    size: chooseOutputSize({ ratio, hasReference: images.length > 0 }),
  };
}
~~~

Run the focused command again. Expected: PASS, 3 tests, 0 failures.

- [ ] **Step 4: Add the explicit count control**

In the quick parameter drawer in index.html, add a 生成数量 field beside 画面比例:

~~~html
<div class="field">
  <label>生成数量</label>
  <select id="param-count">
    <option value="1" selected>1 张（默认）</option>
    <option value="2">2 张</option>
    <option value="3">3 张</option>
    <option value="4">4 张</option>
  </select>
</div>
~~~

At the end of index.html replace the classic app script tag with:

~~~html
<script type="module" src="app.js"></script>
~~~

- [ ] **Step 5: Replace the mock generation path in app.js**

At app.js line 1 import the tested helpers:

~~~js
import {
  buildGenerateRequest,
  normalizeCount,
} from "./generation-helpers.mjs";
~~~

Make these changes in the existing IIFE:

1. Add count: 1 to defaultParams. In collectParamsFromDrawer add count: normalizeCount($("#param-count").value). In syncParamsDrawerFromTask write String(normalizeCount(params.count)) to #param-count.
2. In runGeneration remove both sleep calls and the placeholderSvg draft creation. Set status queued, render, then status running and render.
3. Compute request using buildGenerateRequest with task.effectivePrompt, task.sourceImage, ref?.image, task.params.count, and task.params.ratio.
4. Persist task.lastGenerationInput before fetch with mode, note, ref, request, and promptSnapshot. Disable #btn-send and set aria-busy=true on #chat-stream.
5. POST JSON to /api/generate. For non-OK responses read only response JSON error, then throw Error with that error or 生成失败，请稍后重试。 Do not expose a raw response body.
6. On success map every response image to { id: uid("draft"), label: "草稿 " + (index + 1), image }. Create the current version exactly as today, but result messages use drafts.length rather than the literal 4.
7. On error set task status to failed, assign task.failReason, push a 生成失败： message, save/render, and toast a short error. In finally restore the send button and remove aria-busy.
8. retryTask restores task.lastGenerationInput and calls runGeneration with its stored mode/note/ref. If no snapshot exists show 暂无可重试的生成请求.
9. confirmHD assigns the selected real draft URL to task.hdImage. downloadCurrent uses a .png filename and the message 已触发 PNG 下载.

Retain placeholderSvg only for compatibility with prior mock localStorage records; no new generation may invoke it.

- [ ] **Step 6: Run all automated tests**

Run:

~~~bash
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --test test/*.test.mjs
~~~

Expected: PASS, 10 tests, 0 failures.

## Task 5: Verify the runnable behavior and complete documentation

**Files:**
- Modify: README.md
- Modify only if required by fresh verification: server.mjs, wan-client.mjs, generation-helpers.mjs, app.js, index.html

**Interfaces:**
- Consumes: a newly rotated key in a local .env file.
- Produces: a browser application at http://localhost:3000.

- [ ] **Step 1: Verify syntax and the full automated suite**

Run:

~~~bash
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --check server.mjs
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --check wan-client.mjs
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --check generation-helpers.mjs
"/Users/cecilia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --test test/*.test.mjs
~~~

Expected: all syntax commands exit 0; the test command reports 10 passing tests and 0 failures.

- [ ] **Step 2: Verify missing-key behavior**

Run npm start with no .env file and no DASHSCOPE_API_KEY. Expected: the process exits before listening, reports only that DASHSCOPE_API_KEY is required, and prints no secret value.

- [ ] **Step 3: Verify the real browser workflow only after explicit paid-call authorization**

After the user has placed a newly rotated key in .env and explicitly authorizes a paid request, start the service and test at http://localhost:3000:

1. Creative text-to-image with default count produces exactly one real PNG draft.
2. Selecting three produces exactly three real drafts.
3. Product image processing accepts a JPG/PNG/WebP and shows a local /generated/ result.
4. Quoting a draft and requesting an adjustment creates a new version with real drafts.
5. Confirm, save to library, reload, and download retain a local PNG.
6. An invalid key or stopped service produces a safe failure message and retry action with no credential content.

- [ ] **Step 4: Final README behavior section**

Add a short behavior section that records: default one-image output, optional one-to-four selection, native Wan endpoint/model, generated/ persistence because upstream URLs expire, and .env confidentiality.

- [ ] **Step 5: Record evidence in the handoff**

Do not stage or commit because this directory has no Git metadata. The final report must list fresh verification commands/results, changed files, whether paid Wan verification was skipped or performed, and npm start as the launch command.
