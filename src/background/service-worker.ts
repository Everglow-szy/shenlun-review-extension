import { ChatGPTAdapter } from "../adapters/ChatGPTAdapter";
import {
  BRIDGE_MESSAGE,
  bridgeFailure,
  bridgeSuccess,
  manualSubmissionRecordedMessage,
  type BridgeFailure,
  type BridgeResult,
  type ChatGPTDeliveryResponse,
  type ChatGPTHandoff,
} from "../adapters/bridge-protocol";
import { conversationBindingRepository } from "../database/conversationBindingRepository";
import { DelegatingFeedbackProvider } from "../services/feedbackProvider";
import { parseFeedbackScore } from "../services/feedbackParser";
import { requestDeepSeekFeedback, DeepSeekProviderError } from "../services/deepSeekProvider";
import { practiceService } from "../services/practiceService";
import type {
  ExtensionResponse,
  FeedbackDeliveryResult,
  FeedbackSubmission,
} from "../types";
import { AttemptFeedbackGate } from "./attempt-feedback-gate";
import {
  cancelPendingForAttempt,
  deliverPromptForAttempt,
  forgetRemovedTab,
  isAttemptBoundToTab,
  recordDetectedConversationUrl,
} from "./chatgpt-tab-manager";
import { extractFromActiveTab, injectExamContentScript } from "./exam-bridge";
import { isWorkerRequest, type WorkerExtensionRequest, type WorkerRequest } from "./runtime-guards";

class DeliveryFailureError extends Error {
  public constructor(public readonly failure: BridgeFailure) {
    super(failure.error.message);
    this.name = "DeliveryFailureError";
  }
}

class PreparedOnlySignal extends Error {
  public constructor(public readonly delivery: ChatGPTDeliveryResponse & { readonly ok: true }) {
    super("ChatGPT prompt was prepared but not submitted");
    this.name = "PreparedOnlySignal";
  }
}

type FeedbackRequest = Extract<
  WorkerExtensionRequest,
  { readonly type: "FEEDBACK/SUBMIT_SINGLE" | "FEEDBACK/SUBMIT_FULL" }
>;

const feedbackGate = new AttemptFeedbackGate();

