import type {
  AttemptId,
  CancelPendingFeedbackResult,
  ExtensionError,
  ExtractedPaperPayload,
} from "../types";

/** Messages below this boundary are private to the worker/content-script bridge. */
export const BRIDGE_MESSAGE = {
  extractPage: "BRIDGE/EXAM_EXTRACT_PAGE",
  pingExam: "BRIDGE/EXAM_PING",
  prepareChatGPT: "BRIDGE/CHATGPT_PREPARE",
  pingChatGPT: "BRIDGE/CHATGPT_PING",
  inspectChatGPT: "BRIDGE/CHATGPT_INSPECT",
  cancelPendingChatGPT: "BRIDGE/CHATGPT_CANCEL_PENDING",
  chatGPTUrlObserved: "BRIDGE/CHATGPT_URL_OBSERVED",
  chatGPTUrlChanged: "BRIDGE/CHATGPT_URL_CHANGED",
  manualSubmissionConfirmed: "BRIDGE/MANUAL_SUBMISSION_CONFIRMED",
  manualSubmissionRecorded: "BRIDGE/MANUAL_SUBMISSION_RECORDED",
  conversationDetected: "BRIDGE/CONVERSATION_DETECTED",
} as const;

export interface ChatGPTTarget {
  readonly attemptId: AttemptId;
  readonly projectName: string;
  readonly projectUrl?: string;
  readonly conversationName: string;
  readonly conversationUrl?: string;
}

export interface ChatGPTPreparePayload extends ChatGPTTarget {
  readonly prompt: string;
  readonly autoSubmit: boolean;
  readonly handoff?: ChatGPTHandoff;
}

export type ChatGPTHandoff =
  | {
      readonly mode: "single-question";
      readonly questionId: string;
      readonly requestId: string;
    }
  | { readonly mode: "full-paper"; readonly requestId: string };

export type ExamContentRequest =
  | { readonly type: typeof BRIDGE_MESSAGE.extractPage }
  | { readonly type: typeof BRIDGE_MESSAGE.pingExam };

export type ChatGPTContentRequest =
  | { readonly type: typeof BRIDGE_MESSAGE.pingChatGPT }
  | { readonly type: typeof BRIDGE_MESSAGE.inspectChatGPT }
  | ChatGPTCancelPendingRequest
  | {
      readonly type: typeof BRIDGE_MESSAGE.prepareChatGPT;
      readonly payload: ChatGPTPreparePayload;
    };

export interface ChatGPTCancelPendingRequest {
  readonly type: typeof BRIDGE_MESSAGE.cancelPendingChatGPT;
  readonly payload: { readonly attemptId: AttemptId; readonly requestId: string };
}

export interface ChatGPTUrlChangedMessage {
  readonly type: typeof BRIDGE_MESSAGE.chatGPTUrlChanged;
  readonly payload: {
    readonly attemptId: AttemptId;
    readonly conversationUrl: string;
    readonly renamed: boolean;
    readonly renameError?: string;
  };
}

export interface ChatGPTUrlObservedMessage {
  readonly type: typeof BRIDGE_MESSAGE.chatGPTUrlObserved;
  readonly payload: {
    readonly attemptId: AttemptId;
    readonly conversationUrl: string;
  };
}

export interface ManualSubmissionConfirmedMessage {
  readonly type: typeof BRIDGE_MESSAGE.manualSubmissionConfirmed;
  readonly payload: {
    readonly attemptId: AttemptId;
    readonly handoff: ChatGPTHandoff;
  };
}

export interface ManualSubmissionRecordedMessage {
  readonly type: typeof BRIDGE_MESSAGE.manualSubmissionRecorded;
  readonly payload:
    | {
        readonly attemptId: AttemptId;
        readonly mode: "single-question";
        readonly questionId: string;
        readonly requestId: string;
      }
    | {
        readonly attemptId: AttemptId;
        readonly mode: "full-paper";
        readonly requestId: string;
      };
}

export interface ConversationDetectedMessage {
  readonly type: typeof BRIDGE_MESSAGE.conversationDetected;
  readonly payload: {
    readonly attemptId: AttemptId;
    readonly conversationUrl: string;
    readonly renamed: boolean;
    readonly renameError?: string;
  };
}

