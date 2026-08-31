const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function formatLocalDate(value: Date | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("Invalid date");
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildConversationName(
  date: string,
  paperName: string,
  attemptNumber = 1,
): string {
  if (!DATE_PATTERN.test(date)) {
    throw new RangeError("date must use YYYY-MM-DD format");
  }
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new RangeError("attemptNumber must be a positive integer");
  }

  const normalizedPaperName = paperName.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (normalizedPaperName.length === 0) {
    throw new Error("paperName must not be empty");
  }

  return `${normalizedPaperName}-申论批改`;
}

export function formatElapsedTime(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const seconds = safeSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}
