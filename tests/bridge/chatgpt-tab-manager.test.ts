import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingForAttempt,
  isIdleEmptyChatGPTInspection,
  sendPrepare,
} from "../../src/background/chatgpt-tab-manager";
import { BRIDGE_MESSAGE } from "../../src/adapters/bridge-protocol";

describe("ChatGPT tab delivery safety", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never redispatches auto-submit PREPARE when its response is lost", async () => {
    let prepareCalls = 0;
    const sendMessage = vi.fn(async (_tabId: number, message: { readonly type: string }) => {
      if (message.type === BRIDGE_MESSAGE.pingChatGPT) {
        return { ok: true, data: { ready: true } };
      }
      if (message.type === BRIDGE_MESSAGE.inspectChatGPT) {
        return { ok: true, data: { composerState: "empty" } };
      }
      if (message.type === BRIDGE_MESSAGE.prepareChatGPT) {
        prepareCalls += 1;
        throw new Error("The message port closed before a response was received");
      }
      throw new Error("unexpected message");
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      scripting: { executeScript: vi.fn() },
    });

    const result = await sendPrepare(7, {
      attemptId: "attempt-1",
      projectName: "申论训练",
      conversationName: "练习一",
      prompt: "请批改",
      autoSubmit: true,
    });

    expect(prepareCalls).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "CHATGPT_DELIVERY_UNCERTAIN", retryable: false },
    });
  });

  it("reuses only an idle empty inspection and rejects busy tabs", () => {
    expect(isIdleEmptyChatGPTInspection({ composerState: "empty" })).toBe(true);
    expect(isIdleEmptyChatGPTInspection({ composerState: "busy" })).toBe(false);
    expect(isIdleEmptyChatGPTInspection({ composerState: "non-empty" })).toBe(false);
    expect(isIdleEmptyChatGPTInspection(null)).toBe(false);
  });

  it("routes cancellation only to the tab reserved for that attempt", async () => {
    const sendMessage = vi.fn(async (_tabId: number, message: { readonly type: string }) =>
      message.type === BRIDGE_MESSAGE.pingChatGPT
        ? { ok: true, data: { ready: true } }
        : {
            ok: true,
            data: { cancelled: true, tooLate: false, reason: "cancelled" },
          });
    const get = vi.fn(async () => ({
      id: 7,
      status: "complete",
      url: "https://chatgpt.com/c/existing",
    }));
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async () => ({
            "bridge.chatgptTabs.v1": { "attempt-1": 7, "attempt-2": 8 },
          })),
          set: vi.fn(),
        },
      },
      tabs: { get, sendMessage },
    });

    await expect(cancelPendingForAttempt("attempt-1", "request-1")).resolves.toEqual({
      ok: true,
      data: { cancelled: true, tooLate: false, reason: "cancelled" },
    });
    expect(get).toHaveBeenCalledWith(7);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(7, {
      type: BRIDGE_MESSAGE.cancelPendingChatGPT,
      payload: { attemptId: "attempt-1", requestId: "request-1" },
    });
  });

  it("returns not-found without contacting any unrelated tab", async () => {
    const sendMessage = vi.fn();
    const get = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async () => ({
            "bridge.chatgptTabs.v1": { "another-attempt": 8 },
          })),
          set: vi.fn(),
        },
      },
      tabs: { get, sendMessage },
    });

    await expect(cancelPendingForAttempt("attempt-1", "request-1")).resolves.toEqual({
      ok: true,
      data: { cancelled: false, tooLate: false, reason: "not-found" },
    });
    expect(get).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("blocks PREPARE when the tab already has a pending handoff", async () => {
    let prepareCalls = 0;
    const sendMessage = vi.fn(async (_tabId: number, message: { readonly type: string }) => {
      if (message.type === BRIDGE_MESSAGE.pingChatGPT) {
        return { ok: true, data: { ready: true } };
      }
      if (message.type === BRIDGE_MESSAGE.inspectChatGPT) {
        return {
          ok: true,
          data: { composerState: "non-empty", pendingAttemptId: "attempt-1" },
        };
      }
      prepareCalls += 1;
      return { ok: true, data: { attemptId: "attempt-1", submitted: false } };
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      scripting: { executeScript: vi.fn() },
    });

    const result = await sendPrepare(7, {
      attemptId: "attempt-1",
      projectName: "申论训练",
      conversationName: "练习一",
      prompt: "请批改",
      autoSubmit: false,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "CHATGPT_HANDOFF_ALREADY_PENDING", retryable: false },
    });
    expect(prepareCalls).toBe(0);
  });

  it("rejects a pending handoff owned by another attempt as an isolation violation", async () => {
    let prepareCalls = 0;
    const sendMessage = vi.fn(async (_tabId: number, message: { readonly type: string }) => {
      if (message.type === BRIDGE_MESSAGE.pingChatGPT) {
        return { ok: true, data: { ready: true } };
      }
      if (message.type === BRIDGE_MESSAGE.inspectChatGPT) {
        return {
          ok: true,
          data: { composerState: "non-empty", pendingAttemptId: "attempt-2" },
        };
      }
      prepareCalls += 1;
      return { ok: true, data: { attemptId: "attempt-1", submitted: false } };
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      scripting: { executeScript: vi.fn() },
    });

    const result = await sendPrepare(7, {
      attemptId: "attempt-1",
      projectName: "申论训练",
      conversationName: "练习一",
      prompt: "请批改",
      autoSubmit: false,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_ISOLATION_VIOLATION", retryable: false },
    });
    expect(prepareCalls).toBe(0);
  });
});
