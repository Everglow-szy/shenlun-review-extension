import {
  PERSISTED_ENTITY_VERSION,
  type PersistedTimerState,
  type QuestionId,
} from "../types";

export const DEFAULT_TIMER_CHECKPOINT_INTERVAL_MS = 7_500;

function normalizeNow(now: number): number {
  if (!Number.isFinite(now) || now < 0) {
    throw new RangeError("now must be a non-negative finite timestamp");
  }
  return Math.floor(now);
}

function normalizeAccumulatedMilliseconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("accumulatedMilliseconds must be non-negative and finite");
  }
  return Math.floor(value);
}

export function createTimerState(
  now: number = Date.now(),
  running = false,
): PersistedTimerState {
  const timestamp = normalizeNow(now);
  return {
    schemaVersion: PERSISTED_ENTITY_VERSION,
    accumulatedMilliseconds: 0,
    runningSince: running ? timestamp : null,
    checkpointedAt: timestamp,
  };
}

export function getElapsedMilliseconds(
  state: PersistedTimerState,
  now: number = Date.now(),
): number {
  const timestamp = normalizeNow(now);
  const accumulated = normalizeAccumulatedMilliseconds(state.accumulatedMilliseconds);
  if (state.runningSince === null) {
    return accumulated;
  }
  return accumulated + Math.max(0, timestamp - state.runningSince);
}

export function getElapsedSeconds(
  state: PersistedTimerState,
  now: number = Date.now(),
): number {
  return Math.floor(getElapsedMilliseconds(state, now) / 1_000);
}

export function isTimerRunning(state: PersistedTimerState): boolean {
  return state.runningSince !== null;
}

export function startTimer(
  state: PersistedTimerState,
  now: number = Date.now(),
): PersistedTimerState {
  if (state.runningSince !== null) {
    return state;
  }
  const timestamp = normalizeNow(now);
  return { ...state, runningSince: timestamp, checkpointedAt: timestamp };
}

export function checkpointTimer(
  state: PersistedTimerState,
  now: number = Date.now(),
): PersistedTimerState {
  const timestamp = normalizeNow(now);
  if (state.runningSince === null) {
    return { ...state, checkpointedAt: timestamp };
  }
  return {
    ...state,
    accumulatedMilliseconds: getElapsedMilliseconds(state, timestamp),
    runningSince: timestamp,
    checkpointedAt: timestamp,
  };
}

export function pauseTimer(
  state: PersistedTimerState,
  now: number = Date.now(),
): PersistedTimerState {
  const checkpointed = checkpointTimer(state, now);
  return checkpointed.runningSince === null
    ? checkpointed
    : { ...checkpointed, runningSince: null };
}

export function setTimerElapsedSeconds(
  state: PersistedTimerState,
  elapsedSeconds: number,
  now: number = Date.now(),
): PersistedTimerState {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    throw new RangeError("elapsedSeconds must be non-negative and finite");
  }
  const timestamp = normalizeNow(now);
  return {
    ...state,
    accumulatedMilliseconds: Math.floor(elapsedSeconds * 1_000),
    runningSince: state.runningSince === null ? null : timestamp,
    checkpointedAt: timestamp,
  };
}

export function shouldCheckpointTimer(
  state: PersistedTimerState,
  now: number = Date.now(),
  intervalMs = DEFAULT_TIMER_CHECKPOINT_INTERVAL_MS,
): boolean {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive finite number");
  }
  return normalizeNow(now) - state.checkpointedAt >= intervalMs;
}

export class PersistentTimer {
  private state: PersistedTimerState;

  public constructor(initialState: PersistedTimerState = createTimerState()) {
    this.state = { ...initialState };
  }

  public start(now: number = Date.now()): void {
    this.state = startTimer(this.state, now);
  }

  public pause(now: number = Date.now()): void {
    this.state = pauseTimer(this.state, now);
  }

  public checkpoint(now: number = Date.now()): PersistedTimerState {
    this.state = checkpointTimer(this.state, now);
    return this.snapshot();
  }

  public elapsedSeconds(now: number = Date.now()): number {
    return getElapsedSeconds(this.state, now);
  }

  public isRunning(): boolean {
    return isTimerRunning(this.state);
  }

  public needsCheckpoint(
    now: number = Date.now(),
    intervalMs = DEFAULT_TIMER_CHECKPOINT_INTERVAL_MS,
  ): boolean {
    return shouldCheckpointTimer(this.state, now, intervalMs);
  }

  public snapshot(): PersistedTimerState {
    return { ...this.state };
  }
}

export interface TimerCoordinatorSnapshot {
  readonly attemptTimer: PersistedTimerState;
  readonly questionTimers: Readonly<Record<QuestionId, PersistedTimerState>>;
  readonly activeQuestionId: QuestionId | null;
  readonly manuallyPaused: boolean;
}