async function deliverFeedbackExclusively(
  request: FeedbackRequest,
): Promise<ExtensionResponse> {
  const { attemptId, requestId } = request.payload;
  const { target } = request.payload;
  const settings = await practiceService.getSettings();

  // Attempts are often created before the user opens Settings for the first
  // time. Until a real conversation URL exists, keep the pending binding's
  // Project metadata in sync with the latest settings. Once bound, the URL is
  // authoritative and is never silently moved to another Project/conversation.
  if (target.engine === "chatgpt-web") {
    const binding = await conversationBindingRepository.updatePendingProject(
      attemptId,
      settings.projectName,
      settings.projectUrl || undefined,
    );
    if (!binding) {
      await practiceService.cancelPreparedSubmission(attemptId, requestId).catch(() => undefined);
      return bridgeFailure(
        "CONVERSATION_BINDING_NOT_FOUND",
        "当前练习缺少 ChatGPT ConversationBinding，请重新创建本次练习。",
        false,
      );
    }
  }

  let submission: FeedbackSubmission;
  try {
    submission = await practiceService.getPreparedSubmission(attemptId, requestId);
  } catch (error) {
    return bridgeFailure(
      "SUBMISSION_SNAPSHOT_NOT_FOUND",
      error instanceof Error ? error.message : "未找到本次提交的不可变快照。",
      false,
    );
  }

  let deliveryLease: Awaited<ReturnType<typeof practiceService.markPreparedSubmissionDelivering>>;
  try {
    deliveryLease = await practiceService.markPreparedSubmissionDelivering(
      attemptId,
      requestId,
    );
  } catch (error) {
    return bridgeFailure(
      "SUBMISSION_SNAPSHOT_INVALID",
      error instanceof Error ? error.message : "无法锁定本次提交快照。",
      false,
    );
  }
  if (deliveryLease === "already-delivering") {
    return bridgeFailure(
      "FEEDBACK_DELIVERY_UNCERTAIN",
      "该提交此前已进入批改引擎交接阶段。为避免重复发送，请先核对对应页面或结果记录。",
      false,
    );
  }
  if (deliveryLease === "already-finalized") {
    return bridgeFailure(
      "SUBMISSION_ALREADY_FINALIZED",
      "本次提交已记录，无需再次发送。",
      false,
    );
  }

  let delivered: BridgeResult<FeedbackDeliveryResult> | null = null;
  const handoff: ChatGPTHandoff = request.type === "FEEDBACK/SUBMIT_SINGLE"
    ? {
        mode: "single-question",
        questionId: request.payload.questionId,
        requestId,
      }
    : { mode: "full-paper", requestId };
  const provider = new DelegatingFeedbackProvider(async (submission: FeedbackSubmission) => {
    if (target.engine === "chatgpt-web") {
      const attemptBundle = await practiceService.loadAttemptBundle(submission.attemptId);
      const chatGPTDelivery = await deliverPromptForAttempt(
        submission.attemptId,
        submission.prompt,
        true,
        {
          focusTab: false,
          handoff,
          conversationName: `${attemptBundle?.paper.paperName ?? "申论试卷"}-申论批改`,
        },
      );
      if (!chatGPTDelivery.ok) throw new DeliveryFailureError(chatGPTDelivery);
      if (!chatGPTDelivery.data.submitted) throw new PreparedOnlySignal(chatGPTDelivery);
      const chatGPTResult = chatGPTDelivery.data;
      delivered = bridgeSuccess({
        engine: target.engine,
        model: target.model,
        submitted: true,
        responseText: chatGPTResult.responseText,
        sourceUrl: chatGPTResult.conversationUrl,
        tabId: chatGPTResult.tabId,
        renamed: chatGPTResult.renamed,
        ...(chatGPTResult.renamed ? {} : { renameError: chatGPTResult.renameError }),
      });
      return;
    }
    try {
      const responseText = await requestDeepSeekFeedback({
        apiKey: settings.deepseekApiKey,
        baseUrl: settings.deepseekApiBaseUrl,
        model: target.model,
        prompt: submission.prompt,
      });
      delivered = bridgeSuccess({
        engine: target.engine,
        model: target.model,
        submitted: true,
        responseText,
        sourceUrl: "https://platform.deepseek.com/usage",
      });
    } catch (error) {
      if (error instanceof DeepSeekProviderError) {
        throw new DeliveryFailureError(bridgeFailure(error.code, error.message, error.retryable));
      }
      throw error;
    }
  });

  try {
    await provider.submit(submission);
    await practiceService.finalizePreparedSubmission(attemptId, requestId);
    const completedDelivery = delivered as BridgeResult<FeedbackDeliveryResult> | null;
    if (!completedDelivery?.ok) {
      throw new Error("批改引擎未返回可保存的结果。 ");
    }
    await practiceService.savePastedFeedback({
      attemptId,
      questionId: request.type === "FEEDBACK/SUBMIT_SINGLE"
        ? request.payload.questionId
        : null,
      rawText: completedDelivery.data.responseText,
      engine: completedDelivery.data.engine,
      model: completedDelivery.data.model,
      ...(completedDelivery.data.sourceUrl ? { sourceUrl: completedDelivery.data.sourceUrl } : {}),
      ...parseFeedbackScore(completedDelivery.data.responseText),
    });
    // Submission finalization is authoritative. A lastUsedAt touch failure must
    // never turn a completed web send into a retryable operation.
    if (target.engine === "chatgpt-web") {
      await conversationBindingRepository.touch(attemptId).catch(() => undefined);
    }
    return delivered ?? bridgeFailure("FEEDBACK_DELIVERY_FAILED", "批改引擎未返回结果。", true);
  } catch (error) {
    if (error instanceof PreparedOnlySignal) return error.delivery;
    if (error instanceof DeliveryFailureError) {
      if (!error.failure.error.code.endsWith("DELIVERY_UNCERTAIN")) {
        await practiceService
          .cancelPreparedSubmissionAfterConfirmedUnsent(attemptId, requestId)
          .catch(() => undefined);
      }
      return error.failure;
    }
    const deliveryAtFailure = delivered as BridgeResult<FeedbackDeliveryResult> | null;
    if (deliveryAtFailure?.ok) {
      return bridgeFailure(
        "FEEDBACK_DELIVERY_UNCERTAIN",
        `批改引擎已经返回结果，但本地保存未能确认（${error instanceof Error ? error.message : "未知错误"}）。请勿重复提交。`,
        false,
      );
    }
    await practiceService
      .cancelPreparedSubmissionAfterConfirmedUnsent(attemptId, requestId)
      .catch(() => undefined);
    return bridgeFailure(
      "FEEDBACK_SUBMISSION_FAILED",
      error instanceof Error ? error.message : "批改提交失败。",
      true,
    );
  }
}

