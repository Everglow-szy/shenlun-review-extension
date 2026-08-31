import type {
  ExtractedPaperPayload,
  QuestionDefinition,
  QuestionMeta,
} from "../types";

export type QuestionData = QuestionDefinition;

export interface ExamAdapter {
  canHandle(url: string): boolean;
  getPaperName(): Promise<string>;
  getQuestionList(): Promise<QuestionMeta[]>;
  activateQuestion(questionId: string): Promise<void>;
  extractQuestion(questionId: string): Promise<QuestionData>;
  restoreOriginalQuestion(): Promise<void>;
}

export interface PaperExtractingExamAdapter extends ExamAdapter {
  extractPaper(): Promise<ExtractedPaperPayload>;
}

export class ExamAdapterError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ExamAdapterError";
  }
}
