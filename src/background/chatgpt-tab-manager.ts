import { ChatGPTAdapter } from "../adapters/ChatGPTAdapter";
import {
  BRIDGE_MESSAGE,
  bridgeFailure,
  bridgeSuccess,
  isChatGPTCancelPendingResponse,
  isChatGPTPrepareResult,
  isRecord,
  type BridgeFailure,
  type ChatGPTContentResult,
  type ChatGPTCancelPendingResponse,
  type ChatGPTDeliveryResponse,
  type ChatGPTInspectResult,
  type ChatGPTPreparePayload,
  type ChatGPTPrepareResult,
  type ChatGPTHandoff,
} from "../adapters/bridge-protocol";
import { conversationBindingRepository } from "../database/conversationBindingRepository";
import type { AttemptId, ConversationBinding } from "../types";
import { AsyncSerialQueue } from "./async-serial-queue";

const CHATGPT_HOME = "https://chatgpt.com/";
const CHATGPT_URL_PATTERNS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const TAB_BINDINGS_KEY = "bridge.chatgptTabs.v1";
const SCRIPT_PATH = "assets/chatgpt-content-script.js";

type AttemptTabBindings = Record<AttemptId, number>;

let memoryTabBindings: AttemptTabBindings = {};
const automationQueue = new AsyncSerialQueue();

function isValidTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function loadTabBindings(): Promise<AttemptTabBindings> {
  try {
    const stored = await chrome.storage.session.get(TAB_BINDINGS_KEY);
    const value = stored[TAB_BINDINGS_KEY];
    if (!isRecord(value)) return { ...memoryTabBindings };
    const result: AttemptTabBindings = {};
    for (const [attemptId, tabId] of Object.entries(value)) {
      if (attemptId.trim() && isValidTabId(tabId)) result[attemptId] = tabId;
    }
    memoryTabBindings = result;
  } catch {
    // In-memory state still keeps a live worker safe if storage.session is unavailable.
  }
  return { ...memoryTabBindings };
}

async function saveTabBindings(bindings: AttemptTabBindings): Promise<void> {
  memoryTabBindings = { ...bindings };
  try {
    await chrome.storage.session.set({ [TAB_BINDINGS_KEY]: bindings });
  } catch {
    // The in-memory fallback is sufficient until this worker is suspended.
  }
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function tabIsChatGPT(tab: chrome.tabs.Tab | null): tab is chrome.tabs.Tab & { id: number } {
  return Boolean(tab && isValidTabId(tab.id) && tab.url && ChatGPTAdapter.isChatGPTUrl(tab.url));
}

function validTargetUrl(value: string | undefined): string | null {
  if (!value || !ChatGPTAdapter.isChatGPTUrl(value)) return null;
  return new URL(value).href;
}

async function waitForTabComplete(tabId: number, timeoutMs = 25_000): Promise<chrome.tabs.Tab> {
  const existing = await getTab(tabId);
  if (!existing) throw new Error("ChatGPT 标签页已被关闭。");
  if (existing.status === "complete") return existing;

  return new Promise<chrome.tabs.Tab>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      callback();
    };
    const onUpdated = (
      changedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ): void => {
      if (changedTabId === tabId && changeInfo.status === "complete") finish(() => resolve(tab));
    };
    const onRemoved = (removedTabId: number): void => {
      if (removedTabId === tabId) finish(() => reject(new Error("ChatGPT 标签页已被关闭。")));
    };
    const timeout = globalThis.setTimeout(() => {
      finish(() => reject(new Error("等待 ChatGPT 页面加载超时。")));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // Close the race where loading completed after the first tabs.get() but
    // before onUpdated was registered.
    void getTab(tabId).then((latest) => {
      if (!latest) {
        finish(() => reject(new Error("ChatGPT 标签页已被关闭。")));
      } else if (latest.status === "complete") {
        finish(() => resolve(latest));
      }
    });
  });
}

