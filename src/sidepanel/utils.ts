import type { TimerCoordinatorSnapshot } from "../services/timerService";
import {
  PERSISTED_ENTITY_VERSION,
  type AttemptId,
  type PersistedTimerState,
  type QuestionId,
} from "../types";

export function formatElapsed(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function formatShortElapsed(totalSeconds: number): string {
  const formatted = formatElapsed(totalSeconds);
  return formatted.startsWith("00:") ? formatted.slice(3) : formatted;
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(timestamp))
    .replaceAll("/", "-");
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "操作没有完成，请稍后重试。";
}

export function questionDisplayTitle(index: number, title: string): string {
  const normalized = title.trim();
  return normalized || `第 ${index + 1} 题`;
}

/** Keep the live textarea authoritative while refreshing repository metadata. */
export function mergeUnsavedAnswerText<
  T extends { readonly questionId: string; readonly userAnswer: string },
>(
  refreshed: readonly T[],
  live: readonly { readonly questionId: string; readonly userAnswer: string }[],
): T[] {
  const liveAnswers = new Map(live.map((question) => [question.questionId, question.userAnswer]));
  return refreshed.map((question) => {
    const answer = liveAnswers.get(question.questionId);
    return answer === undefined ? question : { ...question, userAnswer: answer };
  });
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PENDING_DRAFT_PREFIX = "shenlun.pendingDraft.v1:";

function pendingDraftKey(attemptId: string, questionId: string): string {
  return `${PENDING_DRAFT_PREFIX}${encodeURIComponent(attemptId)}:${encodeURIComponent(questionId)}`;
}

interface PendingDraftRecord {
  readonly attemptId: string;
  readonly questionId: string;
  readonly userAnswer: string;
}

function parsePendingDraft(
  storage: DraftStorage | null,
  attemptId: string,
  questionId: string,
): PendingDraftRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(pendingDraftKey(attemptId, questionId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<PendingDraftRecord>;
    return candidate.attemptId === attemptId &&
      candidate.questionId === questionId &&
      typeof candidate.userAnswer === "string"
      ? { attemptId, questionId, userAnswer: candidate.userAnswer }
      : null;
  } catch {
    return null;
  }
}

/**
 * Synchronous write-ahead mirror for the debounce window. IndexedDB remains
 * authoritative after a successful save; this tiny record only survives an
 * abrupt Side Panel teardown between the final input event and that save.
 */
export function cachePendingDraft(
  storage: DraftStorage | null,
  attemptId: string,
  questionId: string,
  userAnswer: string,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      pendingDraftKey(attemptId, questionId),
      JSON.stringify({ attemptId, questionId, userAnswer } satisfies PendingDraftRecord),
    );
  } catch {
    // IndexedDB autosave and explicit save remain available if storage is full.
  }
}

/** Remove only the exact answer that reached IndexedDB; never erase newer input. */
export function clearPendingDraftIfSaved(
  storage: DraftStorage | null,
  attemptId: string,
  questionId: string,
  savedAnswer: string,
): void {
  if (!storage) return;
  const pending = parsePendingDraft(storage, attemptId, questionId);
  if (!pending || pending.userAnswer !== savedAnswer) return;
  try {
    storage.removeItem(pendingDraftKey(attemptId, questionId));
  } catch {
    // A harmless stale mirror is preferable to deleting a newer draft.
  }
}

/** Recover abrupt-close drafts before an Attempt is installed into the UI. */
export function mergePendingDraftAnswers<
  T extends { readonly questionId: string; readonly userAnswer: string },
>(storage: DraftStorage | null, attemptId: string, questions: readonly T[]): T[] {
  return questions.map((question) => {
    const pending = parsePendingDraft(storage, attemptId, question.questionId);
    return pending ? { ...question, userAnswer: pending.userAnswer } : question;
  });
}

const PENDING_TIMER_PREFIX = "shenlun.pendingTimer.v1:";

function pendingTimerKey(attemptId: AttemptId): string {
  return `${PENDING_TIMER_PREFIX}${encodeURIComponent(attemptId)}`;
}

interface PendingTimerRecord {
  readonly attemptId: AttemptId;
  readonly snapshot: TimerCoordinatorSnapshot;
}

/** A validated timer WAL entry ready to be replayed into IndexedDB. */
export type PendingTimerCheckpoint = TimerCoordinatorSnapshot & {
  readonly attemptId: AttemptId;
};

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseTimerState(value: unknown): PersistedTimerState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<PersistedTimerState>;
  if (
    candidate.schemaVersion !== PERSISTED_ENTITY_VERSION ||
    !isNonNegativeFiniteNumber(candidate.accumulatedMilliseconds) ||
    !isNonNegativeFiniteNumber(candidate.checkpointedAt) ||
    !(
      candidate.runningSince === null ||
      isNonNegativeFiniteNumber(candidate.runningSince)
    )
  ) {
    return null;
  }
  return {
    schemaVersion: PERSISTED_ENTITY_VERSION,
    accumulatedMilliseconds: candidate.accumulatedMilliseconds,
    runningSince: candidate.runningSince,
    checkpointedAt: candidate.checkpointedAt,
  };
}

