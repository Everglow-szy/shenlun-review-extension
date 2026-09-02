import type {
  FullPaperPromptInput,
  QuestionAttempt,
  SingleQuestionPromptInput,
} from "../types";
import { formatElapsedTime } from "../utils/dateTime";
import {
  DEFAULT_FULL_PAPER_PROMPT_TEMPLATE,
  DEFAULT_SINGLE_QUESTION_PROMPT_TEMPLATE,
} from "./promptTemplates";

function valueOrFallback(value: string | null, fallback = "未提供"): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function numberOrFallback(value: number | null, suffix: string): string {
  return value === null ? "未识别" : `${value}${suffix}`;
}

function formatMaterials(materials: readonly string[]): string {
  if (materials.length === 0) {
    return "未提取到材料";
  }
  return materials.map((material, index) => `材料${index + 1}：\n${material.trim()}`).join("\n\n");
}

function assertQuestionIsolation(attemptId: string, question: QuestionAttempt): void {
  if (question.attemptId !== attemptId) {
    throw new Error(
      `Prompt isolation violation: question ${question.questionId} belongs to another attempt`,
    );
  }
}

function section(title: string, body: string): string {
  return `【${title}】\n${body}`;
}

function renderTemplate(
  template: string | undefined,
  fallback: string,
  values: Readonly<Record<string, string>>,
): string {
  let rendered = template?.trim() || fallback;
  for (const [name, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${name}}}`, value);
  }
  return rendered.trim();
}

export function buildSingleQuestionPrompt(input: SingleQuestionPromptInput): string {
  assertQuestionIsolation(input.attemptId, input.question);
  const question = input.question;
  return renderTemplate(input.template, DEFAULT_SINGLE_QUESTION_PROMPT_TEMPLATE, {
    试卷名称: input.paperName,
    题号: `第${question.index + 1}题`,
    本题满分: numberOrFallback(question.score, "分"),
    字数限制: numberOrFallback(question.wordLimit, "字"),
    材料: formatMaterials(question.materials),
    题目: question.questionText.trim(),
    参考答案: valueOrFallback(question.referenceAnswer),
    考生答案: valueOrFallback(question.userAnswer, "考生未作答"),
    考生用时: formatElapsedTime(question.elapsedSeconds),
  });
}

function formatFullPaperQuestion(question: QuestionAttempt): string {
  return [
    `===== 第${question.index + 1}题 =====`,
    section("材料", formatMaterials(question.materials)),
    section("题目", question.questionText.trim()),
    section("分值", numberOrFallback(question.score, "分")),
    section("字数要求", numberOrFallback(question.wordLimit, "字")),
    section("参考答案", valueOrFallback(question.referenceAnswer)),
    section("考生答案", valueOrFallback(question.userAnswer, "考生未作答")),
    section("答题用时", formatElapsedTime(question.elapsedSeconds)),
  ].join("\n\n");
}

export function buildFullPaperPrompt(input: FullPaperPromptInput): string {
  for (const question of input.questions) {
    assertQuestionIsolation(input.attemptId, question);
  }
  const questions = [...input.questions]
    .sort((left, right) => left.index - right.index)
    .map(formatFullPaperQuestion)
    .join("\n\n");

  return renderTemplate(input.template, DEFAULT_FULL_PAPER_PROMPT_TEMPLATE, {
    试卷名称: input.paperName,
    题目列表: questions,
    整卷总用时: formatElapsedTime(input.totalElapsedSeconds),
  });
}
