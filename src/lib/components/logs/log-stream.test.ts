import { describe, expect, test } from "bun:test";

import { LogStreamLogic, type LogStreamIo } from "./log-stream.logic";
import type { StreamRequest, StreamStatus } from "./log-viewer";

const REQUEST: StreamRequest = {
  kind: "stream",
  command: "stream_pod_logs",
  args: { name: "web-0", namespace: "default" },
};

/** A stream command the fake backend is holding open. */
interface Pending {
  resolve: () => void;
  reject: (e: Error) => void;
}

interface Harness {
  stream: LogStreamLogic;
  /** Commands the machine sent, in order. */
  invoked: string[];
  lines: string[][];
  resets: number;
  /** Total live subscribers across channels, to catch listener leaks. */
  live: () => number;
  emit: (channel: string, payload: unknown) => void;
  /**
   * Detach the in-flight stream command so a test can settle THAT attempt later,
   * even after a restart has replaced it.
   */
  takePending: () => Pending;
  /** Resolve (or reject) the in-flight stream command. */
  settle: (err?: Error) => void;
}

/**
 * A LogStreamLogic wired to fakes. The stream command is held open until the
 * test calls settle(), so the connecting → live window can be inspected.
 */
function harness(over: Partial<LogStreamIo> = {}): Harness {
  const invoked: string[] = [];
  const lines: string[][] = [];
  let resets = 0;
  const subscribers = new Map<string, Set<(payload: unknown) => void>>();
  let pending: Pending | null = null;

  function takePending(): Pending {
    if (!pending) throw new Error("no stream command in flight");
    const p = pending;
    pending = null;
    return p;
  }

  const io: LogStreamIo = {
    invoke: (cmd) => {
      invoked.push(cmd);
      if (cmd === "stop_log_stream") return Promise.resolve(null);
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    listen: <T,>(channel: string, cb: (payload: T) => void) => {
      const set = subscribers.get(channel) ?? new Set();
      subscribers.set(channel, set);
      const fn = cb as (payload: unknown) => void;
      set.add(fn);
      return Promise.resolve(() => set.delete(fn));
    },
    onLines: (payload) => lines.push(payload),
    onReset: () => {
      resets += 1;
    },
    connectTimeoutMs: 40,
    ...over,
  };

  return {
    stream: new LogStreamLogic(io),
    invoked,
    lines,
    get resets() {
      return resets;
    },
    live: () => [...subscribers.values()].reduce((n, s) => n + s.size, 0),
    emit: (channel, payload) => {
      for (const cb of subscribers.get(channel) ?? []) cb(payload);
    },
    takePending,
    settle: (err) => {
      const p = takePending();
      if (err) p.reject(err);
      else p.resolve();
    },
  } as Harness;
}

/** Let queued microtasks (and optionally timers) run. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LogStreamLogic phases", () => {
  test("starts idle", () => {
    const h = harness();
    expect(h.stream.phase).toBe("idle");
    expect(h.stream.isActive).toBe(false);
  });

  test("is connecting until the backend confirms, then live", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();

    expect(h.stream.phase).toBe("connecting");
    expect(h.stream.isActive).toBe(true);

    h.settle();
    await tick();

    expect(h.stream.phase).toBe("live");
    expect(h.stream.isActive).toBe(true);
  });

  test("clears the previous stream's output on start", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    expect(h.resets).toBe(1);
  });

  test("forwards log lines while live", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    h.settle();
    await tick();

    h.emit("log-lines", ["one", "two"]);
    expect(h.lines).toEqual([["one", "two"]]);
  });

  test("an unavailable request fails without contacting the backend", async () => {
    const h = harness();
    await h.stream.start({ kind: "unavailable", reason: "No pod selected." });

    expect(h.stream.phase).toBe("error");
    expect(h.stream.error).toBe("No pod selected.");
    expect(h.invoked).not.toContain("stream_pod_logs");
  });

  test("a rejected stream command surfaces the error", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    h.settle(new Error("403 Forbidden"));
    await tick();

    expect(h.stream.phase).toBe("error");
    expect(h.stream.error).toBe("403 Forbidden");
    expect(h.stream.isActive).toBe(false);
  });
});

describe("LogStreamLogic terminal status", () => {
  test("an ended status leaves the live phase", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    h.settle();
    await tick();

    h.emit("log-stream-status", { state: "ended" } satisfies StreamStatus);
    expect(h.stream.phase).toBe("ended");
    expect(h.stream.isActive).toBe(false);
  });

  test("an error status carries its message", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    h.settle();
    await tick();

    h.emit("log-stream-status", { state: "error", message: "connection reset" });
    expect(h.stream.phase).toBe("error");
    expect(h.stream.error).toBe("connection reset");
  });

  test("an error status without a message still explains itself", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    h.settle();
    await tick();

    h.emit("log-stream-status", { state: "error" });
    expect(h.stream.error).toBe("The log stream stopped unexpectedly.");
  });

  // A stream can end before the command that started it resolves; "live" must
  // not overwrite a phase that has already gone terminal.
  test("a stream that ends before the command resolves stays ended", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();

    h.emit("log-stream-status", { state: "ended" });
    expect(h.stream.phase).toBe("ended");

    h.settle();
    await tick();
    expect(h.stream.phase).toBe("ended");
  });
});

describe("LogStreamLogic restarts and staleness", () => {
  test("stop returns to idle and drops subscriptions", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    h.settle();
    await tick();
    expect(h.live()).toBe(2);

    h.stream.stop();
    expect(h.stream.phase).toBe("idle");
    expect(h.stream.error).toBeNull();
    expect(h.live()).toBe(0);
  });

  test("a superseded start cannot report over the newer one", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    const first = h.takePending();

    // Restart before the first attempt settles.
    void h.stream.start(REQUEST);
    await tick();

    // The first attempt now fails — it must not touch the new attempt's state.
    first.reject(new Error("stale failure"));
    await tick();
    expect(h.stream.phase).toBe("connecting");
    expect(h.stream.error).toBeNull();

    h.settle();
    await tick();
    expect(h.stream.phase).toBe("live");
  });

  test("restarting does not leak the previous attempt's listeners", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    h.settle();
    await tick();

    void h.stream.start(REQUEST);
    await tick();
    h.settle();
    await tick();

    // Two channels, one subscriber each — not four.
    expect(h.live()).toBe(2);
  });

  test("a status from a stopped stream is ignored", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    h.settle();
    await tick();

    h.stream.stop();
    h.emit("log-stream-status", { state: "error", message: "too late" });

    expect(h.stream.phase).toBe("idle");
    expect(h.stream.error).toBeNull();
  });

  test("destroy stops the stream and refuses further starts", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    h.settle();
    await tick();

    h.stream.destroy();
    expect(h.stream.phase).toBe("idle");
    expect(h.live()).toBe(0);

    await h.stream.start(REQUEST);
    expect(h.stream.phase).toBe("idle");
  });
});

describe("LogStreamLogic connect watchdog", () => {
  // The one ending the backend cannot report: a connect that never settles.
  test("a connect that never settles becomes an error", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    expect(h.stream.phase).toBe("connecting");

    await tick(70);

    expect(h.stream.phase).toBe("error");
    expect(h.stream.error).toBe("Timed out connecting to the log stream.");
    expect(h.live()).toBe(0);
  });

  test("a late connect cannot revive a timed-out attempt", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    await tick(70);
    expect(h.stream.phase).toBe("error");

    h.settle();
    await tick();

    expect(h.stream.phase).toBe("error");
  });

  test("the watchdog does not fire once connected", async () => {
    const h = harness();
    void h.stream.start(REQUEST);
    await tick();
    h.settle();
    await tick();

    await tick(70);

    expect(h.stream.phase).toBe("live");
  });
});
