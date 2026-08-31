import { describe, expect, it } from "vitest";
import { buildConversationName } from "../../src/utils/dateTime";
import {
  buildPaperFingerprintSource,
  computePaperFingerprint,
} from "../../src/utils/fingerprint";
import type { CreatePaperDefinitionInput } from "../../src/types";

const paper: CreatePaperDefinitionInput = {
  paperName: "  2024 国考  副省级卷 ",
  paperSource: "example",
  sourceUrl: "https://example.com/paper/?b=2&a=1#question",
  questions: [
    {
      questionId: "q1",
      index: 0,
      title: "第一题",
      questionText: " 概括  材料 ",
      materials: ["材料 一"],
      score: 20,
      wordLimit: 300,
      referenceAnswer: null,
    },
  ],
};

describe("conversation naming", () => {
  it("uses the paper name followed by the grading suffix", () => {
    expect(buildConversationName("2026-08-20", "2024国考行政执法卷")).toBe(
      "2024国考行政执法卷-申论批改",
    );
    expect(buildConversationName("2026-08-20", "2024国考行政执法卷", 2)).toBe(
      "2024国考行政执法卷-申论批改",
    );
  });
});

describe("paper fingerprint", () => {
  it("normalizes whitespace, URL query order and fragments", async () => {
    const equivalent: CreatePaperDefinitionInput = {
      ...paper,
      paperName: "2024 国考 副省级卷",
      sourceUrl: "https://example.com/paper?a=1&b=2",
      questions: paper.questions.map((question) => ({
        ...question,
        questionText: "概括 材料",
      })),
    };
    expect(buildPaperFingerprintSource(paper)).toBe(buildPaperFingerprintSource(equivalent));
    expect(await computePaperFingerprint(paper)).toBe(await computePaperFingerprint(equivalent));
  });

  it("removes volatile question navigation parameters but preserves paper identity", () => {
    const first = {
      ...paper,
      sourceUrl:
        "https://example.com/paper?id=paper-7&QuestionId=q1&question_index=0&tab=answer",
    };
    const second = {
      ...paper,
      sourceUrl:
        "https://example.com/paper?currentQuestion=q2&QID=q2&id=paper-7&index=1",
    };
    expect(buildPaperFingerprintSource(first)).toBe(buildPaperFingerprintSource(second));
    expect(buildPaperFingerprintSource(first)).toContain("paper-7");
  });
});
