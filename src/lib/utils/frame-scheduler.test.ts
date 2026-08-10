import { describe, expect, test, afterEach } from "bun:test";
import { scheduleFlush, FLUSH_FALLBACK_MS } from "./frame-scheduler";

type RafGlobals = {
  requestAnimationFrame?: (cb: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

const g = globalThis as RafGlobals;

/**
 * Install a controllable requestAnimationFrame. Returns `fire()` to deliver the
 * pending callbacks — never called when simulating a backgrounded window, which
 * is exactly what Chromium does there.
 */
function installRaf(): { fire: () => void; cancelled: number[] } {
  const pending = new Map<number, () => void>();
  const cancelled: number[] = [];
  let next = 1;

  g.requestAnimationFrame = (cb) => {
    const handle = next++;
    pending.set(handle, cb);
    return handle;
  };
  g.cancelAnimationFrame = (handle) => {
    cancelled.push(handle);
    pending.delete(handle);
  };

  return {
    fire: () => {
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb();
    },
    cancelled,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  delete g.requestAnimationFrame;
  delete g.cancelAnimationFrame;
});

describe("scheduleFlush", () => {
  test("runs the callback on the animation frame when the window is painting", () => {
    const raf = installRaf();
    let calls = 0;

    scheduleFlush(() => calls++);
    expect(calls).toBe(0);

    raf.fire();
    expect(calls).toBe(1);
  });

  test("runs the callback via the timeout when rAF never fires (backgrounded window)", async () => {
    installRaf(); // installed but never fired — the window is hidden
    let calls = 0;

    scheduleFlush(() => calls++);
    expect(calls).toBe(0);

    await sleep(FLUSH_FALLBACK_MS + 30);
    expect(calls).toBe(1);
  });

  test("runs exactly once when the frame fires and the fallback deadline passes", async () => {
    const raf = installRaf();
    let calls = 0;

    scheduleFlush(() => calls++);
    raf.fire();
    await sleep(FLUSH_FALLBACK_MS + 30);

    expect(calls).toBe(1);
  });

  test("the timeout fallback cancels the queued frame", async () => {
    const raf = installRaf();

    scheduleFlush(() => {});
    await sleep(FLUSH_FALLBACK_MS + 30);

    // A hidden window never delivers the frame. Leaving it queued would retain
    // one closure per flush for as long as the window stays hidden.
    expect(raf.cancelled.length).toBe(1);
  });

  test("runs exactly once when the fallback fires and the frame arrives late", async () => {
    const raf = installRaf();
    let calls = 0;

    scheduleFlush(() => calls++);
    await sleep(FLUSH_FALLBACK_MS + 30);
    expect(calls).toBe(1);

    // Window comes back to the foreground and the queued frame is delivered.
    raf.fire();
    expect(calls).toBe(1);
  });

  test("cancel prevents both the frame and the fallback from running it", async () => {
    const raf = installRaf();
    let calls = 0;

    const cancel = scheduleFlush(() => calls++);
    cancel();

    expect(raf.cancelled.length).toBe(1);
    raf.fire();
    await sleep(FLUSH_FALLBACK_MS + 30);
    expect(calls).toBe(0);
  });

  test("cancel after the callback ran is a no-op", () => {
    const raf = installRaf();
    let calls = 0;

    const cancel = scheduleFlush(() => calls++);
    raf.fire();
    cancel();

    expect(calls).toBe(1);
  });

  test("falls back to the timeout when rAF is unavailable (non-browser env)", async () => {
    let calls = 0;

    scheduleFlush(() => calls++);
    await sleep(FLUSH_FALLBACK_MS + 30);

    expect(calls).toBe(1);
  });
});
