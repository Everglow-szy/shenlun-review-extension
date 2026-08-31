import type { AttemptId } from "../types";

/** A synchronous per-attempt lease; different attempts remain fully concurrent. */
export class AttemptFeedbackGate {
  private readonly activeAttempts = new Set<AttemptId>();

  public tryAcquire(attemptId: AttemptId): (() => void) | null {
    if (this.activeAttempts.has(attemptId)) return null;
    this.activeAttempts.add(attemptId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeAttempts.delete(attemptId);
    };
  }

  public isActive(attemptId: AttemptId): boolean {
    return this.activeAttempts.has(attemptId);
  }
}