async function deliverFeedback(request: FeedbackRequest): Promise<ExtensionResponse> {
  const release = feedbackGate.tryAcquire(request.payload.attemptId);
  if (!release) {
    return bridgeFailure(
      "FEEDBACK_SUBMISSION_IN_PROGRESS",
      "该练习已有批改交接正在进行，请等待当前操作完成。",
      false,
    );
  }
  try {
    return await deliverFeedbackExclusively(request);
  } finally {
    release();
  }
}

async function cancelPendingFeedback(
  attemptId: string,
  requestId: string,
  confirmedUnsent: boolean,
): Promise<ExtensionResponse> {
  // Taking the same lease closes the race where a new delivery could start
  // between checking the gate and cancelling the in-page watcher.
  const release = feedbackGate.tryAcquire(attemptId);
  if (!release) {
    return bridgeSuccess({
      cancelled: false,
      tooLate: true,
      reason: "delivery-in-progress" as const,
    });
  }
  try {
    const pageResult = await cancelPendingForAttempt(attemptId, requestId);
    if (!pageResult.ok || pageResult.data.tooLate) return pageResult;

    if (pageResult.data.cancelled) {
      const cancelled = await practiceService.cancelPreparedSubmissionAfterConfirmedUnsent(
        attemptId,
        requestId,
      );
      if (cancelled === "already-finalized") {
        return bridgeSuccess({ cancelled: false, tooLate: true, reason: "send-started" });
      }
      return pageResult;
    }

    // No page watcher is conclusive only while delivery never crossed its
    // durable boundary. A delivering outbox remains uncertain for the user to
    // resolve explicitly.
    const cancelled = confirmedUnsent
      ? await practiceService.cancelPreparedSubmissionAfterConfirmedUnsent(attemptId, requestId)
      : await practiceService.cancelPreparedSubmission(attemptId, requestId);
    if (cancelled === "cancelled") {
      return bridgeSuccess({ cancelled: true, tooLate: false, reason: "cancelled" });
    }
    if (cancelled === "already-finalized") {
      return bridgeSuccess({ cancelled: false, tooLate: true, reason: "send-started" });
    }
    if (cancelled === "already-started") {
      return bridgeSuccess({ cancelled: false, tooLate: true, reason: "send-started" });
    }
    return pageResult;
  } finally {
    release();
  }
}

async function handleRebind(
  request: Extract<WorkerExtensionRequest, { readonly type: "CONVERSATION/REBIND" }>,
): Promise<ExtensionResponse> {
  const normalized = ChatGPTAdapter.conversationUrl(request.payload.conversationUrl);
  if (!normalized) {
    return bridgeFailure(
      "CHATGPT_INVALID_CONVERSATION_URL",
      "请输入有效的 ChatGPT 对话 URL。",
      false,
    );
  }
  try {
    const binding = await conversationBindingRepository.rebindConversationUrl(
      request.payload.attemptId,
      normalized,
    );
    return bridgeSuccess(binding);
  } catch (error) {
    return bridgeFailure(
      "CONVERSATION_REBIND_FAILED",
      error instanceof Error ? error.message : "重新绑定对话失败。",
      true,
    );
  }
}