export function createTimerCoordinatorSnapshot(
  questionIds: readonly QuestionId[],
  activeQuestionId: QuestionId | null,
  now: number = Date.now(),
  startImmediately = true,
): TimerCoordinatorSnapshot {
  if (activeQuestionId !== null && !questionIds.includes(activeQuestionId)) {
    throw new Error("activeQuestionId does not belong to this attempt");
  }
  const timestamp = normalizeNow(now);
  const questionTimers: Record<QuestionId, PersistedTimerState> = {};
  for (const questionId of questionIds) {
    questionTimers[questionId] = createTimerState(
      timestamp,
      startImmediately && questionId === activeQuestionId,
    );
  }
  return {
    attemptTimer: createTimerState(timestamp, startImmediately),
    questionTimers,
    activeQuestionId,
    manuallyPaused: !startImmediately,
  };
}

/** Coordinates the always-running paper timer with one active question timer. */
export class AttemptTimerCoordinator {
  private attemptTimer: PersistedTimerState;
  private readonly questionTimers: Map<QuestionId, PersistedTimerState>;
  private activeQuestionId: QuestionId | null;
  private manuallyPaused: boolean;

  public constructor(snapshot: TimerCoordinatorSnapshot) {
    this.attemptTimer = { ...snapshot.attemptTimer };
    this.questionTimers = new Map(
      Object.entries(snapshot.questionTimers).map(([questionId, timer]) => [
        questionId,
        { ...timer },
      ]),
    );
    this.activeQuestionId = snapshot.activeQuestionId;
    this.manuallyPaused = snapshot.manuallyPaused;
  }

  public switchQuestion(
    questionId: QuestionId,
    now: number = Date.now(),
    startQuestion = true,
  ): void {
    if (!this.questionTimers.has(questionId)) {
      throw new Error("questionId does not belong to this attempt");
    }
    const timestamp = normalizeNow(now);
    if (this.activeQuestionId !== null) {
      const previous = this.requireQuestionTimer(this.activeQuestionId);
      this.questionTimers.set(this.activeQuestionId, pauseTimer(previous, timestamp));
    }
    this.activeQuestionId = questionId;
    if (!this.manuallyPaused && startQuestion) {
      this.questionTimers.set(questionId, startTimer(this.requireQuestionTimer(questionId), timestamp));
    }
  }

  /** Freeze only the active question; the whole-paper timer keeps running. */
  public pauseActiveQuestion(now: number = Date.now()): void {
    if (this.activeQuestionId === null) return;
    const timestamp = normalizeNow(now);
    const current = this.requireQuestionTimer(this.activeQuestionId);
    this.questionTimers.set(this.activeQuestionId, pauseTimer(current, timestamp));
  }

  /** Resume a frozen active question without changing the whole-paper timer. */
  public resumeActiveQuestion(now: number = Date.now()): void {
    if (this.activeQuestionId === null || this.manuallyPaused) return;
    const timestamp = normalizeNow(now);
    const current = this.requireQuestionTimer(this.activeQuestionId);
    this.questionTimers.set(this.activeQuestionId, startTimer(current, timestamp));
  }

  public pause(now: number = Date.now()): void {
    const timestamp = normalizeNow(now);
    this.attemptTimer = pauseTimer(this.attemptTimer, timestamp);
    if (this.activeQuestionId !== null) {
      const current = this.requireQuestionTimer(this.activeQuestionId);
      this.questionTimers.set(this.activeQuestionId, pauseTimer(current, timestamp));
    }
    this.manuallyPaused = true;
  }

  public resume(now: number = Date.now()): void {
    const timestamp = normalizeNow(now);
    this.attemptTimer = startTimer(this.attemptTimer, timestamp);
    if (this.activeQuestionId !== null) {
      const current = this.requireQuestionTimer(this.activeQuestionId);
      this.questionTimers.set(this.activeQuestionId, startTimer(current, timestamp));
    }
    this.manuallyPaused = false;
  }

  public checkpoint(now: number = Date.now()): TimerCoordinatorSnapshot {
    const timestamp = normalizeNow(now);
    this.attemptTimer = checkpointTimer(this.attemptTimer, timestamp);
    if (this.activeQuestionId !== null) {
      const current = this.requireQuestionTimer(this.activeQuestionId);
      this.questionTimers.set(this.activeQuestionId, checkpointTimer(current, timestamp));
    }
    return this.snapshot();
  }

  public getAttemptElapsedSeconds(now: number = Date.now()): number {
    return getElapsedSeconds(this.attemptTimer, now);
  }

  public getQuestionElapsedSeconds(questionId: QuestionId, now: number = Date.now()): number {
    return getElapsedSeconds(this.requireQuestionTimer(questionId), now);
  }

  public snapshot(): TimerCoordinatorSnapshot {
    return {
      attemptTimer: { ...this.attemptTimer },
      questionTimers: Object.fromEntries(
        Array.from(this.questionTimers, ([questionId, timer]) => [questionId, { ...timer }]),
      ),
      activeQuestionId: this.activeQuestionId,
      manuallyPaused: this.manuallyPaused,
    };
  }

  private requireQuestionTimer(questionId: QuestionId): PersistedTimerState {
    const timer = this.questionTimers.get(questionId);
    if (!timer) {
      throw new Error("questionId does not belong to this attempt");
    }
    return timer;
  }
}
