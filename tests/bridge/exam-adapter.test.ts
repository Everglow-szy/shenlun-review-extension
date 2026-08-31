/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"https://exam.example.test/papers/2024-a"}
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ExamSiteAdapter } from "../../src/adapters/ExamSiteAdapter";

interface FixtureQuestion {
  readonly material: string;
  readonly text: string;
  readonly score: number;
  readonly wordLimit: number;
  readonly answer?: string;
}

const questions: Record<string, FixtureQuestion> = {
  q1: {
    material: "材料：基层治理材料一",
    text: "概括材料反映的问题。",
    score: 20,
    wordLimit: 300,
    answer: "参考答案：问题概括。",
  },
  q2: {
    material: "材料：公共服务材料二",
    text: "提出有针对性的建议。",
    score: 25,
    wordLimit: 400,
  },
};

function renderQuestion(questionId: string): void {
  const question = questions[questionId];
  if (!question) throw new Error("unknown fixture question");
  document.querySelectorAll(".question-nav button").forEach((button) => {
    button.setAttribute(
      "aria-selected",
      button.getAttribute("data-question-id") === questionId ? "true" : "false",
    );
  });
  const panel = document.querySelector<HTMLElement>(".question-panel");
  if (!panel) throw new Error("fixture panel missing");
  panel.innerHTML = `
    <div class="material-content">${question.material}</div>
    <div class="question-title">${question.text}</div>
    <span class="score">本题 ${question.score} 分</span>
    <span class="word-limit">不超过 ${question.wordLimit} 字</span>
    ${question.answer ? `<div class="reference-answer">${question.answer}</div>` : ""}
  `;
}

describe("ExamSiteAdapter", () => {
  beforeEach(() => {
    document.head.innerHTML = "<title>备用标题</title>";
    document.body.innerHTML = `
      <main>
        <h1 data-paper-name="2024 国考行政执法卷">2024 国考行政执法卷</h1>
        <div class="question-nav" role="tablist">
          <button role="tab" data-question-id="q1" aria-selected="true">第一题</button>
          <button role="tab" data-question-id="q2" aria-selected="false">第二题</button>
        </div>
        <section class="question-panel"></section>
      </main>
    `;
    document.querySelectorAll<HTMLButtonElement>(".question-nav button").forEach((button) => {
      button.addEventListener("click", () => renderQuestion(button.dataset.questionId ?? ""));
    });
    renderQuestion("q1");
  });

  it("traverses all questions, extracts nullable fields, and restores the original question", async () => {
    const adapter = new ExamSiteAdapter(document);
    const paper = await adapter.extractPaper();

    expect(paper.paperName).toBe("2024 国考行政执法卷");
    expect(paper.paperSource).toBe("exam.example.test");
    expect(paper.activeQuestionId).toBe("q1");
    expect(paper.questions).toHaveLength(2);
    expect(paper.questions[0]).toMatchObject({
      questionId: "q1",
      index: 0,
      questionText: "概括材料反映的问题。",
      materials: ["基层治理材料一"],
      score: 20,
      wordLimit: 300,
      referenceAnswer: "问题概括。",
    });
    expect(paper.questions[1]).toMatchObject({
      questionId: "q2",
      index: 1,
      score: 25,
      wordLimit: 400,
      referenceAnswer: null,
    });
    expect(document.querySelector("[data-question-id='q1']")?.getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});
