# 对话式生图流程规则落地计划

> **For agentic workers:** 按任务顺序执行；每任务含红绿验证。规格见 `docs/superpowers/specs/2026-08-02-conversational-image-flow-design.md`。

**Goal:** 将对话规则写入 V3.0 流程规格，并用代码执行硬规则、用引导/前缀落地软规则。

**Architecture:** 规格为唯一规则源；`app.js` 负责发送前校验、导航清引用、adjust 前缀；`generation-helpers.test.mjs` 用源码级回归锁定导航清引用行为；不改 `server.mjs` / `wan-client.mjs`。

**Tech Stack:** 原生 ES module、Node `node:test`、localStorage 前端状态。

---

### Task 1: 规格与 README 入口

**Files:**
- Create: `docs/superpowers/specs/2026-08-02-conversational-image-flow-design.md`
- Create: `docs/superpowers/plans/2026-08-02-conversational-image-flow.md`
- Modify: `README.md`

### Task 2: H9 导航清空瞬时引用

**Files:**
- Modify: `app.js` — 新增 `clearTransientQuote`，在 `switchProject` / `openTask` 改上下文前调用
- Test: `test/generation-helpers.test.mjs` 已有对应断言

### Task 3: H12 引用归属校验 + S1/S2 软规则

**Files:**
- Modify: `app.js` — `isQuoteOwnedByTask`、`validateBeforeSend`、`sendMessage` adjust 前缀、欢迎/引用文案
- Modify: `test/generation-helpers.test.mjs` — 增加归属校验与 adjust 前缀静态断言

### Task 4: 验证

Run: `node --check app.js && npm test`
