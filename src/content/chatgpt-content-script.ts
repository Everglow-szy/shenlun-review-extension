import { ChatGPTAdapter, ChatGPTAdapterError } from "../adapters/ChatGPTAdapter";
import {
  BRIDGE_MESSAGE,
  bridgeFailure,
  bridgeSuccess,
  isChatGPTContentRequest,
  isRecord,
  toErrorMessage,
  type ChatGPTPreparePayload,
  type ChatGPTPrepareResult,
  type ChatGPTHandoff,
  type ChatGPTCancelPendingResponse,
} from "../adapters/bridge-protocol";
import type { CancelPendingFeedbackResult } from "../types";

declare global {
  interface Window {
    __shenlunChatGPTBridgeInstalled?: boolean;
  }
}

interface PendingManualHandoff {
  readonly token: number;
  readonly attemptId: string;
  readonly conversationName: string;
  readonly handoff?: ChatGPTHandoff;
  readonly requiresUrlObservation: boolean;
  gestureObserved: boolean;
  submissionConfirmed: boolean;
  submissionRecorded: boolean;
  manualRecordInFlight: boolean;
  manualRecordRetryTimer: ReturnType<typeof globalThis.setTimeout> | null;
  candidateConversationUrl: string | null;
  urlPersisted: boolean;
  urlOutcomeRecorded: boolean;
  inFlight: boolean;
  retryCount: number;
  retryTimer: ReturnType<typeof globalThis.setTimeout> | null;
  stopWatchingSubmit: () => void;
}

let nextPendingToken = 0;
let pendingManualHandoff: PendingManualHandoff | null = null;

function disarmManualHandoff(token?: number): void {
  const pending = pendingManualHandoff;
  if (!pending || (token !== undefined && pending.token !== token)) return;
  pending.stopWatchingSubmit();
  if (pending.retryTimer !== null) globalThis.clearTimeout(pending.retryTimer);
  if (pending.manualRecordRetryTimer !== null) {
    globalThis.clearTimeout(pending.manualRecordRetryTimer);
  }
  pendingManualHandoff = null;
}

function cancelPendingManualHandoff(
  attemptId: string,
  requestId: string,
): CancelPendingFeedbackResult {
  const pending = pendingManualHandoff;
  if (
    !pending ||
    pending.attemptId !== attemptId ||
    pending.handoff?.requestId !== requestId
  ) {
    return { cancelled: false, tooLate: false, reason: "not-found" };
  }
  if (
    pending.gestureObserved ||
    pending.submissionConfirmed ||
    pending.manualRecordInFlight ||
    pending.inFlight ||
    pending.submissionRecorded
  ) {
    return { cancelled: false, tooLate: true, reason: "send-started" };
  }
  disarmManualHandoff(pending.token);
  return { cancelled: true, tooLate: false, reason: "cancelled" };
}

function armManualHandoff(
  adapter: ChatGPTAdapter,
  payload: ChatGPTPreparePayload,
  requiresUrlObservation: boolean,
): void {
  disarmManualHandoff();
  const token = ++nextPendingToken;
  const pending: PendingManualHandoff = {
    token,
    attemptId: payload.attemptId,
    conversationName: payload.conversationName,
    ...(payload.handoff ? { handoff: payload.handoff } : {}),
    requiresUrlObservation,
    gestureObserved: false,
    submissionConfirmed: false,
    submissionRecorded: payload.handoff === undefined,
    manualRecordInFlight: false,
    manualRecordRetryTimer: null,
    candidateConversationUrl: null,
    urlPersisted: false,
    urlOutcomeRecorded: !requiresUrlObservation,
    inFlight: false,
    retryCount: 0,
    retryTimer: null,
    stopWatchingSubmit: () => undefined,
  };
  pendingManualHandoff = pending;
  pending.stopWatchingSubmit = adapter.watchForManualSubmit(
    () => {
      if (pendingManualHandoff?.token !== token) return;
      pending.submissionConfirmed = true;
      void recordManualSubmission(pending);
      reportConversationUrlIfChanged();
    },
    () => {
      if (pendingManualHandoff?.token === token) pending.gestureObserved = true;
    },
  );
}

async function sendConversationOutcome(
  attemptId: string,
  conversationUrl: string,
  renamed: boolean,
  renameError?: string,
): Promise<boolean> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: BRIDGE_MESSAGE.chatGPTUrlChanged,
      payload: {
        attemptId,
        conversationUrl,
        renamed,
        ...(renameError ? { renameError } : {}),
      },
    });
    return isRecord(response) && response.ok === true;
  } catch {
    return false;
  }
}

async function sendConversationObserved(
  attemptId: string,
  conversationUrl: string,
): Promise<boolean> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: BRIDGE_MESSAGE.chatGPTUrlObserved,
      payload: { attemptId, conversationUrl },
    });
    return isRecord(response) && response.ok === true;
  } catch {
    return false;
  }
}

