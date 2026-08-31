import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationBindingRepository } from "../../src/database/conversationBindingRepository";
import { openShenlunDatabase } from "../../src/database/indexedDB";
import { PracticeService } from "../../src/services/practiceService";
import type { CreatePaperDefinitionInput } from "../../src/types";

const databases: IDBDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

const paperInput: CreatePaperDefinitionInput = {
  paperName: "Project 更新竞态测试卷",
  paperSource: "test",
  sourceUrl: "https://example.test/project-race-paper",
  questions: [
    {
      questionId: "q1",
      index: 0,
      title: "第一题",
      questionText: "作答。",
      materials: ["材料"],
      score: 10,
      wordLimit: 100,
      referenceAnswer: null,
    },
  ],
};

async function createFixture(name: string): Promise<{
  readonly service: PracticeService;
  readonly repository: ConversationBindingRepository;
  readonly paperId: string;
}> {
  const factory = new IDBFactory();
  const database = await openShenlunDatabase({ factory, name });
  databases.push(database);
  const provider = (): Promise<IDBDatabase> => Promise.resolve(database);
  const service = new PracticeService(provider);
  const repository = new ConversationBindingRepository(provider);
  const { paper } = await service.ingestPaper(paperInput);
  return { service, repository, paperId: paper.paperId };
}

describe("ConversationBindingRepository.updatePendingProject", () => {
  it("updates only a pending binding and removes an empty project URL", async () => {
    const { service, repository, paperId } = await createFixture("pending-project-update");
    const bundle = await service.createAttempt({ paperId, now: 1_000 });
    const pending = bundle.conversation;
    expect(pending).not.toBeNull();
    if (!pending) {
      throw new Error("Expected a pending binding");
    }
    await repository.save({
      ...pending,
      projectUrl: "https://chatgpt.com/g/g-p-old/project",
    });

    const updated = await repository.updatePendingProject(
      pending.attemptId,
      "新 Project",
      "",
      2_000,
    );
    expect(updated).toMatchObject({
      attemptId: pending.attemptId,
      projectName: "新 Project",
      lastUsedAt: 2_000,
    });
    expect(updated).not.toHaveProperty("projectUrl");
    expect(updated).not.toHaveProperty("conversationUrl");
    expect(await repository.updatePendingProject("missing-attempt", "Project")).toBeNull();
  });

  it("returns an already-bound record unchanged", async () => {
    const { service, repository, paperId } = await createFixture("bound-project-protection");
    const bundle = await service.createAttempt({ paperId, now: 1_000 });
    const attemptId = bundle.attempt.attemptId;
    const bound = await repository.rebindConversationUrl(
      attemptId,
      "https://chatgpt.com/c/bound-conversation",
      2_000,
    );

    const result = await repository.updatePendingProject(
      attemptId,
      "不应覆盖",
      "https://chatgpt.com/g/new-project",
      3_000,
    );
    expect(result).toEqual(bound);
    expect(await repository.getByAttempt(attemptId)).toEqual(bound);
  });

  it("never erases a URL observed after a stale snapshot was read", async () => {
    const { service, repository, paperId } = await createFixture("stale-save-protection");
    const first = await service.createAttempt({ paperId, now: 1_000 });
    const stale = first.conversation;
    expect(stale).not.toBeNull();
    if (!stale) {
      throw new Error("Expected a pending binding");
    }
    await repository.rebindConversationUrl(
      stale.attemptId,
      "https://chatgpt.com/c/observed-after-read",
      2_000,
    );
    await repository.save({ ...stale, projectName: "旧快照中的 Project", lastUsedAt: 3_000 });
    expect((await repository.getByAttempt(stale.attemptId))?.conversationUrl).toBe(
      "https://chatgpt.com/c/observed-after-read",
    );

    const second = await service.createAttempt({ paperId, now: 4_000 });
    const secondAttemptId = second.attempt.attemptId;
    await Promise.all([
      repository.rebindConversationUrl(
        secondAttemptId,
        "https://chatgpt.com/c/concurrent-observation",
        5_000,
      ),
      repository.updatePendingProject(
        secondAttemptId,
        "并发 Project 更新",
        "https://chatgpt.com/g/concurrent-project",
        5_000,
      ),
    ]);
    expect((await repository.getByAttempt(secondAttemptId))?.conversationUrl).toBe(
      "https://chatgpt.com/c/concurrent-observation",
    );
  });
});
