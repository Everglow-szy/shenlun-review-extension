import { useCallback, useEffect, useRef, useState } from "react";
import {
  AttemptTimerCoordinator,
  getElapsedSeconds,
  isTimerRunning,
  pauseTimer,
  type TimerCoordinatorSnapshot,
} from "../../services";
import type { AttemptBundle, AttemptId, QuestionId } from "../../types";
import { useInterval } from "./useInterval";

export interface AttemptClock {
  readonly totalElapsedSeconds: number;
  readonly questionElapsedSeconds: Readonly<Record<QuestionId, number>>;
  readonly paused: boolean;
  readonly currentQuestionRunning: boolean;
  readonly togglePaused: () => void;
  readonly pauseAll: (expectedAttemptId?: AttemptId) => AttemptTimerCheckpoint | null;
  readonly finishCurrentQuestion: (expectedAttemptId?: AttemptId) => AttemptTimerCheckpoint | null;
  readonly resumeCurrentQuestion: (expectedAttemptId?: AttemptId) => AttemptTimerCheckpoint | null;
  readonly checkpointNow: (expectedAttemptId?: AttemptId) => AttemptTimerCheckpoint | null;
}

export type AttemptTimerCheckpoint = TimerCoordinatorSnapshot & {
  readonly attemptId: AttemptId;
};

function buildCoordinator(bundle: AttemptBundle, activeQuestionId: QuestionId): AttemptTimerCoordinator {
  const now = Date.now();
  const attemptSubmitted = bundle.attempt.status === "submitted";
  return new AttemptTimerCoordinator({
    attemptTimer: attemptSubmitted ? pauseTimer(bundle.attempt.timer, now) : bundle.attempt.timer,
    questionTimers: Object.fromEntries(bundle.questions.map((question) => [
      question.questionId,
      attemptSubmitted || ["submitted", "graded"].includes(question.status)
        ? pauseTimer(question.timer, now)
        : question.timer,
    ])),
    activeQuestionId,
    manuallyPaused: attemptSubmitted || !isTimerRunning(bundle.attempt.timer),
  });
}

function displaySnapshot(coordinator: AttemptTimerCoordinator): Pick<AttemptClock, "totalElapsedSeconds" | "questionElapsedSeconds" | "paused" | "currentQuestionRunning"> {
  const now = Date.now();
  const snapshot = coordinator.snapshot();
  return {
    totalElapsedSeconds: coordinator.getAttemptElapsedSeconds(now),
    questionElapsedSeconds: Object.fromEntries(
      Object.entries(snapshot.questionTimers).map(([questionId, timer]) => [questionId, getElapsedSeconds(timer, now)]),
    ),
    paused: snapshot.manuallyPaused,
    currentQuestionRunning:
      snapshot.activeQuestionId !== null &&
      isTimerRunning(snapshot.questionTimers[snapshot.activeQuestionId]!),
  };
}

const EMPTY_CLOCK = {
  totalElapsedSeconds: 0,
  questionElapsedSeconds: {} as Readonly<Record<QuestionId, number>>,
  paused: true,
  currentQuestionRunning: false,
};

