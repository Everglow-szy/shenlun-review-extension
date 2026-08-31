import { describe, expect, it } from "vitest";
import {
  AttemptTimerCoordinator,
  checkpointTimer,
  createTimerCoordinatorSnapshot,
  createTimerState,
  getElapsedSeconds,
  pauseTimer,
} from "../../src/services/timerService";

describe("persistent timer helpers", () => {
  it("survives a checkpoint and reconstruction while running", () => {
    const initial = createTimerState(1_000, true);
    const checkpoint = checkpointTimer(initial, 8_500);
    expect(checkpoint.accumulatedMilliseconds).toBe(7_500);
    expect(checkpoint.runningSince).toBe(8_500);
    expect(getElapsedSeconds(checkpoint, 11_000)).toBe(10);
    expect(getElapsedSeconds(pauseTimer(checkpoint, 11_000), 99_000)).toBe(10);
  });

  it("keeps the paper running when switching active questions", () => {
    const coordinator = new AttemptTimerCoordinator(
      createTimerCoordinatorSnapshot(["q1", "q2"], "q1", 0, true),
    );
    coordinator.switchQuestion("q2", 5_000);
    expect(coordinator.getQuestionElapsedSeconds("q1", 9_000)).toBe(5);
    expect(coordinator.getQuestionElapsedSeconds("q2", 9_000)).toBe(4);
    expect(coordinator.getAttemptElapsedSeconds(9_000)).toBe(9);

    coordinator.pause(10_000);
    expect(coordinator.getAttemptElapsedSeconds(20_000)).toBe(10);
    expect(coordinator.getQuestionElapsedSeconds("q2", 20_000)).toBe(5);
    coordinator.resume(20_000);
    expect(coordinator.getAttemptElapsedSeconds(22_000)).toBe(12);
  });

  it("freezes a submitted question while the paper timer continues", () => {
    const coordinator = new AttemptTimerCoordinator(
      createTimerCoordinatorSnapshot(["q1", "q2"], "q1", 0, true),
    );
    coordinator.pauseActiveQuestion(5_000);
    expect(coordinator.getQuestionElapsedSeconds("q1", 12_000)).toBe(5);
    expect(coordinator.getAttemptElapsedSeconds(12_000)).toBe(12);

    coordinator.switchQuestion("q2", 12_000, false);
    expect(coordinator.getQuestionElapsedSeconds("q2", 20_000)).toBe(0);
    expect(coordinator.getAttemptElapsedSeconds(20_000)).toBe(20);

    coordinator.resumeActiveQuestion(20_000);
    expect(coordinator.getQuestionElapsedSeconds("q2", 23_000)).toBe(3);
  });

  it("normalizes a legacy snapshot whose paper is paused but active question is running", () => {
    const coordinator = new AttemptTimerCoordinator({
      attemptTimer: createTimerState(0, false),
      questionTimers: { q1: createTimerState(0, true) },
      activeQuestionId: "q1",
      manuallyPaused: true,
    });

    coordinator.pause(5_000);
    expect(coordinator.getAttemptElapsedSeconds(20_000)).toBe(0);
    expect(coordinator.getQuestionElapsedSeconds("q1", 20_000)).toBe(5);
  });
});