async function handleUrlChanged(
  request: Extract<WorkerRequest, { readonly type: typeof BRIDGE_MESSAGE.chatGPTUrlChanged }>,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  const tabId = sender.tab?.id;
  const senderConversationUrl = sender.tab?.url
    ? ChatGPTAdapter.conversationUrl(sender.tab.url)
    : null;
  const reportedConversationUrl = ChatGPTAdapter.conversationUrl(
    request.payload.conversationUrl,
  );
  if (
    !tabId ||
    !senderConversationUrl ||
    !reportedConversationUrl ||
    senderConversationUrl !== reportedConversationUrl ||
    sender.id !== chrome.runtime.id
  ) {
    return bridgeFailure("CHATGPT_UNTRUSTED_SENDER", "忽略了非绑定 ChatGPT 标签页的消息。", false);
  }
  try {
    const failure = await recordDetectedConversationUrl(
      request.payload.attemptId,
      request.payload.conversationUrl,
      tabId,
    );
    if (failure) return failure;
    void chrome.runtime
      .sendMessage({
        type: BRIDGE_MESSAGE.conversationDetected,
        payload: {
          attemptId: request.payload.attemptId,
          conversationUrl: request.payload.conversationUrl,
          renamed: request.payload.renamed,
          ...(request.payload.renameError ? { renameError: request.payload.renameError } : {}),
        },
      })
      .catch(() => undefined);
    return bridgeSuccess({ recorded: true, renamed: request.payload.renamed });
  } catch (error) {
    return bridgeFailure(
      "CONVERSATION_URL_SAVE_FAILED",
      error instanceof Error ? error.message : "保存 ChatGPT 对话 URL 失败。",
      true,
    );
  }
}

async function handleUrlObserved(
  request: Extract<WorkerRequest, { readonly type: typeof BRIDGE_MESSAGE.chatGPTUrlObserved }>,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  const tabId = sender.tab?.id;
  const senderConversationUrl = sender.tab?.url
    ? ChatGPTAdapter.conversationUrl(sender.tab.url)
    : null;
  const reportedConversationUrl = ChatGPTAdapter.conversationUrl(
    request.payload.conversationUrl,
  );
  if (
    !tabId ||
    !senderConversationUrl ||
    !reportedConversationUrl ||
    senderConversationUrl !== reportedConversationUrl ||
    sender.id !== chrome.runtime.id
  ) {
    return bridgeFailure("CHATGPT_UNTRUSTED_SENDER", "忽略了来源不一致的 ChatGPT 对话 URL。", false);
  }
  try {
    const failure = await recordDetectedConversationUrl(
      request.payload.attemptId,
      reportedConversationUrl,
      tabId,
    );
    return failure ?? bridgeSuccess({ recorded: true });
  } catch (error) {
    return bridgeFailure(
      "CONVERSATION_URL_SAVE_FAILED",
      error instanceof Error ? error.message : "保存 ChatGPT 对话 URL 失败。",
      true,
    );
  }
}

async function finalizeManualSubmissionExclusively(
  attemptId: string,
  handoff: ChatGPTHandoff,
): Promise<ExtensionResponse> {
  try {
    const outbox = await practiceService.getSubmissionOutboxRecord(
      attemptId,
      handoff.requestId,
    );
    const handoffMatches = outbox && outbox.handoff.mode === handoff.mode && (
      handoff.mode === "full-paper" ||
      (outbox.handoff.mode === "single-question" &&
        outbox.handoff.questionId === handoff.questionId)
    );
    if (!handoffMatches || outbox.status === "cancelled") {
      return bridgeFailure(
        "MANUAL_SUBMISSION_REQUEST_MISMATCH",
        "手动发送确认与当前不可变提交快照不一致，已拒绝记录。",
        false,
      );
    }
    const binding = await conversationBindingRepository.getByAttempt(attemptId);
    if (!binding?.conversationUrl) {
      return bridgeFailure(
        "MANUAL_SUBMISSION_CONVERSATION_UNBOUND",
        "新对话尚未完成 URL 绑定，提交状态将在绑定成功后自动重试。",
        true,
      );
    }
    await practiceService.finalizePreparedSubmission(attemptId, handoff.requestId);
    await conversationBindingRepository.touch(attemptId).catch(() => undefined);
    void chrome.runtime
      .sendMessage(manualSubmissionRecordedMessage(attemptId, handoff))
      .catch(() => undefined);
    return bridgeSuccess({ recorded: true });
  } catch (error) {
    return bridgeFailure(
      "MANUAL_SUBMISSION_RECORD_FAILED",
      error instanceof Error ? error.message : "手动发送状态保存失败。",
      true,
    );
  }
}

