import {
  BRIDGE_MESSAGE,
  isChatGPTUrlChangedMessage,
  isChatGPTUrlObservedMessage,
  isManualSubmissionConfirmedMessage,
  isNonEmptyString,
  isRecord,
  type ChatGPTUrlChangedMessage,
  type ChatGPTUrlObservedMessage,
  type ManualSubmissionConfirmedMessage,
} from "../adapters/bridge-protocol";
import type { ExtensionRequest } from "../types";
import { isGradingTarget } from "../services/gradingEngines";

export type WorkerExtensionRequest = Extract<
  ExtensionRequest,
  | { readonly type: "EXAM/EXTRACT" }
  | { readonly type: "FEEDBACK/SUBMIT_SINGLE" }
  | { readonly type: "FEEDBACK/SUBMIT_FULL" }
  | { readonly type: "FEEDBACK/CONFIRM_MANUAL" }
  | { readonly type: "FEEDBACK/CANCEL_PENDING" }
  | { readonly type: "CONVERSATION/REBIND" }
  | { readonly type: "CHATGPT/FILL_PROMPT" }
>;

export type WorkerRequest =
  | WorkerExtensionRequest
  | ChatGPTUrlChangedMessage
  | ChatGPTUrlObservedMessage
  | ManualSubmissionConfirmedMessage;

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (
    isChatGPTUrlChangedMessage(value) ||
    isChatGPTUrlObservedMessage(value) ||
    isManualSubmissionConfirmedMessage(value)
  ) return true;
  if (!isRecord(value) || typeof value.type !== "string") return false;

  if (value.type === "EXAM/EXTRACT") {
    if (value.payload === undefined) {
      return Object.keys(value).every((key) => key === "type");
    }
    return Object.keys(value).every((key) => key === "type" || key === "payload") &&
      isRecord(value.payload) &&
      Object.keys(value.payload).every((key) => key === "windowId") &&
      typeof value.payload.windowId === "number" &&
      Number.isSafeInteger(value.payload.windowId) &&
      value.payload.windowId > 0;
  }
  if (value.type === "FEEDBACK/SUBMIT_FULL") {
    return (
      isRecord(value.payload) &&
      isNonEmptyString(value.payload.attemptId) &&
      isNonEmptyString(value.payload.requestId) &&
      isGradingTarget(value.payload.target)
    );
  }
  if (value.type === "FEEDBACK/SUBMIT_SINGLE") {
    return (
      isRecord(value.payload) &&
      isNonEmptyString(value.payload.attemptId) &&
      isNonEmptyString(value.payload.questionId) &&
      isNonEmptyString(value.payload.requestId) &&
      isGradingTarget(value.payload.target)
    );
  }
  if (value.type === "FEEDBACK/CONFIRM_MANUAL") {
    return (
      isRecord(value.payload) &&
      isNonEmptyString(value.payload.attemptId) &&
      isNonEmptyString(value.payload.requestId) &&
      isRecord(value.payload.handoff) &&
      (value.payload.handoff.mode === "full-paper" ||
        (value.payload.handoff.mode === "single-question" &&
          isNonEmptyString(value.payload.handoff.questionId)))
    );
  }
  if (value.type === "FEEDBACK/CANCEL_PENDING") {
    return (
      Object.keys(value).every((key) => key === "type" || key === "payload") &&
      isRecord(value.payload) &&
      Object.keys(value.payload).every(
        (key) => key === "attemptId" || key === "requestId" || key === "confirmedUnsent",
      ) &&
      isNonEmptyString(value.payload.attemptId) &&
      isNonEmptyString(value.payload.requestId) &&
      typeof value.payload.confirmedUnsent === "boolean"
    );
  }
  if (value.type === "CONVERSATION/REBIND") {
    return (
      isRecord(value.payload) &&
      isNonEmptyString(value.payload.attemptId) &&
      isNonEmptyString(value.payload.conversationUrl)
    );
  }
  if (value.type === "CHATGPT/FILL_PROMPT") {
    return (
      isRecord(value.payload) &&
      isNonEmptyString(value.payload.attemptId) &&
      isNonEmptyString(value.payload.prompt) &&
      typeof value.payload.autoSubmit === "boolean"
    );
  }
  return value.type === BRIDGE_MESSAGE.chatGPTUrlChanged && isChatGPTUrlChangedMessage(value);
}
