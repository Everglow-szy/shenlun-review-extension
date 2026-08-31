const ID_SEPARATOR = "\u001f";

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (normalized.includes(ID_SEPARATOR)) {
    throw new Error(`${label} contains a reserved separator`);
  }
  return normalized;
}
export function createId(prefix: string): string {
  const safePrefix = requireIdentifier(prefix, "prefix");
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return `${safePrefix}_${randomUuid}`;
  }

  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("A secure random number generator is required");
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const randomHex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${safePrefix}_${randomHex}`;
}

export function createPaperId(fingerprint: string): string {
  const normalized = requireIdentifier(fingerprint, "fingerprint");
  return `paper_${normalized.slice(0, 32)}`;
}

export function createAttemptId(): string {
  return createId("attempt");
}

export function createFeedbackId(): string {
  return createId("feedback");
}

export function makeQuestionAttemptId(attemptId: string, questionId: string): string {
  return `${requireIdentifier(attemptId, "attemptId")}${ID_SEPARATOR}${requireIdentifier(
    questionId,
    "questionId",
  )}`;
}
