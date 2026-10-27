/** Progress lines during a long build: at most one per interval per source, so a run is readable without being spammed. */
export const PROGRESS_INTERVAL_MS = 60_000;

/**
 * A gate that lets `emit` run once an interval has elapsed since the start or
 * the previous emission; the first call never emits, the final line of a
 * short run covers it.
 */
export function throttle(intervalMs = PROGRESS_INTERVAL_MS, now: () => number = () => performance.now()): (emit: () => void) => void {
  let last = now();
  return (emit) => {
    const at = now();
    if (at - last < intervalMs) return;
    last = at;
    emit();
  };
}