async function finalizeManualSubmission(
  attemptId: string,
  handoff: ChatGPTHandoff,
): Promise<ExtensionResponse> {
  const release = feedbackGate.tryAcquire(attemptId);
  if (!release) {
    return bridgeFailure(
      "FEEDBACK_SUBMISSION_IN_PROGRESS",
      "该练习已有批改交接正在处理，请等待当前操作完成。",
      false,
    );
  }
  try {
    return await finalizeManualSubmissionExclusively(attemptId, handoff);
  } finally {
    release();
  }
}

async function handleManualSubmissionConfirmed(
  request: Extract<
    WorkerRequest,
    { readonly type: typeof BRIDGE_MESSAGE.manualSubmissionConfirmed }
  >,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  const tabId = sender.tab?.id;
  if (
    !tabId ||
    !sender.tab?.url ||
    !ChatGPTAdapter.isChatGPTUrl(sender.tab.url) ||
    sender.id !== chrome.runtime.id ||
    !(await isAttemptBoundToTab(request.payload.attemptId, tabId))
  ) {
    return bridgeFailure(
      "MANUAL_SUBMISSION_UNTRUSTED_SENDER",
      "忽略了未绑定标签页的手动发送确认。",
      false,
    );
  }
  return finalizeManualSubmission(request.payload.attemptId, request.payload.handoff);
}

async function dispatchRequest(
  request: WorkerRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  const extensionPageSender = !sender.tab || sender.url?.startsWith(chrome.runtime.getURL(""));
  switch (request.type) {
    case "EXAM/EXTRACT":
      if (!extensionPageSender) {
        return bridgeFailure("EXAM_UNTRUSTED_SENDER", "试卷提取只能由扩展侧边栏发起。", false);
      }
      return extractFromActiveTab(request.payload?.windowId);
    case "FEEDBACK/SUBMIT_SINGLE":
    case "FEEDBACK/SUBMIT_FULL":
      return deliverFeedback(request);
    case "FEEDBACK/CONFIRM_MANUAL":
      if (!extensionPageSender) {
        return bridgeFailure(
          "MANUAL_SUBMISSION_UNTRUSTED_SENDER",
          "手动发送确认只能由扩展侧边栏发起。",
          false,
        );
      }
      return finalizeManualSubmission(
        request.payload.attemptId,
        request.payload.handoff.mode === "single-question"
          ? {
              mode: "single-question",
              questionId: request.payload.handoff.questionId,
              requestId: request.payload.requestId,
            }
          : { mode: "full-paper", requestId: request.payload.requestId },
      );
    case "FEEDBACK/CANCEL_PENDING":
      if (!extensionPageSender) {
        return bridgeFailure(
          "CHATGPT_CANCEL_UNTRUSTED_SENDER",
          "取消待发送交接只能由扩展侧边栏发起。",
          false,
        );
      }
      return cancelPendingFeedback(
        request.payload.attemptId,
        request.payload.requestId,
        request.payload.confirmedUnsent,
      );
    case "CHATGPT/FILL_PROMPT":
      return deliverPromptForAttempt(
        request.payload.attemptId,
        request.payload.prompt,
        request.payload.autoSubmit,
      );
    case "CONVERSATION/REBIND":
      return handleRebind(request);
    case BRIDGE_MESSAGE.chatGPTUrlObserved:
      return handleUrlObserved(request, sender);
    case BRIDGE_MESSAGE.manualSubmissionConfirmed:
      return handleManualSubmissionConfirmed(request, sender);
    case BRIDGE_MESSAGE.chatGPTUrlChanged:
      return handleUrlChanged(request, sender);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isWorkerRequest(message)) return false;
  void dispatchRequest(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse(
        bridgeFailure(
          "BACKGROUND_OPERATION_FAILED",
          error instanceof Error ? error.message : "扩展后台操作失败。",
          true,
        ),
      );
    });
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.windowId === "number") {
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  }
  if (typeof tab.id === "number" && tab.url && !ChatGPTAdapter.isChatGPTUrl(tab.url)) {
    void injectExamContentScript(tab.id).catch(() => undefined);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetRemovedTab(tabId);
});
