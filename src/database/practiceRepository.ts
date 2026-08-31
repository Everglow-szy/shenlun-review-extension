import {
  DEFAULT_SETTINGS,
  PERSISTED_ENTITY_VERSION,
  type AttemptBundle,
  type AttemptId,
  type ConversationBinding,
  type CreateAttemptInput,
  type PaperAttempt,
  type PaperDefinition,
  type PersistedTimerState,
  type QuestionAttempt,
  type SaveQuestionDraftInput,
  type TimerCheckpointInput,
} from "../types";
import { checkpointTimer, createTimerCoordinatorSnapshot, getElapsedSeconds } from "../services/timerService";
import { buildConversationName, formatLocalDate } from "../utils/dateTime";
import { createAttemptId, makeQuestionAttemptId } from "../utils/ids";
import {
  STORE_NAMES,
  getDefaultDatabase,
  requestToPromise,
  transactionToPromise,
  type DatabaseProvider,
} from "./indexedDB";

export interface CreatedAttemptRecords {
  readonly attempt: PaperAttempt;
  readonly questions: readonly QuestionAttempt[];
  readonly conversation: ConversationBinding;
}

async function abortAndThrow(
  transaction: IDBTransaction,
  completed: Promise<void>,
  message: string,
): Promise<never> {
  transaction.abort();
  await completed.catch(() => undefined);
  throw new Error(message);
}

export class PracticeRepository {
  public constructor(private readonly databaseProvider: DatabaseProvider = getDefaultDatabase) {}

