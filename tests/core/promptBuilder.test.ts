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
});
