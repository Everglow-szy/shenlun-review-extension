/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"https://chatgpt.com/c/conversation-123"}
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_MESSAGE } from "../../src/adapters/bridge-protocol";

type ContentListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

describe("ChatGPT pending handoff cancellation", () => {
  let listener: ContentListener;
  let runtimeSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML =
      '<main><div id="prompt-textarea" contenteditable="true" role="textbox"></div></main>';
    delete (window as Window & { __shenlunChatGPTBridgeInstalled?: boolean })
      .__shenlunChatGPTBridgeInstalled;
    runtimeSendMessage = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: vi.fn((registered: ContentListener) => {
            listener = registered;
          }),
        },
        sendMessage: runtimeSendMessage,
      },
    });
    await import("../../src/content/chatgpt-content-script");
  });

  async function dispatch(message: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let responded = false;
      const keepChannel = listener(message, {} as chrome.runtime.MessageSender, (response) => {
        responded = true;
        resolve(response);
      });
      if (keepChannel !== true && !responded) {
        reject(new Error("Content listener did not respond"));
      }
    });
  }

  it("disarms only the matching attempt without changing the page or composer", async () => {
    const initialUrl = window.location.href;
    await expect(
      dispatch({
        type: BRIDGE_MESSAGE.prepareChatGPT,
        payload: {
          attemptId: "attempt-1",
          projectName: "申论训练",
          conversationName: "练习一",
          conversationUrl: "https://chatgpt.com/c/conversation-123",
          prompt: "prepared prompt",
          autoSubmit: false,
          handoff: { mode: "single-question", questionId: "q1", requestId: "request-1" },
        },
      }),
    ).resolves.toMatchObject({ ok: true, data: { submitted: false } });

    const composer = document.querySelector<HTMLElement>("#prompt-textarea");
    expect(composer?.textContent).toBe("prepared prompt");
    await expect(
      dispatch({
        type: BRIDGE_MESSAGE.cancelPendingChatGPT,
        payload: { attemptId: "attempt-2", requestId: "request-1" },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { cancelled: false, tooLate: false, reason: "not-found" },
    });
    await expect(dispatch({ type: BRIDGE_MESSAGE.inspectChatGPT })).resolves.toMatchObject({
      ok: true,
      data: { pendingAttemptId: "attempt-1", pendingRequestId: "request-1" },
    });

    await expect(
      dispatch({
        type: BRIDGE_MESSAGE.cancelPendingChatGPT,
        payload: { attemptId: "attempt-1", requestId: "request-1" },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { cancelled: true, tooLate: false, reason: "cancelled" },
    });
    const inspection = await dispatch({ type: BRIDGE_MESSAGE.inspectChatGPT });
    expect(inspection).toEqual({
      ok: true,
      data: { composerState: "non-empty" },
    });
    expect(composer?.textContent).toBe("prepared prompt");
    expect(window.location.href).toBe(initialUrl);
    expect(runtimeSendMessage).not.toHaveBeenCalled();
  });

  it("reports send-started and keeps the watcher armed after a send gesture", async () => {
    await dispatch({
      type: BRIDGE_MESSAGE.prepareChatGPT,
      payload: {
        attemptId: "attempt-1",
        projectName: "申论训练",
        conversationName: "练习一",
        conversationUrl: "https://chatgpt.com/c/conversation-123",
        prompt: "prepared prompt",
        autoSubmit: false,
        handoff: { mode: "single-question", questionId: "q1", requestId: "request-1" },
      },
    });
    const sendButton = document.createElement("button");
    sendButton.dataset.testid = "send-button";
    document.body.append(sendButton);
    sendButton.click();

    await expect(
      dispatch({
        type: BRIDGE_MESSAGE.cancelPendingChatGPT,
        payload: { attemptId: "attempt-1", requestId: "request-1" },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { cancelled: false, tooLate: true, reason: "send-started" },
    });
    await expect(dispatch({ type: BRIDGE_MESSAGE.inspectChatGPT })).resolves.toMatchObject({
      ok: true,
      data: { pendingAttemptId: "attempt-1", pendingRequestId: "request-1" },
    });
    expect(document.querySelector("#prompt-textarea")?.textContent).toBe("prepared prompt");
    expect(runtimeSendMessage).not.toHaveBeenCalled();
  });

  it("rejects a second PREPARE without disarming the existing handoff", async () => {
    const firstRequest = {
      type: BRIDGE_MESSAGE.prepareChatGPT,
      payload: {
        attemptId: "attempt-1",
        projectName: "申论训练",
        conversationName: "练习一",
        conversationUrl: "https://chatgpt.com/c/conversation-123",
        prompt: "first prompt",
        autoSubmit: false,
        handoff: {
          mode: "single-question" as const,
          questionId: "q1",
          requestId: "request-1",
        },
      },
    };
    await dispatch(firstRequest);

    await expect(
      dispatch({
        ...firstRequest,
        payload: { ...firstRequest.payload, prompt: "second prompt" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CHATGPT_HANDOFF_ALREADY_PENDING", retryable: false },
    });
    await expect(dispatch({ type: BRIDGE_MESSAGE.inspectChatGPT })).resolves.toMatchObject({
      ok: true,
      data: { pendingAttemptId: "attempt-1", pendingRequestId: "request-1" },
    });
    expect(document.querySelector("#prompt-textarea")?.textContent).toBe("first prompt");
  });

  it("returns the completed assistant response for an automatic background submission", async () => {
    runtimeSendMessage.mockResolvedValue({ ok: true });
    const link = document.createElement("a");
    link.href = "/c/conversation-123";
    link.textContent = "测试申论卷-申论批改";
    document.body.prepend(link);
    const sendButton = document.createElement("button");
    sendButton.dataset.testid = "send-button";
    sendButton.addEventListener("click", () => {
      const composer = document.querySelector<HTMLElement>("#prompt-textarea");
      if (composer) composer.textContent = "";
      const response = document.createElement("div");
      response.dataset.messageAuthorRole = "assistant";
      response.innerHTML = '<div class="markdown">## 得分\n18 / 20\n\n## 修改建议\n补充材料依据。</div>';
      document.querySelector("main")?.append(response);
    });
    document.body.append(sendButton);

    await expect(dispatch({
      type: BRIDGE_MESSAGE.prepareChatGPT,
      payload: {
        attemptId: "attempt-auto",
        projectName: "申论训练",
        conversationName: "测试申论卷-申论批改",
        conversationUrl: "https://chatgpt.com/c/conversation-123",
        prompt: "automatic prompt",
        autoSubmit: true,
        handoff: { mode: "single-question", questionId: "q1", requestId: "request-auto" },
      },
    })).resolves.toMatchObject({
      ok: true,
      data: {
        submitted: true,
        renamed: true,
        responseText: expect.stringContaining("18 / 20"),
      },
    });
  });
});
