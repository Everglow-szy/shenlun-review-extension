import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import {
  DATABASE_VERSION,
  STORE_NAMES,
  openShenlunDatabase,
} from "../../src/database/indexedDB";
import { FeedbackRepository } from "../../src/database/feedbackRepository";
import { ConversationBindingRepository } from "../../src/database/conversationBindingRepository";
import { PracticeRepository } from "../../src/database/practiceRepository";
import { PracticeService } from "../../src/services/practiceService";
import type { CreatePaperDefinitionInput, PersistedTimerState } from "../../src/types";

const openDatabases: IDBDatabase[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    database.close();
  }
});

function createVersionOneDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAMES.papers, { keyPath: "paperId" });
      request.result.createObjectStore(STORE_NAMES.questions, { keyPath: "id" });
      request.result.createObjectStore(STORE_NAMES.conversationBindings, {
        keyPath: "attemptId",
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

function createVersionTwoDatabaseWithDuplicateUrls(
  factory: IDBFactory,
  name: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = factory.open(name, 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAMES.papers, { keyPath: "paperId" });
      request.result.createObjectStore(STORE_NAMES.attempts, { keyPath: "attemptId" });
      request.result.createObjectStore(STORE_NAMES.questions, { keyPath: "id" });
      const bindings = request.result.createObjectStore(STORE_NAMES.conversationBindings, {
        keyPath: "attemptId",
      });
      request.result.createObjectStore(STORE_NAMES.feedback, { keyPath: "feedbackId" });
      request.result.createObjectStore(STORE_NAMES.settings, { keyPath: "key" });
      const shared = "https://chatgpt.com/c/shared";
      bindings.add({
        attemptId: "attempt-a",
        paperId: "paper-a",
        conversationUrl: shared,
        createdAt: 1,
      });
      bindings.add({
        attemptId: "attempt-b",
        paperId: "paper-b",
        conversationUrl: shared,
        createdAt: 2,
      });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

const extractedPaper: CreatePaperDefinitionInput = {
  paperName: "2024国考行政执法卷",
  paperSource: "example.test",
  sourceUrl: "https://example.test/paper/2024",
  questions: [
    {
      questionId: "q1",
      index: 0,
      title: "第一题",
      questionText: "概括材料。",
      materials: ["材料一"],
      score: 20,
      wordLimit: 300,
      referenceAnswer: "参考答案",
    },
    {
      questionId: "q2",
      index: 1,
      title: "第二题",
      questionText: "提出对策。",
      materials: ["材料二"],
      score: 20,
      wordLimit: null,
      referenceAnswer: null,
    },
  ],
};

function timerState(
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

describe("IndexedDB schema", () => {
  it("migrates a v1 database to the current attempt-scoped schema", async () => {
    const factory = new IDBFactory();
    const name = "migration-test";
    await createVersionOneDatabase(factory, name);
    const database = await openShenlunDatabase({ factory, name });
    openDatabases.push(database);

    expect(database.version).toBe(DATABASE_VERSION);
    expect(Array.from(database.objectStoreNames)).toEqual(
      expect.arrayContaining(Object.values(STORE_NAMES)),
    );
    const transaction = database.transaction(
      [
        STORE_NAMES.attempts,
        STORE_NAMES.questions,
        STORE_NAMES.feedback,
        STORE_NAMES.conversationBindings,
      ],
      "readonly",
    );
    expect(Array.from(transaction.objectStore(STORE_NAMES.attempts).indexNames)).toContain(
      "paperAttemptNumber",
    );
    expect(Array.from(transaction.objectStore(STORE_NAMES.questions).indexNames)).toContain(
      "attemptQuestion",
    );
    expect(Array.from(transaction.objectStore(STORE_NAMES.feedback).indexNames)).toContain(
      "attemptId",
    );
    expect(
      transaction.objectStore(STORE_NAMES.conversationBindings).index("conversationUrl").unique,
    ).toBe(true);
  });

  it("migrates v2 duplicate conversation URLs without blocking the upgrade", async () => {
    const factory = new IDBFactory();
    const name = "conversation-url-migration-test";
    await createVersionTwoDatabaseWithDuplicateUrls(factory, name);
    const database = await openShenlunDatabase({ factory, name });
    openDatabases.push(database);

    const transaction = database.transaction(
      [STORE_NAMES.conversationBindings, STORE_NAMES.conversationClaims],
      "readonly",
    );
    const store = transaction.objectStore(STORE_NAMES.conversationBindings);
    const recordsRequest = store.getAll();
    const claimsRequest = transaction.objectStore(STORE_NAMES.conversationClaims).getAll();
    const [records, claims] = await Promise.all([
      new Promise<ReadonlyArray<{ conversationUrl?: string }>>((resolve, reject) => {
        const request = recordsRequest;
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
      new Promise<ReadonlyArray<{ conversationUrl: string; attemptId: string }>>(
        (resolve, reject) => {
          const request = claimsRequest;
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        },
      ),
    ]);
    expect(records.filter((record) => record.conversationUrl !== undefined)).toHaveLength(1);
    expect(store.index("conversationUrl").unique).toBe(true);
    expect(claims).toEqual([
      expect.objectContaining({
        conversationUrl: "https://chatgpt.com/c/shared",
        attemptId: "attempt-a",
      }),
    ]);
  });
});

describe("attempt isolation", () => {
  it("keeps answers, bindings, prompts and feedback isolated for repeated attempts", async () => {
    const factory = new IDBFactory();
    const database = await openShenlunDatabase({ factory, name: "isolation-test" });
    openDatabases.push(database);
    const provider = (): Promise<IDBDatabase> => Promise.resolve(database);
    const service = new PracticeService(provider);
    const ingested = await service.ingestPaper(extractedPaper);
    const first = await service.createAttempt({
      paperId: ingested.paper.paperId,
      now: new Date(2026, 7, 20, 9).getTime(),
    });
    const second = await service.createAttempt({
      paperId: ingested.paper.paperId,
      now: new Date(2026, 7, 20, 10).getTime(),
    });

    expect(first.attempt.attemptId).not.toBe(second.attempt.attemptId);
    expect(first.conversation?.conversationName).toBe("2024国考行政执法卷-申论批改");
    expect(second.conversation?.conversationName).toBe(
      "2024国考行政执法卷-申论批改",
    );
    const nextDay = await service.createAttempt({
      paperId: ingested.paper.paperId,
      now: new Date(2026, 7, 21, 10).getTime(),
    });
    expect(nextDay.attempt.attemptNumber).toBe(3);
    expect(nextDay.conversation?.conversationName).toBe("2024国考行政执法卷-申论批改");
    expect(await service.listAttemptsByPaper(ingested.paper.paperId)).toHaveLength(3);

    await service.saveQuestionDraft({
      attemptId: first.attempt.attemptId,
      questionId: "q1",
      userAnswer: "第一次练习答案",
      now: 1_000,
    });
    expect((await service.loadAttemptBundle(first.attempt.attemptId))?.attempt.status).toBe(
      "answering",
    );
    await service.saveQuestionDraft({
      attemptId: first.attempt.attemptId,
      questionId: "q2",
      userAnswer: "第一次练习第二题答案",
      now: 2_000,
    });
    expect((await service.loadAttemptBundle(first.attempt.attemptId))?.attempt).toMatchObject({
      status: "completed",
      completedAt: 2_000,
    });
    await service.saveQuestionDraft({
      attemptId: first.attempt.attemptId,
      questionId: "q2",
      userAnswer: "",
      now: 3_000,
    });
    expect((await service.loadAttemptBundle(first.attempt.attemptId))?.attempt).toMatchObject({
      status: "answering",
      completedAt: null,
    });
    await service.saveQuestionDraft({
      attemptId: second.attempt.attemptId,
      questionId: "q1",
      userAnswer: "第二次练习答案",
    });
    const firstReloaded = await service.loadAttemptBundle(first.attempt.attemptId);
    const secondReloaded = await service.loadAttemptBundle(second.attempt.attemptId);
    expect(firstReloaded?.questions[0]?.userAnswer).toBe("第一次练习答案");
    expect(secondReloaded?.questions[0]?.userAnswer).toBe("第二次练习答案");

    const prompt = await service.buildSingleSubmission(first.attempt.attemptId, "q1");
    expect(prompt.prompt).toContain("第一次练习答案");
    expect(prompt.prompt).not.toContain("第二次练习答案");
    expect(prompt.binding?.attemptId).toBe(first.attempt.attemptId);

    const bindingRepository = new ConversationBindingRepository(provider);
    await bindingRepository.rebindConversationUrl(
      first.attempt.attemptId,
      "https://chatgpt.com/c/one-conversation",
    );
    await expect(
      bindingRepository.rebindConversationUrl(
        second.attempt.attemptId,
        "https://chatgpt.com/c/one-conversation",
      ),
    ).rejects.toThrow(/already bound to another attempt/u);
    await bindingRepository.rebindConversationUrl(
      first.attempt.attemptId,
      "https://chatgpt.com/c/replacement-conversation",
    );
    await expect(
      bindingRepository.rebindConversationUrl(
        second.attempt.attemptId,
        "https://chatgpt.com/c/one-conversation",
      ),
    ).rejects.toThrow(/previously claimed by another attempt/u);
    await expect(
      bindingRepository.rebindConversationUrl(
        first.attempt.attemptId,
        "https://chatgpt.com/c/one-conversation",
      ),
    ).resolves.toMatchObject({ attemptId: first.attempt.attemptId });

    await expect(
      service.confirmManualSubmission(first.attempt.attemptId, {
        mode: "single-question",
        questionId: "not-in-this-attempt",
      }),
    ).rejects.toThrow(/does not belong/u);
    await service.confirmManualSubmission(first.attempt.attemptId, {
      mode: "single-question",
      questionId: "q1",
    });
    expect(
      (await service.loadAttemptBundle(first.attempt.attemptId))?.questions.find(
        (question) => question.questionId === "q1",
      )?.status,
    ).toBe("submitted");
    await expect(
      service.confirmManualSubmission(second.attempt.attemptId, { mode: "full-paper" }),
    ).rejects.toThrow(/unanswered questions/u);
    await service.saveQuestionDraft({
      attemptId: second.attempt.attemptId,
      questionId: "q2",
      userAnswer: "第二次练习第二题答案",
    });
    await service.confirmManualSubmission(second.attempt.attemptId, { mode: "full-paper" });
    expect((await service.loadAttemptBundle(second.attempt.attemptId))?.attempt.status).toBe(
      "submitted",
    );

    await service.savePastedFeedback({
      attemptId: second.attempt.attemptId,
      questionId: "q1",
      rawText: "第二次反馈",
    });
    expect((await service.loadAttemptBundle(first.attempt.attemptId))?.feedback).toHaveLength(0);
    expect((await service.loadAttemptBundle(second.attempt.attemptId))?.feedback).toHaveLength(1);

    const feedbackRepository = new FeedbackRepository(provider);
    await expect(
      feedbackRepository.create({
        attemptId: first.attempt.attemptId,
        paperId: "paper-from-another-attempt",
        questionId: "q1",
        feedback: { rawText: "should fail", createdAt: Date.now() },
      }),
    ).rejects.toThrow(/does not belong/u);
  });
});

describe("timer and submission monotonicity", () => {
  it("does not let an older running snapshot revive a newer pause and question switch", async () => {
    const factory = new IDBFactory();
    const database = await openShenlunDatabase({ factory, name: "timer-monotonic-test" });
    openDatabases.push(database);
    const service = new PracticeService(() => Promise.resolve(database));
    const paper = await service.ingestPaper(extractedPaper);
    const bundle = await service.createAttempt({
      paperId: paper.paper.paperId,
      activeQuestionId: "q1",
      now: 1_000,
    });

    await service.saveTimerCheckpoint({
      attemptId: bundle.attempt.attemptId,
      attemptTimer: timerState(5_000, 6_000, 6_000),
      questionTimers: {
        q1: timerState(4_000, null, 6_000),
        q2: timerState(2_000, 6_000, 6_000),
      },
      now: 6_000,
    });
    await service.saveTimerCheckpoint({
      attemptId: bundle.attempt.attemptId,
      attemptTimer: timerState(1_000, 3_000, 3_000),
      questionTimers: {
        q1: timerState(1_000, 3_000, 3_000),
        q2: timerState(0, null, 3_000),
      },
      now: 7_000,
    });

    const restored = await service.loadAttemptBundle(bundle.attempt.attemptId);
    expect(restored?.attempt).toMatchObject({
      updatedAt: 6_000,
      timer: { accumulatedMilliseconds: 5_000, runningSince: 6_000, checkpointedAt: 6_000 },
    });
    expect(restored?.questions.find((question) => question.questionId === "q1")).toMatchObject({
      updatedAt: 6_000,
      timer: { accumulatedMilliseconds: 4_000, runningSince: null, checkpointedAt: 6_000 },
    });
    expect(restored?.questions.find((question) => question.questionId === "q2")).toMatchObject({
      updatedAt: 6_000,
      timer: { accumulatedMilliseconds: 2_000, runningSince: 6_000, checkpointedAt: 6_000 },
    });
  });

  it("does not let a stale draft timer overwrite a newer checkpoint", async () => {
    const factory = new IDBFactory();
    const database = await openShenlunDatabase({ factory, name: "draft-timer-monotonic-test" });
    openDatabases.push(database);
    const service = new PracticeService(() => Promise.resolve(database));
    const paper = await service.ingestPaper(extractedPaper);
    const bundle = await service.createAttempt({ paperId: paper.paper.paperId, now: 1_000 });

    await service.saveTimerCheckpoint({
      attemptId: bundle.attempt.attemptId,
      attemptTimer: timerState(8_000, null, 8_000),
      questionTimers: { q1: timerState(8_000, null, 8_000) },
      now: 8_000,
    });
    await service.saveQuestionDraft({
      attemptId: bundle.attempt.attemptId,
      questionId: "q1",
      userAnswer: "较新的答案文本",
      timer: timerState(2_000, 2_000, 2_000),
      elapsedSeconds: 999,
      now: 9_000,
    });

    const restored = await service.loadAttemptBundle(bundle.attempt.attemptId);
    expect(restored?.questions.find((question) => question.questionId === "q1")).toMatchObject({
      userAnswer: "较新的答案文本",
      elapsedSeconds: 8,
      timer: { accumulatedMilliseconds: 8_000, runningSince: null, checkpointedAt: 8_000 },
    });
  });

  it("keeps the first full-paper submission timestamp when marking twice", async () => {
    const factory = new IDBFactory();
    const database = await openShenlunDatabase({ factory, name: "idempotent-attempt-submit-test" });
    openDatabases.push(database);
    const provider = (): Promise<IDBDatabase> => Promise.resolve(database);
    const service = new PracticeService(provider);
    const repository = new PracticeRepository(provider);
    const paper = await service.ingestPaper(extractedPaper);
    const bundle = await service.createAttempt({ paperId: paper.paper.paperId, now: 1_000 });

    await repository.markAttemptSubmitted(bundle.attempt.attemptId, 3_000);
    await repository.markAttemptSubmitted(bundle.attempt.attemptId, 9_000);

    expect((await service.loadAttemptBundle(bundle.attempt.attemptId))?.attempt).toMatchObject({
      status: "submitted",
      submittedAt: 3_000,
      updatedAt: 3_000,
    });
  });

  it("allows repeat question grading while still rejecting a duplicate full-paper submission", async () => {
    const factory = new IDBFactory();
    const database = await openShenlunDatabase({ factory, name: "stale-panel-submit-test" });
    openDatabases.push(database);
    const service = new PracticeService(() => Promise.resolve(database));
    const paper = await service.ingestPaper(extractedPaper);
    const bundle = await service.createAttempt({ paperId: paper.paper.paperId, now: 1_000 });
    await service.saveQuestionDraft({
      attemptId: bundle.attempt.attemptId,
      questionId: "q1",
      userAnswer: "第一题答案",
      now: 2_000,
    });

    await expect(
      service.buildSingleSubmission(bundle.attempt.attemptId, "q1"),
    ).resolves.toMatchObject({ mode: "single-question", questionId: "q1" });
    await service.confirmManualSubmission(bundle.attempt.attemptId, {
      mode: "single-question",
      questionId: "q1",
    });
    await expect(
      service.buildSingleSubmission(bundle.attempt.attemptId, "q1"),
    ).resolves.toMatchObject({ mode: "single-question", questionId: "q1" });

    await service.saveQuestionDraft({
      attemptId: bundle.attempt.attemptId,
      questionId: "q2",
      userAnswer: "第二题答案",
      now: 3_000,
    });
    await expect(
      service.buildFullSubmission(bundle.attempt.attemptId),
    ).resolves.toMatchObject({ mode: "full-paper" });
    await service.confirmManualSubmission(bundle.attempt.attemptId, { mode: "full-paper" });
    await expect(
      service.buildFullSubmission(bundle.attempt.attemptId),
    ).rejects.toThrow(/试卷已提交/u);
    await expect(
      service.buildSingleSubmission(bundle.attempt.attemptId, "q2"),
    ).resolves.toMatchObject({ mode: "single-question", questionId: "q2" });
  });

  it("records submission time without downgrading an already graded question", async () => {
    const factory = new IDBFactory();
    const database = await openShenlunDatabase({ factory, name: "graded-submit-test" });
    openDatabases.push(database);
    const service = new PracticeService(() => Promise.resolve(database));
    const paper = await service.ingestPaper(extractedPaper);
    const bundle = await service.createAttempt({ paperId: paper.paper.paperId, now: 1_000 });
    await service.saveQuestionDraft({
      attemptId: bundle.attempt.attemptId,
      questionId: "q1",
      userAnswer: "待批改答案",
      now: 2_000,
    });
    await expect(service.savePastedFeedback({
      attemptId: bundle.attempt.attemptId,
      questionId: "q1",
      rawText: "尚未提交时的反馈",
      now: 3_000,
    })).rejects.toThrow(/先提交本题或整卷/u);
    await service.confirmManualSubmission(
      bundle.attempt.attemptId,
      { mode: "single-question", questionId: "q1" },
    );
    await service.savePastedFeedback({
      attemptId: bundle.attempt.attemptId,
      questionId: "q1",
      rawText: "提交后的反馈",
      now: 3_500,
    });
    await service.confirmManualSubmission(
      bundle.attempt.attemptId,
      { mode: "single-question", questionId: "q1" },
    );
    await service.saveQuestionDraft({
      attemptId: bundle.attempt.attemptId,
      questionId: "q1",
      userAnswer: "不得覆盖的迟到草稿",
      now: 4_000,
    });
    const afterSingle = await service.loadAttemptBundle(bundle.attempt.attemptId);
    expect(
      afterSingle?.questions.find(
        (question) => question.questionId === "q1",
      ),
    ).toMatchObject({
      status: "graded",
      submittedAt: expect.any(Number),
      userAnswer: "待批改答案",
    });

    await service.saveQuestionDraft({
      attemptId: bundle.attempt.attemptId,
      questionId: "q2",
      userAnswer: "第二题答案",
      now: 5_000,
    });
    await service.confirmManualSubmission(bundle.attempt.attemptId, { mode: "full-paper" });
    const submitted = await service.loadAttemptBundle(bundle.attempt.attemptId);
    await service.saveQuestionDraft({
      attemptId: bundle.attempt.attemptId,
      questionId: "q2",
      userAnswer: "整卷提交后的迟到草稿",
      now: 6_000,
    });
    await service.saveTimerCheckpoint({
      attemptId: bundle.attempt.attemptId,
      attemptTimer: timerState(99_000, 6_000, 6_000),
      questionTimers: {
        q1: timerState(99_000, 6_000, 6_000),
        q2: timerState(99_000, 6_000, 6_000),
      },
      now: 7_000,
    });
    const afterLateWrites = await service.loadAttemptBundle(bundle.attempt.attemptId);
    expect(afterLateWrites?.questions.find((question) => question.questionId === "q2")?.userAnswer)
      .toBe("第二题答案");
    expect(afterLateWrites?.attempt.timer).toEqual(submitted?.attempt.timer);
  });
});
