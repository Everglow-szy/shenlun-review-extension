import type { ExtensionRequest, ExtensionResponse } from "../types";

export class RuntimeRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "RuntimeRequestError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isExtensionResponse(value: unknown): value is ExtensionResponse {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  return typeof (value as { ok?: unknown }).ok === "boolean";
}

export async function sendRuntimeRequest<T>(request: ExtensionRequest): Promise<T> {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    throw new RuntimeRequestError("EXTENSION_UNAVAILABLE", "扩展运行环境尚未就绪，请重新打开 Side Panel。", true);
  }

  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法连接扩展后台。";
    throw new RuntimeRequestError("RUNTIME_UNAVAILABLE", message, true);
  }

  if (!isExtensionResponse(response)) {
    throw new RuntimeRequestError("INVALID_RESPONSE", "扩展返回了无法识别的数据，请重新加载扩展。", true);
  }
  if (!response.ok) {
    throw new RuntimeRequestError(response.error.code, response.error.message, response.error.retryable);
  }
  return response.data as T;
}
