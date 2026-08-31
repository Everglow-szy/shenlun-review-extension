import type {
  ExtractedPaperPayload,
  QuestionDefinition,
  QuestionMeta,
} from "../types";
import { waitForDomStable } from "./dom";
import type { PaperExtractingExamAdapter } from "./ExamAdapter";
import { ExamAdapterError } from "./ExamAdapter";

export abstract class BaseExamAdapter implements PaperExtractingExamAdapter {
  protected originalQuestionId: string | null = null;

  public constructor(protected readonly page: Document = document) {}

  public abstract canHandle(url: string): boolean;
  public abstract getPaperName(): Promise<string>;
  public abstract getQuestionList(): Promise<QuestionMeta[]>;
  public abstract activateQuestion(questionId: string): Promise<void>;
  public abstract extractQuestion(questionId: string): Promise<QuestionDefinition>;

  protected abstract getActiveQuestionId(): string | null;

  protected getObservationRoot(): Node {
    return this.page.body ?? this.page.documentElement;
  }

  protected async waitUntilStable(): Promise<void> {
    await waitForDomStable({
      root: this.getObservationRoot(),
      quietMs: 180,
      timeoutMs: 10_000,
    });
  }

  public async restoreOriginalQuestion(): Promise<void> {
    if (!this.originalQuestionId || this.getActiveQuestionId() === this.originalQuestionId) return;
    await this.activateQuestion(this.originalQuestionId);
    await this.waitUntilStable();
  }

  /**
   * Sequentially visits every question because most exam sites render only one
   * question body at a time. Restoration happens even when extraction fails.
   */
  public async extractPaper(): Promise<ExtractedPaperPayload> {
    const paperName = await this.getPaperName();
    const questions = await this.getQuestionList();
    if (questions.length === 0) {
      throw new ExamAdapterError("EXAM_NO_QUESTIONS", "未识别到题目列表，请检查网页是否已加载完成。", true);
    }

    this.originalQuestionId = this.getActiveQuestionId() ?? questions[0]?.questionId ?? null;
    const extracted: QuestionDefinition[] = [];
    let extractionError: unknown;

    try {
      for (const question of questions) {
        await this.activateQuestion(question.questionId);
        await this.waitUntilStable();
        const data = await this.extractQuestion(question.questionId);
        extracted.push({
          ...data,
          questionId: question.questionId,
          index: question.index,
          title: data.title || question.title,
        });
      }
    } catch (error) {
      extractionError = error;
      throw error;
    } finally {
      try {
        await this.restoreOriginalQuestion();
      } catch (restoreError) {
        if (extractionError === undefined) throw restoreError;
      }
    }

    const sourceUrl = this.page.location.href;
    const result: ExtractedPaperPayload = {
      paperName,
      paperSource: this.page.location.hostname,
      sourceUrl,
      paperDate: null,
      questions: extracted,
    };
    if (this.originalQuestionId) {
      return { ...result, activeQuestionId: this.originalQuestionId };
    }
    return result;
  }
}
