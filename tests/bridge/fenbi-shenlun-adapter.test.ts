/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"https://spa.fenbi.com/ti/view/paper/demo?routecs=shenlun&paperId=8836765"}
 */
import { beforeEach, describe, expect, it } from "vitest";
import { FenbiShenlunAdapter } from "../../src/adapters/FenbiShenlunAdapter";
import { resolveExamAdapter } from "../../src/adapters/exam-registry";

function questionMarkup(input: {
  readonly key: string;
  readonly index: number;
  readonly text: string;
  readonly reference?: string;
}): string {
  return `
    <a name="anchor-ques-0-0-${input.index - 1}">
      <app-ti data-question-key="${input.key}">
        <div class="ti-container">
          <div class="title" id="title-0-0-${input.index - 1}">
            <span class="title-index">${input.index}.</span>
            <span class="title-type-name">申论题</span>
          </div>
          <div class="ti-content">
            <app-solution-smart>
              <div class="solution-smart-container">
                <article class="content">${input.text}</article>
                ${input.reference ? `
                  <app-result-common>
                    <section class="result-common-section" id="section-reference-${input.key}">
                      <app-solution-title>参考答案</app-solution-title>
                      <div class="content">${input.reference}</div>
                    </section>
                  </app-result-common>
                ` : ""}
              </div>
            </app-solution-smart>
          </div>
        </div>
      </app-ti>
    </a>
  `;
}

function renderFenbiPaper(): void {
  document.body.innerHTML = `
    <app-root>
      <app-view-paper>
        <app-nav-header><header><div class="header-title">2025 年某省公务员录用考试申论试卷</div></header></app-nav-header>
        <app-tis>
          <div class="tis-container">
            <div class="ti">
              <div class="left-part">
                <app-materials>
                  <div class="materials-container">
                    <div class="material-body">
                      <div class="material-content">材料：基层治理需要进一步提升精细化水平。</div>
                    </div>
                  </div>
                </app-materials>
              </div>
              <div class="right-part">
                <div class="questions-container">
                  ${questionMarkup({
                    key: "fenbi-q-101",
                    index: 1,
                    text: "根据给定材料，概括基层治理存在的问题。本题 20 分，不超过 300 字。",
                    reference: "参考答案：应从机制、人员和服务三个方面概括。",
                  })}
                </div>
              </div>
            </div>
          </div>
        </app-tis>
      </app-view-paper>
    </app-root>
  `;

  // Fenbi's Angular tree can expose the first app-ti while later small
  // questions are still being mounted from the same paper response.
  globalThis.setTimeout(() => {
    document.querySelector(".questions-container")?.insertAdjacentHTML(
      "beforeend",
      questionMarkup({
        key: "fenbi-q-102",
        index: 2,
        text: "结合给定材料，提出提升基层服务能力的建议。限 400 字。",
      }),
    );
  }, 50);
}

function renderTabbedFenbiPaper(activeIndex = 2): void {
  const questions = [
    { key: "fenbi-tab-q-1", index: 1, text: "概括材料反映的主要问题。不超过 200 字。" },
    { key: "fenbi-tab-q-2", index: 2, text: "提出推进相关工作的具体建议。不超过 300 字。" },
    { key: "fenbi-tab-q-3", index: 3, text: "以传统产业跑得稳、新兴产业飞得高为标题撰写报道。不超过 450 字。" },
  ] as const;
  document.body.innerHTML = `
    <app-root><app-view-paper>
      <app-nav-header><div class="header-title">粉笔申论多小题试卷</div></app-nav-header>
      <app-tis><div class="ti">
        <div class="left-part"><app-materials><div class="material-content">多小题共用材料</div></app-materials></div>
        <div class="right-part">
          <div class="questions-anchors"><app-expand><nav><div class="tabs-content">
            ${questions.map((question, index) => `<a class="tab${index === activeIndex ? " active" : ""}" id="nav${index}">第${question.index}题</a>`).join("")}
          </div></nav></app-expand></div>
          <div class="questions-container"></div>
        </div>
      </div></app-tis>
    </app-view-paper></app-root>
  `;

  const showQuestion = (index: number): void => {
    document.querySelectorAll("app-expand .tab").forEach((tab, tabIndex) => {
      tab.classList.toggle("active", tabIndex === index);
    });
    const container = document.querySelector<HTMLElement>(".questions-container");
    if (container) container.innerHTML = questionMarkup(questions[index]!);
  };
  document.querySelectorAll<HTMLElement>("app-expand .tab").forEach((tab, index) => {
    tab.addEventListener("click", () => showQuestion(index));
  });
  showQuestion(activeIndex);
}

