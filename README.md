# 商品素材工作台 · V5.0

本目录从 V4.0 复制而来，与 `../V4.0` **互相独立**（代码、`.env`、`generated/`、`uploads/`、浏览器 localStorage 均不共用）。

- V4.0 默认端口：`4000`
- V5.0 默认端口：`5000`

同时启动示例：

```bash
# 终端 A
cd ../V4.0 && npm start

# 终端 B
cd ../V5.0 && npm start
```

---

基于 PRD V1.0，采用 Cursor 式布局：最左任务记录、左下功能入口、中对话、右画布。

## 本地启动

需要 Node.js 18 或更高版本。请先在百炼控制台重置任何曾被公开的 Key。

    cp .env.example .env
    # 编辑 .env，填入新 Key；不要提交该文件
    npm start

打开 `http://localhost:5000`。请勿通过双击 `index.html` 打开页面：真实生图需要同源的本地后端。

## 生成行为与凭证

- 默认一次生成 1 张图片；在“快捷参数输入”中可主动选择 1–4 张。
- 服务调用 DashScope 多模态生图端点 `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` 和 `qwen-image-2.0-pro` 模型。
- 上游图片 URL 会过期，因此服务会将下载的 PNG 持久化到本地 `generated/` 目录，并通过本地 `/generated/` 路径提供。
- `.env` 仅用于本地保存 `DASHSCOPE_API_KEY`；不要提交、分享或记录其中的密钥。

布局线框参考：`布局参考-Cursor式.html`

## 布局说明

| 区域 | 内容 |
| --- | --- |
| 最左任务轨 | 当前项目对话任务列表、新建任务 |
| 左栏层级 | 当前店铺（轻量切换）→ 本项目任务；左下为提示词管理 / 素材库 |
| 中栏对话 | 类型切换、上传、快捷参数输入、选用提示词、发送 |
| 右栏画布 | 预览、草稿、版本、保存/下载 |

Composer **不展示**「模板/个人/空白」三块方案卡与「有效提示词」正文；选用通过「选用提示词」弹层完成。提示词管理内含「我的提示词」「模板提示词」「收藏」。

## 建议体验路径

1. 创建店铺项目  
2. 左下进入「提示词管理」查看/发布模板提示词，或在对话点「选用提示词」  
3. 选择商品图加工并上传原图 → 发送需求  
4. 右侧选择草稿 → 引用调整 → 确认成品 → 保存素材库  
5. 对话内「保存提示词」沉淀到「我的提示词」  

对话式生图的完整流程与硬/软规则见：`docs/superpowers/specs/2026-08-02-conversational-image-flow-design.md`。

数据保存在浏览器 localStorage（`v5`）。
