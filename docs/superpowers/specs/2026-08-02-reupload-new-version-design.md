# 同任务重传原图开新版本（V5.0）

## 目标

在同一任务内明确版本归属：

1. **引用某版本 tip 再生成** → 续写该版本（仍为 Vn）
2. **引用非 tip** → 新建版本
3. **重新上传图片后再生成** → 新建版本（不以旧 tip 续写）

## 规则

| 场景 | 版本归属 |
| --- | --- |
| 引用 V1 tip 调整 | 继续 V1 |
| 引用 V1 非 tip / 同轮其他候选 | 新建 V2 |
| 任务已有版本后重新上传图片并发送 | 新建 Vx，以新图为该版本原图 |
| 首轮上传后首次生成 | V1 |

## 实现要点

1. 发送时若 `pendingAttachments` 存在且 `task.versions.length > 0`，强制走「新版本 / create」路径，不自动 `resolveQuoteForGenerate` tip。
2. 已有版本时，上传仅写入 pending，**不立刻覆盖** `task.sourceImage`，避免旧版本链路原图被冲掉。
3. 每个 version 记录 `sourceImage`；链路展示优先用 `version.sourceImage`。
4. tip 续写 / 非 tip 分支逻辑保持 `findVersionToContinue` 不变。

## 验收

1. V1 tip 引用修改 → 仍在 V1，版本条不新增。
2. 引用非 tip → 出现 V2。
3. 有 V1 后重新上传 B 再发送 → 出现 V2，V2 原图为 B；切回 V1 仍显示原图 A。
4. 相关单测通过。