function parseTimerSnapshot(value: unknown): TimerCoordinatorSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<TimerCoordinatorSnapshot>;
  const attemptTimer = parseTimerState(candidate.attemptTimer);
  if (
    !attemptTimer ||
    typeof candidate.questionTimers !== "object" ||
    candidate.questionTimers === null ||
    Array.isArray(candidate.questionTimers) ||
    !(candidate.activeQuestionId === null || typeof candidate.activeQuestionId === "string") ||
    typeof candidate.manuallyPaused !== "boolean"
  ) {
    return null;
  }

  const questionTimerEntries: Array<[QuestionId, PersistedTimerState]> = [];
  for (const [questionId, timerValue] of Object.entries(candidate.questionTimers)) {
    if (!questionId) return null;
    const timer = parseTimerState(timerValue);
    if (!timer) return null;
    questionTimerEntries.push([questionId, timer]);
  }
  const questionTimers = Object.fromEntries(questionTimerEntries);
  if (
    candidate.activeQuestionId !== null &&
    !Object.prototype.hasOwnProperty.call(questionTimers, candidate.activeQuestionId)
  ) {
    return null;
  }
  return {
    attemptTimer,
    questionTimers,
    activeQuestionId: candidate.activeQuestionId,
    manuallyPaused: candidate.manuallyPaused,
  };
}

function parsePendingTimerCheckpoint(
  storage: DraftStorage | null,
  attemptId: AttemptId,
): PendingTimerCheckpoint | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(pendingTimerKey(attemptId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const candidate = value as Partial<PendingTimerRecord>;
    if (candidate.attemptId !== attemptId) return null;
    const snapshot = parseTimerSnapshot(candidate.snapshot);
    return snapshot ? { attemptId, ...snapshot } : null;
  } catch {
    return null;
  }
}

/**
 * Synchronously mirrors every coordinator checkpoint before its asynchronous
 * IndexedDB write. Entries are isolated by Attempt and replace only that
 * Attempt's previous checkpoint.
 */
export function cachePendingTimerCheckpoint(
  storage: DraftStorage | null,
  attemptId: AttemptId,
  snapshot: TimerCoordinatorSnapshot,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      pendingTimerKey(attemptId),
      JSON.stringify({ attemptId, snapshot } satisfies PendingTimerRecord),
    );
  } catch {
    // Periodic IndexedDB checkpoints remain available if local storage is full.
  }
}

/** Read and validate an Attempt-scoped timer checkpoint without mutating it. */
export function readPendingTimerCheckpoint(
  storage: DraftStorage | null,
  attemptId: AttemptId,
): PendingTimerCheckpoint | null {
  return parsePendingTimerCheckpoint(storage, attemptId);
}

function timerStatesEqual(left: PersistedTimerState, right: PersistedTimerState): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.accumulatedMilliseconds === right.accumulatedMilliseconds &&
    left.runningSince === right.runningSince &&
    left.checkpointedAt === right.checkpointedAt;
}

function timerSnapshotsEqual(
  left: TimerCoordinatorSnapshot,
  right: TimerCoordinatorSnapshot,
): boolean {
  if (
    left.activeQuestionId !== right.activeQuestionId ||
    left.manuallyPaused !== right.manuallyPaused ||
    !timerStatesEqual(left.attemptTimer, right.attemptTimer)
  ) {
    return false;
  }
  const leftQuestionIds = Object.keys(left.questionTimers).sort();
  const rightQuestionIds = Object.keys(right.questionTimers).sort();
  if (
    leftQuestionIds.length !== rightQuestionIds.length ||
    leftQuestionIds.some((questionId, index) => questionId !== rightQuestionIds[index])
  ) {
    return false;
  }
  return leftQuestionIds.every((questionId) => {
    const leftTimer = left.questionTimers[questionId];
    const rightTimer = right.questionTimers[questionId];
    return leftTimer !== undefined && rightTimer !== undefined && timerStatesEqual(leftTimer, rightTimer);
  });
}

/** Remove only the exact checkpoint saved to IndexedDB; preserve a newer one. */
export function clearPendingTimerCheckpointIfSaved(
  storage: DraftStorage | null,
  attemptId: AttemptId,
  savedSnapshot: TimerCoordinatorSnapshot,
): void {
  if (!storage) return;
  const pending = parsePendingTimerCheckpoint(storage, attemptId);
  if (!pending || !timerSnapshotsEqual(pending, savedSnapshot)) return;
  try {
    storage.removeItem(pendingTimerKey(attemptId));
  } catch {
    // A harmless stale mirror is preferable to deleting a newer checkpoint.
  }
}