async function navigateTab(tabId: number, url: string, focusTab: boolean): Promise<chrome.tabs.Tab> {
  const updated = await chrome.tabs.update(tabId, {
    url,
    ...(focusTab ? { active: true } : {}),
  });
  if (!updated) throw new Error("无法更新 ChatGPT 标签页。");
  return waitForTabComplete(tabId);
}

async function activateTab(tab: chrome.tabs.Tab & { id: number }): Promise<void> {
  await chrome.tabs.update(tab.id, { active: true });
  if (isValidTabId(tab.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  }
}

interface ResolvedTab {
  readonly tab: chrome.tabs.Tab & { id: number };
  readonly wasBoundToAttempt: boolean;
}

async function resolveTab(
  payload: ChatGPTPreparePayload,
  focusTab: boolean,
): Promise<ResolvedTab> {
  const bindings = await loadTabBindings();
  const boundTabId = bindings[payload.attemptId];
  if (isValidTabId(boundTabId)) {
    const boundTab = await getTab(boundTabId);
    if (tabIsChatGPT(boundTab)) {
      const readyBoundTab = boundTab.status === "complete"
        ? boundTab
        : await waitForTabComplete(boundTab.id);
      if (!tabIsChatGPT(readyBoundTab)) throw new Error("ChatGPT 标签页导航到了非预期地址。");
      const expectedConversation = payload.conversationUrl
        ? ChatGPTAdapter.conversationUrl(payload.conversationUrl)
        : null;
      const currentConversation = ChatGPTAdapter.conversationUrl(readyBoundTab.url ?? "");
      if (
        expectedConversation &&
        currentConversation !== expectedConversation
      ) {
        const inspection = await inspectChatGPTTab(readyBoundTab);
        if (isIdleEmptyChatGPTInspection(inspection)) {
          const navigated = await navigateTab(readyBoundTab.id, expectedConversation, focusTab);
          if (!tabIsChatGPT(navigated)) throw new Error("ChatGPT 标签页导航到了非预期地址。");
          return { tab: navigated, wasBoundToAttempt: true };
        }
        // Preserve a draft in a stale bound tab; only the temporary tab
        // reservation is dropped. The persisted conversation URL stays intact.
        delete bindings[payload.attemptId];
      } else if (
        !expectedConversation &&
        currentConversation &&
        (await inspectChatGPTTab(readyBoundTab))?.pendingAttemptId !== payload.attemptId
      ) {
        // The user navigated the reserved tab to an unrelated conversation.
        delete bindings[payload.attemptId];
      } else {
        if (focusTab) await activateTab(readyBoundTab);
        return { tab: readyBoundTab, wasBoundToAttempt: true };
      }
    }
    delete bindings[payload.attemptId];
  }

  const chatTabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
  const reservedByOtherAttempts = new Set(
    Object.entries(bindings)
      .filter(([attemptId]) => attemptId !== payload.attemptId)
      .map(([, tabId]) => tabId),
  );
  const expectedConversation = payload.conversationUrl
    ? ChatGPTAdapter.conversationUrl(payload.conversationUrl)
    : null;
  const exactConversationTab = expectedConversation
    ? chatTabs.find(
        (tab) =>
          tabIsChatGPT(tab) &&
          !reservedByOtherAttempts.has(tab.id) &&
          ChatGPTAdapter.conversationUrl(tab.url ?? "") === expectedConversation,
      )
    : undefined;
  let reusableTab = exactConversationTab;
  if (!reusableTab) {
    for (const candidate of chatTabs) {
      if (
        tabIsChatGPT(candidate) &&
        !reservedByOtherAttempts.has(candidate.id) &&
        await tabHasEmptyComposer(candidate)
      ) {
        reusableTab = candidate;
        break;
      }
    }
  }
  const initialUrl =
    validTargetUrl(payload.conversationUrl) ?? validTargetUrl(payload.projectUrl) ?? CHATGPT_HOME;

  let tab: chrome.tabs.Tab & { id: number };
  const reusableCandidate = reusableTab ?? null;
  if (tabIsChatGPT(reusableCandidate)) {
    tab = reusableCandidate;
    const alreadyAtExpectedConversation = Boolean(
      expectedConversation &&
      ChatGPTAdapter.conversationUrl(tab.url ?? "") === expectedConversation,
    );
    if (alreadyAtExpectedConversation) {
      // Query/hash, trailing-slash, and legacy-host differences do not justify a
      // reload. The current composer may contain a draft that must be preserved.
      if (focusTab) await activateTab(tab);
      if (tab.status !== "complete") tab = (await waitForTabComplete(tab.id)) as typeof tab;
    } else if (tab.url !== initialUrl) {
      const navigated = await navigateTab(tab.id, initialUrl, focusTab);
      if (!tabIsChatGPT(navigated)) throw new Error("ChatGPT 标签页导航到了非预期地址。");
      tab = navigated;
    } else {
      if (focusTab) await activateTab(tab);
      if (tab.status !== "complete") tab = (await waitForTabComplete(tab.id)) as typeof tab;
    }
  } else {
    const created = await chrome.tabs.create({ url: initialUrl, active: focusTab });
    if (!tabIsChatGPT(created)) throw new Error("无法创建 ChatGPT 标签页。");
    tab = created.status === "complete" ? created : ((await waitForTabComplete(created.id)) as typeof created);
  }

  bindings[payload.attemptId] = tab.id;
  await saveTabBindings(bindings);
  return { tab, wasBoundToAttempt: false };
}

function isContentResult(value: unknown): value is ChatGPTContentResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) {
    return (
      isRecord(value.error) &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string" &&
      typeof value.error.retryable === "boolean"
    );
  }
  return isChatGPTPrepareResult(value.data);
}

