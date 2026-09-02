import { describe, expect, it } from "vitest";
import {
  buildFullPaperPrompt,
  buildSingleQuestionPrompt,
} from "../../src/services/promptBuilder";
import { createTimerState } from "../../src/services/timerService";
import { PERSISTED_ENTITY_VERSION, type QuestionAttempt } from "../../src/types";
import { makeQuestionAttemptId } from "../../src/utils/ids";

function question(attemptId: string, questionId: string, answer: string): QuestionAttempt {
  return {
    schemaVersion: PERSISTED_ENTITY_VERSION,
    id: makeQuestionAttemptId(attemptId, questionId),
    attemptId,
    paperId: "paper-1",
    questionId,
    index: 0,
    title: "第一题",
    questionText: "请概括主要问题。",
    materials: ["材料内容"],
    score: 20,
    wordLimit: 300,
    referenceAnswer: null,
    userAnswer: answer,
    elapsedSeconds: 125,
    timer: createTimerState(0),
    status: "answered",
    createdAt: 0,
    updatedAt: 0,
    submittedAt: null,
  };
}

describe("prompt builders", () => {
  it("includes current attempt data", () => {
    const prompt = buildSingleQuestionPrompt({
      paperName: "测试卷",
      attemptId: "attempt-a",
      question: question("attempt-a", "q1", "本次答案"),
    });
    expect(prompt).toContain("本次答案");
    expect(prompt).toContain("00:02:05");
    expect(prompt).toContain("不要引用其他试卷");
  });

  it("rejects a question from another attempt", () => {
    expect(() =>
      buildSingleQuestionPrompt({
        paperName: "测试卷",
        attemptId: "attempt-a",
        question: question("attempt-b", "q1", "污染答案"),
      }),
    ).toThrow(/isolation/u);
  });

  it("rejects mixed full-paper payloads", () => {
    expect(() =>
      buildFullPaperPrompt({
        paperName: "测试卷",
        attemptId: "attempt-a",
        questions: [
          question("attempt-a", "q1", "A"),
          { ...question("attempt-b", "q2", "B"), index: 1 },
        ],
        totalElapsedSeconds: 10,
      }),
    ).toThrow(/isolation/u);
  });

  it("renders user-editable templates with current attempt placeholders", () => {
    const single = buildSingleQuestionPrompt({
      paperName: "自定义试卷",
      attemptId: "attempt-a",
      question: question("attempt-a", "q1", "自定义答案"),
      template: "卷={{试卷名称}}；题={{题号}}；答案={{考生答案}}；材料={{材料}}",
    });
    expect(single).toContain("卷=自定义试卷；题=第1题；答案=自定义答案");
    expect(single).toContain("材料1：\n材料内容");

    const full = buildFullPaperPrompt({
      paperName: "自定义试卷",
      attemptId: "attempt-a",
      questions: [question("attempt-a", "q1", "整卷答案")],
      totalElapsedSeconds: 90,
      template: "{{试卷名称}}\n{{题目列表}}\n总用时={{整卷总用时}}",
    });
    expect(full).toContain("整卷答案");
    expect(full).toContain("总用时=00:01:30");
  });
});
