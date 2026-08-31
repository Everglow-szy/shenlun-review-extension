import { useCallback, useEffect, useRef, useState } from "react";
import {
  getElapsedSeconds,
  isTimerRunning,
  parseFeedbackScore,
  pauseTimer,
  practiceService,
  type TimerCoordinatorSnapshot,
} from "../services";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AttemptBundle,
  type ExtractedPaperPayload,
  type ExtensionRequest,
  type FeedbackDeliveryResult,
  type GradingTarget,
  type PaperDefinition,
  type PracticeHistoryItem,
  type QuestionSnapshot,
  type QuestionAttempt,
  type QuestionId,
  type SubmissionOutboxRecord,
} from "../types";
import { ChatGPTAdapter } from "../adapters/ChatGPTAdapter";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { DuplicateDialog } from "./components/DuplicateDialog";
import { Icon } from "./components/Icon";
import { StatusBanner } from "./components/StatusBanner";
import { useAttemptTimer } from "./hooks/useAttemptTimer";
import { useDebouncedEffect } from "./hooks/useDebouncedEffect";
import { HistoryPage } from "./pages/HistoryPage";
import { PracticePage, type SaveState } from "./pages/PracticePage";
import { SettingsPage } from "./pages/SettingsPage";
import { RuntimeRequestError, sendRuntimeRequest } from "./runtimeClient";
import {
  FLOATING_WINDOW_SESSION_KEY,
  FLOATING_WINDOW_SIZE_KEY,
  consumeRestoreWithoutScan,
  floatingPageUrl,
  normalizeFloatingWindowSize,
  parseAppDisplayContext,
  requestRestoreWithoutScan,
  type AppDisplayContext,
} from "./windowMode";
import {
  cachePendingDraft,
  cachePendingTimerCheckpoint,
  clearPendingDraftIfSaved,
  clearPendingTimerCheckpointIfSaved,
  getErrorMessage,
  mergePendingDraftAnswers,
  mergeUnsavedAnswerText,
  readPendingTimerCheckpoint,
} from "./utils";

type View = "practice" | "history" | "settings";
type BusyAction = "scan" | "single" | "full" | "feedback" | "resolve" | null;
type Notice = { readonly id: number; readonly tone: "info" | "success" | "error"; readonly text: string };
type DuplicateState = {
  readonly paper: PaperDefinition;
  readonly attempts: readonly PracticeHistoryItem[];
  readonly activeQuestionId: QuestionId | null;
  readonly fallbackAttemptId: string | null;
};
type ConversationDetectedEvent = {
  readonly type: "BRIDGE/CONVERSATION_DETECTED";
  readonly payload: {
    readonly attemptId: string;
    readonly conversationUrl: string;
    readonly renamed: boolean;
    readonly renameError?: string;
  };
};
type ManualSubmissionRecordedEvent = {
  readonly type: "BRIDGE/MANUAL_SUBMISSION_RECORDED";
  readonly payload:
    | { readonly attemptId: string; readonly mode: "single-question"; readonly questionId: string; readonly requestId: string }
    | { readonly attemptId: string; readonly mode: "full-paper"; readonly requestId: string };
};
type CancelPendingResult = {
  readonly cancelled: boolean;
  readonly tooLate?: boolean;
  readonly reason?: "cancelled" | "not-found" | "delivery-in-progress" | "send-started";
};

export type PendingSubmission = {
  readonly attemptId: string;
  readonly mode: "single-question" | "full-paper";
  readonly questionId?: QuestionId;
  readonly state: "preparing" | "manual" | "uncertain";
  readonly requestId: string;
  readonly ownerContextId: string;
  readonly createdAt: number;
};

const ACTIVE_ATTEMPT_KEY = "shenlun.activeAttemptId";
const PENDING_SUBMISSION_PREFIX = "shenlun.pendingSubmission.v2:";
const PREPARING_RECOVERY_DELAY_MS = 120_000;

type ExamExtractionRequest = Extract<ExtensionRequest, { readonly type: "EXAM/EXTRACT" }>;

interface FloatingWindowSession {
  readonly windowId: number;
  readonly sourceWindowId: number;
}

interface SidePanelCloseApi {
  close(options: { readonly windowId: number }): Promise<void>;
}

function examExtractionRequest(context: AppDisplayContext): ExamExtractionRequest {
  return context.sourceWindowId === null
    ? { type: "EXAM/EXTRACT" }
    : { type: "EXAM/EXTRACT", payload: { windowId: context.sourceWindowId } };
}

function parseFloatingWindowSession(value: unknown): FloatingWindowSession | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly windowId?: unknown; readonly sourceWindowId?: unknown };
  return typeof candidate.windowId === "number" && Number.isSafeInteger(candidate.windowId) &&
    candidate.windowId > 0 && typeof candidate.sourceWindowId === "number" &&
    Number.isSafeInteger(candidate.sourceWindowId) && candidate.sourceWindowId > 0
    ? { windowId: candidate.windowId, sourceWindowId: candidate.sourceWindowId }
    : null;
}

function friendlyError(error: unknown): string {
  if (error instanceof RuntimeRequestError) {
    switch (error.code) {
      case "EXAM_UNSUPPORTED":
      case "EXAM_STRUCTURE_UNRECOGNIZED":
      case "EXAM_EXTRACTION_FAILED":
        return "无法识别当前试卷结构。请确认已打开完整试卷页面，或稍后更新网站适配器。";
      case "CHATGPT_LOGIN_REQUIRED":
        return "请先登录 ChatGPT，然后重新提交。";
      case "CHATGPT_PROJECT_NOT_FOUND":
        return "未找到设置中的 ChatGPT Project，请检查 Project 名称或 URL。";
      case "CHATGPT_CONVERSATION_FAILED":
        return "对应试卷对话打开失败。可在历史记录中恢复后重新提交。";
      case "CHATGPT_INVALID_CONVERSATION_URL":
        return "请输入有效的 ChatGPT 对话地址（地址中应包含 /c/）。";
      default:
        return error.message;
    }
  }
  return getErrorMessage(error);
}

async function readActiveAttemptId(): Promise<string | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  const stored = await chrome.storage.local.get(ACTIVE_ATTEMPT_KEY);
  return typeof stored[ACTIVE_ATTEMPT_KEY] === "string" ? stored[ACTIVE_ATTEMPT_KEY] : null;
}

async function rememberActiveAttempt(attemptId: string): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [ACTIVE_ATTEMPT_KEY]: attemptId });
  }
}

function getDraftStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function pendingSubmissionKey(attemptId: string): string {
  return `${PENDING_SUBMISSION_PREFIX}${encodeURIComponent(attemptId)}`;
}

function readPendingSubmission(
  storage: Storage | null,
  attemptId: string,
): PendingSubmission | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(pendingSubmissionKey(attemptId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<PendingSubmission>;
    if (
      candidate.attemptId !== attemptId ||
      candidate.state !== "preparing" &&
      candidate.state !== "manual" &&
      candidate.state !== "uncertain"
    ) return null;
    if (
      typeof candidate.requestId !== "string" ||
      !candidate.requestId ||
      typeof candidate.ownerContextId !== "string" ||
      !candidate.ownerContextId ||
      typeof candidate.createdAt !== "number" ||
      !Number.isFinite(candidate.createdAt) ||
      candidate.createdAt < 0
    ) return null;
    if (candidate.mode === "full-paper") {
      return {
        attemptId: candidate.attemptId,
        mode: candidate.mode,
        state: candidate.state,
        requestId: candidate.requestId,
        ownerContextId: candidate.ownerContextId,
        createdAt: candidate.createdAt,
      };
    }
    if (candidate.mode === "single-question" && typeof candidate.questionId === "string" && candidate.questionId) {
      return {
        attemptId: candidate.attemptId,
        mode: candidate.mode,
        questionId: candidate.questionId,
        state: candidate.state,
        requestId: candidate.requestId,
        ownerContextId: candidate.ownerContextId,
        createdAt: candidate.createdAt,
      };
    }
  } catch {
    // Ignore malformed or unavailable local storage and continue from IndexedDB.
  }
  return null;
}

function writePendingSubmission(
  storage: Storage | null,
  attemptId: string,
  pending: PendingSubmission | null,
): void {
  if (!storage) return;
  try {
    if (pending) storage.setItem(pendingSubmissionKey(attemptId), JSON.stringify(pending));
    else storage.removeItem(pendingSubmissionKey(attemptId));
  } catch {
    // The in-memory lock still protects this panel if local storage is unavailable.
  }
}

function createPendingRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function pendingSubmissionFromOutbox(
  record: SubmissionOutboxRecord,
  stored: PendingSubmission | null,
  ownerContextId: string,
): PendingSubmission {
  const matchingStored = stored?.requestId === record.requestId ? stored : null;
  const state: PendingSubmission["state"] = record.status === "prepared"
    ? (matchingStored?.state ?? "preparing")
    : matchingStored?.state === "manual" || matchingStored?.state === "uncertain"
      ? matchingStored.state
      : "uncertain";
  const base = {
    attemptId: record.attemptId,
    state,
    requestId: record.requestId,
    ownerContextId: matchingStored?.ownerContextId ?? ownerContextId,
    createdAt: matchingStored?.createdAt ?? record.deliveringAt ?? record.createdAt,
  } as const;
  return record.handoff.mode === "single-question"
    ? { ...base, mode: "single-question", questionId: record.handoff.questionId }
    : { ...base, mode: "full-paper" };
}

