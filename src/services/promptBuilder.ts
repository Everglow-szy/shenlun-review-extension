import type {
  FullPaperPromptInput,
  QuestionAttempt,
  SingleQuestionPromptInput,
} from "../types";
import { formatElapsedTime } from "../utils/dateTime";

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

export function buildSingleQuestionPrompt(input: SingleQuestionPromptInput): string {
  assertQuestionIsolation(input.attemptId, input.question);
  const question = input.question;
  const context = [
    "你现在正在批改一套公务员考试申论试卷中的一道题。",
    section("试卷名称", input.paperName),
    section("题号", `第${question.index + 1}题`),
    section("本题满分", numberOrFallback(question.score, "分")),
    section("字数限制", numberOrFallback(question.wordLimit, "字")),
    section("材料", formatMaterials(question.materials)),
    section("题目", question.questionText.trim()),
    section("参考答案", valueOrFallback(question.referenceAnswer)),
    section("考生答案", valueOrFallback(question.userAnswer, "考生未作答")),
    section("考生用时", formatElapsedTime(question.elapsedSeconds)),
  ];

  const instructions = [
    "请严格依据给定材料、题目要求和参考答案进行批改。",
    "请严格使用以下四个 Markdown 二级标题输出，不要增加其他评价模块：",
    "## 得分\nX / X",
    "## 得分点分析\n逐项列出已答出的得分点、表述不完整的得分点和遗漏的得分点。",
    "## 修改建议\n给出可直接执行的修改建议。",
    "## 推荐作答结构\n给出适合本题的作答层次与要点顺序，但不要代写完整答案。",
    "不要引用其他试卷的信息。只针对当前试卷和当前题目进行判断。",
  ];

  return [...context, ...instructions].join("\n\n");
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

  return [
    "你现在正在批改一整套公务员考试申论试卷。",
    section("试卷名称", input.paperName),
    "下面按题号依次提供材料、题目、分值、字数要求、参考答案、考生答案和答题用时。",
    questions,
    section("整套试卷总用时", formatElapsedTime(input.totalElapsedSeconds)),
    "请严格使用以下三个 Markdown 二级标题输出，不要增加其他评价模块：",
    "## 逐题批改\n每题依次给出题号、得分、得分点分析、修改建议和推荐作答结构。",
    "## 整卷总评\n给出总得分、总满分、各题得分率、优势与需要优先改进的问题。",
    "## 后续训练建议\n给出下一阶段最值得优先训练的3项能力。",
    "重要：本次所有判断只能依据当前试卷，不得混入其他申论试卷内容。",
  ].join("\n\n");
}