export function useAttemptTimer(
  bundle: AttemptBundle | null,
  activeQuestionId: QuestionId | null,
  onCheckpoint: (attemptId: AttemptId, snapshot: TimerCoordinatorSnapshot) => void | Promise<void>,
): AttemptClock {
  const coordinatorRef = useRef<AttemptTimerCoordinator | null>(null);
  const attemptIdRef = useRef<string | null>(null);
  const shouldRunActiveQuestionRef = useRef(true);
  const checkpointHandlerRef = useRef(onCheckpoint);
  checkpointHandlerRef.current = onCheckpoint;
  shouldRunActiveQuestionRef.current = !bundle?.questions.some(
    (question) =>
      question.questionId === activeQuestionId && ["submitted", "graded"].includes(question.status),
  );
  const [clock, setClock] = useState(EMPTY_CLOCK);

  useEffect(() => {
    if (!bundle || !activeQuestionId) {
      coordinatorRef.current = null;
      attemptIdRef.current = null;
      setClock(EMPTY_CLOCK);
      return;
    }
    if (attemptIdRef.current !== bundle.attempt.attemptId) {
      const coordinator = buildCoordinator(bundle, activeQuestionId);
      coordinatorRef.current = coordinator;
      attemptIdRef.current = bundle.attempt.attemptId;
      setClock(displaySnapshot(coordinator));
    }
  }, [bundle, activeQuestionId]);

  const checkpointNow = useCallback((expectedAttemptId?: AttemptId): AttemptTimerCheckpoint | null => {
    const coordinator = coordinatorRef.current;
    const attemptId = attemptIdRef.current;
    if (!coordinator || !attemptId || (expectedAttemptId && expectedAttemptId !== attemptId)) {
      return null;
    }
    const snapshot = coordinator.checkpoint();
    setClock(displaySnapshot(coordinator));
    void checkpointHandlerRef.current(attemptId, snapshot);
    return { ...snapshot, attemptId };
  }, []);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || !activeQuestionId) return;
    if (bundle?.attempt.status === "submitted") {
      const persistedStillRunning = isTimerRunning(bundle.attempt.timer) ||
        bundle.questions.some((question) => isTimerRunning(question.timer));
      const coordinatorSnapshot = coordinator.snapshot();
      const coordinatorStillRunning = !coordinatorSnapshot.manuallyPaused ||
        isTimerRunning(coordinatorSnapshot.attemptTimer) ||
        Object.values(coordinatorSnapshot.questionTimers).some((timer) => isTimerRunning(timer));
      coordinator.pause();
      if (persistedStillRunning || coordinatorStillRunning) {
        checkpointNow(bundle.attempt.attemptId);
      } else {
        setClock(displaySnapshot(coordinator));
      }
      return;
    }
    const activeQuestion = bundle?.questions.find((question) => question.questionId === activeQuestionId);
    const shouldRunQuestion = !activeQuestion || !["submitted", "graded"].includes(activeQuestion.status);
    if (coordinator.snapshot().activeQuestionId !== activeQuestionId) {
      coordinator.switchQuestion(activeQuestionId, Date.now(), shouldRunQuestion);
      checkpointNow();
    } else if (!shouldRunQuestion) {
      const timer = coordinator.snapshot().questionTimers[activeQuestionId];
      if (timer && isTimerRunning(timer)) {
        coordinator.pauseActiveQuestion();
        checkpointNow();
      }
    }
  }, [activeQuestionId, bundle, checkpointNow]);

  useInterval(() => {
    const coordinator = coordinatorRef.current;
    if (coordinator) setClock(displaySnapshot(coordinator));
  }, bundle ? 1_000 : null);

  useInterval(
    () => { checkpointNow(); },
    bundle && bundle.attempt.status !== "submitted" ? 10_000 : null,
  );

  useEffect(() => {
    const handleVisibility = (): void => {
      if (document.visibilityState === "hidden") checkpointNow();
    };
    const handleBeforeUnload = (): void => { checkpointNow(); };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      checkpointNow();
    };
  }, [checkpointNow]);

  const togglePaused = useCallback((): void => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    const snapshot = coordinator.snapshot();
    if (snapshot.manuallyPaused) {
      coordinator.resume();
      if (!shouldRunActiveQuestionRef.current) coordinator.pauseActiveQuestion();
    } else if (
      shouldRunActiveQuestionRef.current &&
      snapshot.activeQuestionId !== null &&
      !isTimerRunning(snapshot.questionTimers[snapshot.activeQuestionId]!)
    ) {
      // A prepared-but-not-yet-sent question is frozen independently from the
      // paper timer. One click should resume that question, not pause the paper.
      coordinator.resumeActiveQuestion();
    } else {
      coordinator.pause();
    }
    checkpointNow();
  }, [checkpointNow]);

  const pauseAll = useCallback((expectedAttemptId?: AttemptId): AttemptTimerCheckpoint | null => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || (expectedAttemptId && expectedAttemptId !== attemptIdRef.current)) return null;
    // Always normalize both paper and active-question timers. This also heals
    // a legacy/inconsistent snapshot where the paper is paused but a question
    // still has a runningSince value.
    coordinator.pause();
    return checkpointNow(expectedAttemptId);
  }, [checkpointNow]);

  const finishCurrentQuestion = useCallback((expectedAttemptId?: AttemptId): AttemptTimerCheckpoint | null => {
    const coordinator = coordinatorRef.current;
    if (
      !coordinator ||
      !shouldRunActiveQuestionRef.current ||
      (expectedAttemptId && expectedAttemptId !== attemptIdRef.current)
    ) return null;
    coordinator.pauseActiveQuestion();
    return checkpointNow(expectedAttemptId);
  }, [checkpointNow]);

  const resumeCurrentQuestion = useCallback((expectedAttemptId?: AttemptId): AttemptTimerCheckpoint | null => {
    const coordinator = coordinatorRef.current;
    if (
      !coordinator ||
      !shouldRunActiveQuestionRef.current ||
      (expectedAttemptId && expectedAttemptId !== attemptIdRef.current)
    ) return null;
    coordinator.resumeActiveQuestion();
    return checkpointNow(expectedAttemptId);
  }, [checkpointNow]);

  return {
    ...clock,
    togglePaused,
    pauseAll,
    finishCurrentQuestion,
    resumeCurrentQuestion,
    checkpointNow,
  };
}
