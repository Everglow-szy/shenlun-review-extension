import type {
  GradingEngineId,
  GradingModelId,
  GradingTarget,
} from "../types";

export interface GradingOption<T extends string> {
  readonly id: T;
  readonly label: string;
}

export const GRADING_ENGINES: readonly GradingOption<GradingEngineId>[] = [
  { id: "chatgpt-web", label: "ChatGPT 网页" },
  { id: "deepseek-api", label: "DeepSeek API" },
];

const MODELS: Readonly<Record<GradingEngineId, readonly GradingOption<GradingModelId>[]>> = {
  "chatgpt-web": [
    { id: "chatgpt-project-default", label: "Project 默认模型" },
  ],
  "deepseek-api": [
    { id: "deepseek-v4-flash-thinking", label: "DeepSeek V4 Flash · 深度思考" },
    { id: "deepseek-v4-flash-nonthinking", label: "DeepSeek V4 Flash · 非思考" },
    { id: "deepseek-v4-pro-thinking", label: "DeepSeek V4 Pro · 深度思考" },
    { id: "deepseek-v4-pro-nonthinking", label: "DeepSeek V4 Pro · 非思考" },
  ],
};

export function modelsForEngine(engine: GradingEngineId): readonly GradingOption<GradingModelId>[] {
  return MODELS[engine];
}

export function defaultModelForEngine(engine: GradingEngineId): GradingModelId {
  return MODELS[engine][0]!.id;
}

export function gradingEngineLabel(engine: GradingEngineId): string {
  return GRADING_ENGINES.find((option) => option.id === engine)?.label ?? engine;
}

export function gradingModelLabel(model: GradingModelId): string {
  for (const options of Object.values(MODELS)) {
    const match = options.find((option) => option.id === model);
    if (match) return match.label;
  }
  return model;
}

export function isGradingEngineId(value: unknown): value is GradingEngineId {
  return GRADING_ENGINES.some((option) => option.id === value);
}

export function isGradingModelForEngine(
  engine: GradingEngineId,
  model: unknown,
): model is GradingModelId {
  return MODELS[engine].some((option) => option.id === model);
}

export function isGradingTarget(value: unknown): value is GradingTarget {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly engine?: unknown; readonly model?: unknown };
  return isGradingEngineId(candidate.engine) &&
    isGradingModelForEngine(candidate.engine, candidate.model);
}

export interface DeepSeekModelConfig {
  readonly model: "deepseek-v4-flash" | "deepseek-v4-pro";
  readonly thinking: "enabled" | "disabled";
}

export function deepSeekModelConfig(model: GradingModelId): DeepSeekModelConfig | null {
  switch (model) {
    case "deepseek-v4-flash-thinking":
      return { model: "deepseek-v4-flash", thinking: "enabled" };
    case "deepseek-v4-flash-nonthinking":
      return { model: "deepseek-v4-flash", thinking: "disabled" };
    case "deepseek-v4-pro-thinking":
      return { model: "deepseek-v4-pro", thinking: "enabled" };
    case "deepseek-v4-pro-nonthinking":
      return { model: "deepseek-v4-pro", thinking: "disabled" };
    default:
      return null;
  }
}
