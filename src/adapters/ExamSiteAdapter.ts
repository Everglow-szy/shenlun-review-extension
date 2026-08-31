import type { QuestionDefinition, QuestionMeta } from "../types";
import { BaseExamAdapter } from "./BaseExamAdapter";
import {
  isElementUsable,
  normalizedText,
  queryAllFirstGroup,
  queryFirst,
  waitForCondition,
} from "./dom";
import { ExamAdapterError } from "./ExamAdapter";
import {
  GenericExamSelectors,
  type ExamSelectorSet,
} from "./exam-selectors";

const SCORE_PATTERN = /(?:满分|分值|本题|共)?\s*[：:]?\s*(\d+(?:\.\d+)?)\s*分/u;
const WORD_LIMIT_PATTERNS = [
  /(?:不超过|不得超过|限|字数(?:要求|限制)?)[^\d]{0,12}(\d+)\s*字/u,
  /(\d+)\s*(?:-|—|~|～|至)\s*(\d+)\s*字/u,
  /(\d+)\s*字(?:以内|左右|以下)/u,
] as const;

function normalizeIdentifier(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/[^\p{L}\p{N}_.:-]+/gu, "-");
  return normalized.slice(0, 96);
}

function extractDataIdentifier(element: HTMLElement): string | null {
  const candidates = [
    element.dataset.questionId,
    element.dataset.id,
    element.dataset.key,
    element.getAttribute("data-question-index"),
    element.getAttribute("aria-controls"),
  ];
  for (const candidate of candidates) {
    if (candidate?.trim()) return normalizeIdentifier(candidate);
  }

  if (element instanceof HTMLAnchorElement) {
    try {
      const url = new URL(element.href, document.baseURI);
      const fromQuery =
        url.searchParams.get("questionId") ??
        url.searchParams.get("question_id") ??
        url.searchParams.get("index");
      if (fromQuery) return normalizeIdentifier(fromQuery);
      const pathTail = url.pathname.split("/").filter(Boolean).at(-1);
      if (pathTail) return normalizeIdentifier(pathTail);
      if (url.hash.length > 1) return normalizeIdentifier(url.hash.slice(1));
    } catch {
      // Fall back to a position-derived id below.
    }
  }
  return null;
}

function removeLeadingLabel(value: string): string {
  return value.replace(/^(?:参考答案|标准答案|答案(?:解析)?|材料)[：:\s]*/u, "").trim();
}