export interface ChatGPTPreparedOnlyResult {
  readonly attemptId: AttemptId;
  readonly conversationUrl?: string;
  readonly submitted: false;
}

export interface ChatGPTSubmittedResult {
  readonly attemptId: AttemptId;
  readonly conversationUrl: string;
  readonly submitted: true;
  readonly renamed: true;
  readonly responseText: string;
}

export interface ChatGPTRenameWarningResult {
  readonly attemptId: AttemptId;
  readonly conversationUrl: string;
  readonly submitted: true;
  readonly renamed: false;
  readonly renameError: string;
  readonly responseText: string;
}

export type ChatGPTPrepareResult =
  | ChatGPTPreparedOnlyResult
  | ChatGPTSubmittedResult
  | ChatGPTRenameWarningResult;

export type ChatGPTDeliveryResult = ChatGPTPrepareResult & { readonly tabId: number };

export interface ChatGPTInspectResult {
  readonly composerState: "empty" | "non-empty" | "busy" | "unavailable";
  readonly pendingAttemptId?: AttemptId;
  readonly pendingRequestId?: string;
}

export type BridgeSuccess<T> = { readonly ok: true; readonly data: T };
export type BridgeFailure = { readonly ok: false; readonly error: ExtensionError };
export type BridgeResult<T> = BridgeSuccess<T> | BridgeFailure;

export type ExamExtractionResult = BridgeResult<ExtractedPaperPayload>;
export type ChatGPTContentResult = BridgeResult<ChatGPTPrepareResult>;
export type ChatGPTDeliveryResponse = BridgeResult<ChatGPTDeliveryResult>;
export type ChatGPTCancelPendingResponse = BridgeResult<CancelPendingFeedbackResult>;

export function bridgeSuccess<T>(data: T): BridgeSuccess<T> {
  return { ok: true, data };
}

export function bridgeFailure(
  code: string,
  message: string,
  retryable = false,
): BridgeFailure {
  return { ok: false, error: { code, message, retryable } };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isExamContentRequest(value: unknown): value is ExamContentRequest {
  if (!isRecord(value)) return false;
  return value.type === BRIDGE_MESSAGE.extractPage || value.type === BRIDGE_MESSAGE.pingExam;
}

export function isChatGPTPreparePayload(value: unknown): value is ChatGPTPreparePayload {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.attemptId) &&
    isNonEmptyString(value.projectName) &&
    isNonEmptyString(value.conversationName) &&
    isNonEmptyString(value.prompt) &&
    typeof value.autoSubmit === "boolean" &&
    (value.handoff === undefined || isChatGPTHandoff(value.handoff)) &&
    (value.projectUrl === undefined || typeof value.projectUrl === "string") &&
    (value.conversationUrl === undefined || typeof value.conversationUrl === "string")
  );
}

export function isChatGPTHandoff(value: unknown): value is ChatGPTHandoff {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.requestId)) return false;
  return value.mode === "full-paper"
    ? value.questionId === undefined
    : value.mode === "single-question" && isNonEmptyString(value.questionId);
}

export function isChatGPTPrepareResult(value: unknown): value is ChatGPTPrepareResult {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.attemptId) ||
    typeof value.submitted !== "boolean"
  ) {
    return false;
  }
  if (!value.submitted) {
    return (
      (value.conversationUrl === undefined || isNonEmptyString(value.conversationUrl)) &&
      value.renamed === undefined &&
      value.renameError === undefined
    );
  }
  if (
    !isNonEmptyString(value.conversationUrl) ||
    typeof value.renamed !== "boolean" ||
    !isNonEmptyString(value.responseText)
  ) return false;
  return value.renamed
    ? value.renameError === undefined
    : isNonEmptyString(value.renameError);
}

export function isChatGPTCancelPendingRequest(
  value: unknown,
): value is ChatGPTCancelPendingRequest {
  if (
    !isRecord(value) ||
    value.type !== BRIDGE_MESSAGE.cancelPendingChatGPT ||
    !isRecord(value.payload)
  ) {
    return false;
  }
  return (
    Object.keys(value).every((key) => key === "type" || key === "payload") &&
    Object.keys(value.payload).every((key) => key === "attemptId" || key === "requestId") &&
    isNonEmptyString(value.payload.attemptId) &&
    isNonEmptyString(value.payload.requestId)
  );
}

