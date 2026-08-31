import {
  BRIDGE_MESSAGE,
  bridgeFailure,
  bridgeSuccess,
  isExamContentRequest,
  toErrorMessage,
} from "../adapters/bridge-protocol";
import { ExamAdapterError } from "../adapters/ExamAdapter";
import { extractCurrentPaper } from "../adapters/exam-registry";

declare global {
  interface Window {
    __shenlunExamBridgeInstalled?: boolean;
  }
}

function installExamBridge(): void {
  if (window.__shenlunExamBridgeInstalled) return;
  window.__shenlunExamBridgeInstalled = true;

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isExamContentRequest(message)) return false;

    if (message.type === BRIDGE_MESSAGE.pingExam) {
      sendResponse(bridgeSuccess({ ready: true }));
      return false;
    }

    void extractCurrentPaper(document)
      .then((paper) => sendResponse(bridgeSuccess(paper)))
      .catch((error: unknown) => {
        if (error instanceof ExamAdapterError) {
          sendResponse(bridgeFailure(error.code, error.message, error.retryable));
          return;
        }
        sendResponse(
          bridgeFailure(
            "EXAM_EXTRACTION_FAILED",
            `试卷提取失败：${toErrorMessage(error)}`,
            true,
          ),
        );
      });
    return true;
  });
}

installExamBridge();
