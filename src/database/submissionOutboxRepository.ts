import {
  PERSISTED_ENTITY_VERSION,
  type AttemptId,
  type CancelPreparedSubmissionResult,
  type ConversationBinding,
  type FeedbackSubmission,
  type MarkPreparedSubmissionDeliveringResult,
  type ManualSubmissionHandoff,
  type PaperAttempt,
  type PaperDefinition,
  type QuestionAttempt,
  type QuestionSnapshot,
  type SubmissionOutboxRecord,
  type SubmissionSnapshotInput,
} from "../types";
import { buildFullPaperPrompt, buildSingleQuestionPrompt } from "../services/promptBuilder";
import {
  STORE_NAMES,
  getDefaultDatabase,
  requestToPromise,
  transactionToPromise,
  type DatabaseProvider,
} from "./indexedDB";

const ACTIVE_OUTBOX_STATUSES = new Set<SubmissionOutboxRecord["status"]>([
  "prepared",
  "delivering",
]);

async function abortAndThrow(
  transaction: IDBTransaction,
  completed: Promise<void>,
  message: string,
): Promise<never> {
  transaction.abort();
  await completed.catch(() => undefined);
  throw new Error(message);
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function sameHandoff(
  left: ManualSubmissionHandoff,
  right: ManualSubmissionHandoff,
): boolean {
  return left.mode === right.mode &&
    (left.mode === "full-paper" ||
      (right.mode === "single-question" && left.questionId === right.questionId));
}

function cloneQuestionSnapshot(question: QuestionAttempt): QuestionSnapshot {
  return {
    questionId: question.questionId,
    userAnswer: question.userAnswer,
    elapsedSeconds: question.elapsedSeconds,
    timer: { ...question.timer },
  };
}

function assertTimerSnapshot(timer: QuestionSnapshot["timer"], label: string): void {
  if (
    timer.schemaVersion !== PERSISTED_ENTITY_VERSION ||
    !Number.isFinite(timer.accumulatedMilliseconds) ||
    timer.accumulatedMilliseconds < 0 ||
    (timer.runningSince !== null &&
      (!Number.isFinite(timer.runningSince) || timer.runningSince < 0)) ||
    !Number.isFinite(timer.checkpointedAt) ||
    timer.checkpointedAt < 0
  ) {
    throw new Error(`${label} contains an invalid timer`);
  }
}

function assertQuestionSnapshot(snapshot: QuestionSnapshot, label: string): void {
  requireIdentifier(snapshot.questionId, `${label}.questionId`);
  if (!Number.isFinite(snapshot.elapsedSeconds) || snapshot.elapsedSeconds < 0) {
    throw new Error(`${label}.elapsedSeconds must be a non-negative number`);
  }
  assertTimerSnapshot(snapshot.timer, label);
}

function assertPausedTimer(timer: QuestionSnapshot["timer"], label: string): void {
  if (timer.runningSince !== null) {
    throw new Error(`${label} must be paused before submission`);
  }
}

function mergeMutableSnapshot(
  question: QuestionAttempt,
  snapshot: QuestionSnapshot,
): QuestionAttempt {
  return {
    ...question,
    userAnswer: snapshot.userAnswer,
    elapsedSeconds: snapshot.elapsedSeconds,
    timer: { ...snapshot.timer },
  };
}

function assertAttemptGraph(
  attempt: PaperAttempt,
  paper: PaperDefinition,
  questions: readonly QuestionAttempt[],
  expectedAttemptId: AttemptId,
): void {
  if (attempt.attemptId !== expectedAttemptId) {
    throw new Error("Paper attempt does not match the supplied attemptId");
  }
  if (paper.paperId !== attempt.paperId) {
    throw new Error("Paper attempt references a different paper definition");
  }
  const paperQuestionIds = new Set(paper.questions.map((question) => question.questionId));
  if (
    questions.length !== paper.questions.length ||
    questions.some(
      (question) =>
        question.attemptId !== expectedAttemptId ||
        question.paperId !== paper.paperId ||
        !paperQuestionIds.has(question.questionId),
    ) ||
    new Set(questions.map((question) => question.questionId)).size !== questions.length
  ) {
    throw new Error("Question attempts do not belong to the supplied attempt and paper");
  }
}

function assertRecordIdentity(
  record: SubmissionOutboxRecord,
  attemptId: AttemptId,
  requestId: string,
): void {
  if (record.requestId !== requestId || record.attemptId !== attemptId) {
    throw new Error("Submission request does not belong to the supplied attemptId");
  }
}

function assertRecordSnapshot(
  record: SubmissionOutboxRecord,
  attempt: PaperAttempt,
  paper: PaperDefinition,
  questions: readonly QuestionAttempt[],
): void {
  assertAttemptGraph(attempt, paper, questions, record.attemptId);
  if (record.paperId !== paper.paperId) {
    throw new Error("Submission snapshot belongs to a different paper");
  }
  const storedQuestionIds = new Set(questions.map((question) => question.questionId));
  const snapshotQuestionIds = new Set(record.questions.map((question) => question.questionId));
  if (
    snapshotQuestionIds.size !== record.questions.length ||
    record.questions.some((question) => !storedQuestionIds.has(question.questionId))
  ) {
    throw new Error("Submission snapshot contains a question from another attempt");
  }
  if (record.handoff.mode === "single-question") {
    if (
      record.questions.length !== 1 ||
      record.questions[0]?.questionId !== record.handoff.questionId ||
      record.attemptTimer !== null ||
      record.totalElapsedSeconds !== null
    ) {
      throw new Error("Single-question submission snapshot is inconsistent");
    }
    assertPausedTimer(record.questions[0].timer, "question snapshot timer");
    return;
  }
  if (
    record.questions.length !== questions.length ||
    record.attemptTimer === null ||
    record.totalElapsedSeconds === null ||
    questions.some((question) => !snapshotQuestionIds.has(question.questionId))
  ) {
    throw new Error("Full-paper submission snapshot is incomplete");
  }
  assertPausedTimer(record.attemptTimer, "attempt snapshot timer");
  record.questions.forEach((snapshot, index) =>
    assertPausedTimer(snapshot.timer, `questions[${index}] timer`),
  );
}

function toSubmission(
  record: SubmissionOutboxRecord,
  binding: ConversationBinding | null,
): FeedbackSubmission {
  if (record.handoff.mode === "single-question") {
    return {
      mode: "single-question",
      attemptId: record.attemptId,
      paperId: record.paperId,
      questionId: record.handoff.questionId,
      prompt: record.prompt,
      binding,
    };
  }
  return {
    mode: "full-paper",
    attemptId: record.attemptId,
    paperId: record.paperId,
    prompt: record.prompt,
    binding,
  };
}

export interface PreparedSubmissionRecord {
  readonly record: SubmissionOutboxRecord;
  readonly binding: ConversationBinding | null;
}

export class SubmissionOutboxRepository {
  public constructor(private readonly databaseProvider: DatabaseProvider = getDefaultDatabase) {}

  /**
   * Reads the authoritative attempt graph and writes its immutable prompt and
   * answer/timer snapshot in the same transaction.
   */
  public async prepare(
    attemptIdInput: AttemptId,
    handoff: ManualSubmissionHandoff,
    requestIdInput: string,
    snapshotInput?: SubmissionSnapshotInput,
  ): Promise<PreparedSubmissionRecord> {
    const attemptId = requireIdentifier(attemptIdInput, "attemptId");
    const requestId = requireIdentifier(requestIdInput, "requestId");
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [
        STORE_NAMES.papers,
        STORE_NAMES.attempts,
        STORE_NAMES.questions,
        STORE_NAMES.conversationBindings,
        STORE_NAMES.submissionOutbox,
      ],
      "readwrite",
    );
    const completed = transactionToPromise(transaction);
    const outboxStore = transaction.objectStore(STORE_NAMES.submissionOutbox);
    const [existingValue, activeValues, attemptValue, questionValues, bindingValue] =
      await Promise.all([
        requestToPromise(outboxStore.get(requestId)),
        requestToPromise(outboxStore.index("attemptId").getAll(attemptId)),
        requestToPromise(transaction.objectStore(STORE_NAMES.attempts).get(attemptId)),
        requestToPromise(
          transaction.objectStore(STORE_NAMES.questions).index("attemptId").getAll(attemptId),
        ),
        requestToPromise(
          transaction.objectStore(STORE_NAMES.conversationBindings).get(attemptId),
        ),
      ]);

    const existing = existingValue as SubmissionOutboxRecord | undefined;
    if (existing) {
      if (existing.attemptId !== attemptId || !sameHandoff(existing.handoff, handoff)) {
        return abortAndThrow(
          transaction,
          completed,
          "requestId is already owned by a different submission",
        );
      }
      if (!ACTIVE_OUTBOX_STATUSES.has(existing.status)) {
        return abortAndThrow(transaction, completed, "requestId has already been resolved");
      }
      const binding = (bindingValue as ConversationBinding | undefined) ?? null;
      if (binding && (binding.attemptId !== attemptId || binding.paperId !== existing.paperId)) {
        return abortAndThrow(
          transaction,
          completed,
          "Conversation binding does not belong to the prepared submission",
        );
      }
      await completed;
      return { record: existing, binding };
    }

    const conflicting = (activeValues as SubmissionOutboxRecord[]).find(
      (record) => ACTIVE_OUTBOX_STATUSES.has(record.status),
    );
    if (conflicting) {
      return abortAndThrow(
        transaction,
        completed,
        "Another submission is already prepared for this attempt",
      );
    }

    const attempt = attemptValue as PaperAttempt | undefined;
    if (!attempt) {
      return abortAndThrow(transaction, completed, "Paper attempt was not found");
    }
    const paperValue = await requestToPromise(
      transaction.objectStore(STORE_NAMES.papers).get(attempt.paperId),
    );
    const paper = paperValue as PaperDefinition | undefined;
    if (!paper) {
      return abortAndThrow(transaction, completed, "Paper definition was not found");
    }
    const questions = (questionValues as QuestionAttempt[]).sort(
      (left, right) => left.index - right.index,
    );
    try {
      assertAttemptGraph(attempt, paper, questions, attemptId);
    } catch (error: unknown) {
      return abortAndThrow(
        transaction,
        completed,
        error instanceof Error ? error.message : "Invalid attempt graph",
      );
    }
    if (
      handoff.mode === "full-paper" &&
      (attempt.status === "submitted" || attempt.submittedAt !== null)
    ) {
      return abortAndThrow(transaction, completed, "当前试卷已提交，请勿重复提交。");
    }

    const binding = (bindingValue as ConversationBinding | undefined) ?? null;
    if (binding && (binding.attemptId !== attemptId || binding.paperId !== paper.paperId)) {
      return abortAndThrow(
        transaction,
        completed,
        "Conversation binding does not belong to the supplied attempt and paper",
      );
    }

    if (snapshotInput && snapshotInput.mode !== handoff.mode) {
      return abortAndThrow(
        transaction,
        completed,
        "Submission snapshot mode does not match its handoff",
      );
    }

    let prompt: string;
    let snapshots: readonly QuestionSnapshot[];
    let attemptTimer: SubmissionOutboxRecord["attemptTimer"] = null;
    let totalElapsedSeconds: SubmissionOutboxRecord["totalElapsedSeconds"] = null;
    if (handoff.mode === "single-question") {
      const question = questions.find(
        (candidate) => candidate.questionId === handoff.questionId,
      );
      if (!question) {
        return abortAndThrow(
          transaction,
          completed,
          "Question does not belong to the supplied attemptId",
        );
      }
      const snapshot = snapshotInput?.mode === "single-question"
        ? snapshotInput.question
        : cloneQuestionSnapshot(question);
      try {
        assertQuestionSnapshot(snapshot, "question snapshot");
        assertPausedTimer(snapshot.timer, "question snapshot timer");
      } catch (error: unknown) {
        return abortAndThrow(
          transaction,
          completed,
          error instanceof Error ? error.message : "Invalid question snapshot",
        );
      }
      if (snapshot.questionId !== question.questionId) {
        return abortAndThrow(
          transaction,
          completed,
          "Question snapshot does not belong to the supplied handoff",
        );
      }
      if (snapshot.userAnswer.trim().length === 0) {
        return abortAndThrow(transaction, completed, "请先完成当前题目，再提交批改。");
      }
      const questionForPrompt = mergeMutableSnapshot(question, snapshot);
      prompt = buildSingleQuestionPrompt({
        paperName: paper.paperName,
        attemptId,
        question: questionForPrompt,
      });
      snapshots = [{ ...snapshot, timer: { ...snapshot.timer } }];
    } else {
      const incomingSnapshots = snapshotInput?.mode === "full-paper"
        ? snapshotInput.questions
        : questions.map(cloneQuestionSnapshot);
      const incomingByQuestion = new Map(
        incomingSnapshots.map((snapshot) => [snapshot.questionId, snapshot] as const),
      );
      try {
        incomingSnapshots.forEach((snapshot, index) => {
          assertQuestionSnapshot(snapshot, `questions[${index}]`);
          assertPausedTimer(snapshot.timer, `questions[${index}] timer`);
        });
      } catch (error: unknown) {
        return abortAndThrow(
          transaction,
          completed,
          error instanceof Error ? error.message : "Invalid question snapshots",
        );
      }
      if (
        incomingSnapshots.length !== questions.length ||
        incomingByQuestion.size !== questions.length ||
        questions.some((question) => !incomingByQuestion.has(question.questionId))
      ) {
        return abortAndThrow(
          transaction,
          completed,
          "Full-paper snapshot does not contain exactly this attempt's questions",
        );
      }
      const questionsForPrompt = questions.map((question) =>
        mergeMutableSnapshot(question, incomingByQuestion.get(question.questionId)!),
      );
      if (
        questionsForPrompt.length === 0 ||
        questionsForPrompt.some((question) => !question.userAnswer.trim())
      ) {
        return abortAndThrow(
          transaction,
          completed,
          "请先完成当前试卷的全部题目，再提交整卷批改。",
        );
      }
      prompt = buildFullPaperPrompt({
        paperName: paper.paperName,
        attemptId,
        questions: questionsForPrompt,
        totalElapsedSeconds:
          snapshotInput?.mode === "full-paper"
            ? snapshotInput.totalElapsedSeconds
            : attempt.totalElapsedSeconds,
      });
      snapshots = questionsForPrompt.map(cloneQuestionSnapshot);
      attemptTimer = snapshotInput?.mode === "full-paper"
        ? { ...snapshotInput.attemptTimer }
        : { ...attempt.timer };
      totalElapsedSeconds = snapshotInput?.mode === "full-paper"
        ? snapshotInput.totalElapsedSeconds
        : attempt.totalElapsedSeconds;
      try {
        assertTimerSnapshot(attemptTimer, "attempt snapshot");
        assertPausedTimer(attemptTimer, "attempt snapshot timer");
      } catch (error: unknown) {
        return abortAndThrow(
          transaction,
          completed,
          error instanceof Error ? error.message : "Invalid attempt timer snapshot",
        );
      }
      if (!Number.isFinite(totalElapsedSeconds) || totalElapsedSeconds < 0) {
        return abortAndThrow(
          transaction,
          completed,
          "totalElapsedSeconds must be a non-negative number",
        );
      }
    }

    const now = Date.now();
    const record: SubmissionOutboxRecord = {
      schemaVersion: PERSISTED_ENTITY_VERSION,
      requestId,
      attemptId,
      paperId: paper.paperId,
      handoff:
        handoff.mode === "single-question"
          ? { mode: "single-question", questionId: handoff.questionId }
          : { mode: "full-paper" },
      prompt,
      questions: snapshots,
      attemptTimer,
      totalElapsedSeconds,
      status: "prepared",
      createdAt: now,
      updatedAt: now,
      deliveringAt: null,
      finalizedAt: null,
      cancelledAt: null,
    };
    outboxStore.add(record);
    await completed;
    return { record, binding };
  }

  public async get(
    attemptId: AttemptId,
    requestId: string,
  ): Promise<SubmissionOutboxRecord | null> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.submissionOutbox, "readonly");
    const value = await requestToPromise(
      transaction.objectStore(STORE_NAMES.submissionOutbox).get(requestId),
    );
    const record = (value as SubmissionOutboxRecord | undefined) ?? null;
    if (record) {
      assertRecordIdentity(record, attemptId, requestId);
    }
    return record;
  }

  public async getPrepared(
    attemptId: AttemptId,
    requestId: string,
  ): Promise<PreparedSubmissionRecord> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [STORE_NAMES.submissionOutbox, STORE_NAMES.conversationBindings],
      "readonly",
    );
    const [recordValue, bindingValue] = await Promise.all([
      requestToPromise(transaction.objectStore(STORE_NAMES.submissionOutbox).get(requestId)),
      requestToPromise(transaction.objectStore(STORE_NAMES.conversationBindings).get(attemptId)),
    ]);
    const record = recordValue as SubmissionOutboxRecord | undefined;
    if (!record) {
      throw new Error("Prepared submission was not found");
    }
    assertRecordIdentity(record, attemptId, requestId);
    if (!ACTIVE_OUTBOX_STATUSES.has(record.status)) {
      throw new Error("Submission is no longer prepared for delivery");
    }
    const binding = (bindingValue as ConversationBinding | undefined) ?? null;
    if (binding && (binding.attemptId !== attemptId || binding.paperId !== record.paperId)) {
      throw new Error("Conversation binding does not belong to the prepared submission");
    }
    return { record, binding };
  }

  public async getActive(attemptId: AttemptId): Promise<SubmissionOutboxRecord | null> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.submissionOutbox, "readonly");
    const values = (await requestToPromise(
      transaction.objectStore(STORE_NAMES.submissionOutbox).index("attemptId").getAll(attemptId),
    )) as SubmissionOutboxRecord[];
    const active = values.filter((record) => ACTIVE_OUTBOX_STATUSES.has(record.status));
    if (active.length > 1) {
      throw new Error("Attempt has more than one active submission outbox record");
    }
    const record = active[0] ?? null;
    if (record && record.attemptId !== attemptId) {
      throw new Error("IndexedDB returned an outbox record from another attempt");
    }
    return record;
  }

  public async markDelivering(
    attemptId: AttemptId,
    requestId: string,
    now: number = Date.now(),
  ): Promise<MarkPreparedSubmissionDeliveringResult> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.submissionOutbox, "readwrite");
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.submissionOutbox);
    const record = (await requestToPromise(store.get(requestId))) as
      | SubmissionOutboxRecord
      | undefined;
    if (!record) {
      return abortAndThrow(transaction, completed, "Prepared submission was not found");
    }
    if (record.attemptId !== attemptId) {
      return abortAndThrow(
        transaction,
        completed,
        "Submission request does not belong to the supplied attemptId",
      );
    }
    if (record.status === "cancelled") {
      return abortAndThrow(transaction, completed, "Cancelled submission cannot be delivered");
    }
    if (record.status === "prepared") {
      store.put({
        ...record,
        status: "delivering",
        deliveringAt: record.deliveringAt ?? now,
        updatedAt: now,
      } satisfies SubmissionOutboxRecord);
      await completed;
      return "acquired";
    }
    await completed;
    return record.status === "delivering" ? "already-delivering" : "already-finalized";
  }

  /** Atomically restores the prepared snapshot and marks its target terminal. */
  public async finalize(
    attemptId: AttemptId,
    requestId: string,
    now: number = Date.now(),
  ): Promise<void> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [
        STORE_NAMES.papers,
        STORE_NAMES.attempts,
        STORE_NAMES.questions,
        STORE_NAMES.submissionOutbox,
      ],
      "readwrite",
    );
    const completed = transactionToPromise(transaction);
    const outboxStore = transaction.objectStore(STORE_NAMES.submissionOutbox);
    const record = (await requestToPromise(outboxStore.get(requestId))) as
      | SubmissionOutboxRecord
      | undefined;
    if (!record) {
      return abortAndThrow(transaction, completed, "Prepared submission was not found");
    }
    if (record.attemptId !== attemptId) {
      return abortAndThrow(
        transaction,
        completed,
        "Submission request does not belong to the supplied attemptId",
      );
    }
    if (record.status === "cancelled") {
      return abortAndThrow(transaction, completed, "Cancelled submission cannot be finalized");
    }
    if (record.status === "finalized") {
      await completed;
      return;
    }

    const attemptStore = transaction.objectStore(STORE_NAMES.attempts);
    const questionStore = transaction.objectStore(STORE_NAMES.questions);
    const [attemptValue, paperValue, questionValues] = await Promise.all([
      requestToPromise(attemptStore.get(attemptId)),
      requestToPromise(transaction.objectStore(STORE_NAMES.papers).get(record.paperId)),
      requestToPromise(questionStore.index("attemptId").getAll(attemptId)),
    ]);
    const attempt = attemptValue as PaperAttempt | undefined;
    const paper = paperValue as PaperDefinition | undefined;
    if (!attempt || !paper) {
      return abortAndThrow(
        transaction,
        completed,
        "Submission references a missing attempt or paper",
      );
    }
    const questions = questionValues as QuestionAttempt[];
    try {
      assertRecordSnapshot(record, attempt, paper, questions);
    } catch (error: unknown) {
      return abortAndThrow(
        transaction,
        completed,
        error instanceof Error ? error.message : "Invalid submission snapshot",
      );
    }

    const snapshotsByQuestion = new Map(
      record.questions.map((snapshot) => [snapshot.questionId, snapshot] as const),
    );
    const affectedQuestionId =
      record.handoff.mode === "single-question" ? record.handoff.questionId : null;
    const affectedQuestions = affectedQuestionId === null
      ? questions
      : questions.filter((question) => question.questionId === affectedQuestionId);
    const finalizedQuestions = new Map<string, QuestionAttempt>();
    for (const question of affectedQuestions) {
      const snapshot = snapshotsByQuestion.get(question.questionId);
      if (!snapshot) {
        return abortAndThrow(
          transaction,
          completed,
          "Submission snapshot is missing an affected question",
        );
      }
      const status = record.handoff.mode === "single-question"
        ? question.status === "graded"
          ? "graded"
          : "submitted"
        : question.status === "graded" || question.status === "submitted"
          ? question.status
          : "answered";
      const updatedQuestion: QuestionAttempt = {
        ...question,
        userAnswer: snapshot.userAnswer,
        elapsedSeconds: snapshot.elapsedSeconds,
        timer: { ...snapshot.timer },
        status,
        submittedAt:
          record.handoff.mode === "single-question"
            ? (question.submittedAt ?? now)
            : question.submittedAt,
        updatedAt: Math.max(question.updatedAt, now),
      };
      finalizedQuestions.set(question.questionId, updatedQuestion);
      questionStore.put(updatedQuestion);
    }

    if (record.handoff.mode === "full-paper") {
      if (record.attemptTimer === null || record.totalElapsedSeconds === null) {
        return abortAndThrow(transaction, completed, "Full-paper snapshot is incomplete");
      }
      attemptStore.put({
        ...attempt,
        timer: { ...record.attemptTimer },
        totalElapsedSeconds: record.totalElapsedSeconds,
        status: "submitted",
        submittedAt: attempt.submittedAt ?? now,
        updatedAt: Math.max(attempt.updatedAt, now),
      } satisfies PaperAttempt);
    } else if (attempt.status !== "submitted") {
      const allQuestions = questions.map(
        (question) => finalizedQuestions.get(question.questionId) ?? question,
      );
      const allAnswered = allQuestions.every(
        (question) => question.userAnswer.trim().length > 0,
      );
      attemptStore.put({
        ...attempt,
        status: allAnswered ? "completed" : "answering",
        completedAt: allAnswered ? (attempt.completedAt ?? now) : null,
        updatedAt: Math.max(attempt.updatedAt, now),
      } satisfies PaperAttempt);
    }

    outboxStore.put({
      ...record,
      status: "finalized",
      finalizedAt: record.finalizedAt ?? now,
      updatedAt: now,
    } satisfies SubmissionOutboxRecord);
    await completed;
  }

  public async cancel(
    attemptId: AttemptId,
    requestId: string,
    now: number = Date.now(),
    confirmedUnsent = false,
  ): Promise<CancelPreparedSubmissionResult> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.submissionOutbox, "readwrite");
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.submissionOutbox);
    const record = (await requestToPromise(store.get(requestId))) as
      | SubmissionOutboxRecord
      | undefined;
    if (!record) {
      await completed;
      return "not-found";
    }
    if (record.attemptId !== attemptId) {
      return abortAndThrow(
        transaction,
        completed,
        "Submission request does not belong to the supplied attemptId",
      );
    }
    if (record.status === "delivering" && !confirmedUnsent) {
      await completed;
      return "already-started";
    }
    if (record.status === "finalized") {
      await completed;
      return "already-finalized";
    }
    if (record.status === "cancelled") {
      await completed;
      return "cancelled";
    }
    store.put({
      ...record,
      status: "cancelled",
      cancelledAt: record.cancelledAt ?? now,
      updatedAt: now,
    } satisfies SubmissionOutboxRecord);
    await completed;
    return "cancelled";
  }

  public toSubmission(prepared: PreparedSubmissionRecord): FeedbackSubmission {
    return toSubmission(prepared.record, prepared.binding);
  }
}

export const submissionOutboxRepository = new SubmissionOutboxRepository();