async function ensureChatGPTScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: BRIDGE_MESSAGE.pingChatGPT });
    return;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: [SCRIPT_PATH] });
    // Injection is idempotent; require a positive ping before the one-shot
    // PREPARE request is allowed onto the message channel.
    await chrome.tabs.sendMessage(tabId, { type: BRIDGE_MESSAGE.pingChatGPT });
  }
}

async function inspectChatGPTTab(
  tab: chrome.tabs.Tab & { id: number },
): Promise<ChatGPTInspectResult | null> {
  try {
    if (tab.status !== "complete") await waitForTabComplete(tab.id);
    await ensureChatGPTScript(tab.id);
    const response: unknown = await chrome.tabs.sendMessage(tab.id, {
      type: BRIDGE_MESSAGE.inspectChatGPT,
    });
    return parseChatGPTInspection(response);
  } catch {
    return null;
  }
}

function parseChatGPTInspection(value: unknown): ChatGPTInspectResult | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) return null;
  const composerState = value.data.composerState;
  if (
    composerState !== "empty" &&
    composerState !== "non-empty" &&
    composerState !== "busy" &&
    composerState !== "unavailable"
  ) return null;
  const pendingAttemptId = value.data.pendingAttemptId;
  if (pendingAttemptId !== undefined && typeof pendingAttemptId !== "string") return null;
  const pendingRequestId = value.data.pendingRequestId;
  if (pendingRequestId !== undefined && typeof pendingRequestId !== "string") return null;
  return {
    composerState,
    ...(pendingAttemptId ? { pendingAttemptId } : {}),
    ...(pendingRequestId ? { pendingRequestId } : {}),
  };
}

async function tabHasEmptyComposer(tab: chrome.tabs.Tab & { id: number }): Promise<boolean> {
  return isIdleEmptyChatGPTInspection(await inspectChatGPTTab(tab));
}

/** Only an idle, genuinely empty ChatGPT page is safe to navigate/reuse. */
export function isIdleEmptyChatGPTInspection(
  inspection: ChatGPTInspectResult | null,
): boolean {
  return inspection?.composerState === "empty";
}

