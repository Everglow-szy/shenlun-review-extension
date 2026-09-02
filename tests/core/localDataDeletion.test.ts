import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORE_NAMES,
  openShenlunDatabase,
  requestToPromise,
  transactionToPromise,
} from "../../src/database/indexedDB";
import { PracticeService } from "../../src/services/practiceService";

const databases: IDBDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function seedPracticeStores(database: IDBDatabase): Promise<void> {
  const storeNames = [
    STORE_NAMES.papers,
    STORE_NAMES.attempts,
    STORE_NAMES.questions,
    STORE_NAMES.conversationBindings,
    STORE_NAMES.conversationClaims,
    STORE_NAMES.submissionOutbox,
    STORE_NAMES.feedback,
  ] as const;
  const transaction = database.transaction(storeNames, "readwrite");
  const completed = transactionToPromise(transaction);
  transaction.objectStore(STORE_NAMES.papers).put({ paperId: "paper-1" });
  transaction.objectStore(STORE_NAMES.attempts).put({ attemptId: "attempt-1" });
  transaction.objectStore(STORE_NAMES.questions).put({ id: "attempt-1:q1" });
  transaction.objectStore(STORE_NAMES.conversationBindings).put({ attemptId: "attempt-1" });
  transaction.objectStore(STORE_NAMES.conversationClaims).put({ conversationUrl: "https://chatgpt.com/c/test" });
  transaction.objectStore(STORE_NAMES.submissionOutbox).put({ requestId: "request-1" });
  transaction.objectStore(STORE_NAMES.feedback).put({ feedbackId: "feedback-1" });
  await completed;
}

async function count(database: IDBDatabase, storeName: string): Promise<number> {
  const transaction = database.transaction(storeName, "readonly");
  return requestToPromise(transaction.objectStore(storeName).count());
}

describe("selective local data deletion", () => {
  it("clears practice records while retaining settings, then can clear settings separately", async () => {
    const database = await openShenlunDatabase({
      factory: new IDBFactory(),
      name: "selective-local-data-deletion-test",
    });
    databases.push(database);
    const service = new PracticeService(() => Promise.resolve(database));
    await seedPracticeStores(database);
    await service.saveSettings({ projectName: "保留的设置", deepseekApiKey: "sk-local-only" });

    await service.clearLocalData({ practiceData: true, settings: false });
    for (const storeName of [
      STORE_NAMES.papers,
      STORE_NAMES.attempts,
      STORE_NAMES.questions,
      STORE_NAMES.conversationBindings,
      STORE_NAMES.conversationClaims,
      STORE_NAMES.submissionOutbox,
      STORE_NAMES.feedback,
    ]) {
      await expect(count(database, storeName)).resolves.toBe(0);
    }
    await expect(service.getSettings()).resolves.toMatchObject({
      projectName: "保留的设置",
      deepseekApiKey: "sk-local-only",
    });

    await service.clearLocalData({ practiceData: false, settings: true });
    await expect(service.getSettings()).resolves.toMatchObject({
      projectName: "申论训练",
      deepseekApiKey: "",
    });
  });
});
