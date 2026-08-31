import type { CreatePaperDefinitionInput, QuestionDefinition } from "../types";

export function normalizeFingerprintText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function canonicalizeSourceUrl(value: string): string {
  const normalized = value.trim();
  try {
    const url = new URL(normalized);
    url.hash = "";
    const volatileQuestionParameters = new Set([
      "questionid",
      "question_id",
      "questionindex",
      "question_index",
      "currentquestion",
      "current",
      "index",
      "qid",
      "tab",
    ]);
    for (const key of [...url.searchParams.keys()]) {
      if (volatileQuestionParameters.has(key.toLocaleLowerCase("en-US"))) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/u, "");
    }
    return url.toString();
  } catch {
    return normalizeFingerprintText(normalized);
  }
}

function normalizeQuestion(question: QuestionDefinition): object {
  return {
    index: question.index,
    title: normalizeFingerprintText(question.title),
    questionText: normalizeFingerprintText(question.questionText),
    materials: question.materials.map(normalizeFingerprintText),
    score: question.score,
    wordLimit: question.wordLimit,
    referenceAnswer:
      question.referenceAnswer === null
        ? null
        : normalizeFingerprintText(question.referenceAnswer),
  };
}

/** Stable canonical source used by computePaperFingerprint and unit tests. */
export function buildPaperFingerprintSource(
  input: Pick<CreatePaperDefinitionInput, "paperName" | "sourceUrl" | "questions">,
): string {
  const normalizedQuestions = [...input.questions]
    .sort((left, right) => left.index - right.index || left.questionId.localeCompare(right.questionId))
    .map(normalizeQuestion);

  return JSON.stringify({
    paperName: normalizeFingerprintText(input.paperName),
    sourceUrl: canonicalizeSourceUrl(input.sourceUrl),
    questions: normalizedQuestions,
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto is required to calculate a paper fingerprint");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computePaperFingerprint(
  input: Pick<CreatePaperDefinitionInput, "paperName" | "sourceUrl" | "questions">,
): Promise<string> {
  return sha256Hex(buildPaperFingerprintSource(input));
}
