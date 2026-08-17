// Log stream lifecycle — no Svelte runes (see log-stream.svelte.ts for the
// reactive subclass), IPC injected so the state machine is testable.
//
// This owns the one genuinely subtle part of the log viewer: an async state
// machine over two event channels, a command that may never settle, and a user
// who can restart it at any moment. It lives apart from LogViewer.svelte so
// that component can stay about rendering, and so these transitions can be
// tested without a DOM or a cluster.
//
// The phases and why they exist:
//
//   idle ──start()──▶ connecting ──command resolves──▶ live
//                         │                             │
//                         │                             ├─ status 'ended' ─▶ ended
//                         ├─ command rejects ──▶ error  ├─ status 'error' ─▶ error
//                         └─ watchdog fires ───▶ error  └─ stop() ─────────▶ idle
//
// `connecting` covers ONLY the window until the backend confirms the log request
// is established; `live` means attached, which is NOT the same as "has produced
// output". Collapsing those two into one boolean is what used to leave a quiet
// pod showing "Connecting to log stream..." forever.

import type { StreamPhase, StreamRequest, StreamStatus } from "./log-viewer";

/** How long a "connecting" phase may last before we call it a failure. */
export const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Side effects the state machine needs. The real IPC is wired up in
 * log-stream.svelte.ts; tests pass fakes.
 */
export interface LogStreamIo {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: <T>(channel: string, cb: (payload: T) => void) => Promise<() => void>;
  /** A batch of raw log lines arrived. */
  onLines: (lines: string[]) => void;
  /** A new stream is starting — drop whatever the previous one produced. */
  onReset: () => void;
  /** Override the watchdog, mainly so tests do not wait 15 seconds. */
  connectTimeoutMs?: number;
}

export class LogStreamLogic {
  phase: StreamPhase = "idle";
  error: string | null = null;

  protected _io: LogStreamIo;

  /**
   * Bumped by every start/stop. Each `await` in start() resumes behind a check
   * against it, so a slow attempt can never resurrect itself and clobber the
   * state of a newer one.
   */
  private _generation = 0;
  private _connectTimer: ReturnType<typeof setTimeout> | null = null;
  private _unlisteners: Array<() => void> = [];
  private _destroyed = false;

  constructor(io: LogStreamIo) {
    this._io = io;
  }

  /** Whether a stream is attached or being attached — drives the Stop button. */
  get isActive(): boolean {
    return this.phase === "connecting" || this.phase === "live";
  }

  async start(request: StreamRequest): Promise<void> {
    if (this._destroyed) return;

    // Invalidate FIRST, so anything in flight from a previous attempt is stale
    // before we touch shared state.
    const gen = this._invalidate();
    this._stopBackendStream();
    // Drop the previous stream's lines for EITHER outcome. Leaving them on
    // screen for an unavailable request hides the reason: the empty state is
    // the only thing that renders it, and a non-empty list never shows it.
    this._io.onReset();

    if (request.kind === "unavailable") {
      this._fail(request.reason);
      return;
    }

    this.phase = "connecting";
    this.error = null;

    // Backstop for the one ending the backend cannot report: the connect itself
    // never settling (unreachable apiserver, hung TLS handshake).
    this._connectTimer = setTimeout(() => {
      if (gen !== this._generation) return;
      // Invalidate this attempt too: we are tearing its subscriptions down, so a
      // connect that lands late must not be able to flip us back to "live".
      this._invalidate();
      this._stopBackendStream();
      this._fail("Timed out connecting to the log stream.");
    }, this._io.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

    try {
      const unlistenLines = await this._io.listen<string[]>("log-lines", (payload) => {
        if (gen !== this._generation) return;
        this._io.onLines(payload);
      });
      const unlistenStatus = await this._io.listen<StreamStatus>("log-stream-status", (payload) => {
        if (gen !== this._generation) return;
        this._onStatus(payload);
      });

      if (this._destroyed || gen !== this._generation) {
        unlistenLines();
        unlistenStatus();
        return;
      }
      this._unlisteners = [unlistenLines, unlistenStatus];

      await this._io.invoke(request.command, request.args);
      if (gen !== this._generation) return;

      // The command resolves once the log request is established, so this is a
      // real connection signal rather than an optimistic guess.
      this._clearConnectTimer();
      // A very short-lived stream can report that it already ended before this
      // resolves, so never overwrite a phase that has already gone terminal.
      if (this.phase === "connecting") this.phase = "live";
    } catch (err) {
      if (gen !== this._generation) return;
      this._invalidate();
      this._fail(err instanceof Error ? err.message : String(err));
    }
  }

  stop(): void {
    this._invalidate();
    this.phase = "idle";
    this.error = null;
    this._stopBackendStream();
  }

  /** Stop for good; further start() calls are ignored. */
  destroy(): void {
    this._destroyed = true;
    this.stop();
  }

  /** The backend reporting that the stream finished on its own. */
  private _onStatus(status: StreamStatus): void {
    this._clearConnectTimer();
    if (status.state === "ended") {
      this.phase = "ended";
      return;
    }
    this._fail(status.message ?? "The log stream stopped unexpectedly.");
  }

  private _fail(message: string): void {
    this.error = message;
    this.phase = "error";
  }

  /**
   * Invalidate in-flight work and drop event subscriptions. Returns the new
   * generation so a caller can detect its own obsolescence later.
   */
  private _invalidate(): number {
    this._generation += 1;
    this._clearConnectTimer();
    for (const unlisten of this._unlisteners) unlisten();
    this._unlisteners = [];
    return this._generation;
  }

  private _clearConnectTimer(): void {
    if (this._connectTimer !== null) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
  }

  /** Best-effort teardown of the backend's single active stream slot. */
  private _stopBackendStream(): void {
    this._io.invoke("stop_log_stream").catch(() => {});
  }
}
