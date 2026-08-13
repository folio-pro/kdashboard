<script lang="ts">
  import { Box, Trash2, TerminalSquare } from "lucide-svelte";
  import { Button } from "$lib/components/ui";
  import { SelectMenu } from "$lib/components/ui/select-menu";
  import { listen } from "$lib/ipc/event";
  import { invoke } from "$lib/ipc/core";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { onMount } from "svelte";
  import { WTerm } from "@wterm/dom";
  // Explicit .css subpath rather than the "@wterm/dom/css" alias: vite/client
  // only declares modules matching *.css, so the extensionless alias fails to
  // typecheck. Both are declared in the package's exports map.
  import "@wterm/dom/src/terminal.css";

  const SHELL_OPTIONS = ["/bin/sh", "/bin/bash", "/bin/zsh"];

  // wterm has no clear() method (unlike xterm). CUP home + ED 2 (erase screen)
  // + ED 3 (erase scrollback) is the equivalent; all three are supported by the
  // Zig core.
  const CLEAR_SEQUENCE = "\x1b[H\x1b[2J\x1b[3J";

  let terminalEl: HTMLDivElement | undefined = $state();
  let hostEl: HTMLDivElement | undefined = $state();
  let terminal: WTerm | null = null;
  let terminalReady = $state(false);
  let isConnected = $state(false);
  let selectedContainer = $state("");
  let selectedShell = $state("/bin/sh");
  let unlistenOutput: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let destroyed = false;
  let initPromise: Promise<void> | null = null;
  let initError = $state<string | null>(null);

  const containers = $derived.by(() => {
    const resource = k8sStore.selectedResource;
    if (resource && resource.kind.toLowerCase() === "pod") {
      const statuses = resource.status?.containerStatuses as Array<{ name: string }> | undefined;
      if (statuses) return statuses.map((c) => c.name);
    }
    return [] as string[];
  });

  $effect(() => {
    const names = containers;
    if (names.length > 0 && !selectedContainer) {
      selectedContainer = names[0];
    } else if (names.length === 0) {
      selectedContainer = "";
    }
  });

  /**
   * Snap the emulator to a whole number of rows.
   *
   * wterm's auto-scroll sets scrollTop to a row boundary (_scrollToBottom
   * floors to a multiple of the row height) while its "am I at the bottom?"
   * probe (_isScrolledToBottom) uses a 5px tolerance. If the emulator's content
   * box is not a multiple of the row height, the leftover fraction is never
   * scrolled away, the probe reads it as "the user scrolled up to read
   * history", and follow-the-output switches off permanently.
   *
   * Removing the fraction makes both agree, so wterm keeps following on its
   * own. Do NOT also write scrollTop from here — two writers per frame fight
   * each other and the scroll visibly jitters while typing.
   *
   * The row height is read from --term-row-height rather than duplicated as a
   * constant: the style block is the single source of truth, and a silent
   * mismatch here disables follow-the-output permanently.
   */
  function snapHostToRowGrid() {
    const outer = hostEl;
    const inner = terminalEl;
    if (!outer || !inner) return;

    const outerStyle = getComputedStyle(outer);
    const rowHeight = parseFloat(outerStyle.getPropertyValue("--term-row-height"));
    if (!rowHeight) return;

    // The scroll box is `inner` (WTerm puts .wterm on the element it is handed
    // and turns on overflow-y once there is scrollback), so its vertical
    // breathing room lives on `inner` too and scrolls away with the content.
    // Put it on `outer` instead and it becomes a fixed frame that shears the
    // first and last row as they pass under it.
    //
    // clientHeight is the padding box. `outer`'s padding comes off to get the
    // space actually available; `inner`'s comes off before dividing into rows
    // and back on afterwards, because border-box counts it inside the height
    // being set — without that the last row is clipped by exactly the padding.
    const innerStyle = getComputedStyle(inner);
    const outerPadY = parseFloat(outerStyle.paddingTop) + parseFloat(outerStyle.paddingBottom);
    const innerPadY = parseFloat(innerStyle.paddingTop) + parseFloat(innerStyle.paddingBottom);

    const available = outer.clientHeight - outerPadY - innerPadY;
    const rows = Math.max(1, Math.floor(available / rowHeight));
    inner.style.height = `${rows * rowHeight + innerPadY}px`;
  }

  /**
   * Idempotent, and — critically — concurrent callers await the SAME in-flight
   * initialisation instead of being turned away. The $effect below and
   * connect() both race to build the terminal on mount; if the second caller
   * returned early it would find `terminal` still null and abort the whole
   * connection, leaving a rendered-but-never-connected panel.
   */
  function initTerminal(): Promise<void> {
    if (terminal) return Promise.resolve();
    const host = terminalEl;
    if (!host) return Promise.resolve();

    initPromise ??= (async () => {
      try {
        await createTerminal(host);
      } catch (err) {
        // Never fail silently: WTerm.init() is async and can reject (WASM
        // instantiation, zero-sized host element). Without this the panel sat
        // on the placeholder forever with no clue why, and the rejection
        // escaped connect() as an unhandled promise.
        initError = err instanceof Error ? err.message : String(err);
        console.error("[TerminalView] terminal init failed", err);
      }
    })();

    return initPromise;
  }

  async function createTerminal(host: HTMLDivElement): Promise<void> {
    const term = new WTerm(host, {
      // Built-in ResizeObserver: recomputes cols/rows from the element's
      // content box and fires onResize. Replaces the xterm FitAddon.
      autoResize: true,
      cursorBlink: true,
      // Send keyboard input to the backend via command (not event, to avoid duplication)
      onData: (data) => {
        if (isConnected) {
          invoke("send_terminal_input", { data }).catch(() => {});
        }
      },
      // Send resize via command
      onResize: (cols, rows) => {
        if (isConnected) {
          invoke("resize_terminal", { width: cols, height: rows }).catch(() => {});
        }
      },
    });

    // init() instantiates the WASM core (inlined as base64 — no network fetch).
    await term.init();
    if (destroyed) {
      term.destroy();
      return;
    }

    terminal = term;
    terminalReady = true;
    initError = null;
  }

  async function connect() {
    if (!k8sStore.selectedResource || !selectedContainer || destroyed) return;
    disconnect();

    // Normally the $effect below has already built the terminal; this covers
    // the case where connect() wins the race with the host node binding.
    if (!terminal) await initTerminal();

    // initTerminal() surfaces its own failure via initError — bail quietly.
    if (!terminal) return;

    terminal.write(CLEAR_SEQUENCE);
    isConnected = true;

    try {
      // Listen for output from backend
      const outputFn = await listen<string>("terminal-output", (event) => {
        terminal?.write(event.payload);
      });
      if (destroyed) { outputFn(); return; }
      unlistenOutput = outputFn;

      const exitFn = await listen("terminal-exit", () => {
        isConnected = false;
      });
      if (destroyed) { exitFn(); return; }
      unlistenExit = exitFn;

      await invoke("start_terminal_exec", {
        name: k8sStore.selectedResource.metadata.name,
        namespace: k8sStore.selectedResource.metadata.namespace ?? "",
        container: selectedContainer,
        command: [selectedShell],
      });

      // Send initial resize and focus after connection is established
      if (terminal) {
        invoke("resize_terminal", { width: terminal.cols, height: terminal.rows }).catch(() => {});
        terminal.focus();
      }
    } catch (err) {
      terminal?.write(`\r\n\x1b[31mError: ${err}\x1b[0m\r\n`);
      isConnected = false;
    }
  }

  function disconnect() {
    if (unlistenOutput) {
      unlistenOutput();
      unlistenOutput = null;
    }
    if (unlistenExit) {
      unlistenExit();
      unlistenExit = null;
    }
    isConnected = false;
    invoke("stop_terminal_exec").catch(() => {});
  }

  function clearTerminal() {
    terminal?.write(CLEAR_SEQUENCE);
  }

  function handleContainerSelect(container: string) {
    selectedContainer = container;
    if (isConnected) connect();
  }

  function handleShellSelect(shell: string) {
    selectedShell = shell;
    if (isConnected) connect();
  }

  let autoStarted = false;

  onMount(() => {
    return () => {
      destroyed = true;
      disconnect();
      // destroy() disconnects the internal ResizeObserver and the input handler.
      terminal?.destroy();
      terminal = null;
      terminalReady = false;
    };
  });

  // Build the terminal as soon as its host node is bound. Doing this here
  // rather than guessing with requestAnimationFrame inside connect() removes
  // the timing dependency that could abort the whole connection silently.
  $effect(() => {
    if (terminalEl && !terminal) void initTerminal();
  });

  // Keep the host aligned to the row grid across panel resizes.
  $effect(() => {
    const outer = hostEl;
    if (!outer || !terminalEl) return;
    snapHostToRowGrid();
    const observer = new ResizeObserver(snapHostToRowGrid);
    observer.observe(outer);
    return () => observer.disconnect();
  });

  // Gated on terminalReady as well as the container: autoStarted latches on
  // the first run, so firing before the emulator exists would abort connect()
  // permanently. If init failed, terminalReady stays false and the error
  // message is shown instead of a silently dead panel.
  $effect(() => {
    if (selectedContainer && terminalReady && !autoStarted) {
      autoStarted = true;
      connect();
    }
  });