function numberFromAttribute(element: Element | null, names: readonly string[]): number | null {
  for (const name of names) {
    const raw = element?.getAttribute(name);
    if (!raw) continue;
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseScore(element: Element | null): number | null {
  const fromAttribute = numberFromAttribute(element, ["data-score", "data-points", "value"]);
  if (fromAttribute !== null) return fromAttribute;
  const matched = SCORE_PATTERN.exec(normalizedText(element));
  if (!matched?.[1]) return null;
  const score = Number.parseFloat(matched[1]);
  return Number.isFinite(score) ? score : null;
}

function parseWordLimit(element: Element | null): number | null {
  const fromAttribute = numberFromAttribute(element, [
    "data-word-limit",
    "data-max-length",
    "maxlength",
  ]);
  if (fromAttribute !== null) return Math.trunc(fromAttribute);

  const text = normalizedText(element);
  for (const pattern of WORD_LIMIT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const values = match.slice(1).map(Number).filter(Number.isFinite);
    if (values.length > 0) return Math.max(...values.map(Math.trunc));
  }
  return null;
}

function isChatGPTHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com";
}

/**
 * Conservative generic adapter. A new exam site can subclass this class and
 * pass a site-owned selector set while retaining traversal/restoration logic.
 */
export class ExamSiteAdapter extends BaseExamAdapter {
  private questionElements = new Map<string, HTMLElement>();
  private questionMetadata = new Map<string, QuestionMeta>();

  public constructor(
    page: Document = document,
    private readonly selectors: ExamSelectorSet = GenericExamSelectors,
  ) {
    super(page);
  }

  public canHandle(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !isChatGPTHost(parsed.hostname)
      );
    } catch {
      return false;
    }
  }

  public async getPaperName(): Promise<string> {
    const titleElement = queryFirst<HTMLElement>(this.page, this.selectors.paperName);
    const explicitName =
      titleElement?.dataset.paperName?.trim() ||
      titleElement?.getAttribute("content")?.trim() ||
      normalizedText(titleElement);
    const paperName = explicitName || this.page.title.normalize("NFKC").trim();
    if (!paperName) {
      throw new ExamAdapterError(
        "EXAM_PAPER_NAME_NOT_FOUND",
        "无法识别当前试卷名称，请确认试卷页面已完整加载。",
        true,
      );
    }
    return paperName;
  }

  private getQuestionCandidates(): HTMLElement[] {
    return queryAllFirstGroup<HTMLElement>(this.page, this.selectors.questionItems).filter(
      (element) => isElementUsable(element) && normalizedText(element).length > 0,
    );
  }

  private rememberQuestions(elements: readonly HTMLElement[]): QuestionMeta[] {
    this.questionElements.clear();
    this.questionMetadata.clear();
    const usedIds = new Set<string>();
    const metadata: QuestionMeta[] = [];

    elements.forEach((element, index) => {
      const displayIndex = index + 1;
      const baseId = extractDataIdentifier(element) || `question-${displayIndex}`;
      let questionId = baseId;
      let duplicate = 2;
      while (usedIds.has(questionId)) questionId = `${baseId}-${duplicate++}`;
      usedIds.add(questionId);

      const label = normalizedText(element);
      const title = label || `第${displayIndex}题`;
      const item: QuestionMeta = { questionId, index, title };
      this.questionElements.set(questionId, element);
      this.questionMetadata.set(questionId, item);
      metadata.push(item);
    });
    return metadata;
  }

  public async getQuestionList(): Promise<QuestionMeta[]> {
    let candidates = this.getQuestionCandidates();
    if (candidates.length === 0) {
      // A generic <main> alone is not evidence of an exam. Only accept a
      // single-question page when a question-stem selector is present.
      const questionText = queryFirst<HTMLElement>(this.page, this.selectors.questionText);
      if (questionText) {
        const panel = queryFirst<HTMLElement>(this.page, this.selectors.questionPanel);
        candidates = [panel ?? questionText];
      }
    }
    return this.rememberQuestions(candidates);
  }

  private ensureQuestionElement(questionId: string): HTMLElement | null {
    const remembered = this.questionElements.get(questionId);
    if (remembered?.isConnected) return remembered;
    this.rememberQuestions(this.getQuestionCandidates());
    return this.questionElements.get(questionId) ?? null;
  }

  protected getActiveQuestionId(): string | null {
    const activeElement = queryFirst<HTMLElement>(this.page, this.selectors.activeQuestionItems);
    if (!activeElement) {
      if (this.questionElements.size === 1) return this.questionElements.keys().next().value ?? null;
      return null;
    }

    for (const [questionId, element] of this.questionElements) {
      if (
        element === activeElement ||
        element.contains(activeElement) ||
        activeElement.contains(element)
      ) {
        return questionId;
      }
    }

    const activeIdentifier = extractDataIdentifier(activeElement);
    return activeIdentifier && this.questionElements.has(activeIdentifier) ? activeIdentifier : null;
  }

  protected override getObservationRoot(): Node {
    return queryFirst<HTMLElement>(this.page, this.selectors.questionPanel) ?? super.getObservationRoot();
  }

  private contentSignature(): string {
    return normalizedText(queryFirst<HTMLElement>(this.page, this.selectors.questionPanel));
  }

  public async activateQuestion(questionId: string): Promise<void> {
    const element = this.ensureQuestionElement(questionId);
    if (!element) {
      throw new ExamAdapterError(
        "EXAM_QUESTION_NOT_FOUND",
        `无法定位题目 ${questionId}，网页题目列表可能已经变化。`,
        true,
      );
    }
    if (this.getActiveQuestionId() === questionId) return;

    const previousSignature = this.contentSignature();
    element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    element.click();

    try {
      await waitForCondition(
        () =>
          this.getActiveQuestionId() === questionId ||
          (this.contentSignature() !== previousSignature && this.contentSignature().length > 0),
        // Observe the page container rather than the old question panel: many
        // SPAs replace the panel node itself when a navigation item is clicked.
        { root: this.page.body ?? this.page.documentElement, timeoutMs: 8_000 },
      );
    } catch (error) {
      throw new ExamAdapterError(
        "EXAM_QUESTION_SWITCH_TIMEOUT",
        `切换到题目 ${questionId} 后页面未更新。`,
        true,
      );
    }
  }

  public async extractQuestion(questionId: string): Promise<QuestionDefinition> {
    const meta = this.questionMetadata.get(questionId);
    if (!meta) {
      throw new ExamAdapterError("EXAM_QUESTION_NOT_FOUND", `未找到题目元数据：${questionId}。`, true);
    }

    const panel = queryFirst<HTMLElement>(this.page, this.selectors.questionPanel) ?? this.page.body;
    if (!panel) {
      throw new ExamAdapterError("EXAM_STRUCTURE_UNRECOGNIZED", "无法识别当前试卷结构。", true);
    }

    const materialNodes = queryAllFirstGroup<HTMLElement>(panel, this.selectors.materials);
    const materials = Array.from(
      new Set(
        materialNodes
          .map((node) => removeLeadingLabel(normalizedText(node)))
          .filter((text) => text.length > 0),
      ),
    );

    const questionTextElement = queryFirst<HTMLElement>(panel, this.selectors.questionText);
    const questionText = normalizedText(questionTextElement) || meta.title;
    if (!questionText) {
      throw new ExamAdapterError(
        "EXAM_QUESTION_TEXT_NOT_FOUND",
        `无法提取第 ${meta.index + 1} 题题干。`,
        true,
      );
    }

    const scoreElement = queryFirst<HTMLElement>(panel, this.selectors.score);
    const wordLimitElement = queryFirst<HTMLElement>(panel, this.selectors.wordLimit);
    const referenceElement = queryFirst<HTMLElement>(panel, this.selectors.referenceAnswer);
    const referenceText = removeLeadingLabel(normalizedText(referenceElement));

    return {
      questionId,
      index: meta.index,
      title: meta.title,
      questionText,
      materials,
      score: parseScore(scoreElement),
      wordLimit: parseWordLimit(wordLimitElement ?? questionTextElement),
      referenceAnswer: referenceText || null,
    };
  }
}
