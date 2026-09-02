import {
  DEFAULT_SETTINGS,
  PERSISTED_ENTITY_VERSION,
  type AppSettings,
  type AppSettingsPatch,
} from "../types";
import {
  defaultModelForEngine,
  isGradingEngineId,
  isGradingModelForEngine,
} from "../services/gradingEngines";
import {
  STORE_NAMES,
  getDefaultDatabase,
  requestToPromise,
  transactionToPromise,
  type DatabaseProvider,
} from "./indexedDB";

function promptTemplateOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export class SettingsRepository {
  public constructor(private readonly databaseProvider: DatabaseProvider = getDefaultDatabase) {}

  public async get(): Promise<AppSettings> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.settings, "readonly");
    const value = await requestToPromise(
      transaction.objectStore(STORE_NAMES.settings).get(DEFAULT_SETTINGS.key),
    );
    const merged = value
      ? ({ ...DEFAULT_SETTINGS, ...(value as AppSettings) } satisfies AppSettings)
      : { ...DEFAULT_SETTINGS };
    const gradingEngine = isGradingEngineId(merged.gradingEngine)
      ? merged.gradingEngine
      : DEFAULT_SETTINGS.gradingEngine;
    return {
      ...merged,
      gradingEngine,
      gradingModel: isGradingModelForEngine(gradingEngine, merged.gradingModel)
        ? merged.gradingModel
        : defaultModelForEngine(gradingEngine),
      singleQuestionPromptTemplate: promptTemplateOrDefault(
        merged.singleQuestionPromptTemplate,
        DEFAULT_SETTINGS.singleQuestionPromptTemplate,
      ),
      fullPaperPromptTemplate: promptTemplateOrDefault(
        merged.fullPaperPromptTemplate,
        DEFAULT_SETTINGS.fullPaperPromptTemplate,
      ),
    };
  }

  public async save(
    patch: AppSettingsPatch,
    now: number = Date.now(),
  ): Promise<AppSettings> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(STORE_NAMES.settings, "readwrite");
    const completed = transactionToPromise(transaction);
    const store = transaction.objectStore(STORE_NAMES.settings);
    const stored = (await requestToPromise(store.get(DEFAULT_SETTINGS.key))) as
      | AppSettings
      | undefined;
    const candidate: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      ...patch,
      schemaVersion: PERSISTED_ENTITY_VERSION,
      key: "app",
      updatedAt: now,
    };
    const gradingEngine = isGradingEngineId(candidate.gradingEngine)
      ? candidate.gradingEngine
      : DEFAULT_SETTINGS.gradingEngine;
    const settings: AppSettings = isGradingModelForEngine(
      gradingEngine,
      candidate.gradingModel,
    ) ? { ...candidate, gradingEngine } : {
      ...candidate,
      gradingEngine,
      gradingModel: defaultModelForEngine(gradingEngine),
    };
    const normalizedSettings: AppSettings = {
      ...settings,
      singleQuestionPromptTemplate: promptTemplateOrDefault(
        settings.singleQuestionPromptTemplate,
        DEFAULT_SETTINGS.singleQuestionPromptTemplate,
      ),
      fullPaperPromptTemplate: promptTemplateOrDefault(
        settings.fullPaperPromptTemplate,
        DEFAULT_SETTINGS.fullPaperPromptTemplate,
      ),
    };
    store.put(normalizedSettings);
    await completed;
    return normalizedSettings;
  }
}

export const settingsRepository = new SettingsRepository();
