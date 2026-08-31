import type { QuestionDefinition, QuestionMeta } from "../types";
import { BaseExamAdapter } from "./BaseExamAdapter";
import { normalizedText, waitForCondition } from "./dom";
import { ExamAdapterError } from "./ExamAdapter";

const FENBI_HOST = "spa.fenbi.com";
const QUESTION_ROOT_SELECTOR = "app-tis app-ti[data-question-key]";
const GROUP_QUESTION_SELECTOR = "app-ti[data-question-key]";
const GROUP_TAB_SELECTOR = ".right-part > .questions-anchors app-expand .tabs-content > .tab";
const QUESTION_SET_QUIET_MS = 1_500;
const QUESTION_SET_TIMEOUT_MS = 20_000;
const QUESTION_CONTENT_SELECTORS = [
  ".ti-content app-solution-smart article.content",
  ".ti-content app-solution-view-only article.content",
  ".ti-content app-question-smart article.content",
  ".ti-content app-question-view-only article.content",
  ".ti-content article.content",
] as const;
const SCORE_PATTERN = /(?:满分|分值|本题|共)?\s*[：:]?\s*(\d+(?:\.\d+)?)\s*分/u;
const WORD_LIMIT_PATTERNS = [
  /(?:不超过|不得超过|限|字数(?:要求|限制)?)[^\d]{0,12}(\d+)\s*字/u,
  /(\d+)\s*(?:-|—|~|～|至)\s*(\d+)\s*字/u,
  /(\d+)\s*字(?:以内|左右|以下)/u,
] as const;

function queryFirst<T extends Element>(root: ParentNode, selectors: readonly string[]): T | null {
  for (const selector of selectors) {
    const match = root.querySelector<T>(selector);
    if (match) return match;
  }
  return null;
}

function normalizeQuestionId(value: string, index: number): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}_.:-]+/gu, "-")
    .slice(0, 96);
  return normalized || `fenbi-question-${index + 1}`;
}

