import { describe, expect, it } from "vitest";
import type { ConversationBinding } from "../../src/types";
import {
  isPreparedOnlyDelivery,
  pendingBindingWithLatestProjectSettings,
  postDeliveryUncertainFailure,
  shouldFocusFeedbackTab,
} from "../../src/background/submission-policy";

describe("feedback handoff policy", () => {
  it("does not treat a prepared-only prompt as an actual submission", () => {
    expect(
      isPreparedOnlyDelivery({
        ok: true,
        data: { attemptId: "attempt-1", tabId: 7, submitted: false },
      }),
    ).toBe(true);
    expect(
      isPreparedOnlyDelivery({
        ok: true,
        data: {
          attemptId: "attempt-1",
          tabId: 7,
          submitted: true,
          conversationUrl: "https://chatgpt.com/c/abc",
          renamed: true,
          responseText: "## 得分\n10 / 20",
        },
      }),
    ).toBe(false);
  });

  it("uses independent focus settings for single-question and full-paper handoffs", () => {
    const settings = {
      autoOpenChatGPT: false,
      autoOpenConversationAfterFullSubmit: true,
    };
    expect(shouldFocusFeedbackTab("single", settings)).toBe(false);
    expect(shouldFocusFeedbackTab("full", settings)).toBe(true);
  });

  it("keeps a delivered submission locked when local persistence fails", () => {
    const failure = postDeliveryUncertainFailure(
      {
        ok: true,
        data: {
          attemptId: "attempt-1",
          tabId: 7,
          submitted: true,
          conversationUrl: "https://chatgpt.com/c/already-sent",
          renamed: true,
          responseText: "## 得分\n10 / 20",
        },
      },
      new Error("IndexedDB transaction failed"),
    );
    expect(failure).toMatchObject({
      ok: false,
      error: { code: "CHATGPT_DELIVERY_UNCERTAIN", retryable: false },
    });
    expect(
      postDeliveryUncertainFailure(
        {
          ok: true,
          data: { attemptId: "attempt-1", tabId: 7, submitted: false },
        },
        new Error("before delivery"),
      ),
    ).toBeNull();
  });

  it("refreshes Project metadata only before a conversation URL is bound", () => {
    const pending: ConversationBinding = {
      schemaVersion: 1,
      attemptId: "attempt-1",
      paperId: "paper-1",
      projectName: "旧 Project",
      projectUrl: "https://chatgpt.com/g/old/project",
      conversationName: "练习一",
      createdAt: 10,
      lastUsedAt: 10,
    };
    expect(
      pendingBindingWithLatestProjectSettings(
        pending,
        { projectName: " 新 Project ", projectUrl: "" },
        20,
      ),
    ).toEqual({
      schemaVersion: 1,
      attemptId: "attempt-1",
      paperId: "paper-1",
      projectName: "新 Project",
      conversationName: "练习一",
      createdAt: 10,
      lastUsedAt: 20,
    });

    expect(
      pendingBindingWithLatestProjectSettings(
        { ...pending, conversationUrl: "https://chatgpt.com/c/already-bound" },
        { projectName: "另一个 Project", projectUrl: "https://chatgpt.com/g/new/project" },
        30,
      ),
    ).toBeNull();
  });
});
