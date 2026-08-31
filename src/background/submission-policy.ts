import type {
  BridgeFailure,
  BridgeSuccess,
  ChatGPTDeliveryResponse,
  ChatGPTDeliveryResult,
} from "../adapters/bridge-protocol";
import type { AppSettings } from "../types";
import type { ConversationBinding } from "../types";

export type FeedbackHandoffMode = "single" | "full";

export function shouldFocusFeedbackTab(
  mode: FeedbackHandoffMode,
  settings: Pick<AppSettings, "autoOpenChatGPT" | "autoOpenConversationAfterFullSubmit">,
): boolean {
  return mode === "single"
    ? settings.autoOpenChatGPT
    : settings.autoOpenConversationAfterFullSubmit;
}

export function isPreparedOnlyDelivery(
  response: ChatGPTDeliveryResponse,
): response is BridgeSuccess<ChatGPTDeliveryResult & { readonly submitted: false }> {
  return response.ok && !response.data.submitted;
}

export function postDeliveryUncertainFailure(
  response: ChatGPTDeliveryResponse | null,
  error: unknown,
): BridgeFailure | null {
  if (!response?.ok || !response.data.submitted) return null;
  const detail = error instanceof Error ? error.message : "本地提交状态保存失败。";
  return {
    ok: false,
    error: {
      code: "CHATGPT_DELIVERY_UNCERTAIN",
      message: `Prompt 已在 ChatGPT 中发送，但本地提交状态未能确认（${detail}）。请勿重复发送，并先核对当前练习状态。`,
      retryable: false,
    },
  };
}

/**
 * Refresh Project metadata only while no real conversation has been claimed.
 * A bound URL remains authoritative and must never be moved implicitly.
 */
export function pendingBindingWithLatestProjectSettings(
  binding: ConversationBinding | null,
  settings: Pick<AppSettings, "projectName" | "projectUrl">,
  now: number = Date.now(),
): ConversationBinding | null {
  if (!binding || binding.conversationUrl) return null;
  const { projectUrl: _previousProjectUrl, ...withoutProjectUrl } = binding;
  const projectName = settings.projectName.trim() || binding.projectName;
  const projectUrl = settings.projectUrl.trim();
  return {
    ...withoutProjectUrl,
    projectName,
    ...(projectUrl ? { projectUrl } : {}),
    lastUsedAt: now,
  };
}