async function withPendingSubmissionLock<T>(
  attemptId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let locks: LockManager | undefined;
  try {
    locks = navigator.locks;
  } catch {
    // Tests and older compatible runtimes may not expose navigator.
  }
  if (locks) {
    return locks.request(`shenlun.pendingSubmission:${attemptId}`, operation);
  }
  return operation();
}

async function persistPendingDraftMirrors(
  bundle: AttemptBundle,
  shouldContinue: () => boolean = () => true,
): Promise<AttemptBundle | null> {
  const storage = getDraftStorage();
  const mirroredQuestions = mergePendingDraftAnswers(
    storage,
    bundle.attempt.attemptId,
    bundle.questions,
  );
  let recovered: AttemptBundle = {
    ...bundle,
    questions: mirroredQuestions.map((question, index) => {
      const authoritative = bundle.questions[index]!;
      if (
        bundle.attempt.status !== "submitted" &&
        authoritative.submittedAt === null
      ) return question;
      if (question.userAnswer !== authoritative.userAnswer) {
        clearPendingDraftIfSaved(
          storage,
          bundle.attempt.attemptId,
          authoritative.questionId,
          question.userAnswer,
        );
      }
      return authoritative;
    }),
  };
  const storedAnswers = new Map(
    bundle.questions.map((question) => [question.questionId, question.userAnswer]),
  );
  let wroteRecoveredDraft = false;
  for (const question of recovered.questions) {
    if (!shouldContinue()) return null;
    if (question.userAnswer !== storedAnswers.get(question.questionId)) {
      await practiceService.saveQuestionDraft({
        attemptId: recovered.attempt.attemptId,
        questionId: question.questionId,
        userAnswer: question.userAnswer,
      });
      wroteRecoveredDraft = true;
    }
    clearPendingDraftIfSaved(
      storage,
      recovered.attempt.attemptId,
      question.questionId,
      question.userAnswer,
    );
  }
  if (!shouldContinue()) return null;
  if (!wroteRecoveredDraft) return recovered;
  const refreshed = await practiceService.loadAttemptBundle(recovered.attempt.attemptId);
  if (!shouldContinue()) return null;
  if (refreshed) {
    recovered = {
      ...refreshed,
      questions: mergeRecoverablePendingDraftAnswers(storage, refreshed),
    };
  }
  return recovered;
}

function mergeRecoverablePendingDraftAnswers(
  storage: Storage | null,
  bundle: AttemptBundle,
): QuestionAttempt[] {
  const mirrored = mergePendingDraftAnswers(
    storage,
    bundle.attempt.attemptId,
    bundle.questions,
  );
  return mirrored.map((question, index) => {
    const authoritative = bundle.questions[index]!;
    if (
      bundle.attempt.status !== "submitted" &&
      authoritative.submittedAt === null
    ) return question;
    if (question.userAnswer !== authoritative.userAnswer) {
      clearPendingDraftIfSaved(
        storage,
        bundle.attempt.attemptId,
        authoritative.questionId,
        question.userAnswer,
      );
    }
    return authoritative;
  });
}

async function persistPendingTimerMirror(
  bundle: AttemptBundle,
  shouldContinue: () => boolean = () => true,
): Promise<AttemptBundle | null> {
  const storage = getDraftStorage();
  const pending = readPendingTimerCheckpoint(storage, bundle.attempt.attemptId);
  if (!pending) return bundle;
  const expectedQuestionIds = bundle.questions.map((question) => question.questionId).sort();
  const pendingQuestionIds = Object.keys(pending.questionTimers).sort();
  if (
    expectedQuestionIds.length !== pendingQuestionIds.length ||
    expectedQuestionIds.some((questionId, index) => questionId !== pendingQuestionIds[index])
  ) return bundle;
  if (bundle.attempt.status === "submitted") {
    // A pre-submission running WAL must never accrue closed time into a record
    // that another panel has already finalized. The terminal DB state wins.
    clearPendingTimerCheckpointIfSaved(storage, pending.attemptId, pending);
    return bundle;
  }
  if (!shouldContinue()) return null;
  const now = Date.now();
  const terminalQuestionTimers = new Map(
    bundle.questions
      .filter((question) => question.submittedAt !== null)
      .map((question) => [question.questionId, question.timer] as const),
  );
  const questionTimers = Object.fromEntries(
    Object.entries(pending.questionTimers).map(([questionId, timer]) => [
      questionId,
      terminalQuestionTimers.get(questionId) ?? timer,
    ]),
  );
  await practiceService.saveTimerCheckpoint({
    attemptId: pending.attemptId,
    attemptTimer: pending.attemptTimer,
    questionTimers,
    now,
  });
  clearPendingTimerCheckpointIfSaved(storage, pending.attemptId, pending);
  if (!shouldContinue()) return null;
  return (await practiceService.loadAttemptBundle(bundle.attempt.attemptId)) ?? bundle;
}

async function pausePersistedAttempt(bundle: AttemptBundle): Promise<void> {
  const now = Date.now();
  const snapshot: TimerCoordinatorSnapshot = {
    attemptTimer: pauseTimer(bundle.attempt.timer, now),
    questionTimers: Object.fromEntries(
      bundle.questions.map((question) => [question.questionId, pauseTimer(question.timer, now)]),
    ),
    activeQuestionId:
      bundle.questions.find((question) => isTimerRunning(question.timer))?.questionId ?? null,
    manuallyPaused: true,
  };
  const storage = getDraftStorage();
  cachePendingTimerCheckpoint(storage, bundle.attempt.attemptId, snapshot);
  await practiceService.saveTimerCheckpoint({
    attemptId: bundle.attempt.attemptId,
    attemptTimer: snapshot.attemptTimer,
    questionTimers: snapshot.questionTimers,
    now,
  });
  clearPendingTimerCheckpointIfSaved(storage, bundle.attempt.attemptId, snapshot);
}

function selectInitialQuestion(bundle: AttemptBundle): QuestionId | null {
  return (
    bundle.questions.find((question) => isTimerRunning(question.timer))?.questionId ??
    bundle.questions.find((question) => question.status === "answering")?.questionId ??
    bundle.questions.find((question) => !["submitted", "graded"].includes(question.status))?.questionId ??
    bundle.questions[0]?.questionId ??
    null
  );
}

function isConversationDetectedEvent(message: unknown): message is ConversationDetectedEvent {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { readonly type?: unknown; readonly payload?: unknown };
  if (candidate.type !== "BRIDGE/CONVERSATION_DETECTED" || typeof candidate.payload !== "object" || candidate.payload === null) return false;
  const payload = candidate.payload as { readonly attemptId?: unknown; readonly conversationUrl?: unknown; readonly renamed?: unknown };
  return typeof payload.attemptId === "string" && typeof payload.conversationUrl === "string" && typeof payload.renamed === "boolean";
}

function isManualSubmissionRecordedEvent(message: unknown): message is ManualSubmissionRecordedEvent {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { readonly type?: unknown; readonly payload?: unknown };
  if (candidate.type !== "BRIDGE/MANUAL_SUBMISSION_RECORDED" || typeof candidate.payload !== "object" || candidate.payload === null) return false;
  const payload = candidate.payload as { readonly attemptId?: unknown; readonly mode?: unknown; readonly questionId?: unknown; readonly requestId?: unknown };
  return (
    typeof payload.attemptId === "string" &&
    typeof payload.requestId === "string" &&
    (payload.mode === "full-paper" ||
      (payload.mode === "single-question" && typeof payload.questionId === "string"))
  );
}

