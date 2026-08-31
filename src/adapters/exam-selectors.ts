/**
 * Generic fallbacks are intentionally centralized here. A site-specific
 * adapter should provide a replacement selector set instead of changing its
 * extraction flow.
 */
export interface ExamSelectorSet {
  readonly paperName: readonly string[];
  readonly questionItems: readonly string[];
  readonly activeQuestionItems: readonly string[];
  readonly questionPanel: readonly string[];
  readonly materials: readonly string[];
  readonly questionText: readonly string[];
  readonly score: readonly string[];
  readonly wordLimit: readonly string[];
  readonly referenceAnswer: readonly string[];
}

export const GenericExamSelectors: ExamSelectorSet = {
  paperName: [
    "[data-paper-name]",
    "[data-testid='paper-title']",
    ".paper-title",
    ".exam-title",
    ".test-paper-title",
    "main h1",
    "h1",
  ],
  questionItems: [
    "[data-question-nav] [data-question-id]",
    "[data-question-list] [data-question-id]",
    ".question-nav [data-question-id]",
    ".question-list [data-question-id]",
    ".answer-card [data-question-id]",
    "[role='tablist'] [role='tab']",
    ".question-nav button",
    ".question-list button",
    ".answer-card button",
    ".answer-card li",
    ".question-nav li",
    ".question-item",
    ".topic-item",
    "a[href*='questionId=']",
    "a[href*='question/']",
  ],
  activeQuestionItems: [
    "[data-question-id][aria-selected='true']",
    "[data-question-id][data-active='true']",
    "[role='tab'][aria-selected='true']",
    ".question-nav .active",
    ".question-list .active",
    ".answer-card .active",
    ".question-item.active",
    ".topic-item.active",
    "[aria-current='step']",
    "[aria-current='page']",
  ],
  questionPanel: [
    "[data-question-panel]",
    "[data-testid='question-panel']",
    ".question-panel",
    ".question-content",
    ".subject-content",
    "main",
  ],
  materials: [
    "[data-material-item]",
    "[data-testid='material-item']",
    ".material-item",
    ".material-content section",
    ".materials section",
    ".material-content",
    ".materials",
    ".given-material",
  ],
  questionText: [
    "[data-question-text]",
    "[data-testid='question-text']",
    ".question-stem",
    ".question-requirement",
    ".subject-title",
    ".topic-title",
    ".question-title",
  ],
  score: [
    "[data-score]",
    "[data-testid='question-score']",
    ".question-score",
    ".score",
    ".subject-score",
  ],
  wordLimit: [
    "[data-word-limit]",
    "[data-testid='word-limit']",
    ".word-limit",
    ".word-count-limit",
    ".question-requirement",
    ".subject-title",
  ],
  referenceAnswer: [
    "[data-reference-answer]",
    "[data-testid='reference-answer']",
    ".reference-answer",
    ".standard-answer",
    ".answer-analysis .answer",
    ".analysis-answer",
  ],
};