  /** Atomically creates an attempt, all question attempts, and its pending conversation binding. */
  public async createAttempt(input: CreateAttemptInput): Promise<CreatedAttemptRecords> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [
        STORE_NAMES.papers,
        STORE_NAMES.attempts,
        STORE_NAMES.questions,
        STORE_NAMES.conversationBindings,
        STORE_NAMES.settings,
      ],
      "readwrite",
    );
    const completed = transactionToPromise(transaction);
    const paperRequest = transaction.objectStore(STORE_NAMES.papers).get(input.paperId);
    const attemptsRequest = transaction
      .objectStore(STORE_NAMES.attempts)
      .index("paperId")
      .getAll(input.paperId);
    const settingsRequest = transaction.objectStore(STORE_NAMES.settings).get("app");
    const [paperValue, attemptsValue, settingsValue] = await Promise.all([
      requestToPromise(paperRequest),
      requestToPromise(attemptsRequest),
      requestToPromise(settingsRequest),
    ]);
    const paper = paperValue as PaperDefinition | undefined;
    if (!paper) {
      return abortAndThrow(transaction, completed, "Paper definition was not found");
    }
    if (paper.questions.length === 0) {
      return abortAndThrow(transaction, completed, "Cannot create an attempt for an empty paper");
    }

    const previousAttempts = attemptsValue as PaperAttempt[];
    const attemptNumber =
      previousAttempts.reduce((maximum, attempt) => Math.max(maximum, attempt.attemptNumber), 0) + 1;
    const now = input.now ?? Date.now();
    const attemptDate = formatLocalDate(now);
    const sameDayAttemptNumber =
      previousAttempts.filter((attempt) => formatLocalDate(attempt.createdAt) === attemptDate).length +
      1;
    const startImmediately = input.startImmediately ?? true;
    const activeQuestionId = input.activeQuestionId ?? paper.questions[0]?.questionId ?? null;
    if (!paper.questions.some((question) => question.questionId === activeQuestionId)) {
      return abortAndThrow(
        transaction,
        completed,
        "activeQuestionId does not belong to the selected paper",
      );
    }
    const attemptId = createAttemptId();
    const timers = createTimerCoordinatorSnapshot(
      paper.questions.map((question) => question.questionId),
      activeQuestionId,
      now,
      startImmediately,
    );
    const attempt: PaperAttempt = {
      schemaVersion: PERSISTED_ENTITY_VERSION,
      attemptId,
      paperId: paper.paperId,
      attemptNumber,
      status: startImmediately ? "answering" : "new",
      totalElapsedSeconds: 0,
      timer: timers.attemptTimer,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      submittedAt: null,
    };
    const questions: QuestionAttempt[] = paper.questions.map((question) => ({
      schemaVersion: PERSISTED_ENTITY_VERSION,
      id: makeQuestionAttemptId(attemptId, question.questionId),
      attemptId,
      paperId: paper.paperId,
      questionId: question.questionId,
      index: question.index,
      title: question.title,
      questionText: question.questionText,
      materials: [...question.materials],
      score: question.score,
      wordLimit: question.wordLimit,
      referenceAnswer: question.referenceAnswer,
      userAnswer: "",
      elapsedSeconds: 0,
      timer: timers.questionTimers[question.questionId]!,
      status:
        startImmediately && question.questionId === activeQuestionId ? "answering" : "unanswered",
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
    }));
    const settings = { ...DEFAULT_SETTINGS, ...(settingsValue as object | undefined) };
    const conversation: ConversationBinding = {
      schemaVersion: PERSISTED_ENTITY_VERSION,
      attemptId,
      paperId: paper.paperId,
      projectName: settings.projectName,
      ...(settings.projectUrl ? { projectUrl: settings.projectUrl } : {}),
      conversationName: buildConversationName(attemptDate, paper.paperName, sameDayAttemptNumber),
      createdAt: now,
      lastUsedAt: now,
    };

    transaction.objectStore(STORE_NAMES.attempts).add(attempt);
    const questionStore = transaction.objectStore(STORE_NAMES.questions);
    for (const question of questions) {
      questionStore.add(question);
    }
    transaction.objectStore(STORE_NAMES.conversationBindings).add(conversation);
    transaction.objectStore(STORE_NAMES.papers).put({ ...paper, updatedAt: now });
    await completed;
    return { attempt, questions, conversation };
  }

  public async loadBundle(attemptId: AttemptId): Promise<AttemptBundle | null> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [
        STORE_NAMES.papers,
        STORE_NAMES.attempts,
        STORE_NAMES.questions,
        STORE_NAMES.conversationBindings,
        STORE_NAMES.feedback,
      ],
      "readonly",
    );
    const attemptRequest = transaction.objectStore(STORE_NAMES.attempts).get(attemptId);
    const questionsRequest = transaction
      .objectStore(STORE_NAMES.questions)
      .index("attemptId")
      .getAll(attemptId);
    const conversationRequest = transaction
      .objectStore(STORE_NAMES.conversationBindings)
      .get(attemptId);
    const feedbackRequest = transaction
      .objectStore(STORE_NAMES.feedback)
      .index("attemptId")
      .getAll(attemptId);
    const [attemptValue, questionValues, conversationValue, feedbackValues] = await Promise.all([
      requestToPromise(attemptRequest),
      requestToPromise(questionsRequest),
      requestToPromise(conversationRequest),
      requestToPromise(feedbackRequest),
    ]);
    const attempt = attemptValue as PaperAttempt | undefined;
    if (!attempt) {
      return null;
    }
    const paperTransaction = database.transaction(STORE_NAMES.papers, "readonly");
    const paperValue = await requestToPromise(
      paperTransaction.objectStore(STORE_NAMES.papers).get(attempt.paperId),
    );
    const paper = paperValue as PaperDefinition | undefined;
    if (!paper) {
      throw new Error("Attempt references a missing paper definition");
    }
    const questions = (questionValues as QuestionAttempt[]).sort(
      (left, right) => left.index - right.index,
    );
    if (questions.some((question) => question.attemptId !== attemptId)) {
      throw new Error("Attempt bundle contains a question from another attempt");
    }
    const conversation = (conversationValue as ConversationBinding | undefined) ?? null;
    if (conversation && conversation.attemptId !== attemptId) {
      throw new Error("Attempt bundle contains a conversation from another attempt");
    }
    const feedback = [...(feedbackValues as AttemptBundle["feedback"])].sort(
      (left, right) => right.createdAt - left.createdAt,
    );
    if (feedback.some((record) => record.attemptId !== attemptId)) {
      throw new Error("Attempt bundle contains feedback from another attempt");
    }
    return {
      paper,
      attempt,
      questions,
      conversation,
      feedback,
    };
  }

  public async saveQuestionDraft(input: SaveQuestionDraftInput): Promise<QuestionAttempt> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [STORE_NAMES.attempts, STORE_NAMES.questions],
      "readwrite",
    );
    const completed = transactionToPromise(transaction);
    const questionStore = transaction.objectStore(STORE_NAMES.questions);
    const questionRequest = questionStore
      .index("attemptQuestion")
      .get([input.attemptId, input.questionId]);
    const allQuestionsRequest = questionStore.index("attemptId").getAll(input.attemptId);
    const attemptRequest = transaction.objectStore(STORE_NAMES.attempts).get(input.attemptId);
    const [questionValue, allQuestionsValue, attemptValue] = await Promise.all([
      requestToPromise(questionRequest),
      requestToPromise(allQuestionsRequest),
      requestToPromise(attemptRequest),
    ]);
    const current = questionValue as QuestionAttempt | undefined;
    const attempt = attemptValue as PaperAttempt | undefined;
    if (!current || !attempt || current.attemptId !== input.attemptId) {
      return abortAndThrow(
        transaction,
        completed,
        "Question attempt was not found for the supplied attemptId",
      );
    }
    if (
      attempt.status === "submitted" ||
      current.submittedAt !== null ||
      current.status === "submitted" ||
      current.status === "graded"
    ) {
      await completed;
      return current;
    }
    const now = input.now ?? Date.now();
    const answerHasContent = input.userAnswer.trim().length > 0;
    const shouldUseIncomingTimer = Boolean(
      input.timer && input.timer.checkpointedAt >= current.timer.checkpointedAt,
    );
    const finalTimer = shouldUseIncomingTimer ? input.timer! : current.timer;
    const question: QuestionAttempt = {
      ...current,
      userAnswer: input.userAnswer,
      elapsedSeconds: input.timer
        ? getElapsedSeconds(finalTimer, now)
        : (input.elapsedSeconds ?? current.elapsedSeconds),
      timer: finalTimer,
      status: answerHasContent ? "answered" : "unanswered",
      updatedAt: now,
    };
    const allQuestions = (allQuestionsValue as QuestionAttempt[]).map((candidate) =>
      candidate.questionId === question.questionId ? question : candidate,
    );
    if (
      allQuestions.length === 0 ||
      allQuestions.some((candidate) => candidate.attemptId !== input.attemptId)
    ) {
      return abortAndThrow(
        transaction,
        completed,
        "Question list does not belong to the supplied attemptId",
      );
    }
    const allAnswered = allQuestions.every(
      (candidate) => candidate.userAnswer.trim().length > 0,
    );
    const updatedAttempt: PaperAttempt = {
      ...attempt,
      status: allAnswered ? "completed" : "answering",
      completedAt: allAnswered ? (attempt.completedAt ?? now) : null,
      updatedAt: now,
    };
    questionStore.put(question);
    transaction.objectStore(STORE_NAMES.attempts).put(updatedAttempt);
    await completed;
    return question;
  }

  public async saveTimerCheckpoint(input: TimerCheckpointInput): Promise<void> {
    const entries = Object.entries(input.questionTimers);
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [STORE_NAMES.attempts, STORE_NAMES.questions],
      "readwrite",
    );
    const completed = transactionToPromise(transaction);
    const attemptStore = transaction.objectStore(STORE_NAMES.attempts);
    const questionStore = transaction.objectStore(STORE_NAMES.questions);
    const attemptRequest = attemptStore.get(input.attemptId);
    const questionRequests = entries.map(([questionId]) =>
      questionStore.index("attemptQuestion").get([input.attemptId, questionId]),
    );
    const [attemptValue, questionValues] = await Promise.all([
      requestToPromise(attemptRequest),
      Promise.all(questionRequests.map((request) => requestToPromise(request))),
    ]);
    const attempt = attemptValue as PaperAttempt | undefined;
    if (!attempt) {
      return abortAndThrow(transaction, completed, "Paper attempt was not found");
    }
    const questions = questionValues as Array<QuestionAttempt | undefined>;
    if (questions.some((question) => !question || question.attemptId !== input.attemptId)) {
      return abortAndThrow(
        transaction,
        completed,
        "Timer checkpoint contains a question from another attempt",
      );
    }
    if (attempt.status === "submitted") {
      await completed;
      return;
    }

    const now = input.now ?? Date.now();
    const timerChangedSince = (
      incoming: PersistedTimerState,
      stored: PersistedTimerState,
    ): boolean => incoming.accumulatedMilliseconds !== stored.accumulatedMilliseconds ||
      incoming.runningSince !== stored.runningSince ||
      incoming.checkpointedAt !== stored.checkpointedAt;
    const shouldApplyTimer = (
      incoming: PersistedTimerState,
      stored: PersistedTimerState,
    ): boolean => incoming.checkpointedAt > stored.checkpointedAt || (
      incoming.checkpointedAt === stored.checkpointedAt &&
      timerChangedSince(incoming, stored)
    );

    if (shouldApplyTimer(input.attemptTimer, attempt.timer)) {
      const attemptTimer = checkpointTimer(input.attemptTimer, now);
      attemptStore.put({
        ...attempt,
        timer: attemptTimer,
        totalElapsedSeconds: getElapsedSeconds(attemptTimer, now),
        updatedAt: Math.max(attempt.updatedAt, now),
      } satisfies PaperAttempt);
    }
    entries.forEach(([questionId, timer], index) => {
      const question = questions[index];
      if (!question) {
        return;
      }
      if (question.submittedAt !== null) return;
      if (!shouldApplyTimer(timer, question.timer)) return;
      const checkpointed = checkpointTimer(timer, now);
      questionStore.put({
        ...question,
        timer: checkpointed,
        elapsedSeconds: getElapsedSeconds(checkpointed, now),
        updatedAt: Math.max(question.updatedAt, now),
      } satisfies QuestionAttempt);
      if (question.questionId !== questionId) {
        transaction.abort();
      }
    });
    await completed;
  }

  public async markQuestionSubmitted(
    attemptId: AttemptId,
    questionId: string,
    now: number = Date.now(),
  ): Promise<void> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.questions, "readwrite");
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.questions);
    const value = await requestToPromise(
      store.index("attemptQuestion").get([attemptId, questionId]),
    );
    const question = value as QuestionAttempt | undefined;
    if (!question || question.attemptId !== attemptId) {
      return abortAndThrow(transaction, completed, "Question attempt was not found");
    }
    store.put({
      ...question,
      status: question.status === "graded" ? "graded" : "submitted",
      submittedAt: question.submittedAt ?? now,
      updatedAt: now,
    });
    await completed;
  }

  public async markQuestionGraded(
    attemptId: AttemptId,
    questionId: string,
    now: number = Date.now(),
  ): Promise<void> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.questions, "readwrite");
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.questions);
    const value = await requestToPromise(
      store.index("attemptQuestion").get([attemptId, questionId]),
    );
    const question = value as QuestionAttempt | undefined;
    if (!question || question.attemptId !== attemptId) {
      return abortAndThrow(transaction, completed, "Question attempt was not found");
    }
    store.put({ ...question, status: "graded", updatedAt: now });
    await completed;
  }

  public async markAttemptSubmitted(
    attemptId: AttemptId,
    now: number = Date.now(),
  ): Promise<void> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.attempts, "readwrite");
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.attempts);
    const value = await requestToPromise(store.get(attemptId));
    const attempt = value as PaperAttempt | undefined;
    if (!attempt) {
      return abortAndThrow(transaction, completed, "Paper attempt was not found");
    }
    if (attempt.status === "submitted" && attempt.submittedAt !== null) {
      await completed;
      return;
    }
    store.put({
      ...attempt,
      status: "submitted",
      submittedAt: attempt.submittedAt ?? now,
      updatedAt: now,
    });
    await completed;
  }
}

export const practiceRepository = new PracticeRepository();
