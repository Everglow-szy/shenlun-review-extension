export type AppWindowMode = "pinned" | "floating";

export interface AppDisplayContext {
  readonly mode: AppWindowMode;
  readonly sourceWindowId: number | null;
}

export interface FloatingWindowSize {
  readonly width: number;
  readonly height: number;
}

export interface DocumentPictureInPictureApi {
  readonly window: Window | null;
  requestWindow(options?: {
    readonly width?: number;
    readonly height?: number;
    readonly disallowReturnToOpener?: boolean;
  }): Promise<Window>;
}

export const FLOATING_WINDOW_SIZE_KEY = "shenlun.floatingWindowSize.v1";
export const FLOATING_WINDOW_SESSION_KEY = "shenlun.floatingWindowSession.v1";
export const RESTORE_WITHOUT_SCAN_KEY = "shenlun.restoreWithoutScanOnce.v1";
export const FLOATING_ALWAYS_ON_TOP_SIZE_KEY = "shenlun.floatingAlwaysOnTopSize.v1";

export const DEFAULT_FLOATING_WINDOW_SIZE: FloatingWindowSize = {
  width: 500,
  height: 820,
};

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : null;
}

export function parseAppDisplayContext(search: string): AppDisplayContext {
  const params = new URLSearchParams(search);
  if (params.get("mode") !== "floating") {
    return { mode: "pinned", sourceWindowId: null };
  }
  const rawSourceWindowId = params.get("sourceWindowId");
  const sourceWindowId = rawSourceWindowId === null ? Number.NaN : Number(rawSourceWindowId);
  return {
    mode: "floating",
    sourceWindowId: Number.isSafeInteger(sourceWindowId) && sourceWindowId > 0
      ? sourceWindowId
      : null,
  };
}

export function normalizeFloatingWindowSize(value: unknown): FloatingWindowSize {
  if (typeof value !== "object" || value === null) return DEFAULT_FLOATING_WINDOW_SIZE;
  const candidate = value as { readonly width?: unknown; readonly height?: unknown };
  return {
    width: boundedInteger(candidate.width, 360, 1_600) ?? DEFAULT_FLOATING_WINDOW_SIZE.width,
    height: boundedInteger(candidate.height, 480, 1_400) ?? DEFAULT_FLOATING_WINDOW_SIZE.height,
  };
}

export function floatingPageUrl(extensionPageUrl: string, sourceWindowId: number): string {
  const url = new URL(extensionPageUrl);
  url.searchParams.set("mode", "floating");
  url.searchParams.set("sourceWindowId", String(sourceWindowId));
  return url.toString();
}

export function documentPictureInPictureApi(
  hostWindow: Window,
): DocumentPictureInPictureApi | null {
  const candidate = (hostWindow as Window & {
    readonly documentPictureInPicture?: DocumentPictureInPictureApi;
  }).documentPictureInPicture;
  return candidate && typeof candidate.requestWindow === "function" ? candidate : null;
}

export function copyDocumentStyles(source: Document, target: Document): void {
  for (const node of source.querySelectorAll<HTMLLinkElement | HTMLStyleElement>(
    'link[rel="stylesheet"], style',
  )) {
    if (node instanceof HTMLLinkElement) {
      const link = target.createElement("link");
      link.rel = "stylesheet";
      link.href = node.href;
      if (node.media) link.media = node.media;
      target.head.append(link);
    } else {
      const style = target.createElement("style");
      style.textContent = node.textContent;
      target.head.append(style);
    }
  }
}

export function consumeRestoreWithoutScan(storage: Storage | null): boolean {
  if (!storage) return false;
  try {
    const restore = storage.getItem(RESTORE_WITHOUT_SCAN_KEY) === "1";
    if (restore) storage.removeItem(RESTORE_WITHOUT_SCAN_KEY);
    return restore;
  } catch {
    return false;
  }
}

export function requestRestoreWithoutScan(storage: Storage | null): void {
  if (!storage) return;
  try {
    storage.setItem(RESTORE_WITHOUT_SCAN_KEY, "1");
  } catch {
    // The side panel can still open; it will use its normal initialization path.
  }
}
