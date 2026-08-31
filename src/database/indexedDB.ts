export const DATABASE_NAME = "shenlun-practice-assistant";
export const DATABASE_VERSION = 5;

export const STORE_NAMES = {
  papers: "papers",
  attempts: "attempts",
  questions: "questions",
  conversationBindings: "conversationBindings",
  conversationClaims: "conversationClaims",
  submissionOutbox: "submissionOutbox",
  feedback: "feedback",
  settings: "settings",
} as const;

export type StoreName = (typeof STORE_NAMES)[keyof typeof STORE_NAMES];
export type DatabaseProvider = () => Promise<IDBDatabase>;

export interface OpenDatabaseOptions {
  readonly name?: string;
  readonly factory?: IDBFactory;
}

function createIndex(
  store: IDBObjectStore,
  name: string,
  keyPath: string | readonly string[],
  options?: IDBIndexParameters,
): void {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath as string | string[], options);
  }
}

function normalizeMigratedConversationUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : trimmed;
  } catch {
    return trimmed;
  }
}

function migrateToVersion1(database: IDBDatabase): void {
  const papers = database.createObjectStore(STORE_NAMES.papers, { keyPath: "paperId" });
  createIndex(papers, "fingerprint", "fingerprint", { unique: true });
  createIndex(papers, "paperName", "paperName");
  createIndex(papers, "sourceUrl", "sourceUrl");
  createIndex(papers, "createdAt", "createdAt");
  createIndex(papers, "updatedAt", "updatedAt");

  const questions = database.createObjectStore(STORE_NAMES.questions, { keyPath: "id" });
  createIndex(questions, "paperId", "paperId");
  createIndex(questions, "questionId", "questionId");
  createIndex(questions, "createdAt", "createdAt");
  createIndex(questions, "status", "status");

  const bindings = database.createObjectStore(STORE_NAMES.conversationBindings, {
    keyPath: "attemptId",
  });
  createIndex(bindings, "paperId", "paperId");
  createIndex(bindings, "lastUsedAt", "lastUsedAt");

  const feedback = database.createObjectStore(STORE_NAMES.feedback, { keyPath: "feedbackId" });
  createIndex(feedback, "paperId", "paperId");
  createIndex(feedback, "questionId", "questionId");
  createIndex(feedback, "createdAt", "createdAt");

  database.createObjectStore(STORE_NAMES.settings, { keyPath: "key" });
}

/** Version 2 introduces first-class attempts and all attempt-scoped indexes. */
function migrateToVersion2(database: IDBDatabase, transaction: IDBTransaction): void {
  if (!database.objectStoreNames.contains(STORE_NAMES.attempts)) {
    const attempts = database.createObjectStore(STORE_NAMES.attempts, { keyPath: "attemptId" });
    createIndex(attempts, "paperId", "paperId");
    createIndex(attempts, "createdAt", "createdAt");
    createIndex(attempts, "updatedAt", "updatedAt");
    createIndex(attempts, "status", "status");
    createIndex(attempts, "paperAttemptNumber", ["paperId", "attemptNumber"], {
      unique: true,
    });
  }

  const questions = transaction.objectStore(STORE_NAMES.questions);
  createIndex(questions, "attemptId", "attemptId");
  createIndex(questions, "attemptQuestion", ["attemptId", "questionId"], { unique: true });

  const bindings = transaction.objectStore(STORE_NAMES.conversationBindings);
  createIndex(bindings, "attemptId", "attemptId", { unique: true });

  const feedback = transaction.objectStore(STORE_NAMES.feedback);
  createIndex(feedback, "attemptId", "attemptId");
  createIndex(feedback, "attemptQuestion", ["attemptId", "questionId"]);
}

/**
 * Version 3 guarantees that one ChatGPT conversation URL cannot be owned by two
 * attempts. Existing duplicates are detached from later cursor records before
 * the unique index is created, so an upgrade cannot be blocked by legacy data.
 */
function migrateToVersion3(transaction: IDBTransaction): void {
  const bindings = transaction.objectStore(STORE_NAMES.conversationBindings);
  if (bindings.indexNames.contains("conversationUrl")) {
    return;
  }

  const seenUrls = new Set<string>();
  const request = bindings.openCursor();
  request.onerror = () => transaction.abort();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      createIndex(bindings, "conversationUrl", "conversationUrl", { unique: true });
      return;
    }

    const binding = cursor.value as Record<string, unknown>;
    const conversationUrl = normalizeMigratedConversationUrl(binding.conversationUrl);
    if (conversationUrl.length === 0 || seenUrls.has(conversationUrl)) {
      if ("conversationUrl" in binding) {
        const migrated = { ...binding };
        delete migrated.conversationUrl;
        cursor.update(migrated);
      }
    } else {
      seenUrls.add(conversationUrl);
      if (conversationUrl !== binding.conversationUrl) {
        cursor.update({ ...binding, conversationUrl });
      }
    }
    cursor.continue();
  };
}

