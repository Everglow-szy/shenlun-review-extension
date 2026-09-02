import {
  DEFAULT_FULL_PAPER_PROMPT_TEMPLATE,
  DEFAULT_SINGLE_QUESTION_PROMPT_TEMPLATE,
} from "../services/promptTemplates";

/** Current shape version for every object persisted by the extension. */
export const PERSISTED_ENTITY_VERSION = 1 as const;

export type PersistedEntityVersion = typeof PERSISTED_ENTITY_VERSION;
export type PaperId = string;
export type AttemptId = string;
export type QuestionId = string;
export type FeedbackId = string;

export interface PersistedEntity {
  readonly schemaVersion: PersistedEntityVersion;
}

export type AttemptStatus = "new" | "answering" | "completed" | "submitted";
export type QuestionStatus =
  | "unanswered"
  | "answering"
  | "answered"
  | "submitted"
  | "graded";

export interface QuestionMeta {
  readonly questionId: QuestionId;
  readonly index: number;
  readonly title: string;
}

/** Immutable question data extracted from an exam website. */
export interface QuestionDefinition {
  readonly questionId: QuestionId;
  /** Zero-based display order. */
  readonly index: number;
  readonly title: string;
  readonly questionText: string;
  readonly materials: readonly string[];
  readonly score: number | null;
  readonly wordLimit: number | null;
  readonly referenceAnswer: string | null;
}

