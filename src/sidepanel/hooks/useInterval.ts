import { useEffect, useRef } from "react";

export function useInterval(callback: () => void, delayMs: number | null): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (delayMs === null) {
      return undefined;
    }
    const intervalId = window.setInterval(() => callbackRef.current(), delayMs);
    return () => window.clearInterval(intervalId);
  }, [delayMs]);
}