async function sendManualSubmissionConfirmed(
  attemptId: string,
  handoff: ChatGPTHandoff,
): Promise<boolean> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: BRIDGE_MESSAGE.manualSubmissionConfirmed,
      payload: { attemptId, handoff },
    });
    return isRecord(response) && response.ok === true;
  } catch {
    return false;
  }
}

function maybeFinishPendingHandoff(pending: PendingManualHandoff): void {
  if (
    pendingManualHandoff?.token === pending.token &&
    pending.submissionRecorded &&
    pending.urlOutcomeRecorded
  ) {
    disarmManualHandoff(pending.token);
  }
}

async function recordManualSubmission(pending: PendingManualHandoff): Promise<void> {
  if (
    pending.manualRecordInFlight ||
    pending.submissionRecorded ||
    !pending.submissionConfirmed ||
    !pending.handoff ||
    (pending.requiresUrlObservation && !pending.urlPersisted)
  ) {
    maybeFinishPendingHandoff(pending);
    return;
  }
  pending.manualRecordInFlight = true;
  const recorded = await sendManualSubmissionConfirmed(pending.attemptId, pending.handoff);
  if (pendingManualHandoff?.token !== pending.token) return;
  pending.manualRecordInFlight = false;
  if (recorded) {
    pending.submissionRecorded = true;
    maybeFinishPendingHandoff(pending);
    return;
  }
  if (pending.manualRecordRetryTimer !== null) {
    globalThis.clearTimeout(pending.manualRecordRetryTimer);
  }
  pending.manualRecordRetryTimer = globalThis.setTimeout(
    () => void recordManualSubmission(pending),
    2_000,
  );
}