export async function sendPrepare(
  tabId: number,
  payload: ChatGPTPreparePayload,
): Promise<ChatGPTContentResult> {
  let setupError: unknown;
  let ready = false;
  // Ping/injection is an idempotent pre-delivery phase, so it is safe to retry.
  for (let attempt = 0; attempt < 2 && !ready; attempt += 1) {
    try {
      await ensureChatGPTScript(tabId);
      ready = true;
    } catch (error) {
      setupError = error;
      if (attempt === 0) await waitForTabComplete(tabId).catch(() => undefined);
    }
  }
  if (!ready) {
    return bridgeFailure(
      "CHATGPT_CONTENT_UNREACHABLE",
      setupError instanceof Error ? setupError.message : "无法连接 ChatGPT 页面。",
      true,
    );
  }

  let inspection: ChatGPTInspectResult | null = null;
  try {
    inspection = parseChatGPTInspection(
      await chrome.tabs.sendMessage(tabId, { type: BRIDGE_MESSAGE.inspectChatGPT }),
    );
  } catch (error) {
    return bridgeFailure(
      "CHATGPT_INSPECTION_FAILED",
      error instanceof Error ? error.message : "无法确认 ChatGPT 页面交接状态。",
      true,
    );
  }
  if (!inspection) {
    return bridgeFailure(
      "CHATGPT_INSPECTION_FAILED",
      "ChatGPT 页面返回了无法识别的交接状态，请刷新页面后重试。",
      true,
    );
  }
  if (inspection.pendingAttemptId === payload.attemptId) {
    return bridgeFailure(
      "CHATGPT_HANDOFF_ALREADY_PENDING",
      "该练习已有 Prompt 等待手动发送；请先发送或取消原交接。",
      false,
    );
  }
  if (inspection.pendingAttemptId) {
    return bridgeFailure(
      "CONVERSATION_ISOLATION_VIOLATION",
      "该 ChatGPT 标签页正在等待另一练习的手动发送，已阻止覆盖。",
      false,
    );
  }

  // PREPARE may fill and auto-submit before the response crosses the extension
  // message channel. Once dispatched it is non-idempotent and must never be
  // retried when delivery/response status is unknown.
  try {
    const response: unknown = await chrome.tabs.sendMessage(tabId, {
      type: BRIDGE_MESSAGE.prepareChatGPT,
      payload,
    });
    if (isContentResult(response)) return response;
  } catch {
    // Fall through to the same uncertainty response as an invalid/lost reply.
  }
  return bridgeFailure(
    "CHATGPT_DELIVERY_UNCERTAIN",
    "请求可能已由 ChatGPT 页面处理，但扩展未收到确认响应。请先在对应对话中核对，切勿直接重试，以免重复发送。",
    false,
  );
}

async function persistConversationUrl(
  attemptId: AttemptId,
  conversationUrl: string,
): Promise<BridgeFailure | null> {
  const normalized = ChatGPTAdapter.conversationUrl(conversationUrl);
  if (!normalized) {
    return bridgeFailure("CHATGPT_INVALID_CONVERSATION_URL", "未识别到有效的 ChatGPT 对话 URL。", false);
  }
  const binding = await conversationBindingRepository.getByAttempt(attemptId);
  if (!binding) {
    return bridgeFailure("CONVERSATION_BINDING_NOT_FOUND", "当前练习没有对话绑定。", false);
  }
  if (binding.conversationUrl && ChatGPTAdapter.conversationUrl(binding.conversationUrl) !== normalized) {
    return bridgeFailure(
      "CONVERSATION_ISOLATION_VIOLATION",
      "检测到当前练习试图切换到另一对话；如确需更换，请使用“重新绑定对话”。",
      false,
    );
  }
  if (binding.conversationUrl) await conversationBindingRepository.touch(attemptId);
  else await conversationBindingRepository.updateConversationUrl(attemptId, normalized);
  return null;
}