export function isChatGPTCancelPendingResponse(
  value: unknown,
): value is ChatGPTCancelPendingResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) {
    return (
      isRecord(value.error) &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string" &&
      typeof value.error.retryable === "boolean"
    );
  }
  if (
    !isRecord(value.data) ||
    !Object.keys(value.data).every((key) =>
      key === "cancelled" || key === "tooLate" || key === "reason"
    ) ||
    Object.keys(value.data).length !== 3
  ) return false;
  const { cancelled, tooLate, reason } = value.data;
  return (
    (cancelled === true && tooLate === false && reason === "cancelled") ||
    (cancelled === false && tooLate === false && reason === "not-found") ||
    (
      cancelled === false &&
      tooLate === true &&
      (reason === "delivery-in-progress" || reason === "send-started")
    )
  );
}

export function isChatGPTContentRequest(value: unknown): value is ChatGPTContentRequest {
  if (!isRecord(value)) return false;
  if (
    value.type === BRIDGE_MESSAGE.pingChatGPT ||
    value.type === BRIDGE_MESSAGE.inspectChatGPT
  ) return true;
  if (isChatGPTCancelPendingRequest(value)) return true;
  return value.type === BRIDGE_MESSAGE.prepareChatGPT && isChatGPTPreparePayload(value.payload);
}

export function isChatGPTUrlChangedMessage(value: unknown): value is ChatGPTUrlChangedMessage {
  if (!isRecord(value) || value.type !== BRIDGE_MESSAGE.chatGPTUrlChanged) return false;
  const payload = value.payload;
  return (
    isRecord(payload) &&
    isNonEmptyString(payload.attemptId) &&
    isNonEmptyString(payload.conversationUrl) &&
    typeof payload.renamed === "boolean" &&
    (payload.renamed
      ? payload.renameError === undefined
      : isNonEmptyString(payload.renameError))
  );
}

export function isChatGPTUrlObservedMessage(value: unknown): value is ChatGPTUrlObservedMessage {
  if (!isRecord(value) || value.type !== BRIDGE_MESSAGE.chatGPTUrlObserved) return false;
  const payload = value.payload;
  return (
    isRecord(payload) &&
    isNonEmptyString(payload.attemptId) &&
    isNonEmptyString(payload.conversationUrl)
  );
}

export function isManualSubmissionConfirmedMessage(
  value: unknown,
): value is ManualSubmissionConfirmedMessage {
  if (!isRecord(value) || value.type !== BRIDGE_MESSAGE.manualSubmissionConfirmed) return false;
  const payload = value.payload;
  return (
    isRecord(payload) &&
    isNonEmptyString(payload.attemptId) &&
    isChatGPTHandoff(payload.handoff)
  );
}

export function manualSubmissionRecordedMessage(
  attemptId: AttemptId,
  handoff: ChatGPTHandoff,
): ManualSubmissionRecordedMessage {
  if (handoff.mode === "single-question") {
    return {
      type: BRIDGE_MESSAGE.manualSubmissionRecorded,
      payload: {
        attemptId,
        mode: handoff.mode,
        questionId: handoff.questionId,
        requestId: handoff.requestId,
      },
    };
  }
  return {
    type: BRIDGE_MESSAGE.manualSubmissionRecorded,
    payload: { attemptId, mode: handoff.mode, requestId: handoff.requestId },
  };
}

export function isManualSubmissionRecordedMessage(
  value: unknown,
): value is ManualSubmissionRecordedMessage {
  if (!isRecord(value) || value.type !== BRIDGE_MESSAGE.manualSubmissionRecorded) return false;
  const payload = value.payload;
  if (
    !isRecord(payload) ||
    !isNonEmptyString(payload.attemptId) ||
    !isNonEmptyString(payload.requestId)
  ) return false;
  if (payload.mode === "full-paper") return payload.questionId === undefined;
  return payload.mode === "single-question" && isNonEmptyString(payload.questionId);
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
