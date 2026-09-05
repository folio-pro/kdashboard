<script lang="ts">
  import { Bot, Square, Play, X, ExternalLink, ShieldAlert, History, Sparkles } from "lucide-svelte";
  import { onMount } from "svelte";
  import { WTerm } from "@wterm/dom";
  // Explicit .css subpath — see TerminalView.svelte for why not the alias.
  import "@wterm/dom/src/terminal.css";
  import { Badge, Button } from "$lib/components/ui";
  import { SelectMenu } from "$lib/components/ui/select-menu";
  import { agentStore } from "$lib/stores/agent.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { open as shellOpen } from "$lib/ipc/shell";
  import { PRESETS, buildPresetPrompt } from "./prompts";

  const CLEAR_SEQUENCE = "\x1b[H\x1b[2J\x1b[3J";
  const MIN_HEIGHT = 160;
  const MAX_HEIGHT_RATIO = 0.8;

  let hostEl: HTMLDivElement | undefined = $state();
  let terminalEl: HTMLDivElement | undefined = $state();
  let terminal: WTerm | null = null;
  let terminalReady = $state(false);
  let initError = $state<string | null>(null);
  let destroyed = false;
  let initPromise: Promise<void> | null = null;
  let unsubOutput: (() => void) | null = null;
  let unsubClear: (() => void) | null = null;

  const selectedProfile = $derived(
    agentStore.profiles.find((p) => p.id === agentStore.selectedProfileId),
  );
  const running = $derived(agentStore.status === "running" || agentStore.status === "starting");

  /**
   * Pin the terminal to a whole number of rows (same trick as TerminalView).
   *
   * WTerm derives its row count with Math.floor(height / rowHeight): a leftover
   * fraction of a row means the TUI paints one line more than fits, a vertical
   * scrollbar appears, the width drops by a column, WTerm re-wraps the frame —
   * and the whole thing lands on top of itself.
   */
  function snapHostToRowGrid(): void {
    const outer = hostEl;
    const inner = terminalEl;
    if (!outer || !inner) return;

    const outerStyle = getComputedStyle(outer);
    const rowHeight = parseFloat(outerStyle.getPropertyValue("--term-row-height"));
    if (!rowHeight) return;

    const innerStyle = getComputedStyle(inner);
    const outerPadY = parseFloat(outerStyle.paddingTop) + parseFloat(outerStyle.paddingBottom);
    const innerPadY = parseFloat(innerStyle.paddingTop) + parseFloat(innerStyle.paddingBottom);

    const available = outer.clientHeight - outerPadY - innerPadY;
    const rows = Math.max(1, Math.floor(available / rowHeight));
    inner.style.height = `${rows * rowHeight + innerPadY}px`;
  }

  function initTerminal(): Promise<void> {
    if (terminal) return Promise.resolve();
    const host = terminalEl;
    if (!host) return Promise.resolve();

    initPromise ??= (async () => {
      try {
        // WTerm measures its host asynchronously (ResizeObserver): right
        // after init() it still reports the default 80 columns. Replaying a
        // session's output at that width hard-wraps every line, and WTerm
        // does not reflow — so the replay waits for the first measurement.
        let measured!: () => void;
        const firstMeasure = new Promise<void>((resolve) => (measured = resolve));
        const term = new WTerm(host, {
          autoResize: true,
          cursorBlink: true,
          onData: (data) => {
            if (agentStore.status === "running") agentStore.sendInput(data);
          },
          // Unconditional: the store keeps the size so the next session can
          // spawn its PTY at the right geometry, and only forwards it to a
          // live PTY.
          onResize: (cols, rows) => {
            agentStore.resize(cols, rows);
            measured();
          },
        });
        await term.init();
        if (destroyed) {
          term.destroy();
          return;
        }
        await Promise.race([firstMeasure, new Promise((r) => setTimeout(r, 250))]);
        if (destroyed) {
          term.destroy();
          return;
        }
        terminal = term;
        terminalReady = true;
        initError = null;
        // Replay everything the session already printed, then follow live.
        unsubOutput = agentStore.onOutput((chunk) => terminal?.write(chunk));
        unsubClear = agentStore.onClear(() => terminal?.write(CLEAR_SEQUENCE));
        // Publishes the real geometry: a pending start() is waiting for it.
        agentStore.attachTerminal(term.cols, term.rows);
        if (agentStore.status === "running") {
          agentStore.repaint(term.cols, term.rows);
          term.focus();
        }
      } catch (err) {
        initError = err instanceof Error ? err.message : String(err);
        console.error("[AgentPanel] terminal init failed", err);
      }
    })();

    return initPromise;
  }

  async function handleStart(resume = false): Promise<void> {
    // The store clears the screen and spawns at this terminal's size.
    await agentStore.start(undefined, { resume });
    if (terminal && agentStore.status === "running") terminal.focus();
  }

  // Presets: cluster-wide questions. Scoped to the namespace the UI shows
  // ("" / "all" = whole cluster), so "namespace health" only appears then.
  const scopedNamespace = $derived(
    k8sStore.currentNamespace && k8sStore.currentNamespace !== "all" ? k8sStore.currentNamespace : undefined,
  );
  const presetItems = $derived(
    PRESETS.filter((p) => !p.needsNamespace || scopedNamespace !== undefined).map((p) => ({
      value: p.id,
      label: p.label,
      onSelect: () =>
        void agentStore.quickAction(
          buildPresetPrompt(p.id, { context: k8sStore.currentContext, namespace: scopedNamespace }),
        ),
    })),
  );

  // --- Panel resize (drag the top edge) -------------------------------------

  function startResize(event: PointerEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = agentStore.panelHeight;
    const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO;

    const onMove = (e: PointerEvent): void => {
      const next = startHeight + (startY - e.clientY);
      agentStore.panelHeight = Math.min(maxHeight, Math.max(MIN_HEIGHT, next));
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  onMount(() => {
    return () => {
      destroyed = true;
      unsubOutput?.();
      unsubOutput = null;
      unsubClear?.();
      unsubClear = null;
      agentStore.detachTerminal();
      terminal?.destroy();
      terminal = null;
      terminalReady = false;
    };
  });

  $effect(() => {
    if (terminalEl && !terminal) void initTerminal();
  });

  // Keep the terminal on the row grid across panel drags and window resizes.
  $effect(() => {
    const outer = hostEl;
    if (!outer || !terminalEl) return;
    snapHostToRowGrid();
    const observer = new ResizeObserver(snapHostToRowGrid);
    observer.observe(outer);
    return () => observer.disconnect();
  });

  // Quick Actions bump focusRequest so the terminal grabs the keyboard (the
  // user's next keystroke is usually Enter to submit the injected prompt).
  $effect(() => {
    void agentStore.focusRequest;
    terminal?.focus();
  });
</script>

<!-- Bottom panel: sits between the content area and the status bar.
     min-h-0: as a flex item the default min-height:auto would let the pinned
     terminal height push the panel past its own height, which feeds straight
     back into the row-grid snap and grows without bound. -->
<div
  data-testid="agent-panel"
  class="relative flex min-h-0 shrink-0 flex-col overflow-hidden border-t border-[var(--border-color)] bg-[var(--bg-primary)]"
  style="height: {agentStore.panelHeight}px"
>
  <!-- Drag handle -->
  <div
    class="absolute inset-x-0 top-0 z-20 h-1 cursor-row-resize hover:bg-[var(--accent)]/40"
    onpointerdown={startResize}
  ></div>

  <!-- Header -->
  <div class="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-3">
    <Bot class="h-3.5 w-3.5 text-[var(--text-muted)]" />
    <span class="text-[12px] font-medium text-[var(--text-primary)]">AI Agent</span>

    {#if agentStore.profiles.length > 0}
      <SelectMenu
        title="Agent"
        value={agentStore.selectedProfileId}
        items={agentStore.profiles.map((p) => ({
          value: p.id,
          label: p.available ? p.displayName : `${p.displayName} (not installed)`,
          onSelect: () => {
            if (p.available) agentStore.selectedProfileId = p.id;
          },
        }))}
        contentClass="min-w-[170px]"
        disabled={running}
      />
    {/if}

    {#if selectedProfile?.available}
      <SelectMenu title="Prompts" label="Prompts" value="" items={presetItems} contentClass="min-w-[210px]">
        {#snippet icon()}<Sparkles class="h-3 w-3" />{/snippet}
      </SelectMenu>
    {/if}

    {#if agentStore.approvals.length > 0}
      <Badge tone="warning" size="sm" class="gap-1 font-mono">
        <ShieldAlert class="h-3 w-3" />
        APPROVAL PENDING
      </Badge>
    {/if}

    <div class="ml-auto flex items-center gap-2">
      {#if agentStore.status === "running"}
        <div class="flex items-center gap-1.5">
          <div class="h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--status-running)]"></div>
          <span class="font-mono text-[11px] font-semibold text-[var(--status-running)]">RUNNING</span>
        </div>
        <Button variant="solid-tone" tone="error" size="sm" mono onclick={() => agentStore.stop()}>
          <Square class="h-3 w-3" />
          <span>Stop</span>
        </Button>
      {:else if agentStore.status === "starting"}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">starting…</span>
      {:else}
        <Button
          variant="toolbar"
          size="sm"
          mono
          title="Continue the last conversation of this agent"
          onclick={() => handleStart(true)}
          disabled={!selectedProfile?.available}
        >
          <History class="h-3 w-3" />
          <span>Resume</span>
        </Button>
        <Button
          variant="solid-tone"
          tone="success"
          size="sm"
          mono
          onclick={() => handleStart()}
          disabled={!selectedProfile?.available}
        >
          <Play class="h-3 w-3" />
          <span>{agentStore.status === "ended" ? "Restart" : "Start"}</span>
        </Button>
      {/if}
      <Button
        variant="toolbar"
        size="icon-sm"
        title={running ? "Hide panel (session keeps running)" : "Hide panel"}
        aria-label="Hide agent panel"
        onclick={() => agentStore.closePanel()}
      >
        <X class="h-3 w-3" />
      </Button>
    </div>
  </div>

  <!-- Terminal -->
  <div class="min-h-0 flex-1 overflow-hidden px-3 py-2">
    <div
      bind:this={hostEl}
      class="wterm-host relative h-full overflow-hidden rounded-sm border border-[var(--border-color)] bg-[var(--log-bg)] px-2"
    >
      {#if initError}
        <div class="absolute inset-0 z-10 flex items-center justify-center px-4 text-center font-mono text-[12px] text-[var(--status-failed)]">
          Terminal failed to start: {initError}
        </div>
      {:else if agentStore.status === "idle"}
        <div class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-4 text-center">
          {#if selectedProfile && !selectedProfile.available}
            <p class="text-[12px] text-[var(--text-secondary)]">
              {selectedProfile.displayName} is not installed.
            </p>
            {#if selectedProfile.installUrl}
              <Button variant="outline" size="sm" onclick={() => shellOpen(selectedProfile.installUrl)}>
                <ExternalLink class="h-3 w-3" />
                <span>Install instructions</span>
              </Button>
            {/if}
          {:else if agentStore.profilesLoaded && !agentStore.profiles.some((p) => p.available)}
            <p class="text-[12px] text-[var(--text-secondary)]">
              No agent CLI found. Install Claude Code or Codex CLI to use the AI agent.
            </p>
          {:else}
            <p class="text-[12px] text-[var(--text-muted)]">
              Start a session, or use a Quick Action on any resource.
            </p>
          {/if}
          {#if selectedProfile?.warning}
            <p class="text-[11px] text-[var(--status-warning)]">{selectedProfile.warning}</p>
          {/if}
        </div>
      {:else if agentStore.status === "ended" && agentStore.endedReason}
        <div class="absolute inset-x-0 bottom-0 z-10 flex items-center justify-center bg-[var(--bg-secondary)]/90 py-1">
          <span class="font-mono text-[11px] text-[var(--text-muted)]">
            {agentStore.endedReason}{agentStore.exitCode !== null ? ` (exit ${agentStore.exitCode})` : ""}
          </span>
        </div>
      {/if}
      <!-- Height comes from snapHostToRowGrid(), never from the layout. -->
      <div bind:this={terminalEl} class="w-full" class:invisible={!terminalReady}></div>
    </div>
  </div>
</div>

<style>
  /* Same --term-* mapping as TerminalView.svelte (single design contract). */
  .wterm-host,
  .wterm-host :global(.wterm) {
    --term-bg: var(--log-bg, #111111);
    --term-fg: var(--text-secondary, #a0a0a0);
    --term-cursor: var(--accent, #ffffff);

    --term-color-0: var(--log-debug, #737373);
    --term-color-1: var(--log-error, #ef4444);
    --term-color-2: var(--status-running, #22c55e);
    --term-color-3: var(--log-warn, #eab308);
    --term-color-4: var(--log-info, #3b82f6);
    --term-color-5: var(--log-json, #a78bfa);
    --term-color-6: var(--accent, #06b6d4);
    --term-color-7: var(--text-primary, #e0e0e0);
    --term-color-8: var(--text-muted, #525252);
    --term-color-9: var(--log-error, #ef4444);
    --term-color-10: var(--status-running, #22c55e);
    --term-color-11: var(--log-warn, #eab308);
    --term-color-12: var(--log-info, #3b82f6);
    --term-color-13: var(--log-json, #a78bfa);
    --term-color-14: var(--accent, #06b6d4);
    --term-color-15: var(--text-primary, #ffffff);

    --term-font-family: "Geist Mono", ui-monospace, SFMono-Regular, monospace;
    --term-font-size: 12px;
    --term-line-height: 1.4;
    /* Integer, in sync with font-size x line-height (12 x 1.4 = 16.8) — the
       row count is a Math.floor of height / this. See TerminalView.svelte. */
    --term-row-height: 17px;
  }

  /* Height is NOT set here: snapHostToRowGrid() pins it to whole rows. */
  .wterm-host :global(.wterm) {
    width: 100%;
    padding: 8px 0;
    border-radius: 0;
    box-shadow: none;
  }

  .wterm-host :global(.wterm ::selection) {
    background: var(--log-row-selected, rgba(255, 255, 255, 0.06));
  }
</style>