export function App(): JSX.Element {
  const [displayContext] = useState(() => parseAppDisplayContext(window.location.search));
  const [restoreOnlyOnInit] = useState(
    () => displayContext.mode === "floating" || consumeRestoreWithoutScan(getDraftStorage()),
  );
  const [view, setView] = useState<View>("practice");
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS });
  const [bundle, setBundle] = useState<AttemptBundle | null>(null);
  const [activeQuestionId, setActiveQuestionId] = useState<QuestionId | null>(null);
  const [history, setHistory] = useState<AttemptBundle[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateState | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [windowModeBusy, setWindowModeBusy] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null);
  const initializedRef = useRef(false);
  const panelContextIdRef = useRef(createPendingRequestId());
  const installGenerationRef = useRef(0);
  const reloadSequenceRef = useRef(0);
  const runtimeAttemptRevisionRef = useRef(new Map<string, number>());
  const draftSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const draftSaveSequenceRef = useRef(0);
  const bundleRef = useRef(bundle);
  const activeQuestionRef = useRef(activeQuestionId);
  const pendingSubmissionRef = useRef(pendingSubmission);
  const settingsRef = useRef(settings);
  bundleRef.current = bundle;
  activeQuestionRef.current = activeQuestionId;
  pendingSubmissionRef.current = pendingSubmission;
  settingsRef.current = settings;

  const readPendingForAttempt = useCallback((attemptId: string): PendingSubmission | null => {
    const stored = readPendingSubmission(getDraftStorage(), attemptId);
    if (stored) return stored;
    const inMemory = pendingSubmissionRef.current;
    return inMemory?.attemptId === attemptId ? inMemory : null;
  }, []);

  const replacePendingSubmission = useCallback((
    attemptId: string,
    next: PendingSubmission | null,
    expectedRequestId?: string,
  ): boolean => {
    const storage = getDraftStorage();
    const stored = readPendingSubmission(storage, attemptId);
    // localStorage can be unavailable or quota-blocked in an extension context.
    // Preserve the current panel's in-memory reservation as the CAS authority in
    // that case; otherwise a failed write followed by a transition would
    // silently unlock an already-armed ChatGPT handoff.
    const inMemory = pendingSubmissionRef.current?.attemptId === attemptId
      ? pendingSubmissionRef.current
      : null;
    const current = stored ?? inMemory;
    if (expectedRequestId && current?.requestId !== expectedRequestId) {
      if (bundleRef.current?.attempt.attemptId === attemptId) {
        pendingSubmissionRef.current = current;
        setPendingSubmission(current);
      }
      return false;
    }
    writePendingSubmission(storage, attemptId, next);
    if (bundleRef.current?.attempt.attemptId === attemptId) {
      pendingSubmissionRef.current = next;
      setPendingSubmission(next);
    }
    return true;
  }, []);

  const showNotice = useCallback((tone: Notice["tone"], text: string): void => {
    setNotice({ id: Date.now(), tone, text });
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice((current) => current?.id === notice.id ? null : current), toneDelay(notice.tone));
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (displayContext.mode !== "floating" || typeof chrome === "undefined" || !chrome.storage?.local) {
      return undefined;
    }
    let timer: number | undefined;
    const persistSize = (): void => {
      const size = normalizeFloatingWindowSize({
        width: window.outerWidth,
        height: window.outerHeight,
      });
      void chrome.storage.local.set({ [FLOATING_WINDOW_SIZE_KEY]: size });
    };
    const handleResize = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(persistSize, 250);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      persistSize();
      window.removeEventListener("resize", handleResize);
    };
  }, [displayContext.mode]);

  useEffect(() => {
    const syncPendingSubmission = (event: StorageEvent): void => {
      const attemptId = bundleRef.current?.attempt.attemptId;
      if (!attemptId || event.key !== pendingSubmissionKey(attemptId)) return;
      const next = readPendingSubmission(getDraftStorage(), attemptId);
      pendingSubmissionRef.current = next;
      setPendingSubmission(next);
    };
    window.addEventListener("storage", syncPendingSubmission);
    return () => window.removeEventListener("storage", syncPendingSubmission);
  }, []);

  useEffect(() => {
    if (!bundle || !pendingSubmission || pendingSubmission.attemptId !== bundle.attempt.attemptId) return;
    const recorded = pendingSubmission.mode === "full-paper"
      ? bundle.attempt.status === "submitted"
      : bundle.questions.some(
          (question) =>
            question.questionId === pendingSubmission.questionId &&
            question.submittedAt !== null,
        );
    if (recorded) {
      replacePendingSubmission(
        pendingSubmission.attemptId,
        null,
        pendingSubmission.requestId,
      );
    }
  }, [bundle, pendingSubmission, replacePendingSubmission]);

  const persistTimerCheckpoint = useCallback(async (
    attemptId: string,
    snapshot: TimerCoordinatorSnapshot,
  ): Promise<void> => {
    const storage = getDraftStorage();
    cachePendingTimerCheckpoint(storage, attemptId, snapshot);
    try {
      await practiceService.saveTimerCheckpoint({
        attemptId,
        attemptTimer: snapshot.attemptTimer,
        questionTimers: snapshot.questionTimers,
      });
      clearPendingTimerCheckpointIfSaved(storage, attemptId, snapshot);
    } catch {
      if (bundleRef.current?.attempt.attemptId === attemptId) setSaveState("error");
    }
  }, []);

  const clock = useAttemptTimer(bundle, activeQuestionId, persistTimerCheckpoint);

  useEffect(() => {
    if (!bundle || !pendingSubmission || pendingSubmission.attemptId !== bundle.attempt.attemptId) return;
    if (pendingSubmission.mode === "full-paper") {
      clock.pauseAll(bundle.attempt.attemptId);
    } else if (activeQuestionId === pendingSubmission.questionId) {
      clock.finishCurrentQuestion(bundle.attempt.attemptId);
    }
  }, [
    activeQuestionId,
    bundle?.attempt.attemptId,
    clock.finishCurrentQuestion,
    clock.pauseAll,
    pendingSubmission,
  ]);

  const saveCurrentDraft = useCallback((announce = true): Promise<void> => {
    const current = bundleRef.current;
    const questionId = activeQuestionRef.current;
    const question = current?.questions.find((item) => item.questionId === questionId);
    if (!current || !question) return Promise.resolve();
    const sequence = ++draftSaveSequenceRef.current;
    if (announce) setSaveState("saving");
    const persist = async (): Promise<void> => {
      try {
        // Capture timer state only when this queued write actually executes.
        // An invocation-time snapshot could run after a later pause/switch and
        // resurrect stale runningSince values in the same Attempt.
        const snapshot = clock.checkpointNow(current.attempt.attemptId);
        const questionTimer = snapshot?.questionTimers[question.questionId];
        await Promise.all([
          practiceService.saveQuestionDraft({
            attemptId: current.attempt.attemptId,
            questionId: question.questionId,
            userAnswer: question.userAnswer,
            ...(questionTimer ? {
              elapsedSeconds: getElapsedSeconds(questionTimer),
              timer: questionTimer,
            } : {}),
          }),
          snapshot ? practiceService.saveTimerCheckpoint({
            attemptId: current.attempt.attemptId,
            attemptTimer: snapshot.attemptTimer,
            questionTimers: snapshot.questionTimers,
          }) : Promise.resolve(),
        ]);
        clearPendingDraftIfSaved(
          getDraftStorage(),
          current.attempt.attemptId,
          question.questionId,
          question.userAnswer,
        );
        if (bundleRef.current?.attempt.attemptId !== current.attempt.attemptId) return;
        setBundle((existing) => {
          if (!existing || existing.attempt.attemptId !== current.attempt.attemptId) return existing;
          const savedAt = Date.now();
          const questions = existing.questions.map((item): QuestionAttempt => item.questionId === question.questionId ? {
            ...item,
            status: item.status === "submitted" || item.status === "graded"
              ? item.status
              : item.userAnswer.trim()
                ? "answered"
                : "unanswered",
          } : item);
          const allAnswered = questions.length > 0 && questions.every((item) => item.userAnswer.trim());
          return {
            ...existing,
            attempt: existing.attempt.status === "submitted" ? existing.attempt : {
              ...existing.attempt,
              status: allAnswered ? "completed" : "answering",
              completedAt: allAnswered ? (existing.attempt.completedAt ?? savedAt) : null,
              updatedAt: savedAt,
            },
            questions,
          };
        });
        if (announce && sequence === draftSaveSequenceRef.current) setSaveState("saved");
      } catch (error) {
        if (
          bundleRef.current?.attempt.attemptId === current.attempt.attemptId &&
          sequence === draftSaveSequenceRef.current
        ) {
          setSaveState("error");
          if (announce) showNotice("error", `草稿保存失败：${friendlyError(error)}`);
        }
        throw error;
      }
    };
    const task = draftSaveQueueRef.current.catch(() => undefined).then(persist);
    draftSaveQueueRef.current = task.catch(() => undefined);
    return task;
  }, [clock, showNotice]);

  const installBundle = useCallback(async (
    nextBundle: AttemptBundle,
    preferredQuestionId?: QuestionId,
    requestedGeneration?: number,
  ): Promise<boolean> => {
    const generation = requestedGeneration ?? ++installGenerationRef.current;
    if (generation !== installGenerationRef.current) return false;
    ++reloadSequenceRef.current;
    const previous = bundleRef.current;
    let candidateBundle = nextBundle;
    if (previous) {
      // Flush the latest textarea value before React tears down its debounce.
      await saveCurrentDraft(false);
      if (
        generation !== installGenerationRef.current ||
        bundleRef.current?.attempt.attemptId !== previous.attempt.attemptId
      ) return false;
      if (previous.attempt.attemptId === nextBundle.attempt.attemptId) {
        const refreshed = await practiceService.loadAttemptBundle(nextBundle.attempt.attemptId);
        if (generation !== installGenerationRef.current) return false;
        if (refreshed) candidateBundle = refreshed;
      }
    }
    if (previous && previous.attempt.attemptId !== candidateBundle.attempt.attemptId) {
      const pausedSnapshot = clock.pauseAll(previous.attempt.attemptId);
      if (pausedSnapshot) {
        await practiceService.saveTimerCheckpoint({
          attemptId: previous.attempt.attemptId,
          attemptTimer: pausedSnapshot.attemptTimer,
          questionTimers: pausedSnapshot.questionTimers,
        });
      } else {
        await pausePersistedAttempt(previous);
      }
    } else if (!previous) {
      // The first render has no in-memory coordinator yet, but storage may
      // point at a different running Attempt. Pause that persisted stopwatch
      // before replacing the active Attempt so it cannot accrue in the background.
      const storedAttemptId = await readActiveAttemptId();
      if (storedAttemptId && storedAttemptId !== candidateBundle.attempt.attemptId) {
        const storedBundle = await practiceService.loadAttemptBundle(storedAttemptId);
        if (storedBundle) await pausePersistedAttempt(storedBundle);
      }
    }
    if (generation !== installGenerationRef.current) return false;
    let recoveredBundle = await persistPendingDraftMirrors(
      candidateBundle,
      () => generation === installGenerationRef.current,
    );
    if (!recoveredBundle || generation !== installGenerationRef.current) return false;
    recoveredBundle = await persistPendingTimerMirror(
      recoveredBundle,
      () => generation === installGenerationRef.current,
    );
    if (!recoveredBundle || generation !== installGenerationRef.current) return false;

    // Resolve the durable handoff before the final revision-stable load. There
    // must be no await between that final load and the refs/state commit, or a
    // runtime finalize could be overwritten by an older install snapshot.
    const locallyStoredPending = readPendingSubmission(
      getDraftStorage(),
      recoveredBundle.attempt.attemptId,
    );
    const durablePending = await practiceService.getActivePreparedSubmission(
      recoveredBundle.attempt.attemptId,
    );
    if (generation !== installGenerationRef.current) return false;

    // Runtime submission/conversation events can arrive while the outgoing
    // Attempt is being flushed. Load until no such event raced the read, then
    // commit that authoritative snapshot instead of the earlier history item.
    let authoritative: AttemptBundle | null = null;
    while (generation === installGenerationRef.current) {
      const revisionBefore = runtimeAttemptRevisionRef.current.get(
        recoveredBundle.attempt.attemptId,
      ) ?? 0;
      authoritative = await practiceService.loadAttemptBundle(recoveredBundle.attempt.attemptId);
      if (generation !== installGenerationRef.current) return false;
      const revisionAfter = runtimeAttemptRevisionRef.current.get(
        recoveredBundle.attempt.attemptId,
      ) ?? 0;
      if (revisionBefore === revisionAfter) break;
    }
    if (authoritative) {
      recoveredBundle = {
        ...authoritative,
        questions: mergeRecoverablePendingDraftAnswers(
          getDraftStorage(),
          authoritative,
        ),
      };
    }
    const selected = preferredQuestionId && recoveredBundle.questions.some((question) => question.questionId === preferredQuestionId)
      ? preferredQuestionId
      : selectInitialQuestion(recoveredBundle);
    ++reloadSequenceRef.current;
    bundleRef.current = recoveredBundle;
    activeQuestionRef.current = selected;
    const installedPending = durablePending
      ? pendingSubmissionFromOutbox(
          durablePending,
          locallyStoredPending,
          panelContextIdRef.current,
        )
      : null;
    writePendingSubmission(
      getDraftStorage(),
      recoveredBundle.attempt.attemptId,
      installedPending,
    );
    pendingSubmissionRef.current = installedPending;
    setBundle(recoveredBundle);
    setActiveQuestionId(selected);
    setPendingSubmission(installedPending);
    setSaveState("idle");
    setView("practice");
    await rememberActiveAttempt(recoveredBundle.attempt.attemptId);
    // A slower install must not leave storage pointing at an Attempt that has
    // already been superseded by a later restore/create operation.
    if (generation !== installGenerationRef.current) {
      const latestAttemptId = bundleRef.current?.attempt.attemptId;
      if (latestAttemptId) await rememberActiveAttempt(latestAttemptId);
      return false;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }, [clock, saveCurrentDraft]);

  const reloadCurrentBundle = useCallback(async (): Promise<void> => {
    const sequence = ++reloadSequenceRef.current;
    const current = bundleRef.current;
    if (!current) return;
    let refreshed: AttemptBundle | null = null;
    while (sequence === reloadSequenceRef.current) {
      const revisionBefore = runtimeAttemptRevisionRef.current.get(current.attempt.attemptId) ?? 0;
      refreshed = await practiceService.loadAttemptBundle(current.attempt.attemptId);
      if (sequence !== reloadSequenceRef.current) return;
      const revisionAfter = runtimeAttemptRevisionRef.current.get(current.attempt.attemptId) ?? 0;
      if (revisionBefore === revisionAfter) break;
    }
    const live = bundleRef.current;
    if (
      sequence !== reloadSequenceRef.current ||
      live?.attempt.attemptId !== current.attempt.attemptId
    ) return;
    if (refreshed) {
      // Runtime events (for example a manually-created Conversation URL) may
      // arrive inside the 700ms draft debounce window. Repository state is the
      // authority for statuses/bindings, while the current textarea value is
      // the authority for unsaved answer text in this live panel.
      const liveAnswers = mergeUnsavedAnswerText(refreshed.questions, live.questions);
      const answerBase: AttemptBundle = {
        ...refreshed,
        questions: refreshed.questions.map((question, index) =>
          refreshed.attempt.status !== "submitted" && question.submittedAt === null
            ? liveAnswers[index]!
            : question,
        ),
      };
      const merged: AttemptBundle = {
        ...refreshed,
        questions: mergeRecoverablePendingDraftAnswers(getDraftStorage(), answerBase),
      };
      const preferred = activeQuestionRef.current;
      const selected = preferred && merged.questions.some((question) => question.questionId === preferred)
        ? preferred
        : selectInitialQuestion(merged);
      bundleRef.current = merged;
      activeQuestionRef.current = selected;
      setBundle(merged);
      setActiveQuestionId(selected);
    }
  }, []);

  const currentAnswer = bundle?.questions.find((question) => question.questionId === activeQuestionId)?.userAnswer ?? "";
  useDebouncedEffect(() => {
    if (settings.autoSave && bundle && activeQuestionId) void saveCurrentDraft(true).catch(() => undefined);
  }, [bundle?.attempt.attemptId, activeQuestionId, currentAnswer, settings.autoSave], 700);

  // A debounce timer can still be pending when the Side Panel is hidden or
  // destroyed. Flush the current in-memory answer in addition to the timer
  // checkpoint so the final keystrokes are not silently discarded.
  const flushDraftRef = useRef<() => void>(() => undefined);
  flushDraftRef.current = () => {
    if (settings.autoSave) void saveCurrentDraft(false).catch(() => undefined);
  };
  useEffect(() => {
    const flushDraft = (): void => flushDraftRef.current();
    const handleVisibility = (): void => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", flushDraft);
    window.addEventListener("beforeunload", flushDraft);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", flushDraft);
      window.removeEventListener("beforeunload", flushDraft);
      flushDraft();
    };
  }, []);

  const loadHistory = useCallback(async (): Promise<void> => {
    setHistoryLoading(true);
    try {
      const summaries = await practiceService.listHistory(50);
      const bundles = await Promise.all(summaries.map((item) => practiceService.loadAttemptBundle(item.attempt.attemptId)));
      setHistory(bundles.filter((item): item is AttemptBundle => item !== null));
    } catch (error) {
      showNotice("error", `历史记录读取失败：${friendlyError(error)}`);
    } finally {
      setHistoryLoading(false);
    }
  }, [showNotice]);

  const createAttempt = useCallback(async (
    paper: PaperDefinition,
    preferredQuestionId: QuestionId | null,
    requestedGeneration?: number,
  ): Promise<void> => {
    const generation = requestedGeneration ?? ++installGenerationRef.current;
    if (generation !== installGenerationRef.current) return;
    setBusyAction("scan");
    let createdAttempt: AttemptBundle | null = null;
    try {
      const next = await practiceService.createAttempt({
        paperId: paper.paperId,
        startImmediately: true,
        ...(preferredQuestionId ? { activeQuestionId: preferredQuestionId } : {}),
      });
      createdAttempt = next;
      if (generation !== installGenerationRef.current) {
        if (bundleRef.current?.attempt.attemptId !== next.attempt.attemptId) {
          await pausePersistedAttempt(next).catch(() => undefined);
        }
        return;
      }
      setDuplicate(null);
      const installed = await installBundle(next, preferredQuestionId ?? undefined, generation);
      if (installed) {
        showNotice("success", "试卷已就绪，草稿和计时会保存在本机。 ");
      } else if (bundleRef.current?.attempt.attemptId !== next.attempt.attemptId) {
        await pausePersistedAttempt(next).catch(() => undefined);
      }
    } catch (error) {
      if (
        createdAttempt &&
        bundleRef.current?.attempt.attemptId !== createdAttempt.attempt.attemptId
      ) {
        await pausePersistedAttempt(createdAttempt).catch(() => undefined);
      }
      if (generation === installGenerationRef.current) showNotice("error", friendlyError(error));
    } finally {
      if (generation === installGenerationRef.current) setBusyAction(null);
    }
  }, [installBundle, showNotice]);

  const scanCurrentPaper = useCallback(async (): Promise<void> => {
    if (busyAction) return;
    const generation = ++installGenerationRef.current;
    setBusyAction("scan");
    try {
      const extracted = await sendRuntimeRequest<ExtractedPaperPayload>(
        examExtractionRequest(displayContext),
      );
      const ingested = await practiceService.ingestPaper(extracted);
      if (generation !== installGenerationRef.current) return;
      if (ingested.duplicate) {
        const attempts = await practiceService.listAttemptsByPaper(ingested.paper.paperId);
        if (generation !== installGenerationRef.current) return;
        if (attempts.length) {
          const fallback = bundleRef.current;
          if (fallback) {
            await saveCurrentDraft(false);
            if (generation !== installGenerationRef.current) return;
            const pausedSnapshot = clock.pauseAll(fallback.attempt.attemptId);
            if (pausedSnapshot) {
              await practiceService.saveTimerCheckpoint({
                attemptId: fallback.attempt.attemptId,
                attemptTimer: pausedSnapshot.attemptTimer,
                questionTimers: pausedSnapshot.questionTimers,
              });
            } else {
              await pausePersistedAttempt(fallback);
            }
            if (generation !== installGenerationRef.current) return;
          }
          setDuplicate({ paper: ingested.paper, attempts, activeQuestionId: extracted.activeQuestionId ?? null, fallbackAttemptId: fallback?.attempt.attemptId ?? null });
          return;
        }
      }
      await createAttempt(ingested.paper, extracted.activeQuestionId ?? null, generation);
    } catch (error) {
      if (generation === installGenerationRef.current) showNotice("error", friendlyError(error));
    } finally {
      if (generation === installGenerationRef.current) setBusyAction(null);
    }
  }, [busyAction, clock, createAttempt, displayContext, saveCurrentDraft, showNotice]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void (async () => {
      const generation = ++installGenerationRef.current;
      setBusyAction("scan");
      try {
        const [storedSettings, attemptId] = await Promise.all([practiceService.getSettings(), readActiveAttemptId()]);
        if (generation !== installGenerationRef.current) return;
        setSettings(storedSettings);
        const restored = attemptId ? await practiceService.loadAttemptBundle(attemptId) : null;
        if (generation !== installGenerationRef.current) return;
        if (restoreOnlyOnInit) {
          if (restored) await installBundle(restored, undefined, generation);
          return;
        }
        try {
          const extracted = await sendRuntimeRequest<ExtractedPaperPayload>(
            examExtractionRequest(displayContext),
          );
          const ingested = await practiceService.ingestPaper(extracted);
          if (generation !== installGenerationRef.current) return;
          if (ingested.duplicate) {
            const attempts = await practiceService.listAttemptsByPaper(ingested.paper.paperId);
            if (generation !== installGenerationRef.current) return;
            if (attempts.length) {
              if (restored) await pausePersistedAttempt(restored);
              if (generation !== installGenerationRef.current) return;
              setDuplicate({
                paper: ingested.paper,
                attempts,
                activeQuestionId: extracted.activeQuestionId ?? null,
                fallbackAttemptId: restored?.attempt.attemptId ?? null,
              });
              return;
            }
          }
          await createAttempt(ingested.paper, extracted.activeQuestionId ?? null, generation);
        } catch (extractionError) {
          if (generation !== installGenerationRef.current) return;
          if (!restored) throw extractionError;
          const installed = await installBundle(restored, undefined, generation);
          if (installed) showNotice("success", "当前页未识别到新试卷，已恢复上次练习。 ");
        }
      } catch (error) {
        if (generation === installGenerationRef.current) showNotice("error", friendlyError(error));
      } finally {
        if (generation === installGenerationRef.current) setBusyAction(null);
      }
    })();
  }, [createAttempt, displayContext, installBundle, restoreOnlyOnInit, showNotice]);

  useEffect(() => { if (view === "history") void loadHistory(); }, [view, loadHistory]);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return undefined;
    const handleMessage = (message: unknown): boolean => {
      if (isConversationDetectedEvent(message)) {
        runtimeAttemptRevisionRef.current.set(
          message.payload.attemptId,
          (runtimeAttemptRevisionRef.current.get(message.payload.attemptId) ?? 0) + 1,
        );
        if (message.payload.attemptId !== bundleRef.current?.attempt.attemptId) return false;
        // The URL has already been persisted even when automatic renaming fails.
        // Reload first so the recovery/rebind UI immediately reflects that safe binding.
        void reloadCurrentBundle();
        if (message.payload.renamed) {
          showNotice("success", "已绑定并命名本次试卷的 ChatGPT 对话。 ");
        } else {
          showNotice("error", message.payload.renameError || "对话已安全绑定，但自动命名失败；可在 ChatGPT 中手动修改标题。 ");
        }
        return false;
      }
      if (isManualSubmissionRecordedEvent(message)) {
        runtimeAttemptRevisionRef.current.set(
          message.payload.attemptId,
          (runtimeAttemptRevisionRef.current.get(message.payload.attemptId) ?? 0) + 1,
        );
        const pending = readPendingForAttempt(message.payload.attemptId);
        const matchesPending = pending !== null &&
          pending.requestId === message.payload.requestId && (
          (pending.mode === "full-paper" && message.payload.mode === "full-paper") ||
          (
            pending.mode === "single-question" &&
            message.payload.mode === "single-question" &&
            pending.questionId === message.payload.questionId
          )
        );
        if (matchesPending) {
          replacePendingSubmission(
            message.payload.attemptId,
            null,
            pending.requestId,
          );
        }
        if (message.payload.attemptId !== bundleRef.current?.attempt.attemptId) return false;
        void reloadCurrentBundle();
        showNotice(
          "success",
          message.payload.mode === "single-question"
            ? "已确认本题在 ChatGPT 中手动发送。"
            : "已确认整卷在 ChatGPT 中手动发送。",
        );
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [readPendingForAttempt, reloadCurrentBundle, replacePendingSubmission, showNotice]);

  const handleQuestionSelect = (questionId: QuestionId): void => {
    if (questionId === activeQuestionId) return;
    // A navigation-triggered hidden save supersedes any visible "saving"
    // operation for the previous question. Reset the indicator so it cannot
    // remain stuck after the earlier save's sequence is invalidated.
    setSaveState("idle");
    void saveCurrentDraft(false).catch(() => undefined);
    setActiveQuestionId(questionId);
  };

  const handleAnswerChange = (answer: string): void => {
    const current = bundleRef.current;
    const questionId = activeQuestionRef.current;
    const pending = pendingSubmissionRef.current;
    if (
      current &&
      pending?.attemptId === current.attempt.attemptId &&
      (pending.mode === "full-paper" || pending.questionId === questionId)
    ) return;
    if (current && questionId) {
      cachePendingDraft(getDraftStorage(), current.attempt.attemptId, questionId, answer);
    }
    ++draftSaveSequenceRef.current;
    setSaveState("idle");
    setBundle((current) => current ? {
      ...current,
      questions: current.questions.map((question) => question.questionId === activeQuestionRef.current ? { ...question, userAnswer: answer } : question),
    } : current);
  };

  const submitWithProvider = useCallback(async (mode: "single" | "full"): Promise<void> => {
    const current = bundleRef.current;
    const questionId = activeQuestionRef.current;
    if (!current || (mode === "single" && !questionId)) return;
    const requestId = createPendingRequestId();
    const handoff: PendingSubmission = mode === "single"
      ? {
          attemptId: current.attempt.attemptId,
          mode: "single-question",
          questionId: questionId!,
          state: "preparing",
          requestId,
          ownerContextId: panelContextIdRef.current,
          createdAt: Date.now(),
        }
      : {
          attemptId: current.attempt.attemptId,
          mode: "full-paper",
          state: "preparing",
          requestId,
          ownerContextId: panelContextIdRef.current,
          createdAt: Date.now(),
        };
    setBusyAction(mode);
    let runtimeDispatchStarted = false;
    try {
      const reserved = await withPendingSubmissionLock(
        current.attempt.attemptId,
        async () => {
          const storedPending = readPendingForAttempt(current.attempt.attemptId);
          if (storedPending) {
            replacePendingSubmission(current.attempt.attemptId, storedPending);
            return false;
          }
          const durablePending = await practiceService.getActivePreparedSubmission(
            current.attempt.attemptId,
          );
          if (durablePending) {
            replacePendingSubmission(
              current.attempt.attemptId,
              pendingSubmissionFromOutbox(
                durablePending,
                null,
                panelContextIdRef.current,
              ),
            );
            return false;
          }
          // The read and reservation are one cross-Side-Panel critical section.
          replacePendingSubmission(current.attempt.attemptId, handoff);
          return true;
        },
      );
      if (!reserved) {
        showNotice("info", "已有一份 Prompt 等待确认，请先在 ChatGPT 中发送或取消后再提交。");
        return;
      }
      // Capture an immutable click-time timer snapshot. Terminal snapshots are
      // required to be paused so a finalized record can never keep accruing.
      const repeatedQuestionSubmission = mode === "single" && current.questions.some(
        (question) => question.questionId === questionId && question.submittedAt !== null,
      );
      const submissionTimer = repeatedQuestionSubmission
        ? clock.checkpointNow(current.attempt.attemptId)
        : mode === "single"
          ? clock.finishCurrentQuestion(current.attempt.attemptId)
          : clock.pauseAll(current.attempt.attemptId);
      if (!submissionTimer) throw new Error("当前练习计时器尚未就绪，请稍后重试。");
      await practiceService.saveTimerCheckpoint({
        attemptId: current.attempt.attemptId,
        attemptTimer: submissionTimer.attemptTimer,
        questionTimers: submissionTimer.questionTimers,
      });
      // Stop the exam clock at the user's submit click, before ChatGPT page
      // loading/automation time. A failed hand-off remains safely paused and
      // the user can explicitly resume from the answer card.
      await saveCurrentDraft(false);
      if (mode === "full") {
        const stored = await practiceService.loadAttemptBundle(current.attempt.attemptId);
        if (
          !stored ||
          bundleRef.current?.attempt.attemptId !== current.attempt.attemptId
        ) throw new Error("提交准备期间已切换练习，本次交接已取消。");
        const recovered = await persistPendingDraftMirrors(
          stored,
          () => bundleRef.current?.attempt.attemptId === current.attempt.attemptId,
        );
        if (!recovered) throw new Error("整卷草稿恢复未完成，本次交接已取消。");
      }

      const toQuestionSnapshot = (question: QuestionAttempt): QuestionSnapshot => {
        const timer = submissionTimer.questionTimers[question.questionId];
        if (!timer) throw new Error("提交快照缺少题目计时，请重新打开本次练习。");
        return {
          questionId: question.questionId,
          userAnswer: question.userAnswer,
          elapsedSeconds: getElapsedSeconds(timer),
          timer,
        };
      };
      if (mode === "single" && questionId) {
        const question = current.questions.find((item) => item.questionId === questionId);
        if (!question) throw new Error("当前题目不属于本次练习。");
        await practiceService.prepareSubmission(
          current.attempt.attemptId,
          { mode: "single-question", questionId },
          requestId,
          { mode: "single-question", question: toQuestionSnapshot(question) },
        );
      } else {
        await practiceService.prepareSubmission(
          current.attempt.attemptId,
          { mode: "full-paper" },
          requestId,
          {
            mode: "full-paper",
            questions: current.questions.map(toQuestionSnapshot),
            attemptTimer: submissionTimer.attemptTimer,
            totalElapsedSeconds: getElapsedSeconds(submissionTimer.attemptTimer),
          },
        );
      }

      let delivery: FeedbackDeliveryResult;
      const target: GradingTarget = {
        engine: settingsRef.current.gradingEngine,
        model: settingsRef.current.gradingModel,
      };
      runtimeDispatchStarted = true;
      if (mode === "single" && questionId) {
        delivery = await sendRuntimeRequest<FeedbackDeliveryResult>({
          type: "FEEDBACK/SUBMIT_SINGLE",
          payload: { attemptId: current.attempt.attemptId, questionId, requestId, target },
        });
      } else {
        delivery = await sendRuntimeRequest<FeedbackDeliveryResult>({
          type: "FEEDBACK/SUBMIT_FULL",
          payload: { attemptId: current.attempt.attemptId, requestId, target },
        });
      }
      if (delivery.submitted) {
        replacePendingSubmission(current.attempt.attemptId, null, requestId);
      }
      const stillCurrent = bundleRef.current?.attempt.attemptId === current.attempt.attemptId;
      if (stillCurrent) await reloadCurrentBundle();
      if (!delivery.submitted) {
        const updated = bundleRef.current;
        const alreadyRecorded = stillCurrent && updated?.attempt.attemptId === current.attempt.attemptId && (
          mode === "full"
            ? updated.attempt.status === "submitted"
            : updated.questions.some(
                (question) =>
                  question.questionId === questionId &&
                  question.submittedAt !== null,
              )
        );
        if (!alreadyRecorded) {
          replacePendingSubmission(
            current.attempt.attemptId,
            { ...handoff, state: "manual" },
            requestId,
          );
          if (stillCurrent) {
            showNotice(
              "info",
              mode === "single"
                ? "本题 Prompt 已填入 ChatGPT；发送确认前答案已锁定。"
                : "整卷 Prompt 已填入 ChatGPT；发送确认前答案与计时已锁定。",
            );
          }
        } else {
          replacePendingSubmission(current.attempt.attemptId, null, requestId);
        }
      } else if (stillCurrent && delivery.engine === "chatgpt-web" && delivery.renamed === false) {
        showNotice(
          "error",
          `${delivery.renameError} 对话已按本次练习安全绑定，请在 ChatGPT 中手动重命名。`,
        );
      } else if (stillCurrent) {
        const engineName = delivery.engine === "chatgpt-web" ? "ChatGPT" : "DeepSeek";
        showNotice("success", mode === "single"
          ? `本题已由 ${engineName} 批改，结果已自动返回。`
          : `整套试卷已由 ${engineName} 批改，结果已自动返回。`);
      }
    } catch (error) {
      const stillCurrent = bundleRef.current?.attempt.attemptId === current.attempt.attemptId;
      let keepLocked = false;
      try {
        const durable = await practiceService.getActivePreparedSubmission(
          current.attempt.attemptId,
        );
        if (durable && durable.requestId !== requestId) {
          replacePendingSubmission(
            current.attempt.attemptId,
            pendingSubmissionFromOutbox(
              durable,
              readPendingForAttempt(current.attempt.attemptId),
              panelContextIdRef.current,
            ),
          );
          keepLocked = true;
        } else if (durable) {
          const cancellation = await practiceService.cancelPreparedSubmission(
            current.attempt.attemptId,
            requestId,
          );
          keepLocked = cancellation === "already-started";
        } else if (runtimeDispatchStarted) {
          const authoritative = await practiceService.loadAttemptBundle(
            current.attempt.attemptId,
          );
          const terminal = authoritative && (
            mode === "full"
              ? authoritative.attempt.status === "submitted"
              : authoritative.questions.some(
                  (question) =>
                    question.questionId === questionId && question.submittedAt !== null,
                )
          );
          if (terminal) {
            replacePendingSubmission(current.attempt.attemptId, null, requestId);
            if (stillCurrent) await reloadCurrentBundle();
          }
        }
      } catch {
        // If the durable outbox cannot be inspected, uncertainty wins over a
        // potentially destructive unlock/retry.
        keepLocked = runtimeDispatchStarted;
      }
      if (keepLocked) {
        const currentPending = readPendingForAttempt(current.attempt.attemptId);
        if (currentPending?.requestId === requestId) {
          replacePendingSubmission(
            current.attempt.attemptId,
            { ...handoff, state: "uncertain" },
            requestId,
          );
        } else if (currentPending) {
          replacePendingSubmission(current.attempt.attemptId, currentPending);
        }
      } else {
        replacePendingSubmission(
          current.attempt.attemptId,
          null,
          requestId,
        );
      }
      if (stillCurrent) {
        showNotice(
          "error",
          keepLocked
            ? "发送结果未确认。请先在 ChatGPT 对话中核对，勿重复提交；不可变提交快照与计时已保持锁定。"
            : friendlyError(error),
        );
      }
    } finally {
      setBusyAction(null);
    }
  }, [clock, readPendingForAttempt, reloadCurrentBundle, replacePendingSubmission, saveCurrentDraft, showNotice]);

  const recoverPreparingSubmission = useCallback(async (): Promise<void> => {
    const pending = pendingSubmissionRef.current;
    const current = bundleRef.current;
    if (
      !pending ||
      !current ||
      pending.attemptId !== current.attempt.attemptId ||
      pending.state !== "preparing" ||
      Date.now() - pending.createdAt < PREPARING_RECOVERY_DELAY_MS
    ) return;
    setBusyAction("resolve");
    try {
      await withPendingSubmissionLock(pending.attemptId, async () => {
        const stored = readPendingForAttempt(pending.attemptId);
        if (
          stored?.requestId !== pending.requestId ||
          stored.state !== "preparing"
        ) {
          pendingSubmissionRef.current = stored;
          setPendingSubmission(stored);
          showNotice("info", "交接状态已经更新，请按最新提示处理。");
          return;
        }
        const cancellation = await sendRuntimeRequest<CancelPendingResult>({
          type: "FEEDBACK/CANCEL_PENDING",
          payload: {
            attemptId: stored.attemptId,
            requestId: stored.requestId,
            confirmedUnsent: false,
          },
        });
        if (cancellation.reason === "delivery-in-progress") {
          replacePendingSubmission(
            stored.attemptId,
            { ...stored, createdAt: Date.now() },
            stored.requestId,
          );
          showNotice("info", "后台仍在交接 Prompt，请稍后再检查。");
          return;
        }
        if (cancellation.reason === "send-started" || cancellation.tooLate) {
          replacePendingSubmission(
            stored.attemptId,
            {
              ...stored,
              state: "uncertain",
              ownerContextId: panelContextIdRef.current,
            },
            stored.requestId,
          );
          showNotice("error", "检测到发送动作可能已经开始，请核对 ChatGPT 后确认结果；若确定未发送，可刷新该 ChatGPT 页面后再选择“未发送”。");
          return;
        }
        if (!cancellation.cancelled) {
          // A missing content-side watcher does not prove that an auto-submit
          // was never delivered: the page or worker may have reloaded after
          // the click. Recovery therefore requires an explicit human verdict.
          replacePendingSubmission(
            stored.attemptId,
            {
              ...stored,
              state: "uncertain",
              ownerContextId: panelContextIdRef.current,
            },
            stored.requestId,
          );
          showNotice(
            "error",
            "未检测到仍在运行的页面交接，但无法据此确认未发送。请核对 ChatGPT 后选择“已发送”或“未发送”。",
          );
          return;
        }
        replacePendingSubmission(stored.attemptId, null, stored.requestId);
        showNotice(
          "info",
          "已安全取消遗留交接。计时保持暂停，请清除 ChatGPT 输入框中的旧 Prompt。",
        );
      });
    } catch (error) {
      showNotice("error", friendlyError(error));
    } finally {
      setBusyAction(null);
    }
  }, [readPendingForAttempt, replacePendingSubmission, showNotice]);

  const takeOverPendingSubmission = useCallback(async (): Promise<void> => {
    const pending = pendingSubmissionRef.current;
    const current = bundleRef.current;
    if (
      !pending ||
      !current ||
      pending.attemptId !== current.attempt.attemptId ||
      pending.state === "preparing"
    ) return;
    setBusyAction("resolve");
    try {
      await withPendingSubmissionLock(pending.attemptId, async () => {
        const stored = readPendingForAttempt(pending.attemptId);
        if (
          stored?.requestId !== pending.requestId ||
          stored.state === "preparing"
        ) {
          pendingSubmissionRef.current = stored;
          setPendingSubmission(stored);
          showNotice("error", "待发送状态已在另一窗口更新，请按最新状态处理。");
          return;
        }
        replacePendingSubmission(
          pending.attemptId,
          { ...stored, ownerContextId: panelContextIdRef.current },
          stored.requestId,
        );
        showNotice("info", "已在当前 Side Panel 接管待发送状态。");
      });
    } catch (error) {
      showNotice("error", friendlyError(error));
    } finally {
      setBusyAction(null);
    }
  }, [readPendingForAttempt, replacePendingSubmission, showNotice]);

  const resolvePendingSubmission = useCallback(async (sent: boolean): Promise<void> => {
    const pending = pendingSubmissionRef.current;
    const current = bundleRef.current;
    if (!pending || !current || pending.attemptId !== current.attempt.attemptId) return;
    setBusyAction("resolve");
    try {
      await withPendingSubmissionLock(pending.attemptId, async () => {
        const stored = readPendingForAttempt(pending.attemptId);
        if (
          stored?.requestId !== pending.requestId ||
          stored.state === "preparing" ||
          stored.ownerContextId !== panelContextIdRef.current
        ) {
          pendingSubmissionRef.current = stored;
          setPendingSubmission(stored);
          showNotice(
            "error",
            stored?.state === "preparing"
              ? "Prompt 仍在交接中，请等待当前操作完成。"
              : "待发送状态已在另一窗口更新，请先接管最新状态。",
          );
          return;
        }
        if (sent) {
          await sendRuntimeRequest({
            type: "FEEDBACK/CONFIRM_MANUAL",
            payload: {
              attemptId: stored.attemptId,
              requestId: stored.requestId,
              handoff: stored.mode === "single-question"
                ? { mode: stored.mode, questionId: stored.questionId! }
                : { mode: stored.mode },
            },
          });
          runtimeAttemptRevisionRef.current.set(
            stored.attemptId,
            (runtimeAttemptRevisionRef.current.get(stored.attemptId) ?? 0) + 1,
          );
          replacePendingSubmission(stored.attemptId, null, stored.requestId);
          await reloadCurrentBundle();
          showNotice("success", stored.mode === "single-question" ? "已确认本题发送。" : "已确认整卷发送。");
          return;
        }

        const cancellation = await sendRuntimeRequest<CancelPendingResult>({
          type: "FEEDBACK/CANCEL_PENDING",
          payload: {
            attemptId: stored.attemptId,
            requestId: stored.requestId,
            confirmedUnsent: true,
          },
        });
        if (cancellation.reason === "delivery-in-progress") {
          showNotice("info", "后台仍在交接 Prompt，请稍后再处理发送状态。");
          return;
        }
        if (cancellation.reason === "send-started" || cancellation.tooLate) {
          replacePendingSubmission(
            stored.attemptId,
            { ...stored, state: "uncertain" },
            stored.requestId,
          );
          showNotice("error", "发送动作已经开始，无法直接取消。请核对 ChatGPT；若确定未发送，可刷新该页面后再次选择“未发送”。");
          return;
        }
        const cleared = replacePendingSubmission(
          stored.attemptId,
          null,
          stored.requestId,
        );
        if (!cleared) {
          showNotice("error", "待发送状态已在另一窗口更新，请按最新状态处理。");
          return;
        }
        showNotice(
          "info",
          stored.state === "manual"
            ? "已取消待发送状态。计时保持暂停；请清除 ChatGPT 输入框中的旧 Prompt，再手动继续。"
            : "已按“未发送”处理。计时保持暂停，可核对页面后手动继续。",
        );
      });
    } catch (error) {
      showNotice("error", friendlyError(error));
    } finally {
      setBusyAction(null);
    }
  }, [readPendingForAttempt, reloadCurrentBundle, replacePendingSubmission, showNotice]);

  const saveFeedback = async (rawText: string, scope: "question" | "paper"): Promise<void> => {
    const current = bundleRef.current;
    const questionId = activeQuestionRef.current;
    if (!current || !questionId) return;
    const question = current.questions.find((candidate) => candidate.questionId === questionId);
    if (
      scope === "question" &&
      current.attempt.status !== "submitted" &&
      question?.submittedAt === null
    ) {
      const error = new Error("请先提交本题或整卷，再保存本题批改结果。");
      showNotice("error", error.message);
      throw error;
    }
    setBusyAction("feedback");
    try {
      const score = parseFeedbackScore(rawText);
      await practiceService.savePastedFeedback({
        attemptId: current.attempt.attemptId,
        questionId: scope === "question" ? questionId : null,
        rawText,
        ...score,
      });
      if (bundleRef.current?.attempt.attemptId !== current.attempt.attemptId) return;
      await reloadCurrentBundle();
      showNotice("success", scope === "question" ? "本题批改结果已保存。" : "整卷批改结果已保存。 ");
    } catch (error) {
      showNotice("error", friendlyError(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  };

  const rebindConversation = async (conversationUrl: string): Promise<void> => {
    const current = bundleRef.current;
    if (!current) return;
    const pending = pendingSubmissionRef.current;
    if (
      pending?.attemptId === current.attempt.attemptId &&
      pending.state !== "uncertain"
    ) {
      showNotice("error", "当前 Prompt 仍在交接中，暂不能更换对话绑定。");
      return;
    }
    setBusyAction("feedback");
    try {
      await sendRuntimeRequest({
        type: "CONVERSATION/REBIND",
        payload: { attemptId: current.attempt.attemptId, conversationUrl },
      });
      if (bundleRef.current?.attempt.attemptId !== current.attempt.attemptId) return;
      await reloadCurrentBundle();
      showNotice(
        "success",
        pending?.state === "uncertain"
          ? "对话已重新绑定。请核对该对话后，再确认本次提交是否已发送。"
          : "本次练习已重新绑定到指定 ChatGPT 对话。 ",
      );
    } catch (error) {
      showNotice("error", friendlyError(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  };

  const saveProjectUrl = async (projectUrl: string): Promise<void> => {
    const normalized = ChatGPTAdapter.projectUrl(projectUrl);
    if (!normalized) {
      const error = new Error(
        "请输入有效的 ChatGPT Project 链接，例如 https://chatgpt.com/g/g-p-.../project。",
      );
      showNotice("error", error.message);
      throw error;
    }
    const pending = pendingSubmissionRef.current;
    if (pending && pending.state !== "uncertain") {
      const error = new Error("当前 Prompt 仍在交接中，暂不能更换批改 Project。");
      showNotice("error", error.message);
      throw error;
    }
    setBusyAction("feedback");
    try {
      const stored = await practiceService.saveSettings({ projectUrl: normalized });
      setSettings(stored);
      showNotice("success", "批改 Project 已保存，首次提交会在该 Project 中创建并绑定对话。");
    } catch (error) {
      showNotice("error", friendlyError(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  };

  const saveSettings = async (next: AppSettings): Promise<void> => {
    setSettingsSaving(true);
    try {
      const stored = await practiceService.saveSettings(next);
      setSettings(stored);
      showNotice("success", "设置已保存。 ");
    } catch (error) {
      showNotice("error", friendlyError(error));
      throw error;
    } finally {
      setSettingsSaving(false);
    }
  };

  const changeGradingTarget = (target: GradingTarget): void => {
    setSettings((current) => ({
      ...current,
      gradingEngine: target.engine,
      gradingModel: target.model,
    }));
    void practiceService.saveSettings({
      gradingEngine: target.engine,
      gradingModel: target.model,
    }).then(setSettings).catch((error) => {
      showNotice("error", friendlyError(error));
    });
  };

  const restoreHistory = async (attemptId: string): Promise<void> => {
    const generation = ++installGenerationRef.current;
    setBusyAction("scan");
    try {
      const restored = await practiceService.loadAttemptBundle(attemptId);
      if (generation !== installGenerationRef.current) return;
      if (!restored) throw new Error("练习记录不存在或已损坏。");
      const installed = await installBundle(restored, undefined, generation);
      if (installed) showNotice("success", "练习内容、计时与批改结果已恢复。 ");
    } catch (error) {
      if (generation === installGenerationRef.current) showNotice("error", friendlyError(error));
    } finally {
      if (generation === installGenerationRef.current) setBusyAction(null);
    }
  };

  const continueDuplicateAttempt = async (attemptId: string): Promise<void> => {
    const generation = ++installGenerationRef.current;
    setBusyAction("scan");
    try {
      const restored = await practiceService.loadAttemptBundle(attemptId);
      if (generation !== installGenerationRef.current) return;
      if (!restored) throw new Error("上次练习记录不存在或已损坏。");
      setDuplicate(null);
      const installed = await installBundle(restored, undefined, generation);
      if (installed) showNotice("success", "已继续上次练习。 ");
    } catch (error) {
      if (generation === installGenerationRef.current) showNotice("error", friendlyError(error));
    } finally {
      if (generation === installGenerationRef.current) setBusyAction(null);
    }
  };

  const cancelDuplicate = async (): Promise<void> => {
    const fallbackAttemptId = duplicate?.fallbackAttemptId ?? null;
    const generation = ++installGenerationRef.current;
    setDuplicate(null);
    if (!fallbackAttemptId || bundleRef.current?.attempt.attemptId === fallbackAttemptId) return;
    setBusyAction("scan");
    try {
      const fallback = await practiceService.loadAttemptBundle(fallbackAttemptId);
      if (generation !== installGenerationRef.current) return;
      if (fallback) {
        const installed = await installBundle(fallback, undefined, generation);
        if (!installed) return;
        showNotice("info", "已返回先前的练习；计时保持暂停，可手动继续。 ");
      }
    } catch (error) {
      if (generation === installGenerationRef.current) showNotice("error", friendlyError(error));
    } finally {
      if (generation === installGenerationRef.current) setBusyAction(null);
    }
  };

  const confirmClear = (): void => {
    handleAnswerChange("");
    setClearDialogOpen(false);
    window.setTimeout(() => void saveCurrentDraft(true).catch(() => undefined), 0);
  };

  const openChatGPT = (): void => {
    const url = settings.projectUrl || "https://chatgpt.com/";
    if (typeof chrome !== "undefined" && chrome.tabs?.create) void chrome.tabs.create({ url });
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  const openConversation = (conversationUrl: string): void => {
    if (typeof chrome !== "undefined" && chrome.tabs?.create) void chrome.tabs.create({ url: conversationUrl });
    else window.open(conversationUrl, "_blank", "noopener,noreferrer");
  };

  const switchWindowMode = async (): Promise<void> => {
    if (windowModeBusy || busyAction !== null) return;
    if (typeof chrome === "undefined" || !chrome.windows || !chrome.sidePanel) {
      showNotice("error", "当前浏览器不支持侧栏与悬浮窗切换。");
      return;
    }
    setWindowModeBusy(true);
    flushDraftRef.current();
    try {
      if (displayContext.mode === "floating") {
        if (displayContext.sourceWindowId === null) {
          throw new Error("未找到悬浮窗对应的浏览器窗口，请关闭悬浮窗后从扩展图标重新打开。");
        }
        requestRestoreWithoutScan(getDraftStorage());
        await chrome.sidePanel.open({ windowId: displayContext.sourceWindowId });
        await chrome.windows.update(displayContext.sourceWindowId, { focused: true })
          .catch(() => undefined);
        await chrome.storage.session.remove(FLOATING_WINDOW_SESSION_KEY).catch(() => undefined);
        const currentWindow = await chrome.windows.getCurrent();
        if (typeof currentWindow.id === "number") {
          await chrome.windows.remove(currentWindow.id);
        }
        return;
      }

      const sourceWindow = await chrome.windows.getCurrent();
      if (typeof sourceWindow.id !== "number") {
        throw new Error("无法识别当前浏览器窗口。");
      }
      const stored = await chrome.storage.local.get(FLOATING_WINDOW_SIZE_KEY);
      const size = normalizeFloatingWindowSize(stored[FLOATING_WINDOW_SIZE_KEY]);
      const sessionValue = await chrome.storage.session.get(FLOATING_WINDOW_SESSION_KEY);
      const session = parseFloatingWindowSession(sessionValue[FLOATING_WINDOW_SESSION_KEY]);
      if (session?.sourceWindowId === sourceWindow.id) {
        const existing = await chrome.windows.get(session.windowId).catch(() => null);
        if (existing?.type === "popup") {
          await chrome.windows.update(session.windowId, { focused: true });
          await (chrome.sidePanel as unknown as SidePanelCloseApi).close({
            windowId: sourceWindow.id,
          });
          return;
        }
      }

      const created = await chrome.windows.create({
        url: floatingPageUrl(chrome.runtime.getURL("index.html"), sourceWindow.id),
        type: "popup",
        focused: true,
        width: size.width,
        height: size.height,
      });
      if (typeof created?.id !== "number") throw new Error("悬浮窗创建失败。");
      await chrome.storage.session.set({
        [FLOATING_WINDOW_SESSION_KEY]: {
          windowId: created.id,
          sourceWindowId: sourceWindow.id,
        } satisfies FloatingWindowSession,
      });
      await (chrome.sidePanel as unknown as SidePanelCloseApi).close({
        windowId: sourceWindow.id,
      });
    } catch (error) {
      showNotice("error", `切换显示模式失败：${friendlyError(error)}`);
    } finally {
      setWindowModeBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand"><span className="brand__mark"><Icon name="book" /></span><span className="brand__copy"><strong>申论智能训练助手</strong><span>LOCAL PRACTICE · PRIVATE CONTEXT</span></span></div>
        <div className="header-actions">
          <button className={`header-action header-action--mode${displayContext.mode === "pinned" ? " is-active" : ""}`} type="button" aria-label={displayContext.mode === "pinned" ? "取消置顶并切换为悬浮窗" : "置顶到浏览器侧栏"} aria-pressed={displayContext.mode === "pinned"} title={displayContext.mode === "pinned" ? "取消置顶并切换为悬浮窗" : "置顶到浏览器侧栏"} disabled={windowModeBusy || busyAction !== null} onClick={() => void switchWindowMode()}><Icon name="pin" /><span>{displayContext.mode === "pinned" ? "已置顶" : "置顶"}</span></button>
          <button className="header-action" type="button" aria-label="重新扫描当前试卷" title="重新扫描当前试卷" disabled={busyAction !== null || windowModeBusy} onClick={() => void scanCurrentPaper()}><Icon name="scan" /></button>
        </div>
      </header>

      {notice ? <div className="status-stack"><StatusBanner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</StatusBanner></div> : null}

      {view === "practice" ? <PracticePage bundle={bundle} activeQuestionId={activeQuestionId} settings={settings} clock={clock} saveState={saveState} busyAction={busyAction} pendingSubmission={pendingSubmission} pendingOwnedByThisPanel={pendingSubmission?.ownerContextId === panelContextIdRef.current} preparingRecoveryAvailable={pendingSubmission?.state === "preparing" && Date.now() - pendingSubmission.createdAt >= PREPARING_RECOVERY_DELAY_MS} onScan={() => void scanCurrentPaper()} onSelectQuestion={handleQuestionSelect} onAnswerChange={handleAnswerChange} onPauseToggle={clock.togglePaused} onSave={() => void saveCurrentDraft(true).catch(() => undefined)} onClear={() => setClearDialogOpen(true)} onSubmitQuestion={() => void submitWithProvider("single")} onSubmitFull={() => void submitWithProvider("full")} onResolvePendingSubmission={(sent) => void resolvePendingSubmission(sent)} onTakeOverPendingSubmission={() => void takeOverPendingSubmission()} onRecoverPreparingSubmission={() => void recoverPreparingSubmission()} onSaveFeedback={saveFeedback} onSaveProjectUrl={saveProjectUrl} onRebindConversation={rebindConversation} onOpenConversation={openConversation} onGradingTargetChange={changeGradingTarget} /> : null}
      {view === "history" ? <HistoryPage items={history} loading={historyLoading || busyAction === "scan"} onRefresh={() => void loadHistory()} onRestore={(attemptId) => void restoreHistory(attemptId)} /> : null}
      {view === "settings" ? <SettingsPage settings={settings} saving={settingsSaving} onSave={saveSettings} onOpenChatGPT={openChatGPT} onOpenUrl={openConversation} /> : null}

      <nav className="bottom-nav" aria-label="主导航">
        <button className={view === "practice" ? "is-active" : ""} type="button" disabled={busyAction !== null} onClick={() => setView("practice")}><Icon name="book" />答题</button>
        <button className={view === "history" ? "is-active" : ""} type="button" disabled={busyAction !== null} onClick={() => setView("history")}><Icon name="history" />历史</button>
        <button className={view === "settings" ? "is-active" : ""} type="button" disabled={busyAction !== null} onClick={() => setView("settings")}><Icon name="settings" />设置</button>
      </nav>

      <DuplicateDialog paper={duplicate?.paper ?? null} attempts={duplicate?.attempts ?? []} busy={busyAction === "scan"} onContinue={(attemptId) => void continueDuplicateAttempt(attemptId)} onCreate={() => { if (duplicate) void createAttempt(duplicate.paper, duplicate.activeQuestionId); }} onCancel={() => void cancelDuplicate()} />
      <ConfirmDialog open={clearDialogOpen} title="清空本题答案？" description="清空后会立即覆盖本题已保存的草稿，此操作无法撤销。" confirmLabel="确认清空" destructive onConfirm={confirmClear} onCancel={() => setClearDialogOpen(false)} />
    </div>
  );
}

function toneDelay(tone: Notice["tone"]): number {
  return tone === "error" ? 8_000 : 4_500;
}
