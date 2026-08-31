import { describe, expect, it } from "vitest";
import { parseFeedbackModules, parseFeedbackScore } from "../../src/services/feedbackParser";

describe("feedback parser", () => {
  it("splits the requested grading response into modules", () => {
    const modules = parseFeedbackModules(`
## 得分
16 / 20

## 得分点分析
- 已答出产业升级
- 遗漏人才保障

## 修改建议
补充政策工具。

## 推荐作答结构
现状—问题—建议
    `);
    expect(modules.map((module) => module.title)).toEqual([
      "得分",
      "得分点分析",
      "修改建议",
      "推荐作答结构",
    ]);
    expect(modules[1]?.content).toContain("人才保障");
    expect(parseFeedbackScore(modules[0]?.content ?? "")).toEqual({ score: 16, maxScore: 20 });
  });

  it("keeps an unstructured response readable", () => {
    expect(parseFeedbackModules("暂时无法形成结构化结果。")).toEqual([
      { title: "批改详情", content: "暂时无法形成结构化结果。" },
    ]);
  });
});
