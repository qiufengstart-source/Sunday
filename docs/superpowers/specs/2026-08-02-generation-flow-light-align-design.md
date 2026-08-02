# 生图流程轻量对齐设计（V4.0 · 方案 B）

## 目标

对照「生图流程」泳道图，在不引入独立文本大模型的前提下，补齐用户可见的流程缺口：合成指令可见、变化检测、参数调整提示、更诚实的排队状态、成功后软引导。

## 范围

### 做

1. **展示合成指令**：发送前组装的 `effectivePrompt` 以可折叠系统消息展示（对应流程图「显示增强后文本指令」的轻量替代）。
2. **变化检测**：若与 `lastGenerationInput` 的提示词与请求包一致，确认后才重新生成。
3. **参数调整提示**：张数推断抬高、比例/分辨率纠正时系统提示。
4. **排队状态**：请求发出前保持 `queued`；收到响应后进入 `running` 语义（实现上：fetch 发出后仍显示排队直至开始等待结果，或保持 queued 直到 response headers）；429 文案对齐服务端「生成任务正在处理中」。
5. **成功软引导**：任务首次成功后提示可引用修改 / 确认成品 / 保存素材库 / 新建任务。

### 不做

- 独立 LLM 文本增强、翻译、营销词改写
- 步数参数、引擎健康检查、异步任务队列、磁盘级项目文件夹

## 实现要点

| 能力 | 落点 |
| --- | --- |
| 合成指令展示 | `sendMessage` / `runGeneration` 推送带 `promptPreview` 的 system 消息；`renderWorkbench` 渲染 `<details>` |
| 变化检测 | `generation-helpers.mjs`：`isSameGenerationRequest`；`sendMessage` / 重新生成前确认 |
| 参数提示 | `sendMessage` 在 `resolveOutputCount` 等纠正后 `pushMessage` |
| 排队 | `runGeneration`：先 `queued` + render，再 `fetch`；成功/失败前再切状态；`formatGenerationError` 识别 429 服务端文案 |
| 软引导 | `runGeneration` 成功且此前无成功版本时推送引导句 |

## 验收

1. 发送后对话可见「本次合成指令」折叠块，内容与实际请求 prompt 一致。
2. 指令与参数未变时点发送/重新生成会弹出确认。
3. 对话写「生成 3 张」且控件为 1 时，出现调整提示且控件变为 3。
4. 生成进行中状态文案可为「排队中」直至请求发出；429 提示排队/稍候。
5. 首轮成功后出现后续操作引导。
6. `generation-helpers` 相关单测通过。
