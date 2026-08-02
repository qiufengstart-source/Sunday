import { WanApiError } from "./wan-client.mjs";

export const QWEN_CHAT_ENDPOINT =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
export const QWEN_OPTIMIZE_MODEL = "qwen3.5-flash";
const OPTIMIZE_TIMEOUT_MS = 45_000;

export function buildOptimizeMessages({ userText, guidePrompt, negative = "" }) {
  const guide = String(guidePrompt || "").trim();
  const user = String(userText || "").trim();
  const neg = String(negative || "").trim();
  const system = [
    "你是电商商品视觉生图提示词优化助手。",
    "请依据「个人提示词约束」改写用户需求，输出可直接用于文生图/图生图的中文提示词。",
    "要求：保留用户核心意图；补全主体、场景、光影、构图等必要细节；不要输出解释、标题或 Markdown；只输出优化后的提示词正文。",
  ].join("");

  const userContent = [
    guide ? `个人提示词约束：\n${guide}` : "",
    neg ? `尽量避免：\n${neg}` : "",
    `用户输入：\n${user}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];
}

export function extractChatText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return "";
  return content.trim();
}

export async function optimizePromptWithQwen({
  apiKey,
  userText,
  guidePrompt,
  negative = "",
  fetchImpl = globalThis.fetch,
  signal,
}) {
  const normalizedUser = String(userText || "").trim();
  if (!normalizedUser) {
    throw new WanApiError("请输入需要优化的描述。", { status: 400 });
  }
  if (!apiKey) {
    throw new WanApiError("服务未配置有效密钥，请检查本地 .env 后重启再试。", { status: 500 });
  }
  if (typeof fetchImpl !== "function") {
    throw new WanApiError("文本优化服务不可用。");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPTIMIZE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const response = await fetchImpl(QWEN_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: QWEN_OPTIMIZE_MODEL,
        messages: buildOptimizeMessages({
          userText: normalizedUser,
          guidePrompt,
          negative,
        }),
        temperature: 0.4,
        max_tokens: 800,
        enable_thinking: false,
      }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        typeof data?.error?.message === "string"
          ? data.error.message
          : typeof data?.message === "string"
            ? data.message
            : "文本优化失败，请稍后重试。";
      throw new WanApiError(message, { status: response.status >= 400 ? response.status : 502 });
    }

    const optimized = extractChatText(data);
    if (!optimized) {
      throw new WanApiError("文本优化未返回有效内容。", { status: 502 });
    }
    return { optimized, model: QWEN_OPTIMIZE_MODEL };
  } catch (error) {
    if (error instanceof WanApiError) throw error;
    if (error?.name === "AbortError") {
      throw new WanApiError("文本优化超时，请稍后重试。", { status: 504 });
    }
    throw new WanApiError("文本优化请求失败。");
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
