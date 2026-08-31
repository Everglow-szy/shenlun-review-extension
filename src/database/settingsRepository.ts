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
    store.put(settings);
    await completed;
    return settings;
  }
}

export const settingsRepository = new SettingsRepository();