/**
 * Version 4 preserves URL ownership even after an attempt switches its active
 * conversation. Existing active bindings seed the append-only claim store.
 */
function migrateToVersion4(database: IDBDatabase, transaction: IDBTransaction): void {
  const claims = database.objectStoreNames.contains(STORE_NAMES.conversationClaims)
    ? transaction.objectStore(STORE_NAMES.conversationClaims)
    : database.createObjectStore(STORE_NAMES.conversationClaims, {
        keyPath: "conversationUrl",
      });
  createIndex(claims, "attemptId", "attemptId");
  createIndex(claims, "paperId", "paperId");
  createIndex(claims, "claimedAt", "claimedAt");

  const bindings = transaction.objectStore(STORE_NAMES.conversationBindings);
  const cursorRequest = bindings.openCursor();
  cursorRequest.onerror = () => transaction.abort();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) {
      return;
    }
    const binding = cursor.value as Record<string, unknown>;
    const conversationUrl = normalizeMigratedConversationUrl(binding.conversationUrl);
    const attemptId = typeof binding.attemptId === "string" ? binding.attemptId : "";
    const paperId = typeof binding.paperId === "string" ? binding.paperId : "";
    if (conversationUrl.length === 0 || attemptId.length === 0 || paperId.length === 0) {
      cursor.continue();
      return;
    }

    const claimRequest = claims.get(conversationUrl);
    claimRequest.onerror = () => transaction.abort();
    claimRequest.onsuccess = () => {
      if (claimRequest.result) {
        cursor.continue();
        return;
      }
      const addRequest = claims.add({
        schemaVersion: 1,
        conversationUrl,
        attemptId,
        paperId,
        claimedAt:
          typeof binding.createdAt === "number"
            ? binding.createdAt
            : typeof binding.lastUsedAt === "number"
              ? binding.lastUsedAt
              : Date.now(),
      });
      addRequest.onerror = () => transaction.abort();
      addRequest.onsuccess = () => cursor.continue();
    };
  };
}

/** Version 5 adds a durable, attempt-scoped submission outbox. */
function migrateToVersion5(database: IDBDatabase, transaction: IDBTransaction): void {
  const outbox = database.objectStoreNames.contains(STORE_NAMES.submissionOutbox)
    ? transaction.objectStore(STORE_NAMES.submissionOutbox)
    : database.createObjectStore(STORE_NAMES.submissionOutbox, {
        keyPath: "requestId",
      });
  createIndex(outbox, "attemptId", "attemptId");
  createIndex(outbox, "status", "status");
  createIndex(outbox, "attemptStatus", ["attemptId", "status"]);
}

function upgradeDatabase(
  database: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: number,
): void {
  if (oldVersion < 1) {
    migrateToVersion1(database);
  }
  if (oldVersion < 2) {
    migrateToVersion2(database, transaction);
  }
  if (oldVersion < 3) {
    migrateToVersion3(transaction);
  }
  if (oldVersion < 4) {
    migrateToVersion4(database, transaction);
  }
  if (oldVersion < 5) {
    migrateToVersion5(database, transaction);
  }
}

export function openShenlunDatabase(
  options: OpenDatabaseOptions = {},
): Promise<IDBDatabase> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) {
    return Promise.reject(new Error("IndexedDB is not available in this execution context"));
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(options.name ?? DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB"));
    request.onblocked = () =>
      reject(new Error("IndexedDB upgrade is blocked by another open extension context"));
    request.onupgradeneeded = (event) => {
      const transaction = request.transaction;
      if (!transaction) {
        throw new Error("IndexedDB upgrade transaction is unavailable");
      }
      upgradeDatabase(request.result, transaction, event.oldVersion);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

let defaultDatabasePromise: Promise<IDBDatabase> | null = null;

export function getDefaultDatabase(): Promise<IDBDatabase> {
  if (!defaultDatabasePromise) {
    defaultDatabasePromise = openShenlunDatabase().catch((error: unknown) => {
      defaultDatabasePromise = null;
      throw error;
    });
  }
  return defaultDatabasePromise;
}

export async function closeDefaultDatabase(): Promise<void> {
  const databasePromise = defaultDatabasePromise;
  defaultDatabasePromise = null;
  if (databasePromise) {
    (await databasePromise).close();
  }
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

export function readAllFromIndex<T>(
  index: IDBIndex,
  query?: IDBValidKey | IDBKeyRange | null,
  direction: IDBCursorDirection = "next",
  limit?: number,
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const values: T[] = [];
    const request = index.openCursor(query, direction);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || (limit !== undefined && values.length >= limit)) {
        resolve(values);
        return;
      }
      values.push(cursor.value as T);
      cursor.continue();
    };
  });
}

export function readAllFromStore<T>(
  store: IDBObjectStore,
  direction: IDBCursorDirection = "next",
  limit?: number,
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const values: T[] = [];
    const request = store.openCursor(null, direction);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || (limit !== undefined && values.length >= limit)) {
        resolve(values);
        return;
      }
      values.push(cursor.value as T);
      cursor.continue();
    };
  });
}
