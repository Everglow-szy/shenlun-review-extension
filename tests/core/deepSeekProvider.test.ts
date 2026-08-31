import { describe, expect, it, vi } from "vitest";
import {
  DeepSeekProviderError,
  normalizeDeepSeekBaseUrl,
  requestDeepSeekFeedback,
} from "../../src/services/deepSeekProvider";

describe("DeepSeek API provider", () => {
  it("accepts only the official API root or its OpenAI-compatible /v1 path", () => {
    expect(normalizeDeepSeekBaseUrl("https://api.deepseek.com/"))
      .toBe("https://api.deepseek.com");
    expect(normalizeDeepSeekBaseUrl("https://api.deepseek.com/v1/"))
      .toBe("https://api.deepseek.com/v1");
    expect(normalizeDeepSeekBaseUrl("https://api.deepseek.com/unexpected"))
      .toBeNull();
    expect(normalizeDeepSeekBaseUrl("https://example.com"))
      .toBeNull();
  });

  it("maps the selected V4 variant and returns the assistant content", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "## 得分\n16 / 20" } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

    await expect(requestDeepSeekFeedback({
      apiKey: "sk-test-only",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro-nonthinking",
      prompt: "请批改",
      fetchImpl,
    })).resolves.toBe("## 得分\n16 / 20");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test-only",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "请批改" }],
      thinking: { type: "disabled" },
      stream: false,
    });
  });

  it("turns an authentication rejection into a non-retryable safe error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Authentication failed" },
    }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

    const request = requestDeepSeekFeedback({
      apiKey: "sk-invalid-test-only",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash-thinking",
      prompt: "test",
      fetchImpl,
    });
    await expect(request).rejects.toBeInstanceOf(DeepSeekProviderError);
    await expect(request).rejects.toMatchObject({
      code: "DEEPSEEK_API_KEY_INVALID",
      retryable: false,
    });
  });
});
