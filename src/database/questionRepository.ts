import type {
  AttemptId,
  QuestionAttempt,
  QuestionId,
  SaveQuestionDraftInput,
} from "../types";
import { makeQuestionAttemptId } from "../utils/ids";
import {
  STORE_NAMES,
  getDefaultDatabase,
  readAllFromIndex,
  requestToPromise,
  transactionToPromise,
  type DatabaseProvider,
} from "./indexedDB";

function assertQuestionKey(question: QuestionAttempt): void {
  const expectedId = makeQuestionAttemptId(question.attemptId, question.questionId);
  if (question.id !== expectedId) {
    throw new Error("QuestionAttempt.id must be derived from attemptId and questionId");
  }
}

export class QuestionRepository {
  public constructor(private readonly databaseProvider: DatabaseProvider = getDefaultDatabase) {}

  public async get(
    attemptId: AttemptId,
    questionId: QuestionId,
  ): Promise<QuestionAttempt | null> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.questions, "readonly");
    const value = await requestToPromise(
      transaction.objectStore(STORE_NAMES.questions).index("attemptQuestion").get([
        attemptId,
        questionId,
      ]),
    );
    const question = (value as QuestionAttempt | undefined) ?? null;
    if (question && question.attemptId !== attemptId) {
      throw new Error("IndexedDB returned a question from another attempt");
    }
    return question;
  }

  public async listByAttempt(attemptId: AttemptId): Promise<QuestionAttempt[]> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.questions, "readonly");
    const values = await readAllFromIndex<QuestionAttempt>(
      transaction.objectStore(STORE_NAMES.questions).index("attemptId"),
      attemptId,
    );
    return values.sort((left, right) => left.index - right.index);
  }

  public async save(question: QuestionAttempt): Promise<void> {
    assertQuestionKey(question);
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [STORE_NAMES.questions, STORE_NAMES.attempts],
      "readwrite",
    );
    const completed = transactionToPromise(transaction);
    const attempt = (await requestToPromise(
      transaction.objectStore(STORE_NAMES.attempts).get(question.attemptId),
    )) as { readonly paperId?: string } | undefined;
    if (!attempt || attempt.paperId !== question.paperId) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("QuestionAttempt does not belong to the supplied PaperAttempt");
    }
    transaction.objectStore(STORE_NAMES.questions).put(question);
    await completed;
  }

  public async saveMany(questions: readonly QuestionAttempt[]): Promise<void> {
    for (const question of questions) {
      assertQuestionKey(question);
    }
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [STORE_NAMES.questions, STORE_NAMES.attempts],
      "readwrite",
    );
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.questions);
    const attemptIds = [...new Set(questions.map((question) => question.attemptId))];
    const attempts = await Promise.all(
      attemptIds.map((attemptId) =>
        requestToPromise(transaction.objectStore(STORE_NAMES.attempts).get(attemptId)),
      ),
    );
    const paperByAttempt = new Map(
      attempts.map((attempt, index) => [
        attemptIds[index]!,
        (attempt as { readonly paperId?: string } | undefined)?.paperId,
      ]),
    );
    if (questions.some((question) => paperByAttempt.get(question.attemptId) !== question.paperId)) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("At least one QuestionAttempt does not belong to its PaperAttempt");
    }
    for (const question of questions) {
      store.put(question);
    }
    await completed;
  }

  public async saveDraft(input: SaveQuestionDraftInput): Promise<QuestionAttempt> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.questions, "readwrite");
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.questions);
    const current = (await requestToPromise(
      store.index("attemptQuestion").get([input.attemptId, input.questionId]),
    )) as QuestionAttempt | undefined;
    if (!current || current.attemptId !== input.attemptId) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("Question attempt was not found for the supplied attemptId");
    }

    const now = input.now ?? Date.now();
    const answerHasContent = input.userAnswer.trim().length > 0;
    const updated: QuestionAttempt = {
      ...current,
      userAnswer: input.userAnswer,
      elapsedSeconds: input.elapsedSeconds ?? current.elapsedSeconds,
      timer: input.timer ?? current.timer,
      status:
        current.status === "submitted" || current.status === "graded"
          ? current.status
          : answerHasContent
            ? "answered"
            : "unanswered",
      updatedAt: now,
    };
    store.put(updated);
    await completed;
    return updated;
  }
}

export const questionRepository = new QuestionRepository();
