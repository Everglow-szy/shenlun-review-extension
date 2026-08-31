import {
  PERSISTED_ENTITY_VERSION,
  type AppSettings,
  type AppSettingsPatch,
  type AttemptBundle,
  type AttemptId,
  type CreateAttemptInput,
  type CreatePaperDefinitionInput,
  type FeedbackProvider,
  type FeedbackRecord,
  type FeedbackSubmission,
  type IngestPaperResult,
  type ManualSubmissionHandoff,
  type MarkPreparedSubmissionDeliveringResult,
  type PaperAttempt,
  type PaperId,
  type PaperDefinition,
  type PracticeHistoryItem,
  type QuestionId,
  type SavePastedFeedbackInput,
  type SaveQuestionDraftInput,
  type SubmissionOutboxRecord,
  type SubmissionSnapshotInput,
  type CancelPreparedSubmissionResult,
  type TimerCheckpointInput,
} from "../types";
import { AttemptRepository } from "../database/attemptRepository";
import { ConversationBindingRepository } from "../database/conversationBindingRepository";
import { FeedbackRepository } from "../database/feedbackRepository";
import {
  getDefaultDatabase,
  type DatabaseProvider,
} from "../database/indexedDB";
import { PaperRepository } from "../database/paperRepository";
import { PracticeRepository } from "../database/practiceRepository";
import { SettingsRepository } from "../database/settingsRepository";
import { SubmissionOutboxRepository } from "../database/submissionOutboxRepository";
import { computePaperFingerprint } from "../utils/fingerprint";
import { createPaperId } from "../utils/ids";
import { buildFullPaperPrompt, buildSingleQuestionPrompt } from "./promptBuilder";

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function validatePaperInput(input: CreatePaperDefinitionInput): void {
  requireNonEmpty(input.paperName, "paperName");
  requireNonEmpty(input.paperSource, "paperSource");
  requireNonEmpty(input.sourceUrl, "sourceUrl");
  if (input.questions.length === 0) {
    throw new Error("A paper must contain at least one question");
  }
  const questionIds = new Set<string>();
  const indexes = new Set<number>();
  for (const question of input.questions) {
    requireNonEmpty(question.questionId, "questionId");
    if (!Number.isSafeInteger(question.index) || question.index < 0) {
      throw new RangeError("Question index must be a zero-based non-negative integer");
    }
    if (questionIds.has(question.questionId) || indexes.has(question.index)) {
      throw new Error("Question ids and indexes must be unique within a paper");
    }
    questionIds.add(question.questionId);
    indexes.add(question.index);
  }
}

function isConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "ConstraintError"
  );
}

export class PracticeService {
  private readonly papers: PaperRepository;
  private readonly attempts: AttemptRepository;
  private readonly conversations: ConversationBindingRepository;
  private readonly feedback: FeedbackRepository;
  private readonly practice: PracticeRepository;
  private readonly settings: SettingsRepository;
  private readonly submissionOutbox: SubmissionOutboxRepository;

  public constructor(databaseProvider: DatabaseProvider = getDefaultDatabase) {
    this.papers = new PaperRepository(databaseProvider);
    this.attempts = new AttemptRepository(databaseProvider);
    this.conversations = new ConversationBindingRepository(databaseProvider);
    this.feedback = new FeedbackRepository(databaseProvider);
    this.practice = new PracticeRepository(databaseProvider);
    this.settings = new SettingsRepository(databaseProvider);
    this.submissionOutbox = new SubmissionOutboxRepository(databaseProvider);
  }

  public async ingestPaper(input: CreatePaperDefinitionInput): Promise<IngestPaperResult> {
    validatePaperInput(input);
    const fingerprint = await computePaperFingerprint(input);
    const existing = await this.papers.findByFingerprint(fingerprint);
    if (existing) {
      return { paper: existing, duplicate: true };
    }
    const now = Date.now();
    const paper: PaperDefinition = {
      schemaVersion: PERSISTED_ENTITY_VERSION,
      paperId: createPaperId(fingerprint),
      fingerprint,
      paperName: input.paperName.trim(),
      paperSource: input.paperSource.trim(),
      sourceUrl: input.sourceUrl.trim(),
      paperDate: input.paperDate ?? null,
      questions: [...input.questions]
        .sort((left, right) => left.index - right.index)
        .map((question) => ({ ...question, materials: [...question.materials] })),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.papers.save(paper);
      return { paper, duplicate: false };
    } catch (error: unknown) {
      // Two extension contexts may ingest the same paper at the same time.
      if (isConstraintError(error)) {
        const raced = await this.papers.findByFingerprint(fingerprint);
        if (raced) {
          return { paper: raced, duplicate: true };
        }
      }
      throw error;
    }
  }

