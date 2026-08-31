import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import {
  DATABASE_VERSION,
  STORE_NAMES,
  openShenlunDatabase,
  requestToPromise,
} from "../../src/database/indexedDB";
import { PracticeService } from "../../src/services/practiceService";
import type {
  CreatePaperDefinitionInput,
  PersistedTimerState,
  QuestionSnapshot,
} from "../../src/types";

const openDatabases: IDBDatabase[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    database.close();
  }
});

const paperInput: CreatePaperDefinitionInput = {
  paperName: "Outbox 回归卷",
  paperSource: "example.test",
  sourceUrl: "https://example.test/outbox-paper",
  questions: [
    {
      questionId: "q1",
      index: 0,
      title: "第一题",
      questionText: "概括问题。",
      materials: ["材料一"],
      score: 20,
      wordLimit: 200,
      referenceAnswer: "参考一",
    },
    {
      questionId: "q2",
      index: 1,
      title: "第二题",
      questionText: "提出对策。",
      materials: ["材料二"],
      score: 30,
      wordLimit: 300,
      referenceAnswer: "参考二",
    },
  ],
};

function timer(
  accumulatedMilliseconds: number,
  runningSince: number | null,
  checkpointedAt: number,
): PersistedTimerState {
  return {
    schemaVersion: 1,
    accumulatedMilliseconds,
    runningSince,
    checkpointedAt,
  };
}

function snapshot(
  questionId: string,
  userAnswer: string,
  elapsedSeconds: number,
  timerState: PersistedTimerState,
): QuestionSnapshot {
  return { questionId, userAnswer, elapsedSeconds, timer: timerState };
}

async function createService(name: string): Promise<{
  readonly database: IDBDatabase;
  readonly service: PracticeService;
  readonly attemptId: string;
}> {
  const database = await openShenlunDatabase({ factory: new IDBFactory(), name });
  openDatabases.push(database);
  const service = new PracticeService(() => Promise.resolve(database));
  const paper = await service.ingestPaper(paperInput);
  const bundle = await service.createAttempt({ paperId: paper.paper.paperId, now: 1_000 });
  return { database, service, attemptId: bundle.attempt.attemptId };
}

function createVersionFourDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = factory.open(name, 4);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAMES.papers, { keyPath: "paperId" });
      request.result.createObjectStore(STORE_NAMES.attempts, { keyPath: "attemptId" });
      request.result.createObjectStore(STORE_NAMES.questions, { keyPath: "id" });
      request.result.createObjectStore(STORE_NAMES.conversationBindings, {
        keyPath: "attemptId",
      });
      request.result.createObjectStore(STORE_NAMES.conversationClaims, {
        keyPath: "conversationUrl",
      });
      request.result.createObjectStore(STORE_NAMES.feedback, { keyPath: "feedbackId" });
      request.result.createObjectStore(STORE_NAMES.settings, { keyPath: "key" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

describe("submission outbox schema", () => {
  it("migrates v4 to v5 with request, attempt, status and composite indexes", async () => {
    const factory = new IDBFactory();
    const name = "outbox-v4-migration";
    await createVersionFourDatabase(factory, name);
    const database = await openShenlunDatabase({ factory, name });
    openDatabases.push(database);

    expect(database.version).toBe(DATABASE_VERSION);
    expect(database.objectStoreNames.contains(STORE_NAMES.submissionOutbox)).toBe(true);
    const store = database
      .transaction(STORE_NAMES.submissionOutbox, "readonly")
      .objectStore(STORE_NAMES.submissionOutbox);
    expect(store.keyPath).toBe("requestId");
    expect(Array.from(store.indexNames)).toEqual(
      expect.arrayContaining(["attemptId", "status", "attemptStatus"]),
    );
    expect(store.index("attemptStatus").keyPath).toEqual(["attemptId", "status"]);
  });
});

describe("durable submission outbox", () => {
  it("uses the click-time single snapshot and restores it over a late draft atomically", async () => {
    const { service, attemptId } = await createService("outbox-single-finalize");
    await service.saveQuestionDraft({
      attemptId,
      questionId: "q1",
      userAnswer: "数据库旧答案",
      timer: timer(2_000, null, 2_000),
      now: 2_000,
    });
    await service.saveQuestionDraft({
      attemptId,
      questionId: "q2",
      userAnswer: "第二题已完成",
      now: 2_500,
    });

    const clickSnapshot = snapshot(
      "q1",
      "点击提交时的最终答案",
      37,
      timer(37_000, null, 3_000),
    );
    const submission = await service.prepareSubmission(
      attemptId,
      { mode: "single-question", questionId: "q1" },
      "request-single",
      { mode: "single-question", question: clickSnapshot },
    );
    expect(submission.prompt).toContain("点击提交时的最终答案");
    expect(submission.prompt).not.toContain("数据库旧答案");
    expect(await service.getActivePreparedSubmission(attemptId)).toMatchObject({
      requestId: "request-single",
      status: "prepared",
      questions: [clickSnapshot],
    });

    // A stale autosave wins the database race after the click and even
    // downgrades the aggregate attempt. Finalize must restore the outbox truth.
    await service.saveQuestionDraft({
      attemptId,
      questionId: "q1",
      userAnswer: "",
      timer: timer(99_000, null, 5_000),
      now: 5_000,
    });
    expect((await service.loadAttemptBundle(attemptId))?.attempt.status).toBe("answering");

    await service.finalizePreparedSubmission(attemptId, "request-single", 6_000);
    const finalized = await service.loadAttemptBundle(attemptId);
    expect(finalized?.questions.find((question) => question.questionId === "q1")).toMatchObject({
      userAnswer: "点击提交时的最终答案",
      elapsedSeconds: 37,
      timer: timer(37_000, null, 3_000),
      status: "submitted",
      submittedAt: 6_000,
    });
    expect(finalized?.attempt).toMatchObject({ status: "completed", completedAt: 6_000 });

    await service.finalizePreparedSubmission(attemptId, "request-single", 9_000);
    expect(
      (await service.loadAttemptBundle(attemptId))?.questions.find(
        (question) => question.questionId === "q1",
      )?.submittedAt,
    ).toBe(6_000);
    expect(await service.cancelPreparedSubmission(attemptId, "request-single", 10_000)).toBe(
      "already-finalized",
    );
    expect(await service.getActivePreparedSubmission(attemptId)).toBeNull();
  });

  it("keeps delivering durable, prevents reacquisition, and finalizes the full snapshot", async () => {
    const { database, service, attemptId } = await createService("outbox-full-finalize");
    await service.saveQuestionDraft({
      attemptId,
      questionId: "q1",
      userAnswer: "DB答案一",
      now: 2_000,
    });
    await service.saveQuestionDraft({
      attemptId,
      questionId: "q2",
      userAnswer: "DB答案二",
      now: 2_100,
    });

    const questionSnapshots = [
      snapshot("q1", "面板答案一", 41, timer(41_000, null, 4_000)),
      snapshot("q2", "面板答案二", 52, timer(52_000, null, 4_000)),
    ];
    const attemptTimer = timer(100_000, null, 4_000);
    const submission = await service.prepareSubmission(
      attemptId,
      { mode: "full-paper" },
      "request-full",
      {
        mode: "full-paper",
        questions: questionSnapshots,
        attemptTimer,
        totalElapsedSeconds: 100,
      },
    );
    expect(submission.prompt).toContain("面板答案一");
    expect(submission.prompt).toContain("面板答案二");

    expect(
      await service.markPreparedSubmissionDelivering(attemptId, "request-full", 5_000),
    ).toBe("acquired");
    const restartedService = new PracticeService(() => Promise.resolve(database));
    expect(await restartedService.getActivePreparedSubmission(attemptId)).toMatchObject({
      requestId: "request-full",
      status: "delivering",
      deliveringAt: 5_000,
    });
    expect(
      await restartedService.markPreparedSubmissionDelivering(
        attemptId,
        "request-full",
        6_000,
      ),
    ).toBe("already-delivering");
    expect(await restartedService.cancelPreparedSubmission(attemptId, "request-full", 6_100)).toBe(
      "already-started",
    );

    await service.saveQuestionDraft({
      attemptId,
      questionId: "q1",
      userAnswer: "迟到答案一",
      timer: timer(90_000, null, 6_500),
      now: 6_500,
    });
    await service.saveQuestionDraft({
      attemptId,
      questionId: "q2",
      userAnswer: "迟到答案二",
      timer: timer(91_000, null, 6_600),
      now: 6_600,
    });
    await service.saveTimerCheckpoint({
      attemptId,
      attemptTimer: timer(999_000, null, 7_000),
      questionTimers: {
        q1: timer(999_000, null, 7_000),
        q2: timer(999_000, null, 7_000),
      },
      now: 7_000,
    });

    await restartedService.finalizePreparedSubmission(attemptId, "request-full", 8_000);
    const finalized = await service.loadAttemptBundle(attemptId);
    expect(finalized?.attempt).toMatchObject({
      status: "submitted",
      submittedAt: 8_000,
      timer: attemptTimer,
      totalElapsedSeconds: 100,
    });
    expect(finalized?.questions.map((question) => ({
      questionId: question.questionId,
      userAnswer: question.userAnswer,
      elapsedSeconds: question.elapsedSeconds,
      timer: question.timer,
      status: question.status,
    }))).toEqual([
      { ...questionSnapshots[0], status: "answered" },
      { ...questionSnapshots[1], status: "answered" },
    ]);

    await restartedService.finalizePreparedSubmission(attemptId, "request-full", 12_000);
    expect((await service.loadAttemptBundle(attemptId))?.attempt.submittedAt).toBe(8_000);
    expect(await service.cancelPreparedSubmission(attemptId, "request-full", 13_000)).toBe(
      "already-finalized",
    );

    const transaction = database.transaction(STORE_NAMES.submissionOutbox, "readonly");
    const stored = await requestToPromise(
      transaction.objectStore(STORE_NAMES.submissionOutbox).get("request-full"),
    );
    expect(stored).toMatchObject({ status: "finalized", finalizedAt: 8_000 });
  });

  it("cancels only definitely unsent records and retains every resolved snapshot", async () => {
    const { database, service, attemptId } = await createService("outbox-cancel");
    await service.saveQuestionDraft({
      attemptId,
      questionId: "q1",
      userAnswer: "待发送答案",
      now: 2_000,
    });

    await service.prepareSubmission(
      attemptId,
      { mode: "single-question", questionId: "q1" },
      "request-cancelled",
      {
        mode: "single-question",
        question: snapshot("q1", "待发送答案", 2, timer(2_000, null, 2_000)),
      },
    );
    expect(await service.cancelPreparedSubmission(attemptId, "request-cancelled", 3_000)).toBe(
      "cancelled",
    );
    expect(await service.cancelPreparedSubmission(attemptId, "request-cancelled", 4_000)).toBe(
      "cancelled",
    );
    await expect(
      service.finalizePreparedSubmission(attemptId, "request-cancelled", 5_000),
    ).rejects.toThrow(/Cancelled submission/u);

    await service.prepareSubmission(
      attemptId,
      { mode: "single-question", questionId: "q1" },
      "request-confirmed-unsent",
      {
        mode: "single-question",
        question: snapshot("q1", "待发送答案", 2, timer(2_000, null, 2_000)),
      },
    );
    expect(
      await service.markPreparedSubmissionDelivering(
        attemptId,
        "request-confirmed-unsent",
        6_000,
      ),
    ).toBe("acquired");
    expect(
      await service.cancelPreparedSubmissionAfterConfirmedUnsent(
        attemptId,
        "request-confirmed-unsent",
        7_000,
      ),
    ).toBe("cancelled");
    expect(await service.getActivePreparedSubmission(attemptId)).toBeNull();
    expect(await service.cancelPreparedSubmission(attemptId, "missing-request", 8_000)).toBe(
      "not-found",
    );

    const records = await requestToPromise(
      database
        .transaction(STORE_NAMES.submissionOutbox, "readonly")
        .objectStore(STORE_NAMES.submissionOutbox)
        .getAll(),
    );
    expect(records).toHaveLength(2);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: "request-cancelled", status: "cancelled" }),
        expect.objectContaining({
          requestId: "request-confirmed-unsent",
          status: "cancelled",
        }),
      ]),
    );
  });

  it("creates a new durable request and feedback record when a graded question is resubmitted", async () => {
    const { service, attemptId } = await createService("outbox-repeat-question");
    await service.saveQuestionDraft({
      attemptId,
      questionId: "q1",
      userAnswer: "可重复批改的答案",
      now: 2_000,
    });
    const frozen = snapshot("q1", "可重复批改的答案", 12, timer(12_000, null, 2_000));

    await service.prepareSubmission(
      attemptId,
      { mode: "single-question", questionId: "q1" },
      "repeat-first",
      { mode: "single-question", question: frozen },
    );
    await service.finalizePreparedSubmission(attemptId, "repeat-first", 3_000);
    await service.savePastedFeedback({
      attemptId,
      questionId: "q1",
      rawText: "## 得分\n12 / 20",
      now: 3_100,
    });

    await expect(service.prepareSubmission(
      attemptId,
      { mode: "single-question", questionId: "q1" },
      "repeat-second",
      { mode: "single-question", question: frozen },
    )).resolves.toMatchObject({ mode: "single-question", questionId: "q1" });
    await service.finalizePreparedSubmission(attemptId, "repeat-second", 4_000);
    await service.savePastedFeedback({
      attemptId,
      questionId: "q1",
      rawText: "## 得分\n15 / 20",
      now: 4_100,
    });

    const bundle = await service.loadAttemptBundle(attemptId);
    expect(bundle?.feedback).toHaveLength(2);
    expect(bundle?.feedback.map((record) => record.feedback.rawText)).toEqual(
      expect.arrayContaining(["## 得分\n12 / 20", "## 得分\n15 / 20"]),
    );
  });

  it("enforces one active record per attempt and immutable request ownership", async () => {
    const { service, attemptId } = await createService("outbox-active-isolation");
    await service.saveQuestionDraft({
      attemptId,
      questionId: "q1",
      userAnswer: "原始快照答案",
      now: 2_000,
    });
    const original = await service.prepareSubmission(
      attemptId,
      { mode: "single-question", questionId: "q1" },
      "stable-request",
      {
        mode: "single-question",
        question: snapshot("q1", "原始快照答案", 2, timer(2_000, null, 2_000)),
      },
    );
    await expect(
      service.prepareSubmission(
        attemptId,
        { mode: "single-question", questionId: "q1" },
        "another-request",
      ),
    ).rejects.toThrow(/already prepared/u);

    const repeated = await service.prepareSubmission(
      attemptId,
      { mode: "single-question", questionId: "q1" },
      "stable-request",
      {
        mode: "single-question",
        question: snapshot("q1", "不得覆盖原快照", 99, timer(99_000, null, 9_000)),
      },
    );
    expect(repeated.prompt).toBe(original.prompt);
    expect(repeated.prompt).not.toContain("不得覆盖原快照");

    const other = await service.createAttempt({
      paperId: (await service.loadAttemptBundle(attemptId))!.paper.paperId,
      now: 10_000,
    });
    await service.saveQuestionDraft({
      attemptId: other.attempt.attemptId,
      questionId: "q1",
      userAnswer: "另一次练习",
      now: 11_000,
    });
    await expect(
      service.prepareSubmission(
        other.attempt.attemptId,
        { mode: "single-question", questionId: "q1" },
        "stable-request",
      ),
    ).rejects.toThrow(/different submission/u);
  });

  it("rejects empty and cross-question live snapshots", async () => {
    const { service, attemptId } = await createService("outbox-snapshot-validation");
    await service.saveQuestionDraft({
      attemptId,
      questionId: "q1",
      userAnswer: "数据库有内容",
      now: 2_000,
    });
    await expect(
      service.prepareSubmission(
        attemptId,
        { mode: "single-question", questionId: "q1" },
        "empty-live",
        {
          mode: "single-question",
          question: snapshot("q1", "   ", 1, timer(1_000, null, 2_000)),
        },
      ),
    ).rejects.toThrow(/先完成当前题目/u);
    await expect(
      service.prepareSubmission(
        attemptId,
        { mode: "single-question", questionId: "q1" },
        "wrong-question",
        {
          mode: "single-question",
          question: snapshot("q2", "越界答案", 1, timer(1_000, null, 2_000)),
        },
      ),
    ).rejects.toThrow(/does not belong/u);
    await expect(
      service.prepareSubmission(
        attemptId,
        { mode: "single-question", questionId: "q1" },
        "running-timer",
        {
          mode: "single-question",
          question: snapshot("q1", "仍在计时", 1, timer(1_000, 2_000, 2_000)),
        },
      ),
    ).rejects.toThrow(/must be paused/u);
  });
});
