import { describe, expect, it } from "vitest";
import { isWorkerRequest } from "../../src/background/runtime-guards";

describe("background runtime request guards", () => {
  it("validates an optional source window for floating-mode extraction", () => {
    expect(isWorkerRequest({ type: "EXAM/EXTRACT" })).toBe(true);
    expect(isWorkerRequest({
      type: "EXAM/EXTRACT",
      payload: { windowId: 42 },
    })).toBe(true);
    expect(isWorkerRequest({
      type: "EXAM/EXTRACT",
      payload: { windowId: -1 },
    })).toBe(false);
    expect(isWorkerRequest({
      type: "EXAM/EXTRACT",
      payload: { windowId: 42, unexpected: true },
    })).toBe(false);
  });

  it("requires a valid engine-specific model for grading submissions", () => {
    expect(isWorkerRequest({
      type: "FEEDBACK/SUBMIT_SINGLE",
      payload: {
        attemptId: "attempt-1",
        questionId: "q1",
        requestId: "request-1",
        target: { engine: "deepseek-api", model: "deepseek-v4-flash-thinking" },
      },
    })).toBe(true);
    expect(isWorkerRequest({
      type: "FEEDBACK/SUBMIT_FULL",
      payload: {
        attemptId: "attempt-1",
        requestId: "request-1",
        target: { engine: "chatgpt-web", model: "chatgpt-project-default" },
      },
    })).toBe(true);
    expect(isWorkerRequest({
      type: "FEEDBACK/SUBMIT_FULL",
      payload: {
        attemptId: "attempt-1",
        requestId: "request-1",
        target: { engine: "chatgpt-web", model: "deepseek-v4-pro-thinking" },
      },
    })).toBe(false);
    expect(isWorkerRequest({
      type: "FEEDBACK/SUBMIT_FULL",
      payload: { attemptId: "attempt-1", requestId: "request-1" },
    })).toBe(false);
  });

  it("accepts only a well-formed attempt-scoped cancellation request", () => {
    expect(
      isWorkerRequest({
        type: "FEEDBACK/CANCEL_PENDING",
        payload: {
          attemptId: "attempt-1",
          requestId: "request-1",
          confirmedUnsent: false,
        },
      }),
    ).toBe(true);

    const invalidRequests: readonly unknown[] = [
      { type: "FEEDBACK/CANCEL_PENDING" },
      { type: "FEEDBACK/CANCEL_PENDING", payload: null },
      { type: "FEEDBACK/CANCEL_PENDING", payload: {} },
      { type: "FEEDBACK/CANCEL_PENDING", payload: { attemptId: "" } },
      { type: "FEEDBACK/CANCEL_PENDING", payload: { attemptId: 1 } },
      {
        type: "FEEDBACK/CANCEL_PENDING",
        payload: { attemptId: "attempt-1", requestId: "request-1" },
      },
      {
        type: "FEEDBACK/CANCEL_PENDING",
        payload: {
          attemptId: "attempt-1",
          requestId: "request-1",
          confirmedUnsent: "yes",
        },
      },
      {
        type: "FEEDBACK/CANCEL_PENDING",
        payload: { attemptId: "attempt-1", force: true },
      },
      {
        type: "FEEDBACK/CANCEL_PENDING",
        payload: { attemptId: "attempt-1" },
        unexpected: true,
      },
    ];

    for (const request of invalidRequests) {
      expect(isWorkerRequest(request)).toBe(false);
    }
  });
});
