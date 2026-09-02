import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { openShenlunDatabase } from "../../src/database/indexedDB";
import { SettingsRepository } from "../../src/database/settingsRepository";

const databases: IDBDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("SettingsRepository grading engine settings", () => {
  it("persists API configuration and resets incompatible models on engine changes", async () => {
    const database = await openShenlunDatabase({
      factory: new IDBFactory(),
      name: "grading-engine-settings-test",
    });
    databases.push(database);
    const repository = new SettingsRepository(() => Promise.resolve(database));

    const deepseek = await repository.save({
      gradingEngine: "deepseek-api",
      deepseekApiBaseUrl: "https://api.deepseek.com",
      deepseekApiKey: "sk-local-test-only",
      singleQuestionPromptTemplate: "单题 {{题目}}",
      fullPaperPromptTemplate: "整卷 {{题目列表}}",
    }, 100);
    expect(deepseek).toMatchObject({
      gradingEngine: "deepseek-api",
      gradingModel: "deepseek-v4-flash-thinking",
      deepseekApiKey: "sk-local-test-only",
    });

    const chatgpt = await repository.save({
      gradingEngine: "chatgpt-web",
      gradingModel: "deepseek-v4-pro-thinking",
    }, 200);
    expect(chatgpt).toMatchObject({
      gradingEngine: "chatgpt-web",
      gradingModel: "chatgpt-project-default",
    });
    await expect(repository.get()).resolves.toMatchObject({
      gradingEngine: "chatgpt-web",
      gradingModel: "chatgpt-project-default",
      deepseekApiKey: "sk-local-test-only",
      singleQuestionPromptTemplate: "单题 {{题目}}",
      fullPaperPromptTemplate: "整卷 {{题目列表}}",
    });
  });

  it("falls back to safe default templates when a saved template is blank", async () => {
    const database = await openShenlunDatabase({
      factory: new IDBFactory(),
      name: "prompt-template-settings-test",
    });
    databases.push(database);
    const repository = new SettingsRepository(() => Promise.resolve(database));

    const saved = await repository.save({
      singleQuestionPromptTemplate: "   ",
      fullPaperPromptTemplate: "\n",
    });
    expect(saved.singleQuestionPromptTemplate).toContain("{{考生答案}}");
    expect(saved.fullPaperPromptTemplate).toContain("{{题目列表}}");
  });
});
