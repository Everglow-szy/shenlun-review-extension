import { describe, expect, it } from "vitest";
import {
  BRIDGE_MESSAGE,
  isChatGPTCancelPendingRequest,
  isChatGPTCancelPendingResponse,
  isChatGPTContentRequest,
  isChatGPTPreparePayload,
  isChatGPTPrepareResult,
  isChatGPTUrlChangedMessage,
  isManualSubmissionConfirmedMessage,
  isManualSubmissionRecordedMessage,
  manualSubmissionRecordedMessage,
} from "../../src/adapters/bridge-protocol";

describe("bridge protocol guards", () => {
  it("strictly validates attempt-scoped pending-handoff cancellation", () => {
    const request = {
      type: BRIDGE_MESSAGE.cancelPendingChatGPT,
      payload: { attemptId: "attempt-1", requestId: "request-1" },
    };
    expect(isChatGPTCancelPendingRequest(request)).toBe(true);
    expect(isChatGPTContentRequest(request)).toBe(true);
    expect(
      isChatGPTCancelPendingRequest({
        type: BRIDGE_MESSAGE.cancelPendingChatGPT,
        payload: { attemptId: "   ", requestId: "request-1" },
      }),
    ).toBe(false);
    expect(
      isChatGPTCancelPendingRequest({
        type: BRIDGE_MESSAGE.cancelPendingChatGPT,
        payload: { attemptId: "attempt-1", requestId: "request-1", force: true },
      }),
    ).toBe(false);
    expect(
      isChatGPTCancelPendingRequest({
        type: BRIDGE_MESSAGE.cancelPendingChatGPT,
        payload: { attemptId: "attempt-1", requestId: "request-1" },
        unexpected: true,
      }),
    ).toBe(false);
    const validResults = [
      { cancelled: true, tooLate: false, reason: "cancelled" },
      { cancelled: false, tooLate: false, reason: "not-found" },
      { cancelled: false, tooLate: true, reason: "delivery-in-progress" },
      { cancelled: false, tooLate: true, reason: "send-started" },
    ] as const;
    for (const data of validResults) {
      expect(isChatGPTCancelPendingResponse({ ok: true, data })).toBe(true);
    }
    expect(
      isChatGPTCancelPendingResponse({
        ok: true,
        data: {
          cancelled: true,
          tooLate: true,
          reason: "send-started",
        },
      }),
    ).toBe(false);
    expect(
      isChatGPTCancelPendingResponse({
        ok: true,
        data: {
          cancelled: false,
          tooLate: false,
          reason: "not-found",
          clearedComposer: true,
        },
      }),
    ).toBe(false);
  });

  it("requires attempt-scoped ChatGPT preparation", () => {
    expect(
      isChatGPTPreparePayload({
        attemptId: "attempt-1",
        projectName: "申论训练",
        conversationName: "2026-08-20-试卷",
        prompt: "grade this",
        autoSubmit: false,
      }),
    ).toBe(true);
    expect(
      isChatGPTPreparePayload({
        projectName: "申论训练",
        conversationName: "shared conversation",
        prompt: "grade this",
        autoSubmit: false,
      }),
    ).toBe(false);
  });

  it("validates attempt-scoped handoff metadata and manual confirmations", () => {
    expect(
      isChatGPTPreparePayload({
        attemptId: "attempt-1",
        projectName: "申论训练",
        conversationName: "2026-08-20-试卷",
        prompt: "grade this",
        autoSubmit: false,
        handoff: { mode: "single-question", questionId: "q1", requestId: "request-1" },
      }),
    ).toBe(true);
    expect(
      isManualSubmissionConfirmedMessage({
        type: BRIDGE_MESSAGE.manualSubmissionConfirmed,
        payload: {
          attemptId: "attempt-1",
          handoff: { mode: "full-paper", requestId: "request-1" },
        },
      }),
    ).toBe(true);
    expect(
      isManualSubmissionConfirmedMessage({
        type: BRIDGE_MESSAGE.manualSubmissionConfirmed,
        payload: {
          attemptId: "attempt-1",
          handoff: { mode: "single-question" },
        },
      }),
    ).toBe(false);
  });

  it("constructs and validates the flat manual-submission-recorded event", () => {
    const recorded = manualSubmissionRecordedMessage("attempt-1", {
      mode: "single-question",
      questionId: "q1",
      requestId: "request-1",
    });
    expect(recorded).toEqual({
      type: BRIDGE_MESSAGE.manualSubmissionRecorded,
      payload: {
        attemptId: "attempt-1",
        mode: "single-question",
        questionId: "q1",
        requestId: "request-1",
      },
    });
    expect(isManualSubmissionRecordedMessage(recorded)).toBe(true);
    expect(
      isManualSubmissionRecordedMessage({
        type: BRIDGE_MESSAGE.manualSubmissionRecorded,
        payload: {
          attemptId: "attempt-1",
          handoff: { mode: "single-question", questionId: "q1" },
        },
      }),
    ).toBe(false);
  });

  it("distinguishes prepared-only, submitted, and rename-warning results", () => {
    expect(
      isChatGPTPrepareResult({ attemptId: "attempt-1", submitted: false }),
    ).toBe(true);
    expect(
      isChatGPTPrepareResult({
        attemptId: "attempt-1",
        submitted: true,
        conversationUrl: "https://chatgpt.com/c/abc",
        renamed: true,
        responseText: "## 得分\n10 / 20",
      }),
    ).toBe(true);
    expect(
      isChatGPTPrepareResult({
        attemptId: "attempt-1",
        submitted: true,
        conversationUrl: "https://chatgpt.com/c/abc",
        renamed: false,
      }),
    ).toBe(false);
    expect(
      isChatGPTPrepareResult({
        attemptId: "attempt-1",
        submitted: true,
        conversationUrl: "https://chatgpt.com/c/abc",
        renamed: false,
        renameError: "请手动重命名",
        responseText: "## 得分\n10 / 20",
      }),
    ).toBe(true);
  });

  it("rejects URL notifications that omit rename outcome", () => {
    expect(
      isChatGPTUrlChangedMessage({
        type: BRIDGE_MESSAGE.chatGPTUrlChanged,
        payload: {
          attemptId: "attempt-1",
          conversationUrl: "https://chatgpt.com/c/abc",
        },
      }),
    ).toBe(false);
    expect(
      isChatGPTUrlChangedMessage({
        type: BRIDGE_MESSAGE.chatGPTUrlChanged,
        payload: {
          attemptId: "attempt-1",
          conversationUrl: "https://chatgpt.com/c/abc",
          renamed: false,
          renameError: "请手动重命名",
        },
      }),
    ).toBe(true);
  });
});
