import { describe, expect, it } from "vitest";
import { countShenlunCharacters } from "../../src/services";
import {
  cachePendingDraft,
  cachePendingTimerCheckpoint,
  clearPendingDraftIfSaved,
  clearPendingTimerCheckpointIfSaved,
  formatElapsed,
  formatShortElapsed,
  mergePendingDraftAnswers,
  mergeUnsavedAnswerText,
  questionDisplayTitle,
  readPendingTimerCheckpoint,
} from "../../src/sidepanel/utils";

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function timerCheckpoint(
  checkpointedAt: number,
): Parameters<typeof cachePendingTimerCheckpoint>[2] {
  return {
    attemptTimer: {
      schemaVersion: 1,
      accumulatedMilliseconds: checkpointedAt * 10,
      runningSince: checkpointedAt,
      checkpointedAt,
    },
    questionTimers: {
      q1: {
        schemaVersion: 1,
        accumulatedMilliseconds: checkpointedAt * 5,
        runningSince: checkpointedAt,
        checkpointedAt,
      },
    },
    activeQuestionId: "q1",
    manuallyPaused: false,
  };
}

describe("side panel formatting", () => {
  it("formats paper and question elapsed time", () => {
    expect(formatElapsed(0)).toBe("00:00:00");
    expect(formatElapsed(3_872.9)).toBe("01:04:32");
    expect(formatShortElapsed(1_122)).toBe("18:42");
    expect(formatShortElapsed(3_661)).toBe("01:01:01");
  });

  it("uses a stable fallback for missing question titles", () => {
    expect(questionDisplayTitle(1, "  ")).toBe("第 2 题");
    expect(questionDisplayTitle(0, "概括主要问题")).toBe("概括主要问题");
  });
});

describe("live answer count", () => {
  it("counts Unicode code points and ignores whitespace", () => {
    expect(countShenlunCharacters("治 理\nA1，。\t𠮷")).toBe(7);
  });
});

describe("repository refresh draft protection", () => {
  it("keeps pending textarea text while accepting refreshed metadata", () => {
    const refreshed = [
      { questionId: "q1", userAnswer: "旧草稿", status: "submitted" },
      { questionId: "q2", userAnswer: "数据库答案", status: "answered" },
    ];
    const live = [{ questionId: "q1", userAnswer: "最后 700ms 输入" }];

    expect(mergeUnsavedAnswerText(refreshed, live)).toEqual([
      { questionId: "q1", userAnswer: "最后 700ms 输入", status: "submitted" },
      { questionId: "q2", userAnswer: "数据库答案", status: "answered" },
    ]);
  });

  it("recovers the synchronous debounce mirror after an abrupt panel close", () => {
    const storage = createMemoryStorage();
    cachePendingDraft(storage, "attempt-a", "q1", "最后一个字");

    expect(mergePendingDraftAnswers(storage, "attempt-a", [
      { questionId: "q1", userAnswer: "数据库旧值", status: "unanswered" },
      { questionId: "q2", userAnswer: "另一题", status: "answered" },
    ])).toEqual([
      { questionId: "q1", userAnswer: "最后一个字", status: "unanswered" },
      { questionId: "q2", userAnswer: "另一题", status: "answered" },
    ]);
    expect(mergePendingDraftAnswers(storage, "attempt-b", [
      { questionId: "q1", userAnswer: "另一练习的答案" },
    ])[0]?.userAnswer).toBe("另一练习的答案");
  });

  it("clears only the exact draft saved to IndexedDB", () => {
    const storage = createMemoryStorage();
    cachePendingDraft(storage, "attempt-a", "q1", "较新输入");
    clearPendingDraftIfSaved(storage, "attempt-a", "q1", "较旧输入");
    expect(mergePendingDraftAnswers(storage, "attempt-a", [
      { questionId: "q1", userAnswer: "较旧输入" },
    ])[0]?.userAnswer).toBe("较新输入");

    clearPendingDraftIfSaved(storage, "attempt-a", "q1", "较新输入");
    expect(mergePendingDraftAnswers(storage, "attempt-a", [
      { questionId: "q1", userAnswer: "数据库已同步" },
    ])[0]?.userAnswer).toBe("数据库已同步");
  });
});

describe("timer checkpoint write-ahead mirror", () => {
  it("isolates checkpoints by Attempt", () => {
    const storage = createMemoryStorage();
    const snapshotA = timerCheckpoint(100);
    const snapshotB = timerCheckpoint(200);
    cachePendingTimerCheckpoint(storage, "attempt-a", snapshotA);
    cachePendingTimerCheckpoint(storage, "attempt-b", snapshotB);

    expect(readPendingTimerCheckpoint(storage, "attempt-a")).toEqual({
      attemptId: "attempt-a",
      ...snapshotA,
    });
    expect(readPendingTimerCheckpoint(storage, "attempt-b")).toEqual({
      attemptId: "attempt-b",
      ...snapshotB,
    });

    clearPendingTimerCheckpointIfSaved(storage, "attempt-a", snapshotA);
    expect(readPendingTimerCheckpoint(storage, "attempt-a")).toBeNull();
    expect(readPendingTimerCheckpoint(storage, "attempt-b")?.attemptTimer).toEqual(
      snapshotB.attemptTimer,
    );
  });

  it("rejects malformed, mismatched, and internally inconsistent records", () => {
    const storage = createMemoryStorage();
    const key = `shenlun.pendingTimer.v1:${encodeURIComponent("attempt-a")}`;

    storage.setItem(key, "not-json");
    expect(readPendingTimerCheckpoint(storage, "attempt-a")).toBeNull();

    storage.setItem(key, JSON.stringify({
      attemptId: "attempt-b",
      snapshot: timerCheckpoint(100),
    }));
    expect(readPendingTimerCheckpoint(storage, "attempt-a")).toBeNull();

    storage.setItem(key, JSON.stringify({
      attemptId: "attempt-a",
      snapshot: {
        ...timerCheckpoint(100),
        attemptTimer: { ...timerCheckpoint(100).attemptTimer, runningSince: "yesterday" },
      },
    }));
    expect(readPendingTimerCheckpoint(storage, "attempt-a")).toBeNull();

    storage.setItem(key, JSON.stringify({
      attemptId: "attempt-a",
      snapshot: { ...timerCheckpoint(100), activeQuestionId: "unknown-question" },
    }));
    expect(readPendingTimerCheckpoint(storage, "attempt-a")).toBeNull();
  });

  it("does not let an older IndexedDB completion clear a newer checkpoint", () => {
    const storage = createMemoryStorage();
    const older = timerCheckpoint(100);
    const newer = timerCheckpoint(200);
    cachePendingTimerCheckpoint(storage, "attempt-a", older);
    cachePendingTimerCheckpoint(storage, "attempt-a", newer);

    clearPendingTimerCheckpointIfSaved(storage, "attempt-a", older);
    expect(readPendingTimerCheckpoint(storage, "attempt-a")).toEqual({
      attemptId: "attempt-a",
      ...newer,
    });

    clearPendingTimerCheckpointIfSaved(storage, "attempt-a", {
      ...newer,
      questionTimers: { q1: { ...newer.questionTimers.q1! } },
    });
    expect(readPendingTimerCheckpoint(storage, "attempt-a")).toBeNull();
  });
});
