import type { FeedbackProvider, FeedbackSubmission } from "../types";

export type FeedbackSubmissionHandler = (submission: FeedbackSubmission) => Promise<void>;

export function assertFeedbackSubmissionIsolation(submission: FeedbackSubmission): void {
  if (submission.binding !== null && submission.binding.attemptId !== submission.attemptId) {
    throw new Error("Feedback submission and conversation binding have different attemptIds");
  }
  if (submission.mode === "single-question" && !submission.questionId) {
    throw new Error("A single-question submission requires questionId");
  }
}
/** Small adapter used by the worker to plug browser automation into core logic. */
export class DelegatingFeedbackProvider implements FeedbackProvider {
  public constructor(private readonly handler: FeedbackSubmissionHandler) {}

  public async submit(submission: FeedbackSubmission): Promise<void> {
    assertFeedbackSubmissionIsolation(submission);
    await this.handler(submission);
  }
}
