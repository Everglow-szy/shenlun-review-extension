export interface DomWaitOptions {
  readonly root?: Node;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DomStableOptions extends DomWaitOptions {
  readonly quietMs?: number;
}

export class DomWaitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DomWaitError";
  }
}

function observerTarget(root: Node | undefined): Node {
  return root ?? document.documentElement;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The DOM wait was aborted", "AbortError");
  }
}

/**
 * Wait for a predicate by observing DOM changes. This deliberately avoids a
 * polling loop and always disconnects its observer on success/timeout/abort.
 */
export async function waitForCondition<T>(
  predicate: () => T | null | undefined | false,
  options: DomWaitOptions = {},
): Promise<T> {
  const { signal } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  throwIfAborted(signal);

  const initialValue = predicate();
  if (initialValue) return initialValue;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const target = observerTarget(options.root);

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const evaluate = (): void => {
      try {
        const value = predicate();
        if (value) finish(() => resolve(value));
      } catch (error) {
        finish(() => reject(error));
      }
    };

    const observer = new MutationObserver(evaluate);
    const timeout = globalThis.setTimeout(() => {
      finish(() => reject(new DomWaitError(`DOM condition timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    const onAbort = (): void => {
      finish(() => reject(new DOMException("The DOM wait was aborted", "AbortError")));
    };

    observer.observe(target, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    signal?.addEventListener("abort", onAbort, { once: true });

    // Close the small race between the initial predicate call and observe().
    evaluate();
  });
}

export async function waitForElement<T extends Element>(
  selectors: readonly string[],
  options: DomWaitOptions = {},
): Promise<T> {
  const root = options.root instanceof Document || options.root instanceof Element
    ? options.root
    : document;
  return waitForCondition(
    () => queryFirst<T>(root, selectors),
    { ...options, root: options.root ?? document.documentElement },
  );
}

/** Resolve after the observed DOM has remained mutation-free for quietMs. */
export async function waitForDomStable(options: DomStableOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const quietMs = options.quietMs ?? 180;
  const { signal } = options;
  throwIfAborted(signal);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let quietTimer: ReturnType<typeof globalThis.setTimeout>;
    const target = observerTarget(options.root);

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      globalThis.clearTimeout(quietTimer);
      globalThis.clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const scheduleQuietResolution = (): void => {
      globalThis.clearTimeout(quietTimer);
      quietTimer = globalThis.setTimeout(() => finish(resolve), quietMs);
    };

    const observer = new MutationObserver(scheduleQuietResolution);
    const timeoutTimer = globalThis.setTimeout(() => {
      finish(() => reject(new DomWaitError(`DOM did not stabilize within ${timeoutMs}ms`)));
    }, timeoutMs);
    const onAbort = (): void => {
      finish(() => reject(new DOMException("The DOM wait was aborted", "AbortError")));
    };

    observer.observe(target, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    scheduleQuietResolution();
  });
}

export function queryFirst<T extends Element>(
  root: ParentNode,
  selectors: readonly string[],
): T | null {
  for (const selector of selectors) {
    try {
      const match = root.querySelector<T>(selector);
      if (match) return match;
    } catch {
      // A single stale selector must not disable all fallbacks.
    }
  }
  return null;
}

export function queryAllFirstGroup<T extends Element>(
  root: ParentNode,
  selectors: readonly string[],
): T[] {
  for (const selector of selectors) {
    try {
      const matches = Array.from(root.querySelectorAll<T>(selector));
      if (matches.length > 0) return matches;
    } catch {
      // Continue to the next selector fallback.
    }
  }
  return [];
}

export function normalizedText(node: Element | null | undefined): string {
  return (node?.textContent ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function isElementUsable(element: Element): boolean {
  return (
    !element.hasAttribute("disabled") &&
    element.getAttribute("aria-disabled") !== "true" &&
    element.getAttribute("aria-hidden") !== "true"
  );
}
