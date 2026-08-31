import type { PaperDefinition, PaperId } from "../types";
import {
  STORE_NAMES,
  getDefaultDatabase,
  readAllFromIndex,
  requestToPromise,
  transactionToPromise,
  type DatabaseProvider,
} from "./indexedDB";

export class PaperRepository {
  public constructor(private readonly databaseProvider: DatabaseProvider = getDefaultDatabase) {}

  public async get(paperId: PaperId): Promise<PaperDefinition | null> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.papers, "readonly");
    const value = await requestToPromise(
      transaction.objectStore(STORE_NAMES.papers).get(paperId),
    );
    return (value as PaperDefinition | undefined) ?? null;
  }

  public async findByFingerprint(fingerprint: string): Promise<PaperDefinition | null> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.papers, "readonly");
    const value = await requestToPromise(
      transaction.objectStore(STORE_NAMES.papers).index("fingerprint").get(fingerprint),
    );
    return (value as PaperDefinition | undefined) ?? null;
  }

  public async findBySourceUrl(sourceUrl: string): Promise<PaperDefinition[]> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.papers, "readonly");
    return readAllFromIndex<PaperDefinition>(
      transaction.objectStore(STORE_NAMES.papers).index("sourceUrl"),
      sourceUrl,
    );
  }

  public async list(limit?: number): Promise<PaperDefinition[]> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.papers, "readonly");
    return readAllFromIndex<PaperDefinition>(
      transaction.objectStore(STORE_NAMES.papers).index("updatedAt"),
      null,
      "prev",
      limit,
    );
  }

  public async save(paper: PaperDefinition): Promise<void> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.papers, "readwrite");
    const completed = transactionToPromise(transaction);
    transaction.objectStore(STORE_NAMES.papers).put(paper);
    await completed;
  }
}

export const paperRepository = new PaperRepository();