function parseScore(text: string): number | null {
  const match = SCORE_PATTERN.exec(text);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseWordLimit(text: string): number | null {
  for (const pattern of WORD_LIMIT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const values = match.slice(1).map(Number).filter(Number.isFinite);
    if (values.length > 0) return Math.max(...values.map(Math.trunc));
  }
  return null;
}

function withoutLeadingLabel(value: string): string {
  return value.replace(/^(?:参考答案|标准答案|答案(?:解析)?|材料)[：:\s]*/u, "").trim();
}

function uniqueText(nodes: readonly Element[]): string[] {
  return Array.from(
    new Set(
      nodes
        .map((node) => withoutLeadingLabel(normalizedText(node)))
        .filter(Boolean),
    ),
  );
}

function findQuestionElements(page: Document): HTMLElement[] {
  return Array.from(page.querySelectorAll<HTMLElement>(QUESTION_ROOT_SELECTOR));
}

function findGroupQuestionElements(group: ParentNode): HTMLElement[] {
  return Array.from(group.querySelectorAll<HTMLElement>(GROUP_QUESTION_SELECTOR));
}

function questionSetSignature(elements: readonly HTMLElement[]): string {
  return elements
    .map((element, index) => {
      const content = queryFirst<HTMLElement>(element, QUESTION_CONTENT_SELECTORS);
      return `${element.dataset.questionKey ?? index}:${normalizedText(content).length}`;
    })
    .join("|");
}

function allQuestionBodiesReady(elements: readonly HTMLElement[]): boolean {
  return elements.length > 0 && elements.every((element) => {
    const content = queryFirst<HTMLElement>(element, QUESTION_CONTENT_SELECTORS);
    return normalizedText(content).length > 0;
  });
}

/**
 * Angular mounts Fenbi questions progressively. Waiting only for the first
 * `app-ti` makes a scan race the remaining small questions, so resolve only
 * after the complete set and its body lengths have stopped changing.
 */
async function waitForCompleteQuestionSet(page: Document): Promise<HTMLElement[]> {
  const observationRoot = await waitForCondition(
    () => page.querySelector<HTMLElement>("app-tis"),
    { root: page.body ?? page.documentElement, timeoutMs: QUESTION_SET_TIMEOUT_MS },
  );

  return new Promise<HTMLElement[]>((resolve, reject) => {
    let settled = false;
    let lastSignature = "";
    let quietTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      if (quietTimer !== undefined) globalThis.clearTimeout(quietTimer);
      globalThis.clearTimeout(timeoutTimer);
      callback();
    };

    const evaluate = (): void => {
      const elements = findQuestionElements(page);
      const signature = questionSetSignature(elements);
      if (signature === lastSignature && quietTimer !== undefined) return;
      lastSignature = signature;
      if (quietTimer !== undefined) globalThis.clearTimeout(quietTimer);
      quietTimer = undefined;
      if (!allQuestionBodiesReady(elements)) return;
      quietTimer = globalThis.setTimeout(() => {
        const current = findQuestionElements(page);
        if (allQuestionBodiesReady(current) && questionSetSignature(current) === lastSignature) {
          finish(() => resolve(current));
        } else {
          evaluate();
        }
      }, QUESTION_SET_QUIET_MS);
    };

    const observer = new MutationObserver(evaluate);
    const timeoutTimer = globalThis.setTimeout(() => {
      const elements = findQuestionElements(page);
      if (allQuestionBodiesReady(elements)) {
        finish(() => resolve(elements));
      } else {
        finish(() => reject(new Error("Fenbi question set did not finish rendering")));
      }
    }, QUESTION_SET_TIMEOUT_MS);

    observer.observe(observationRoot, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    evaluate();
  });
}

/**
 * Fenbi's Shenlun viewer renders an `app-ti` for each immediately visible
 * question, but a subjective group keeps only its selected small question in
 * the DOM. The adapter traverses its `app-expand` tabs and stores detached DOM
 * snapshots, keeping all Fenbi-specific knowledge outside application logic.
 */
export class FenbiShenlunAdapter extends BaseExamAdapter {
  private readonly questionElements = new Map<string, HTMLElement>();
  private readonly questionMetadata = new Map<string, QuestionMeta>();
  private originalActiveQuestionId: string | null = null;

  public canHandle(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        parsed.hostname.toLowerCase() === FENBI_HOST &&
        /^\/ti\/view\/(?:paper|questions)\//u.test(parsed.pathname) &&
        parsed.searchParams.get("routecs") === "shenlun"
      );
    } catch {
      return false;
    }
  }

  public async getPaperName(): Promise<string> {
    try {
      const title = await waitForCondition(
        () => {
          const element = this.page.querySelector<HTMLElement>("app-nav-header .header-title");
          return normalizedText(element) ? element : null;
        },
        { root: this.page.body ?? this.page.documentElement, timeoutMs: 20_000 },
      );
      return normalizedText(title);
    } catch {
      throw new ExamAdapterError(
        "EXAM_PAPER_NAME_NOT_FOUND",
        "粉笔试卷标题尚未加载，请确认页面已显示试卷内容后重试。",
        true,
      );
    }
  }

  public async getQuestionList(): Promise<QuestionMeta[]> {
    let initiallyRendered: HTMLElement[];
    try {
      initiallyRendered = await waitForCompleteQuestionSet(this.page);
    } catch {
      return [];
    }

    const originalVisibleElement = [...initiallyRendered]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= 60)
      .sort((left, right) => Math.abs(left.rect.top - 80) - Math.abs(right.rect.top - 80))[0]
      ?.element ?? initiallyRendered[0] ?? null;
    const originalRawId = originalVisibleElement?.dataset.questionKey ?? null;

    const elements: HTMLElement[] = [];
    const capturedRawIds = new Set<string>();
    const groups = Array.from(this.page.querySelectorAll<HTMLElement>("app-tis .ti"));
    const selections = groups.map((group) => ({
      group,
      index: Array.from(group.querySelectorAll<HTMLElement>(GROUP_TAB_SELECTOR))
        .findIndex((tab) => tab.classList.contains("active")),
    }));

    const captureGroup = (group: HTMLElement): void => {
      const clone = group.cloneNode(true) as HTMLElement;
      for (const element of findGroupQuestionElements(clone)) {
        const rawId = element.dataset.questionKey ?? "";
        if (rawId && capturedRawIds.has(rawId)) continue;
        if (rawId) capturedRawIds.add(rawId);
        elements.push(element);
      }
    };

    try {
      for (const group of groups) {
        const initialTabs = Array.from(group.querySelectorAll<HTMLElement>(GROUP_TAB_SELECTOR));
        if (initialTabs.length <= 1 || findGroupQuestionElements(group).length > 1) {
          captureGroup(group);
          continue;
        }

        for (let index = 0; index < initialTabs.length; index += 1) {
          await this.selectGroupQuestion(group, index);
          captureGroup(group);
        }
      }
    } finally {
      for (const selection of selections) {
        if (selection.index < 0) continue;
        try {
          await this.selectGroupQuestion(selection.group, selection.index);
        } catch {
          // A completed extraction is still useful if the host replaced a
          // group while restoring its original tab.
        }
      }
    }

    // Defensive fallback for a Fenbi layout without the usual `.ti` wrapper.
    if (elements.length === 0) {
      elements.push(...initiallyRendered.map((element) => element.cloneNode(true) as HTMLElement));
    }

    this.questionElements.clear();
    this.questionMetadata.clear();
    const usedIds = new Set<string>();
    const metadata = elements.map((element, index) => {
      const rawId = element.dataset.questionKey ?? "";
      const baseId = normalizeQuestionId(rawId, index);
      let questionId = baseId;
      let duplicate = 2;
      while (usedIds.has(questionId)) questionId = `${baseId}-${duplicate++}`;
      usedIds.add(questionId);

      const displayedIndex = normalizedText(element.querySelector(".title-index"))
        .replace(/[.、。\s]+$/u, "") || String(index + 1);
      const typeName = normalizedText(element.querySelector(".title-type-name"));
      const title = `第${displayedIndex}题${typeName ? ` · ${typeName}` : ""}`;
      const metadata: QuestionMeta = { questionId, index, title };
      this.questionElements.set(questionId, element);
      this.questionMetadata.set(questionId, metadata);
      return metadata;
    });

    this.originalActiveQuestionId = originalRawId
      ? Array.from(this.questionElements.entries())
        .find(([, element]) => element.dataset.questionKey === originalRawId)?.[0] ?? null
      : null;

    return metadata;
  }

  private async selectGroupQuestion(group: HTMLElement, index: number): Promise<void> {
    const tabs = Array.from(group.querySelectorAll<HTMLElement>(GROUP_TAB_SELECTOR));
    const target = tabs[index];
    if (!target) {
      throw new ExamAdapterError(
        "EXAM_QUESTION_NOT_FOUND",
        `粉笔第 ${index + 1} 个小题标签已发生变化，请重新扫描。`,
        true,
      );
    }

    const before = questionSetSignature(findGroupQuestionElements(group));
    if (target.classList.contains("active") && allQuestionBodiesReady(findGroupQuestionElements(group))) {
      return;
    }
    target.click();
    await waitForCondition(
      () => {
        const currentTabs = Array.from(group.querySelectorAll<HTMLElement>(GROUP_TAB_SELECTOR));
        const currentQuestions = findGroupQuestionElements(group);
        return (
          currentTabs[index]?.classList.contains("active") &&
          allQuestionBodiesReady(currentQuestions) &&
          questionSetSignature(currentQuestions) !== before
        ) ? currentQuestions : null;
      },
      { root: group, timeoutMs: 5_000 },
    );
  }

  protected getActiveQuestionId(): string | null {
    if (this.originalActiveQuestionId && this.questionElements.has(this.originalActiveQuestionId)) {
      return this.originalActiveQuestionId;
    }
    try {
      const requested = new URL(this.page.location.href).searchParams.get("curQKey");
      if (requested) {
        for (const [questionId, element] of this.questionElements) {
          if (element.dataset.questionKey === requested) return questionId;
        }
      }
    } catch {
      // Fall through to the viewport-based choice.
    }

    const visible = Array.from(this.questionElements.entries())
      .map(([questionId, element]) => ({ questionId, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= 60)
      .sort((left, right) => Math.abs(left.rect.top - 80) - Math.abs(right.rect.top - 80));
    return visible[0]?.questionId ?? this.questionElements.keys().next().value ?? null;
  }

  public async activateQuestion(questionId: string): Promise<void> {
    if (!this.questionElements.has(questionId)) {
      throw new ExamAdapterError(
        "EXAM_QUESTION_NOT_FOUND",
        `粉笔页面中的题目 ${questionId} 已发生变化，请重新扫描。`,
        true,
      );
    }
    // getQuestionList has already visited Fenbi's tabbed small questions and
    // stored detached snapshots, so extraction must not change the host again.
  }

  protected override async waitUntilStable(): Promise<void> {
    // getQuestionList has already waited for each app-ti and its article body.
    // A page timer or other unrelated Angular update must not hold extraction.
  }

  public async extractQuestion(questionId: string): Promise<QuestionDefinition> {
    const root = this.questionElements.get(questionId);
    const metadata = this.questionMetadata.get(questionId);
    if (!root || !metadata) {
      throw new ExamAdapterError(
        "EXAM_QUESTION_NOT_FOUND",
        `未找到粉笔题目元数据：${questionId}。`,
        true,
      );
    }

    const questionContent = queryFirst<HTMLElement>(root, QUESTION_CONTENT_SELECTORS);
    const questionText = normalizedText(questionContent);
    if (!questionText) {
      throw new ExamAdapterError(
        "EXAM_QUESTION_TEXT_NOT_FOUND",
        `无法提取粉笔第 ${metadata.index + 1} 题题干。`,
        true,
      );
    }

    const group = root.closest<HTMLElement>(".ti") ?? root.parentElement;
    const materialNodes = group
      ? Array.from(group.querySelectorAll<HTMLElement>("app-materials .material-content"))
      : [];
    const reference = queryFirst<HTMLElement>(root, [
      "[id^='section-reference-'] .content",
      "[id^='section-ai-reference-'] .content",
      "app-solution-ai-reference .content",
    ]);

    return {
      questionId,
      index: metadata.index,
      title: metadata.title,
      questionText,
      materials: uniqueText(materialNodes),
      score: parseScore(questionText),
      wordLimit: parseWordLimit(questionText),
      referenceAnswer: withoutLeadingLabel(normalizedText(reference)) || null,
    };
  }
}