function payloadFromBinding(
  binding: ConversationBinding,
  prompt: string,
  autoSubmit: boolean,
  handoff?: ChatGPTHandoff,
  conversationName?: string,
): ChatGPTPreparePayload {
  const base = {
    attemptId: binding.attemptId,
    projectName: binding.projectName,
    conversationName: conversationName ?? binding.conversationName,
    prompt,
    autoSubmit,
    ...(handoff ? { handoff } : {}),
  } as const;
  return {
    ...base,
    ...(binding.projectUrl ? { projectUrl: binding.projectUrl } : {}),
    ...(binding.conversationUrl ? { conversationUrl: binding.conversationUrl } : {}),
  };
}

export async function deliverPromptForAttempt(
  attemptId: AttemptId,
  prompt: string,
  autoSubmit: boolean,
  options: DeliveryOptions = {},
): Promise<ChatGPTDeliveryResponse> {
  const binding = await conversationBindingRepository.getByAttempt(attemptId);
  if (!binding || binding.attemptId !== attemptId) {
    return bridgeFailure(
      "CONVERSATION_BINDING_NOT_FOUND",
      "当前练习没有独立的 ChatGPT 对话绑定，请重新创建或恢复练习。",
      false,
    );
  }
  return deliverPreparedPrompt(
    payloadFromBinding(binding, prompt, autoSubmit, options.handoff, options.conversationName),
    options,
  );
}

export interface DeliveryOptions {
  /** Whether this hand-off should steal focus from the user's current tab/window. */
  readonly focusTab?: boolean;
  readonly handoff?: ChatGPTHandoff;
  readonly conversationName?: string;
}

async function deliverPreparedPrompt(
  initialPayload: ChatGPTPreparePayload,
  options: DeliveryOptions = {},
): Promise<ChatGPTDeliveryResponse> {
  return automationQueue.run(() => deliverPreparedPromptExclusively(initialPayload, options));
}

async function deliverPreparedPromptExclusively(
  initialPayload: ChatGPTPreparePayload,
  options: DeliveryOptions,
): Promise<ChatGPTDeliveryResponse> {
  if (!initialPayload.prompt.trim()) {
    return bridgeFailure("CHATGPT_EMPTY_PROMPT", "批改提示词为空。", false);
  }
  if (initialPayload.projectUrl && !validTargetUrl(initialPayload.projectUrl)) {
    return bridgeFailure("CHATGPT_INVALID_PROJECT_URL", "ChatGPT Project URL 无效。", false);
  }
  if (initialPayload.conversationUrl && !ChatGPTAdapter.conversationUrl(initialPayload.conversationUrl)) {
    return bridgeFailure("CHATGPT_INVALID_CONVERSATION_URL", "ChatGPT 对话 URL 无效。", false);
  }

  let deliveryConfirmed = false;
  try {
    const resolved = await resolveTab(initialPayload, options.focusTab ?? true);
    let payload = initialPayload;
    if (!payload.conversationUrl && resolved.wasBoundToAttempt) {
      const detected = ChatGPTAdapter.conversationUrl(resolved.tab.url ?? "");
      if (detected) {
        const failure = await persistConversationUrl(payload.attemptId, detected);
        if (failure) return failure;
        payload = { ...payload, conversationUrl: detected };
      }
    }

    const contentResult = await sendPrepare(resolved.tab.id, payload);
    if (!contentResult.ok) return contentResult;
    deliveryConfirmed = contentResult.data.submitted;
    if (contentResult.data.attemptId !== payload.attemptId) {
      return contentResult.data.submitted
        ? bridgeFailure(
            "CHATGPT_DELIVERY_UNCERTAIN",
            "ChatGPT 页面报告已发送，但返回了其他练习的 attemptId。请勿重试，并人工核对目标对话。",
            false,
          )
        : bridgeFailure(
            "CONVERSATION_ISOLATION_VIOLATION",
            "ChatGPT 页面返回了其他练习的 attemptId。",
            false,
          );
    }

    if (contentResult.data.conversationUrl) {
      const failure = await persistConversationUrl(payload.attemptId, contentResult.data.conversationUrl);
      if (failure) {
        return contentResult.data.submitted
          ? bridgeFailure(
              "CHATGPT_DELIVERY_UNCERTAIN",
              `Prompt 已发送，但对话 URL 未能持久化（${failure.error.message}）。请勿重复提交并先核对绑定。`,
              false,
            )
          : failure;
      }
    }
    const data: ChatGPTPrepareResult = contentResult.data;
    if (data.submitted && !data.renamed) {
      void chrome.runtime
        .sendMessage({
          type: BRIDGE_MESSAGE.conversationDetected,
          payload: {
            attemptId: data.attemptId,
            conversationUrl: data.conversationUrl,
            renamed: false,
            renameError: data.renameError,
          },
        })
        .catch(() => undefined);
    }
    return bridgeSuccess({ ...data, tabId: resolved.tab.id });
  } catch (error) {
    if (deliveryConfirmed) {
      return bridgeFailure(
        "CHATGPT_DELIVERY_UNCERTAIN",
        `Prompt 已发送，但后续绑定处理未完成（${error instanceof Error ? error.message : "未知错误"}）。请勿重复提交。`,
        false,
      );
    }
    return bridgeFailure(
      "CHATGPT_TAB_FAILED",
      error instanceof Error ? error.message : "无法打开 ChatGPT 标签页。",
      true,
    );
  }
}