async function prepareChatGPT(payload: ChatGPTPreparePayload): Promise<ChatGPTPrepareResult> {
  const existingPending = pendingManualHandoff;
  if (existingPending) {
    if (existingPending.attemptId === payload.attemptId) {
      throw new ChatGPTAdapterError(
        "CHATGPT_HANDOFF_ALREADY_PENDING",
        "该练习已有 Prompt 等待手动发送；请先发送或取消原交接。",
        false,
      );
    }
    throw new ChatGPTAdapterError(
      "CONVERSATION_ISOLATION_VIOLATION",
      "该 ChatGPT 标签页正在等待另一练习的手动发送，已阻止覆盖。",
      false,
    );
  }
  const adapter = new ChatGPTAdapter(document);
  await adapter.ensureLoggedIn();

  if (payload.conversationUrl) {
    await adapter.openConversation(payload.conversationName, payload.conversationUrl);
  } else {
    await adapter.openProject(payload.projectName, payload.projectUrl);
    await adapter.createConversation();
  }

  await adapter.fillPrompt(payload.prompt);

  let conversationUrl = adapter.getConversationUrl() ?? undefined;
  if (payload.autoSubmit) {
    const responseText = await adapter.submitPromptAndWaitForResponse();
    conversationUrl = await adapter.waitForConversationUrl();
    const urlPersisted = await sendConversationObserved(payload.attemptId, conversationUrl);
    if (!urlPersisted) {
      return {
        attemptId: payload.attemptId,
        conversationUrl,
        submitted: true,
        renamed: false,
        responseText,
        renameError: "消息已发送，但后台未确认对话绑定；已跳过自动重命名，请勿重复提交并稍后核对绑定。",
      };
    }
    try {
      await adapter.renameCurrentConversation(payload.conversationName);
      return {
        attemptId: payload.attemptId,
        conversationUrl,
        submitted: true,
        renamed: true,
        responseText,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "ChatGPT 对话重命名失败，请手动修改。";
      return {
        attemptId: payload.attemptId,
        conversationUrl,
        submitted: true,
        renamed: false,
        responseText,
        renameError: message,
      };
    }
  }

  // Existing bound conversations do not need URL detection. Arm a one-shot
  // monitor only for a brand-new conversation that is waiting for manual send.
  const requiresUrlObservation = !payload.conversationUrl && !conversationUrl;
  if (payload.handoff || requiresUrlObservation) {
    armManualHandoff(adapter, payload, requiresUrlObservation);
  }
  const prepared = {
    attemptId: payload.attemptId,
    submitted: false,
  } as const;
  return conversationUrl ? { ...prepared, conversationUrl } : prepared;
}

function reportConversationUrlIfChanged(): void {
  // MutationObserver callbacks may already be queued while a test/document is
  // being torn down. In the extension both globals exist for the full content
  // script lifetime; the guard also makes that teardown deterministic.
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const pending = pendingManualHandoff;
  if (!pending || pending.inFlight) return;
  const conversationUrl = ChatGPTAdapter.conversationUrl(window.location.href);
  if (!conversationUrl) return;
  if (!pending.gestureObserved) {
    // The user navigated away instead of sending the prepared prompt. Never
    // rename or bind that unrelated conversation.
    disarmManualHandoff(pending.token);
    return;
  }
  if (!pending.submissionConfirmed) return;
  if (
    pending.candidateConversationUrl &&
    pending.candidateConversationUrl !== conversationUrl
  ) {
    disarmManualHandoff(pending.token);
    return;
  }
  pending.candidateConversationUrl = conversationUrl;
  pending.inFlight = true;
  void processPendingManualHandoff(pending, conversationUrl);
}

function schedulePendingRetry(pending: PendingManualHandoff): void {
  pending.retryCount += 1;
  const retryDelay = Math.min(1_000 * 2 ** Math.min(pending.retryCount - 1, 5), 30_000);
  if (pending.retryTimer !== null) globalThis.clearTimeout(pending.retryTimer);
  pending.retryTimer = globalThis.setTimeout(reportConversationUrlIfChanged, retryDelay);
}

async function processPendingManualHandoff(
  pending: PendingManualHandoff,
  conversationUrl: string,
): Promise<void> {
  const token = pending.token;
  try {
    if (!pending.urlPersisted) {
      const persisted = await sendConversationObserved(pending.attemptId, conversationUrl);
      if (pendingManualHandoff?.token !== token) return;
      if (!persisted) {
        schedulePendingRetry(pending);
        return;
      }
      pending.urlPersisted = true;
      // A brand-new conversation must be durably bound before its answer is
      // marked submitted. Otherwise a transient URL-save failure could make
      // the next question create a second conversation for the same Attempt.
      void recordManualSubmission(pending);
    }
    if (ChatGPTAdapter.conversationUrl(window.location.href) !== conversationUrl) {
      disarmManualHandoff(token);
      return;
    }

  const adapter = new ChatGPTAdapter(document);
    let renamed = true;
    let renameError: string | undefined;
    try {
      await adapter.renameCurrentConversation(pending.conversationName);
    } catch (error) {
      renamed = false;
      renameError = error instanceof Error ? error.message : "ChatGPT 对话重命名失败，请手动修改。";
    }
    if (ChatGPTAdapter.conversationUrl(window.location.href) !== conversationUrl) {
      disarmManualHandoff(token);
      return;
    }
    const recorded = await sendConversationOutcome(
        pending.attemptId,
        conversationUrl,
        renamed,
        renameError,
      );
    if (pendingManualHandoff?.token !== token) return;
    if (recorded) {
      pending.urlOutcomeRecorded = true;
      maybeFinishPendingHandoff(pending);
    }
    else schedulePendingRetry(pending);
  } finally {
    if (pendingManualHandoff?.token === token) pending.inFlight = false;
  }
}

function installUrlMonitor(): void {
  const observer = new MutationObserver(reportConversationUrlIfChanged);
  observer.observe(document.documentElement, { subtree: true, childList: true });
  window.addEventListener("popstate", reportConversationUrlIfChanged);
  window.addEventListener("hashchange", reportConversationUrlIfChanged);
}

function installChatGPTBridge(): void {
  if (window.__shenlunChatGPTBridgeInstalled) return;
  window.__shenlunChatGPTBridgeInstalled = true;
  installUrlMonitor();

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isChatGPTContentRequest(message)) return false;
    if (message.type === BRIDGE_MESSAGE.pingChatGPT) {
      sendResponse(bridgeSuccess({ ready: true }));
      return false;
    }
    if (message.type === BRIDGE_MESSAGE.inspectChatGPT) {
      const pendingAttemptId = pendingManualHandoff?.attemptId;
      const pendingRequestId = pendingManualHandoff?.handoff?.requestId;
      sendResponse(
        bridgeSuccess({
          composerState: new ChatGPTAdapter(document).getComposerState(),
          ...(pendingAttemptId ? { pendingAttemptId } : {}),
          ...(pendingRequestId ? { pendingRequestId } : {}),
        }),
      );
      return false;
    }
    if (message.type === BRIDGE_MESSAGE.cancelPendingChatGPT) {
      const response: ChatGPTCancelPendingResponse = bridgeSuccess(
        cancelPendingManualHandoff(
          message.payload.attemptId,
          message.payload.requestId,
        ),
      );
      sendResponse(response);
      return false;
    }

    void prepareChatGPT(message.payload)
      .then((result) => sendResponse(bridgeSuccess(result)))
      .catch((error: unknown) => {
        if (error instanceof ChatGPTAdapterError) {
          sendResponse(bridgeFailure(error.code, error.message, error.retryable));
          return;
        }
        sendResponse(
          bridgeFailure(
            "CHATGPT_AUTOMATION_FAILED",
            `ChatGPT 网页联动失败：${toErrorMessage(error)}`,
            true,
          ),
        );
      });
    return true;
  });
}

installChatGPTBridge();
