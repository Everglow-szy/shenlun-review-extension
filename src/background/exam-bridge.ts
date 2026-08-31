import {
  BRIDGE_MESSAGE,
  bridgeFailure,
  isRecord,
  type ExamExtractionResult,
} from "../adapters/bridge-protocol";
import { ChatGPTAdapter } from "../adapters/ChatGPTAdapter";
import type { ExtractedPaperPayload, QuestionDefinition } from "../types";

const EXAM_SCRIPT_PATH = "assets/exam-content-script.js";

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isQuestion(value: unknown): value is QuestionDefinition {
  if (!isRecord(value)) return false;
  return (
    typeof value.questionId === "string" &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    typeof value.title === "string" &&
    typeof value.questionText === "string" &&
    Array.isArray(value.materials) &&
    value.materials.every((item) => typeof item === "string") &&
    isNullableNumber(value.score) &&
    isNullableNumber(value.wordLimit) &&
    (value.referenceAnswer === null || typeof value.referenceAnswer === "string")
  );
}

function isExtractedPaper(value: unknown): value is ExtractedPaperPayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.paperName === "string" &&
    value.paperName.trim().length > 0 &&
    typeof value.paperSource === "string" &&
    typeof value.sourceUrl === "string" &&
    (value.paperDate === undefined || value.paperDate === null || typeof value.paperDate === "string") &&
    (value.activeQuestionId === undefined || typeof value.activeQuestionId === "string") &&
    Array.isArray(value.questions) &&
    value.questions.length > 0 &&
    value.questions.every(isQuestion)
  );
}

function isExamExtractionResult(value: unknown): value is ExamExtractionResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) return isExtractedPaper(value.data);
  return (
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    typeof value.error.retryable === "boolean"
  );
}

function isInjectableExamUrl(value: string | undefined): boolean {
  if (!value || ChatGPTAdapter.isChatGPTUrl(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function injectExamContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [EXAM_SCRIPT_PATH],
  });
}

export async function extractFromActiveTab(windowId?: number): Promise<ExamExtractionResult> {
  const [tab] = await chrome.tabs.query(
    windowId === undefined
      ? { active: true, currentWindow: true }
      : { active: true, windowId },
  );
  if (!tab?.id || !isInjectableExamUrl(tab.url)) {
    return bridgeFailure(
      "EXAM_PAGE_NOT_ACCESSIBLE",
      "请先在普通 HTTP/HTTPS 标签页中打开申论试卷，再点击扩展图标。",
      false,
    );
  }

  try {
    await injectExamContentScript(tab.id);
    const response: unknown = await chrome.tabs.sendMessage(tab.id, {
      type: BRIDGE_MESSAGE.extractPage,
    });
    if (!isExamExtractionResult(response)) {
      return bridgeFailure(
        "EXAM_INVALID_RESPONSE",
        "试卷页面返回了无效数据，网站结构可能已经更新。",
        true,
      );
    }
    return response;
  } catch (error) {
    return bridgeFailure(
      "EXAM_INJECTION_FAILED",
      error instanceof Error
        ? `无法读取当前试卷：${error.message}`
        : "无法读取当前试卷，请刷新页面后重试。",
      true,
    );
  }
}
