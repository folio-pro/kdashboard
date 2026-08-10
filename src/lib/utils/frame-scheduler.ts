/**
 * Frame scheduling that survives a backgrounded window.
 *
 * Streaming subsystems (resource watch, log tail) coalesce incoming events into
 * a pending buffer and schedule ONE flush per frame with requestAnimationFrame.
 * That is the right cadence while the window is on screen — but Chromium stops
 * delivering rAF callbacks entirely once the window is minimized or fully
 * occluded, and Electron's `backgroundThrottling` (on by default) makes that the
 * normal case rather than an edge case.
 *
 * The main process keeps emitting regardless (electron/handlers/watch.ts and
 * logs.ts flush every 50ms), so a bare rAF means the pending buffer grows for as
 * long as the window stays hidden and then lands as one giant flush on refocus.
 *
 * `scheduleFlush` races rAF against a timeout so a hidden window still drains at
 * a slow but bounded rate, while a visible window keeps the exact per-frame
 * cadence it has today (the rAF virtually always wins at 60fps). Same pattern as
 * the benchmark harness's `nextPaint` in $lib/benchmark/e2e-runner.ts.
 */

/**
 * Fallback delay. Longer than a 60fps frame (16.7ms) so the rAF wins whenever
 * the window is actually painting — the timer only takes over when rAF is
 * paused. Short enough that a hidden window still drains several times a second.
 */
export const FLUSH_FALLBACK_MS = 100;

/**
 * Run `cb` on the next animation frame, or after FLUSH_FALLBACK_MS if the
 * window is backgrounded and rAF never fires. `cb` runs exactly once.
 *
 * Returns a cancel function; calling it after `cb` has run is a no-op.
 */
export function scheduleFlush(cb: () => void): () => void {
  let done = false;
  let raf: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Drop the queued frame. Critical when the TIMEOUT wins: a hidden window
   * never delivers that frame, so without this every flush would leave a live
   * rAF callback (and its closure) queued until the window is shown again —
   * ~10 per second, a slow leak of exactly the kind this module exists to
   * prevent. Cancelling an already-fired handle is a no-op.
   */
  const cancelFrame = (): void => {
    if (raf !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(raf);
    }
    raf = undefined;
  };

  const run = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cancelFrame();
    cb();
  };

  // requestAnimationFrame is absent in the bun test environment; the timeout
  // path alone is a correct (if slower) scheduler there.
  raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : undefined;
  timer = setTimeout(run, FLUSH_FALLBACK_MS);

  return () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cancelFrame();
  };
}
