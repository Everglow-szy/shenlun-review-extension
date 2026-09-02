import type { GradingModelId } from "../types";
import { deepSeekModelConfig } from "./gradingEngines";

export class DeepSeekProviderError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DeepSeekProviderError";
  }
}

interface DeepSeekResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: "stop" | "length" | "content_filter" | "tool_calls" | "insufficient_system_resource" | null;
  }[];
  readonly error?: { readonly message?: string; readonly code?: string };
}

export function normalizeDeepSeekBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "api.deepseek.com") return null;
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname && pathname !== "/v1") return null;
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

export async function requestDeepSeekFeedback(input: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: GradingModelId;
  readonly prompt: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<string> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new DeepSeekProviderError(
      "DEEPSEEK_API_KEY_MISSING",
      "尚未配置 DeepSeek API Key，请先在设置中填写。",
      false,
    );
  }
  const baseUrl = normalizeDeepSeekBaseUrl(input.baseUrl);
  if (!baseUrl) {
    throw new DeepSeekProviderError(
      "DEEPSEEK_BASE_URL_INVALID",
      "DeepSeek API 地址无效，目前仅支持 https://api.deepseek.com。",
      false,
    );
  }
  const model = deepSeekModelConfig(input.model);
  if (!model) {
    throw new DeepSeekProviderError(
      "DEEPSEEK_MODEL_INVALID",
      "所选模型不属于 DeepSeek API。",
      false,
    );
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), input.timeoutMs ?? 180_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.model,
        messages: [{ role: "user", content: input.prompt }],
        thinking: { type: model.thinking },
        stream: false,
        max_tokens: 32_768,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null) as DeepSeekResponse | null;
    if (!response.ok) {
      const detail = data?.error?.message?.trim();
      throw new DeepSeekProviderError(
        response.status === 401 ? "DEEPSEEK_API_KEY_INVALID" : "DEEPSEEK_API_FAILED",
        response.status === 401
          ? "DeepSeek API Key 无效或已失效。"
          : `DeepSeek API 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : "。"}`,
        response.status === 429 || response.status >= 500,
      );
    }
    const choice = data?.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (!content) {
      throw new DeepSeekProviderError(
        "DEEPSEEK_EMPTY_RESPONSE",
        "DeepSeek API 返回成功，但没有可保存的批改内容。",
        true,
      );
    }
    if (choice?.finish_reason === "length") {
      throw new DeepSeekProviderError(
        "DEEPSEEK_RESPONSE_TRUNCATED",
        "DeepSeek 达到输出长度上限，返回内容可能不完整。本次结果未保存，请缩短提示词或重新提交。",
        true,
      );
    }
    if (choice?.finish_reason === "content_filter") {
      throw new DeepSeekProviderError(
        "DEEPSEEK_RESPONSE_FILTERED",
        "DeepSeek 因内容过滤未返回完整结果，本次结果未保存。",
        false,
      );
    }
    if (choice?.finish_reason === "insufficient_system_resource") {
      throw new DeepSeekProviderError(
        "DEEPSEEK_RESOURCE_INTERRUPTED",
        "DeepSeek 因服务资源不足中断生成，本次结果未保存，请稍后重试。",
        true,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof DeepSeekProviderError) throw error;
    if (controller.signal.aborted) {
      throw new DeepSeekProviderError(
        "DEEPSEEK_TIMEOUT",
        "等待 DeepSeek API 返回批改结果超时。",
        true,
      );
    }
    throw new DeepSeekProviderError(
      "DEEPSEEK_NETWORK_FAILED",
      error instanceof Error ? `无法连接 DeepSeek API：${error.message}` : "无法连接 DeepSeek API。",
      true,
    );
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