/** A deduplicated paper. User answers never belong on this object. */
export interface PaperDefinition extends PersistedEntity {
  readonly paperId: PaperId;
  readonly fingerprint: string;
  readonly paperName: string;
  readonly paperSource: string;
  readonly sourceUrl: string;
  readonly paperDate: string | null;
  readonly questions: readonly QuestionDefinition[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Serializable timer state. `runningSince` intentionally remains persisted so a
 * running timer can be reconstructed after a side-panel/browser restart.
 */
export interface PersistedTimerState {
  readonly schemaVersion: PersistedEntityVersion;
  readonly accumulatedMilliseconds: number;
  readonly runningSince: number | null;
  readonly checkpointedAt: number;
}

/** One practice run of a PaperDefinition. */
export interface PaperAttempt extends PersistedEntity {
  readonly attemptId: AttemptId;
  readonly paperId: PaperId;
  readonly attemptNumber: number;
  readonly status: AttemptStatus;
  readonly totalElapsedSeconds: number;
  readonly timer: PersistedTimerState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly submittedAt: number | null;
}

/**
 * Mutable answer state. The composite `id` is derived from attemptId and
 * questionId; repositories never look up an answer by question index alone.
 */
export interface QuestionAttempt extends PersistedEntity {
  readonly id: string;
  readonly attemptId: AttemptId;
  readonly paperId: PaperId;
  readonly questionId: QuestionId;
  readonly index: number;
  readonly title: string;
  readonly questionText: string;
  readonly materials: readonly string[];
  readonly score: number | null;
  readonly wordLimit: number | null;
  readonly referenceAnswer: string | null;
  readonly userAnswer: string;
  readonly elapsedSeconds: number;
  readonly timer: PersistedTimerState;
  readonly status: QuestionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly submittedAt: number | null;
}

/** Exactly one binding is stored for each attemptId. */
export interface ConversationBinding extends PersistedEntity {
  readonly attemptId: AttemptId;
  readonly paperId: PaperId;
  readonly projectName: string;
  readonly projectUrl?: string;
  readonly conversationName: string;
  readonly conversationUrl?: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

/**
 * Permanent ownership of a ChatGPT conversation URL. Claims are append-only:
 * rebinding changes ConversationBinding but never releases an old URL.
 */
export interface ConversationClaim extends PersistedEntity {
  readonly conversationUrl: string;
  readonly attemptId: AttemptId;
  readonly paperId: PaperId;
  readonly claimedAt: number;
}

export interface GradingFeedback {
  readonly score?: number;
  readonly maxScore?: number;
  readonly rawText: string;
  readonly engine?: GradingEngineId;
  readonly model?: GradingModelId;
  readonly sourceUrl?: string;
  readonly createdAt: number;
}

export type GradingEngineId = "chatgpt-web" | "deepseek-api";

export type GradingModelId =
  | "chatgpt-project-default"
  | "deepseek-v4-flash-thinking"
  | "deepseek-v4-flash-nonthinking"
  | "deepseek-v4-pro-thinking"
  | "deepseek-v4-pro-nonthinking";

export interface GradingTarget {
  readonly engine: GradingEngineId;
  readonly model: GradingModelId;
}

export interface FeedbackDeliveryResult extends GradingTarget {
  readonly submitted: true;
  readonly responseText: string;
  readonly sourceUrl?: string;
  readonly tabId?: number;
  readonly renamed?: boolean;
  readonly renameError?: string;
}

export type FeedbackScope = "question" | "paper";

export interface FeedbackRecord extends PersistedEntity {
  readonly feedbackId: FeedbackId;
  readonly attemptId: AttemptId;
  readonly paperId: PaperId;
  readonly questionId: QuestionId | null;
  readonly scope: FeedbackScope;
  readonly feedback: GradingFeedback;
  readonly createdAt: number;
}

export interface AppSettings extends PersistedEntity {
  readonly key: "app";
  readonly projectName: string;
  readonly projectUrl: string;
  readonly autoOpenChatGPT: boolean;
  readonly autoFillPrompt: boolean;
  readonly autoSubmitPrompt: boolean;
  readonly autoOpenConversationAfterFullSubmit: boolean;
  readonly gradingEngine: GradingEngineId;
  readonly gradingModel: GradingModelId;
  readonly deepseekApiBaseUrl: string;
  readonly deepseekApiKey: string;
  readonly singleQuestionPromptTemplate: string;
  readonly fullPaperPromptTemplate: string;
  readonly autoSave: boolean;
  readonly showWordCount: boolean;
  readonly showQuestionTimer: boolean;
  readonly showTotalTimer: boolean;
  readonly updatedAt: number;
}

export interface AppSettingsPatch {
  readonly projectName?: string;
  readonly projectUrl?: string;
  readonly autoOpenChatGPT?: boolean;
  readonly autoFillPrompt?: boolean;
  readonly autoSubmitPrompt?: boolean;
  readonly autoOpenConversationAfterFullSubmit?: boolean;
  readonly gradingEngine?: GradingEngineId;
  readonly gradingModel?: GradingModelId;
  readonly deepseekApiBaseUrl?: string;
  readonly deepseekApiKey?: string;
  readonly singleQuestionPromptTemplate?: string;
  readonly fullPaperPromptTemplate?: string;
  readonly autoSave?: boolean;
  readonly showWordCount?: boolean;
  readonly showQuestionTimer?: boolean;
  readonly showTotalTimer?: boolean;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  schemaVersion: PERSISTED_ENTITY_VERSION,
  key: "app",
  projectName: "申论训练",
  projectUrl: "",
  autoOpenChatGPT: true,
  autoFillPrompt: true,
  autoSubmitPrompt: false,
  autoOpenConversationAfterFullSubmit: true,
  gradingEngine: "chatgpt-web",
  gradingModel: "chatgpt-project-default",
  deepseekApiBaseUrl: "https://api.deepseek.com",
  deepseekApiKey: "",
  singleQuestionPromptTemplate: DEFAULT_SINGLE_QUESTION_PROMPT_TEMPLATE,
  fullPaperPromptTemplate: DEFAULT_FULL_PAPER_PROMPT_TEMPLATE,
  autoSave: true,
  showWordCount: true,
  showQuestionTimer: true,
  showTotalTimer: true,
  updatedAt: 0,
};

export interface CreatePaperDefinitionInput {
  readonly paperName: string;
  readonly paperSource: string;
  readonly sourceUrl: string;
  readonly paperDate?: string | null;
  readonly questions: readonly QuestionDefinition[];
}

export interface CreateAttemptInput {
  readonly paperId: PaperId;
  readonly startImmediately?: boolean;
  readonly activeQuestionId?: QuestionId;
  readonly now?: number;
}

export interface SaveQuestionDraftInput {
  readonly attemptId: AttemptId;
  readonly questionId: QuestionId;
  readonly userAnswer: string;
  readonly elapsedSeconds?: number;
  readonly timer?: PersistedTimerState;
  readonly now?: number;
}

export interface TimerCheckpointInput {
  readonly attemptId: AttemptId;
  readonly attemptTimer: PersistedTimerState;
  readonly questionTimers: Readonly<Record<QuestionId, PersistedTimerState>>;
  readonly now?: number;
}

export interface SavePastedFeedbackInput {
  readonly attemptId: AttemptId;
  readonly questionId: QuestionId | null;
  readonly rawText: string;
  readonly score?: number;
  readonly maxScore?: number;
  readonly engine?: GradingEngineId;
  readonly model?: GradingModelId;
  readonly sourceUrl?: string;
  readonly now?: number;
}

export interface IngestPaperResult {
  readonly paper: PaperDefinition;
  readonly duplicate: boolean;
}

export interface PracticeHistoryItem {
  readonly paper: PaperDefinition;
  readonly attempt: PaperAttempt;
  readonly completedQuestionCount: number;
  readonly totalQuestionCount: number;
}

export type ManualSubmissionHandoff =
  | {
      readonly mode: "single-question";
      readonly questionId: QuestionId;
    }
  | {
      readonly mode: "full-paper";
    };

export interface SingleQuestionPromptInput {
  readonly paperName: string;
  readonly attemptId: AttemptId;
  readonly question: QuestionAttempt;
  readonly template?: string;
}

export interface FullPaperPromptInput {
  readonly paperName: string;
  readonly attemptId: AttemptId;
  readonly questions: readonly QuestionAttempt[];
  readonly totalElapsedSeconds: number;
  readonly template?: string;
}

export type FeedbackSubmissionMode = "single-question" | "full-paper";

export interface FeedbackSubmission {
  readonly mode: FeedbackSubmissionMode;
  readonly attemptId: AttemptId;
  readonly paperId: PaperId;
  readonly questionId?: QuestionId;
  readonly prompt: string;
  readonly binding: ConversationBinding | null;
}

/** Immutable answer/timer payload captured before a non-idempotent web handoff. */
export interface QuestionSnapshot {
  readonly questionId: QuestionId;
  readonly userAnswer: string;
  readonly elapsedSeconds: number;
  readonly timer: PersistedTimerState;
}

/** Live mutable state supplied by the side panel at the user's submit click. */
export type SubmissionSnapshotInput =
  | {
      readonly mode: "single-question";
      readonly question: QuestionSnapshot;
    }
  | {
      readonly mode: "full-paper";
      readonly questions: readonly QuestionSnapshot[];
      readonly attemptTimer: PersistedTimerState;
      readonly totalElapsedSeconds: number;
    };

export type SubmissionOutboxStatus =
  | "prepared"
  | "delivering"
  | "finalized"
  | "cancelled";

/**
 * Durable submission intent. Answer and timer fields are immutable after the
 * record is prepared; later state transitions only update delivery metadata.
 */
export interface SubmissionOutboxRecord extends PersistedEntity {
  readonly requestId: string;
  readonly target?: GradingTarget;
  readonly attemptId: AttemptId;
  readonly paperId: PaperId;
  readonly handoff: ManualSubmissionHandoff;
  readonly prompt: string;
  readonly questions: readonly QuestionSnapshot[];
  readonly attemptTimer: PersistedTimerState | null;
  readonly totalElapsedSeconds: number | null;
  readonly status: SubmissionOutboxStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deliveringAt: number | null;
  readonly finalizedAt: number | null;
  readonly cancelledAt: number | null;
}

export type CancelPreparedSubmissionResult =
  | "cancelled"
  | "not-found"
  | "already-started"
  | "already-finalized";

export type MarkPreparedSubmissionDeliveringResult =
  | "acquired"
  | "already-delivering"
  | "already-finalized";

/** Outcome of cancelling this attempt's one-shot manual-send handoff. */
export type CancelPendingFeedbackResult =
  | {
      readonly cancelled: true;
      readonly tooLate: false;
      readonly reason: "cancelled";
    }
  | {
      readonly cancelled: false;
      readonly tooLate: false;
      readonly reason: "not-found";
    }
  | {
      readonly cancelled: false;
      readonly tooLate: true;
      readonly reason: "delivery-in-progress" | "send-started";
    };

/** Replaceable boundary; the MVP implementation drives the ChatGPT web page. */
export interface FeedbackProvider {
  submit(submission: FeedbackSubmission): Promise<void>;
}

export interface ExtensionError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Runtime requests shared by the side panel, content scripts and service worker.
 * Every attempt-scoped operation carries attemptId explicitly.
 */
export type ExtensionRequest =
  | {
      readonly type: "EXAM/EXTRACT";
      readonly payload?: { readonly windowId: number };
    }
  | {
      readonly type: "ATTEMPT/CREATE";
      readonly payload: CreateAttemptInput;
    }
  | {
      readonly type: "ATTEMPT/GET";
      readonly payload: { readonly attemptId: AttemptId };
    }
  | {
      readonly type: "QUESTION/SAVE_DRAFT";
      readonly payload: SaveQuestionDraftInput;
    }
  | {
      readonly type: "FEEDBACK/SUBMIT_SINGLE";
      readonly payload: {
        readonly attemptId: AttemptId;
        readonly questionId: QuestionId;
        readonly requestId: string;
        readonly target: GradingTarget;
      };
    }
  | {
      readonly type: "FEEDBACK/SUBMIT_FULL";
      readonly payload: {
        readonly attemptId: AttemptId;
        readonly requestId: string;
        readonly target: GradingTarget;
      };
    }
  | {
      readonly type: "FEEDBACK/CONFIRM_MANUAL";
      readonly payload: {
        readonly attemptId: AttemptId;
        readonly requestId: string;
        readonly handoff: ManualSubmissionHandoff;
      };
    }
  | {
      readonly type: "FEEDBACK/CANCEL_PENDING";
      readonly payload: {
        readonly attemptId: AttemptId;
        readonly requestId: string;
        readonly confirmedUnsent: boolean;
      };
    }
  | {
      readonly type: "FEEDBACK/SAVE_PASTED";
      readonly payload: {
        readonly attemptId: AttemptId;
        readonly questionId: QuestionId | null;
        readonly rawText: string;
        readonly score?: number;
        readonly maxScore?: number;
      };
    }
  | {
      readonly type: "CONVERSATION/REBIND";
      readonly payload: {
        readonly attemptId: AttemptId;
        readonly conversationUrl: string;
      };
    }
  | {
      readonly type: "CHATGPT/FILL_PROMPT";
      readonly payload: {
        readonly attemptId: AttemptId;
        readonly prompt: string;
        readonly autoSubmit: boolean;
      };
    };

export interface ExtractedPaperPayload extends CreatePaperDefinitionInput {
  readonly activeQuestionId?: QuestionId;
}

export type ExtensionResponse =
  | { readonly ok: true; readonly data?: unknown }
  | { readonly ok: false; readonly error: ExtensionError };

export type AttemptBundle = {
  readonly paper: PaperDefinition;
  readonly attempt: PaperAttempt;
  readonly questions: readonly QuestionAttempt[];
  readonly conversation: ConversationBinding | null;
  readonly feedback: readonly FeedbackRecord[];
};