  public async createAttempt(input: CreateAttemptInput): Promise<AttemptBundle> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const created = await this.practice.createAttempt(input);
        const paper = await this.papers.get(input.paperId);
        if (!paper) {
          throw new Error("Attempt was created but its paper definition is missing");
        }
        return {
          paper,
          attempt: created.attempt,
          questions: created.questions,
          conversation: created.conversation,
          feedback: [],
        };
      } catch (error: unknown) {
        lastError = error;
        if (!isConstraintError(error)) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  public async loadAttemptBundle(attemptId: AttemptId): Promise<AttemptBundle | null> {
    return this.practice.loadBundle(attemptId);
  }

  public async listHistory(limit = 50): Promise<PracticeHistoryItem[]> {
    const attempts = await this.attempts.listRecent(limit);
    return this.summarizeAttempts(attempts);
  }

  public async listAttemptsByPaper(paperId: PaperId): Promise<PracticeHistoryItem[]> {
    const attempts = await this.attempts.listByPaper(paperId);
    return this.summarizeAttempts(attempts);
  }

  private async summarizeAttempts(
    attempts: readonly PaperAttempt[],
  ): Promise<PracticeHistoryItem[]> {
    const items = await Promise.all(
      attempts.map(async (attempt): Promise<PracticeHistoryItem | null> => {
        const bundle = await this.practice.loadBundle(attempt.attemptId);
        if (!bundle) {
          return null;
        }
        return {
          paper: bundle.paper,
          attempt: bundle.attempt,
          completedQuestionCount: bundle.questions.filter((question) =>
            ["answered", "submitted", "graded"].includes(question.status),
          ).length,
          totalQuestionCount: bundle.questions.length,
        };
      }),
    );
    return items.filter((item): item is PracticeHistoryItem => item !== null);
  }

  public async saveQuestionDraft(input: SaveQuestionDraftInput): Promise<void> {
    await this.practice.saveQuestionDraft(input);
  }

  public async saveTimerCheckpoint(input: TimerCheckpointInput): Promise<void> {
    await this.practice.saveTimerCheckpoint(input);
  }

  public async prepareSubmission(
    attemptId: AttemptId,
    handoff: ManualSubmissionHandoff,
    requestId: string,
    snapshotInput?: SubmissionSnapshotInput,
  ): Promise<FeedbackSubmission> {
    return this.submissionOutbox.toSubmission(
      await this.submissionOutbox.prepare(attemptId, handoff, requestId, snapshotInput),
    );
  }

  public async getPreparedSubmission(
    attemptId: AttemptId,
    requestId: string,
  ): Promise<FeedbackSubmission> {
    return this.submissionOutbox.toSubmission(
      await this.submissionOutbox.getPrepared(attemptId, requestId),
    );
  }

  public async getActivePreparedSubmission(
    attemptId: AttemptId,
  ): Promise<SubmissionOutboxRecord | null> {
    return this.submissionOutbox.getActive(attemptId);
  }

  public async getSubmissionOutboxRecord(
    attemptId: AttemptId,
    requestId: string,
  ): Promise<SubmissionOutboxRecord | null> {
    return this.submissionOutbox.get(attemptId, requestId);
  }

  public async markPreparedSubmissionDelivering(
    attemptId: AttemptId,
    requestId: string,
    now?: number,
  ): Promise<MarkPreparedSubmissionDeliveringResult> {
    return this.submissionOutbox.markDelivering(attemptId, requestId, now);
  }

  public async finalizePreparedSubmission(
    attemptId: AttemptId,
    requestId: string,
    now?: number,
  ): Promise<void> {
    await this.submissionOutbox.finalize(attemptId, requestId, now);
  }

  public async cancelPreparedSubmission(
    attemptId: AttemptId,
    requestId: string,
    now?: number,
  ): Promise<CancelPreparedSubmissionResult> {
    return this.submissionOutbox.cancel(attemptId, requestId, now);
  }

  /** Use only after the ChatGPT page positively proves that no send occurred. */
  public async cancelPreparedSubmissionAfterConfirmedUnsent(
    attemptId: AttemptId,
    requestId: string,
    now?: number,
  ): Promise<CancelPreparedSubmissionResult> {
    return this.submissionOutbox.cancel(attemptId, requestId, now, true);
  }

  public async buildSingleSubmission(
    attemptId: AttemptId,
    questionId: QuestionId,
  ): Promise<FeedbackSubmission> {
    const bundle = await this.requireBundle(attemptId);
    const question = bundle.questions.find((candidate) => candidate.questionId === questionId);
    if (!question) {
      throw new Error("Question does not belong to the supplied attemptId");
    }
    return {
      mode: "single-question",
      attemptId,
      paperId: bundle.paper.paperId,
      questionId,
      prompt: buildSingleQuestionPrompt({
        paperName: bundle.paper.paperName,
        attemptId,
        question,
      }),
      binding: bundle.conversation,
    };
  }

  public async buildFullSubmission(attemptId: AttemptId): Promise<FeedbackSubmission> {
    const bundle = await this.requireBundle(attemptId);
    if (bundle.attempt.status === "submitted" || bundle.attempt.submittedAt !== null) {
      throw new Error("当前试卷已提交，请勿重复提交。");
    }
    if (bundle.questions.length === 0 || bundle.questions.some((question) => !question.userAnswer.trim())) {
      throw new Error("请先完成当前试卷的全部题目，再提交整卷批改。");
    }
    return {
      mode: "full-paper",
      attemptId,
      paperId: bundle.paper.paperId,
      prompt: buildFullPaperPrompt({
        paperName: bundle.paper.paperName,
        attemptId,
        questions: bundle.questions,
        totalElapsedSeconds: bundle.attempt.totalElapsedSeconds,
      }),
      binding: bundle.conversation,
    };
  }

  public async submitSingleQuestion(
    attemptId: AttemptId,
    questionId: QuestionId,
    provider: FeedbackProvider,
  ): Promise<FeedbackSubmission> {
    const submission = await this.buildSingleSubmission(attemptId, questionId);
    await provider.submit(submission);
    await this.practice.markQuestionSubmitted(attemptId, questionId);
    await this.conversations.touch(attemptId);
    return submission;
  }

  public async submitFullPaper(
    attemptId: AttemptId,
    provider: FeedbackProvider,
  ): Promise<FeedbackSubmission> {
    const submission = await this.buildFullSubmission(attemptId);
    await provider.submit(submission);
    await this.practice.markAttemptSubmitted(attemptId);
    await this.conversations.touch(attemptId);
    return submission;
  }

  public async confirmManualSubmission(
    attemptId: AttemptId,
    handoff: ManualSubmissionHandoff,
  ): Promise<void> {
    const bundle = await this.requireBundle(attemptId);
    if (handoff.mode === "single-question") {
      if (!bundle.questions.some((question) => question.questionId === handoff.questionId)) {
        throw new Error("Question does not belong to the supplied attemptId");
      }
      await this.practice.markQuestionSubmitted(attemptId, handoff.questionId);
    } else {
      if (bundle.questions.length === 0 || bundle.questions.some((question) => !question.userAnswer.trim())) {
        throw new Error("Cannot confirm a full-paper submission with unanswered questions");
      }
      await this.practice.markAttemptSubmitted(attemptId);
    }
    await this.conversations.touch(attemptId);
  }

  public async savePastedFeedback(input: SavePastedFeedbackInput): Promise<FeedbackRecord> {
    const rawText = requireNonEmpty(input.rawText, "rawText");
    const bundle = await this.requireBundle(input.attemptId);
    if (
      input.questionId !== null &&
      !bundle.questions.some((question) => question.questionId === input.questionId)
    ) {
      throw new Error("Question does not belong to the supplied attemptId");
    }
    if (input.questionId !== null) {
      const question = bundle.questions.find(
        (candidate) => candidate.questionId === input.questionId,
      )!;
      if (bundle.attempt.status !== "submitted" && question.submittedAt === null) {
        throw new Error("请先提交本题或整卷，再保存本题批改结果。");
      }
    }
    const createdAt = input.now ?? Date.now();
    const record = await this.feedback.create({
      attemptId: input.attemptId,
      paperId: bundle.paper.paperId,
      questionId: input.questionId,
      feedback: {
        rawText,
        createdAt,
        ...(input.score === undefined ? {} : { score: input.score }),
        ...(input.maxScore === undefined ? {} : { maxScore: input.maxScore }),
        ...(input.engine === undefined ? {} : { engine: input.engine }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
      },
    });
    if (input.questionId !== null) {
      await this.practice.markQuestionGraded(input.attemptId, input.questionId, createdAt);
    }
    return record;
  }

  public async getSettings(): Promise<AppSettings> {
    return this.settings.get();
  }

  public async saveSettings(patch: AppSettingsPatch): Promise<AppSettings> {
    return this.settings.save(patch);
  }

  private async requireBundle(attemptId: AttemptId): Promise<AttemptBundle> {
    const bundle = await this.practice.loadBundle(attemptId);
    if (!bundle) {
      throw new Error("Paper attempt was not found");
    }
    return bundle;
  }
}

export const practiceService = new PracticeService();
