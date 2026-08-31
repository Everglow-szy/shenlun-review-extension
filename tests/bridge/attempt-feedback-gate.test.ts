import { describe, expect, it } from "vitest";
import { AttemptFeedbackGate } from "../../src/background/attempt-feedback-gate";

describe("AttemptFeedbackGate", () => {
  it("rejects concurrent single/full handoffs for one attempt", () => {
    const gate = new AttemptFeedbackGate();
    const releaseSingle = gate.tryAcquire("attempt-1");
    expect(releaseSingle).not.toBeNull();
    expect(gate.isActive("attempt-1")).toBe(true);
    expect(gate.tryAcquire("attempt-1")).toBeNull();

    releaseSingle?.();
    const releaseFull = gate.tryAcquire("attempt-1");
    expect(releaseFull).not.toBeNull();
    releaseFull?.();
    expect(gate.isActive("attempt-1")).toBe(false);
  });

  it("does not block a different attempt", () => {
    const gate = new AttemptFeedbackGate();
    const releaseFirst = gate.tryAcquire("attempt-1");
    const releaseSecond = gate.tryAcquire("attempt-2");
    expect(releaseFirst).not.toBeNull();
    expect(releaseSecond).not.toBeNull();
    expect(gate.isActive("attempt-1")).toBe(true);
    expect(gate.isActive("attempt-2")).toBe(true);
    releaseFirst?.();
    releaseSecond?.();
  });
});
