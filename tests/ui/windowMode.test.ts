/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeRestoreWithoutScan,
  documentPictureInPictureApi,
  floatingPageUrl,
  normalizeFloatingWindowSize,
  parseAppDisplayContext,
  requestRestoreWithoutScan,
} from "../../src/sidepanel/windowMode";

describe("side panel and floating window mode", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to pinned mode and validates a floating source window", () => {
    expect(parseAppDisplayContext("")).toEqual({ mode: "pinned", sourceWindowId: null });
    expect(parseAppDisplayContext("?mode=floating&sourceWindowId=42"))
      .toEqual({ mode: "floating", sourceWindowId: 42 });
    expect(parseAppDisplayContext("?mode=floating&sourceWindowId=-1"))
      .toEqual({ mode: "floating", sourceWindowId: null });
  });

  it("builds a floating extension URL and constrains restored dimensions", () => {
    expect(floatingPageUrl("chrome-extension://example/index.html", 18))
      .toBe("chrome-extension://example/index.html?mode=floating&sourceWindowId=18");
    expect(normalizeFloatingWindowSize({ width: 100, height: 5_000 }))
      .toEqual({ width: 360, height: 1_400 });
    expect(normalizeFloatingWindowSize(null)).toEqual({ width: 500, height: 820 });
  });

  it("consumes the one-shot restore flag exactly once", () => {
    requestRestoreWithoutScan(window.localStorage);
    expect(consumeRestoreWithoutScan(window.localStorage)).toBe(true);
    expect(consumeRestoreWithoutScan(window.localStorage)).toBe(false);
  });

  it("feature-detects the always-on-top document window API", () => {
    expect(documentPictureInPictureApi(window)).toBeNull();
    const requestWindow = async (): Promise<Window> => window;
    const supportedWindow = {
      documentPictureInPicture: { window: null, requestWindow },
    } as unknown as Window;
    expect(documentPictureInPictureApi(supportedWindow)?.requestWindow).toBe(requestWindow);
  });
});