describe("Fenbi Shenlun adapter", () => {
  beforeEach(() => {
    document.body.innerHTML = "<app-root></app-root>";
  });

  it("is selected before the generic fallback for Fenbi Shenlun paper routes", () => {
    expect(resolveExamAdapter(document)).toBeInstanceOf(FenbiShenlunAdapter);
    const adapter = new FenbiShenlunAdapter(document);
    expect(adapter.canHandle("https://spa.fenbi.com/ti/view/paper/key?routecs=shenlun")).toBe(true);
    expect(adapter.canHandle("https://spa.fenbi.com/ti/view/paper/key?routecs=xingce")).toBe(false);
    expect(adapter.canHandle("https://www.fenbi.com/ti/view/paper/key?routecs=shenlun")).toBe(false);
  });

  it("waits for progressively mounted small questions and extracts them in one scan", async () => {
    const adapter = new FenbiShenlunAdapter(document);
    const originalBody = document.body.innerHTML;
    globalThis.setTimeout(renderFenbiPaper, 0);

    const paper = await adapter.extractPaper();

    expect(originalBody).toBe("<app-root></app-root>");
    expect(paper.paperName).toBe("2025 年某省公务员录用考试申论试卷");
    expect(paper.paperSource).toBe("spa.fenbi.com");
    expect(paper.activeQuestionId).toBe("fenbi-q-101");
    expect(paper.questions).toHaveLength(2);
    expect(paper.questions[0]).toMatchObject({
      questionId: "fenbi-q-101",
      index: 0,
      title: "第1题 · 申论题",
      questionText: "根据给定材料,概括基层治理存在的问题。本题 20 分,不超过 300 字。",
      materials: ["基层治理需要进一步提升精细化水平。"],
      score: 20,
      wordLimit: 300,
      referenceAnswer: "应从机制、人员和服务三个方面概括。",
    });
    expect(paper.questions[1]).toMatchObject({
      questionId: "fenbi-q-102",
      index: 1,
      title: "第2题 · 申论题",
      score: null,
      wordLimit: 400,
      referenceAnswer: null,
    });
    expect(document.querySelector("app-ti[data-question-key='fenbi-q-101']")).not.toBeNull();
  });

  it("visits every subjective-question tab in one scan and restores the original tab", async () => {
    renderTabbedFenbiPaper(2);
    const adapter = new FenbiShenlunAdapter(document);

    const paper = await adapter.extractPaper();

    expect(paper.questions.map((question) => question.questionId)).toEqual([
      "fenbi-tab-q-1",
      "fenbi-tab-q-2",
      "fenbi-tab-q-3",
    ]);
    expect(paper.questions.map((question) => question.index)).toEqual([0, 1, 2]);
    expect(paper.questions[2]).toMatchObject({
      title: "第3题 · 申论题",
      wordLimit: 450,
      materials: ["多小题共用材料"],
    });
    expect(paper.activeQuestionId).toBe("fenbi-tab-q-3");
    expect(document.querySelector("app-expand .tab.active")?.textContent).toBe("第3题");
    expect(document.querySelector("app-ti")?.getAttribute("data-question-key")).toBe("fenbi-tab-q-3");
  });
});
