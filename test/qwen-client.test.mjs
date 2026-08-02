import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOptimizeMessages,
  extractChatText,
  optimizePromptWithQwen,
  QWEN_OPTIMIZE_MODEL,
} from "../qwen-client.mjs";

test("optimize messages include guide and user text", () => {
  const messages = buildOptimizeMessages({
    userText: "换成米白色",
    guidePrompt: "商品主体保真",
    negative: "水印",
  });
  assert.equal(messages[0].role, "system");
  assert.match(messages[1].content, /商品主体保真/);
  assert.match(messages[1].content, /换成米白色/);
  assert.match(messages[1].content, /水印/);
});

test("extractChatText reads assistant content", () => {
  assert.equal(
    extractChatText({
      choices: [{ message: { content: "  优化后的提示词  " } }],
    }),
    "优化后的提示词",
  );
});

test("optimizePromptWithQwen posts qwen3.5-flash with thinking disabled", async () => {
  let seen;
  const result = await optimizePromptWithQwen({
    apiKey: "sk-test",
    userText: "咖啡馆场景",
    guidePrompt: "主体保真",
    fetchImpl: async (url, options) => {
      seen = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "咖啡馆内的商品实拍图，主体清晰" } }],
        }),
      };
    },
  });
  assert.equal(result.optimized, "咖啡馆内的商品实拍图，主体清晰");
  assert.equal(result.model, QWEN_OPTIMIZE_MODEL);
  assert.equal(seen.body.model, "qwen3.5-flash");
  assert.equal(seen.body.enable_thinking, false);
  assert.match(seen.url, /compatible-mode\/v1\/chat\/completions/);
});