export async function recordDetectedConversationUrl(
  attemptId: AttemptId,
  conversationUrl: string,
  senderTabId: number,
): Promise<BridgeFailure | null> {
  const bindings = await loadTabBindings();
  if (bindings[attemptId] !== senderTabId) {
    return bridgeFailure(
      "CONVERSATION_ISOLATION_VIOLATION",
      "对话 URL 来自未绑定到该练习的标签页。",
      false,
    );
  }
  return persistConversationUrl(attemptId, conversationUrl);
}

export async function isAttemptBoundToTab(
  attemptId: AttemptId,
  tabId: number,
): Promise<boolean> {
  const bindings = await loadTabBindings();
  return bindings[attemptId] === tabId;
}

/**
 * Cancels only the in-page one-shot manual handoff already reserved for this
 * attempt. It deliberately never resolves, creates, activates, or navigates a tab.
 */
export async function cancelPendingForAttempt(
  attemptId: AttemptId,
  requestId: string,
): Promise<ChatGPTCancelPendingResponse> {
  const bindings = await loadTabBindings();
  const tabId = bindings[attemptId];
  if (!isValidTabId(tabId)) {
    return bridgeSuccess({ cancelled: false, tooLate: false, reason: "not-found" });
  }

  const tab = await getTab(tabId);
  if (!tabIsChatGPT(tab)) {
    delete bindings[attemptId];
    await saveTabBindings(bindings);
    return bridgeSuccess({ cancelled: false, tooLate: false, reason: "not-found" });
  }

  try {
    await ensureChatGPTScript(tabId);
    const response: unknown = await chrome.tabs.sendMessage(tabId, {
      type: BRIDGE_MESSAGE.cancelPendingChatGPT,
      payload: { attemptId, requestId },
    });
    if (isChatGPTCancelPendingResponse(response)) return response;
    return bridgeFailure(
      "CHATGPT_CANCEL_INVALID_RESPONSE",
      "ChatGPT 页面返回了无法识别的取消结果，请刷新页面后重试。",
      true,
    );
  } catch (error) {
    return bridgeFailure(
      "CHATGPT_CANCEL_UNREACHABLE",
      error instanceof Error ? error.message : "无法连接已预留的 ChatGPT 标签页。",
      true,
    );
  }
}

export async function forgetRemovedTab(tabId: number): Promise<void> {
  const bindings = await loadTabBindings();
  let changed = false;
  for (const [attemptId, boundTabId] of Object.entries(bindings)) {
    if (boundTabId === tabId) {
      delete bindings[attemptId];
      changed = true;
    }
  }
  if (changed) await saveTabBindings(bindings);
}
