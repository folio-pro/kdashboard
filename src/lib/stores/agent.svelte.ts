// Agent Session state for the renderer: panel visibility, session lifecycle,
// profile availability, Mutation Approval queue, and the output buffer that
// bridges PTY output emitted before the terminal widget has mounted.
//
// Event subscriptions are installed once, lazily, on the first interaction
// with the store (opening the panel / starting a session) — not at module
// load, so importing the store stays side-effect free for tests.

import { invoke } from "$lib/ipc/core";
import { listen } from "$lib/ipc/event";
import { settingsStore } from "$lib/stores/settings.svelte";
import { toastStore } from "$lib/stores/toast.svelte";

export interface AgentProfileStatus {
  id: string;
  displayName: string;
  available: boolean;
  version?: string;
  warning?: string;
  installUrl: string;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  resource: { kind: string; namespace?: string; name: string; container?: string };
  changes: string[];
}

export type AgentSessionStatus = "idle" | "starting" | "running" | "ended";

/** Cap on the replay buffer for output that predates the terminal mount. */
const OUTPUT_BUFFER_MAX = 256 * 1024;

/** Quiet period a terminal size must hold before the PTY is told about it. */
const RESIZE_SETTLE_MS = 150;

const END_REASON_TEXT: Record<string, string> = {
  exit: "The agent exited.",
  stopped: "Session stopped.",
  replaced: "Session replaced by a new one.",
  "context-switch": "Session ended: the Kubernetes context changed.",
};

class AgentStore {
  panelOpen = $state(false);
  panelHeight = $state(320);

  status = $state<AgentSessionStatus>("idle");
  endedReason = $state<string | null>(null);
  exitCode = $state<number | null>(null);

  profiles = $state<AgentProfileStatus[]>([]);
  profilesLoaded = $state(false);
  selectedProfileId = $state<string>("");

  approvals = $state<ApprovalRequest[]>([]);

  /** Output since session start, replayed into a terminal that mounts late. */
  outputBuffer = "";
  private outputListeners = new Set<(chunk: string) => void>();
  private subscribed = false;

  private async ensureSubscribed(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;

    await listen<string>("agent-output", (event) => {
      this.outputBuffer = (this.outputBuffer + event.payload).slice(-OUTPUT_BUFFER_MAX);
      for (const cb of this.outputListeners) cb(event.payload);
    });

    await listen<{ reason: string; code?: number }>("agent-session-ended", (event) => {
      this.status = "ended";
      this.endedReason = END_REASON_TEXT[event.payload.reason] ?? event.payload.reason;
      this.exitCode = event.payload.code ?? null;
      this.approvals = [];
      if (event.payload.reason === "context-switch") {
        toastStore.info("Agent session ended", END_REASON_TEXT["context-switch"]);
      }
    });

    await listen<ApprovalRequest>("agent-approval-request", (event) => {
      this.approvals = [...this.approvals, event.payload];
    });
  }

  /** Subscribe a terminal to live output; replays the buffer first. */
  onOutput(cb: (chunk: string) => void): () => void {
    if (this.outputBuffer.length > 0) cb(this.outputBuffer);
    this.outputListeners.add(cb);
    return () => this.outputListeners.delete(cb);
  }

  // --- Terminal geometry ----------------------------------------------------
  //
  // The agent CLIs are full-screen TUIs: they paint their frame once for the
  // size the PTY had at spawn. Spawning at a default 80x24 and resizing a
  // moment later leaves that first frame on screen at the wrong width — the
  // "letters on top of each other" look. So the session waits for the mounted
  // terminal and spawns at its real size.

  private terminalSize: { cols: number; rows: number } | null = null;
  private terminalWaiters: Array<() => void> = [];
  private clearListeners = new Set<() => void>();
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  /** The panel's terminal is mounted and measured. */
  attachTerminal(cols: number, rows: number): void {
    this.terminalSize = { cols, rows };
    const waiters = this.terminalWaiters;
    this.terminalWaiters = [];
    for (const resolve of waiters) resolve();
  }

  detachTerminal(): void {
    this.terminalSize = null;
  }

