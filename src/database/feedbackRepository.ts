import {
  PERSISTED_ENTITY_VERSION,
  type AttemptId,
  type FeedbackRecord,
  type GradingFeedback,
  type PaperId,
  type QuestionId,
} from "../types";
import { createFeedbackId } from "../utils/ids";
import {
  STORE_NAMES,
  getDefaultDatabase,
  readAllFromIndex,
  requestToPromise,
  transactionToPromise,
  type DatabaseProvider,
} from "./indexedDB";

export interface CreateFeedbackRecordInput {
  readonly attemptId: AttemptId;
  readonly paperId: PaperId;
  readonly questionId: QuestionId | null;
  readonly feedback: GradingFeedback;
}

function assertFeedbackScope(record: FeedbackRecord): void {
  if (record.scope === "question" && record.questionId === null) {
    throw new Error("Question feedback requires questionId");
  }
  if (record.scope === "paper" && record.questionId !== null) {
    throw new Error("Paper feedback must not contain questionId");
  }
}

export class FeedbackRepository {
  public constructor(private readonly databaseProvider: DatabaseProvider = getDefaultDatabase) {}

  public async save(record: FeedbackRecord): Promise<void> {
    assertFeedbackScope(record);
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [STORE_NAMES.feedback, STORE_NAMES.attempts, STORE_NAMES.questions],
      "readwrite",
    );
    const completed = transactionToPromise(transaction);
    const attemptRequest = transaction.objectStore(STORE_NAMES.attempts).get(record.attemptId);
    const questionRequest =
      record.questionId === null
        ? null
        : transaction
            .objectStore(STORE_NAMES.questions)
            .index("attemptQuestion")
            .get([record.attemptId, record.questionId]);
    const [attemptValue, questionValue] = await Promise.all([
      requestToPromise(attemptRequest),
      questionRequest ? requestToPromise(questionRequest) : Promise.resolve(undefined),
    ]);
    const attempt = attemptValue as { readonly paperId?: string } | undefined;
    const question = questionValue as { readonly paperId?: string; readonly attemptId?: string } | undefined;
    if (
      !attempt ||
      attempt.paperId !== record.paperId ||
      (record.questionId !== null &&
        (!question ||
          question.attemptId !== record.attemptId ||
          question.paperId !== record.paperId))
    ) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("FeedbackRecord does not belong to the supplied PaperAttempt");
    }
    transaction.objectStore(STORE_NAMES.feedback).put(record);
    await completed;
  }

  public async create(input: CreateFeedbackRecordInput): Promise<FeedbackRecord> {
    const record: FeedbackRecord = {
      schemaVersion: PERSISTED_ENTITY_VERSION,
      feedbackId: createFeedbackId(),
      attemptId: input.attemptId,
      paperId: input.paperId,
      questionId: input.questionId,
      scope: input.questionId === null ? "paper" : "question",
      feedback: input.feedback,
      createdAt: input.feedback.createdAt,
    };
    await this.save(record);
    return record;
  }

  public async listByAttempt(attemptId: AttemptId): Promise<FeedbackRecord[]> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.feedback, "readonly");
    const values = await readAllFromIndex<FeedbackRecord>(
      transaction.objectStore(STORE_NAMES.feedback).index("attemptId"),
      attemptId,
    );
    return values.sort((left, right) => right.createdAt - left.createdAt);
  }

  public async getLatest(
    attemptId: AttemptId,
    questionId: QuestionId | null,
  ): Promise<FeedbackRecord | null> {
    const records = await this.listByAttempt(attemptId);
    return records.find((record) => record.questionId === questionId) ?? null;
  }
}

export const feedbackRepository = new FeedbackRepository();