</script>

<div data-testid="terminal-panel" class="flex h-full flex-col bg-[var(--bg-primary)]">
  <!-- Terminal: the tab bar already names the view and the pod, so this panel
       carries no title of its own. -->
  <div class="flex-1 overflow-hidden px-4 pt-3 pb-2">
    <div class="flex h-full flex-col">
      <!-- Terminal Container -->
      <div
        bind:this={hostEl}
        class="wterm-host relative flex-1 overflow-hidden rounded-sm border border-[var(--border-color)] bg-[var(--log-bg)] px-2"
      >
        {#if initError}
          <div
            class="absolute inset-0 z-10 flex items-center justify-center px-4 text-center font-mono text-[12px] text-[var(--status-failed)]"
          >
            Terminal failed to start: {initError}
          </div>
        {:else if !terminalReady}
          <div class="absolute inset-0 z-10 flex items-center justify-center text-[12px] text-[var(--text-muted)]">
            Select a container and press Connect to start
          </div>
        {/if}
        <!--
          No onclick focus handler here: WTerm attaches its own, which skips
          focusing when there is an active text selection so click-dragging to
          select does not steal focus mid-selection.
        -->
        <!-- Height is set imperatively by snapHostToRowGrid(), not by a class. -->
        <div
          bind:this={terminalEl}
          class="w-full"
          class:invisible={!terminalReady}
        ></div>
      </div>
    </div>
  </div>

  <!-- Controls: single bar at the bottom of the panel. -->
  <div class="flex h-11 shrink-0 items-center gap-2 border-t border-[var(--border-color)] px-4">
    {#if !isConnected}
      <Button variant="solid-tone" tone="success" size="sm" mono onclick={connect} disabled={!selectedContainer}>
        <TerminalSquare class="h-3 w-3" />
        <span>Connect</span>
      </Button>
    {:else}
      <Button variant="solid-tone" tone="error" size="sm" mono onclick={disconnect}>
        <TerminalSquare class="h-3 w-3" />
        <span>Disconnect</span>
      </Button>
    {/if}

    {#if containers.length > 0}
      <SelectMenu
        title="Container"
        value={selectedContainer}
        items={containers.map((c) => ({ value: c, label: c, onSelect: () => handleContainerSelect(c) }))}
        contentClass="min-w-[160px]"
      >
        {#snippet icon()}<Box class="h-3 w-3 text-[var(--text-muted)]" />{/snippet}
      </SelectMenu>
    {/if}

    <SelectMenu
      title="Shell"
      value={selectedShell}
      items={SHELL_OPTIONS.map((sh) => ({ value: sh, label: sh, onSelect: () => handleShellSelect(sh) }))}
    >
      {#snippet icon()}<TerminalSquare class="h-3 w-3 text-[var(--text-muted)]" />{/snippet}
    </SelectMenu>

    <Button
      variant="toolbar"
      size="icon-sm"
      title="Clear terminal"
      aria-label="Clear terminal"
      onclick={clearTerminal}
    >
      <Trash2 class="h-3 w-3" />
    </Button>

    {#if isConnected}
      <div class="ml-auto flex shrink-0 items-center gap-1.5">
        <div class="h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--status-running)]"></div>
        <span class="font-mono text-[11px] font-semibold text-[var(--status-running)]">CONNECTED</span>
      </div>
    {/if}
  </div>
</div>

<style>
  /*
    wterm is themed entirely through CSS custom properties (it renders to the
    DOM, so there is no JS theme object). This maps the app palette onto the
    --term-* contract, replacing the old getTerminalTheme() helper. Fallbacks
    mirror the ones that helper used.

    :global() is required because WTerm adds the .wterm class at runtime, so
    Svelte cannot see it at compile time and would prune the rules as unused.
  */
  /* The tokens are declared on BOTH the host and .wterm, and both are load
     bearing.

     On the host, because snapHostToRowGrid() reads --term-row-height from a
     node that exists before WTerm mounts.

     On .wterm, because inheritance does not reach it: the package's own
     stylesheet declares the full --term-* set on `.wterm` itself, and a value
     declared on an element beats one inherited from its parent. Setting them
     only on the host — which is what this component used to do — left the
     terminal painting VS Code's #1e1e1e over a --log-bg host, which is the
     two-tone seam at the padding edge, and rendering the whole 16-colour
     palette from the package defaults instead of the active theme. Neither
     symptom was obvious because 12px x 1.4 and the package's 14px x 1.2 both
     round to the same 17px row, so the grid still lined up.

     `.wterm-host :global(.wterm)` (0,2,0) outranks the package's `.wterm`
     (0,1,0). */
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
    /*
      Must stay in sync with font-size x line-height (12 x 1.4 = 16.8). Rounded
      to an integer because the auto-resize observer derives the row count with
      Math.floor(height / rowHeight); a fractional value drifts as the panel
      grows and misaligns the cursor.
    */
    --term-row-height: 17px;

  }

  /* The host supplies the border, radius and horizontal padding; neutralise
     wterm's own chrome. The vertical padding stays HERE rather than on the
     host because this element is the scroll box — padding on a scroll box is
     part of the scrolled content, so the top gap scrolls away with the first
     row and the last row clears the bottom edge instead of being sheared off
     by a frame that does not move. snapHostToRowGrid() adds it back on top of
     the whole-row height for the same reason.

     Height is NOT set here — snapHostToRowGrid() pins it to a whole number of
     rows so follow-the-output stays armed. */
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
