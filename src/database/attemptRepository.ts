import type { AttemptId, PaperAttempt, PaperId } from "../types";
import {
  STORE_NAMES,
  getDefaultDatabase,
  readAllFromIndex,
  requestToPromise,
  transactionToPromise,
  type DatabaseProvider,
} from "./indexedDB";

export class AttemptRepository {
  public constructor(private readonly databaseProvider: DatabaseProvider = getDefaultDatabase) {}

  public async get(attemptId: AttemptId): Promise<PaperAttempt | null> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.attempts, "readonly");
    const value = await requestToPromise(
      transaction.objectStore(STORE_NAMES.attempts).get(attemptId),
    );
    return (value as PaperAttempt | undefined) ?? null;
  }

  public async listByPaper(paperId: PaperId): Promise<PaperAttempt[]> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.attempts, "readonly");
    const values = await readAllFromIndex<PaperAttempt>(
      transaction.objectStore(STORE_NAMES.attempts).index("paperId"),
      paperId,
    );
    return values.sort((left, right) => right.attemptNumber - left.attemptNumber);
  }

  public async listRecent(limit = 50): Promise<PaperAttempt[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("limit must be a positive integer");
    }
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.attempts, "readonly");
    return readAllFromIndex<PaperAttempt>(
      transaction.objectStore(STORE_NAMES.attempts).index("updatedAt"),
      null,
      "prev",
      limit,
    );
  }

  public async save(attempt: PaperAttempt): Promise<void> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [STORE_NAMES.attempts, STORE_NAMES.papers],
      "readwrite",
    );
    const completed = transactionToPromise(transaction);
    const paper = await requestToPromise(
      transaction.objectStore(STORE_NAMES.papers).get(attempt.paperId),
    );
    if (!paper) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("PaperAttempt references a missing PaperDefinition");
    }
    transaction.objectStore(STORE_NAMES.attempts).put(attempt);
    await completed;
  }
}

export const attemptRepository = new AttemptRepository();