  /** Resolves once a terminal is mounted, or after `timeoutMs` regardless. */
  private waitForTerminal(timeoutMs = 3000): Promise<void> {
    if (this.terminalSize) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.terminalWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Resolves when the terminal size has held still for one settle period. */
  private async waitForStableSize(): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const before = this.terminalSize;
      await new Promise((r) => setTimeout(r, RESIZE_SETTLE_MS));
      const after = this.terminalSize;
      if (before && after && before.cols === after.cols && before.rows === after.rows) return;
    }
  }

  /** Subscribe to "wipe the screen" (fired when a new session starts). */
  onClear(cb: () => void): () => void {
    this.clearListeners.add(cb);
    return () => this.clearListeners.delete(cb);
  }

  /** Bumped to ask the mounted terminal to grab keyboard focus. */
  focusRequest = $state(0);

  async loadProfiles(): Promise<void> {
    await this.ensureSubscribed();
    try {
      this.profiles = await invoke<AgentProfileStatus[]>("get_agent_profiles");
    } catch (err) {
      toastStore.error("Agent profiles unavailable", String(err));
      this.profiles = [];
    }
    this.profilesLoaded = true;

    const last = settingsStore.settings.agent_last_profile;
    const preferred =
      (last && this.profiles.find((p) => p.id === last && p.available)) ||
      this.profiles.find((p) => p.available);
    if (!this.profiles.some((p) => p.id === this.selectedProfileId && p.available)) {
      this.selectedProfileId = preferred?.id ?? "";
    }
  }

  async openPanel(): Promise<void> {
    this.panelOpen = true;
    if (!this.profilesLoaded) await this.loadProfiles();
  }

  /**
   * Hide the panel. The session keeps running: Mutation Approvals still
   * surface (the dialog is always mounted) and the status bar shows the
   * running dot. Stop is an explicit action, never a side effect of hiding.
   */
  closePanel(): void {
    this.panelOpen = false;
  }

  /** Quick Action prompt that arrived while a session was still starting. */
  private queuedPrompt: string | null = null;

  async start(prompt?: string): Promise<void> {
    await this.ensureSubscribed();
    if (!this.selectedProfileId) return;
    if (this.status === "starting") return;
    this.status = "starting";
    this.queuedPrompt = null;
    this.endedReason = null;
    this.exitCode = null;
    this.outputBuffer = "";
    this.approvals = [];
    for (const cb of this.clearListeners) cb();
    // Spawn at the terminal's real, settled size — see the geometry note above.
    await this.waitForTerminal();
    await this.waitForStableSize();
    try {
      await invoke("start_agent_session", {
        profileId: this.selectedProfileId,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(this.terminalSize ?? {}),
      });
      this.status = "running";
      settingsStore.settings.agent_last_profile = this.selectedProfileId;
      settingsStore.saveSettings();
      const queued = this.queuedPrompt;
      this.queuedPrompt = null;
      if (queued !== null) {
        this.sendInput(queued);
        this.focusRequest++;
      }
    } catch (err) {
      this.status = "idle";
      this.queuedPrompt = null;
      toastStore.error("Agent failed to start", String(err));
    }
  }

  async stop(): Promise<void> {
    try {
      await invoke("stop_agent_session");
    } catch {
      // already gone
    }
  }

  sendInput(data: string): void {
    invoke("send_agent_input", { data }).catch(() => {});
  }

  /**
   * Called on every terminal resize; the PTY only hears about it when live,
   * and only once the size has settled.
   *
   * A panel drag (or the window settling at startup) fires a burst of resizes.
   * Forwarding each one makes the TUI repaint mid-paint at a dozen different
   * widths, which is exactly the scrambled output. Debounced, the agent gets
   * one SIGWINCH at the final size and repaints cleanly.
   */
  resize(cols: number, rows: number): void {
    this.terminalSize = { cols, rows };
    if (this.status !== "running") return;
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      const size = this.terminalSize;
      if (!size || this.status !== "running") return;
      invoke("resize_agent_terminal", size).catch(() => {});
    }, RESIZE_SETTLE_MS);
  }

  /**
   * Quick Action entry point: with a live session the prompt lands in the
   * terminal input UNSUBMITTED (the user presses Enter); otherwise it starts
   * a new session with the prompt.
   */
  async quickAction(prompt: string): Promise<void> {
    await this.openPanel();
    if (this.status === "running") {
      this.sendInput(prompt);
      this.focusRequest++;
      return;
    }
    if (this.status === "starting") {
      // Two Quick Actions in quick succession must not spawn two sessions:
      // the second prompt is typed into the first session once it is up.
      this.queuedPrompt = prompt;
      return;
    }
    await this.start(prompt);
    this.focusRequest++;
  }

  /**
   * A terminal re-mounted onto a LIVE session (the panel was hidden and shown
   * again). The replayed output buffer restores the scrollback, but a
   * full-screen TUI only repaints on SIGWINCH — and the PTY only sends one
   * when the size actually changes. Jiggle the width so the agent repaints
   * its frame at the real geometry.
   */
  repaint(cols: number, rows: number): void {
    this.terminalSize = { cols, rows };
    if (this.status !== "running") return;
    invoke("resize_agent_terminal", { cols: Math.max(1, cols - 1), rows })
      .then(() => invoke("resize_agent_terminal", { cols, rows }))
      .catch(() => {});
  }

  respondApproval(id: string, approved: boolean): void {
    this.approvals = this.approvals.filter((a) => a.id !== id);
    invoke("respond_agent_approval", { id, approved }).catch(() => {});
  }
}

export const agentStore = new AgentStore();
