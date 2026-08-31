import { useEffect, useRef } from "react";

export function useDebouncedEffect(
  effect: () => void | (() => void),
  dependencies: readonly unknown[],
  delayMs: number,
): void {
  const effectRef = useRef(effect);
  effectRef.current = effect;

  useEffect(() => {
    const timeoutId = window.setTimeout(() => effectRef.current(), delayMs);
    return () => window.clearTimeout(timeoutId);
    // The caller intentionally controls the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, delayMs]);
}
