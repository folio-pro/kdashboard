<script lang="ts">
  import { cn } from "$lib/utils";
  import {
    Box,
    ChevronDown,
    Trash2,
    TerminalSquare,
  } from "lucide-svelte";
  import { listen } from "@tauri-apps/api/event";
  import { invoke } from "@tauri-apps/api/core";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import "@xterm/xterm/css/xterm.css";

  type DropdownId = "container" | "shell" | null;

  const SHELL_OPTIONS = ["/bin/sh", "/bin/bash", "/bin/zsh"];

  let terminalEl: HTMLDivElement | undefined = $state();
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let terminalReady = $state(false);
  let isConnected = $state(false);
  let selectedContainer = $state("");
  let selectedShell = $state("/bin/sh");
  let openDropdown = $state<DropdownId>(null);
  let unlistenOutput: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let resizeCleanup: (() => void) | null = null;
  let destroyed = false;

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

  const podName = $derived(k8sStore.selectedResource?.metadata?.name ?? "Pod");

  function getTerminalTheme(): Record<string, string> {
    const style = getComputedStyle(document.documentElement);
    const get = (v: string) => style.getPropertyValue(v).trim();
    return {
      background: get("--log-bg") || "#111111",
      foreground: get("--text-secondary") || "#a0a0a0",
      cursor: get("--accent") || "#ffffff",
      cursorAccent: get("--log-bg") || "#111111",
      selectionBackground: get("--log-row-selected") || "rgba(255,255,255,0.06)",
      black: get("--log-debug") || "#737373",
      red: get("--log-error") || "#EF4444",
      green: get("--status-running") || "#22C55E",
      yellow: get("--log-warn") || "#EAB308",
      blue: get("--log-info") || "#3B82F6",
      magenta: get("--log-json") || "#A78BFA",
      cyan: get("--accent") || "#06B6D4",
      white: get("--text-primary") || "#e0e0e0",
      brightBlack: get("--text-muted") || "#525252",
      brightRed: get("--log-error") || "#EF4444",
      brightGreen: get("--status-running") || "#22C55E",
      brightYellow: get("--log-warn") || "#EAB308",
      brightBlue: get("--log-info") || "#3B82F6",
      brightMagenta: get("--log-json") || "#A78BFA",
      brightCyan: get("--accent") || "#06B6D4",
      brightWhite: get("--text-primary") || "#ffffff",
    };
  }

  function initTerminal() {
    if (!terminalEl || terminal) return;

    fitAddon = new FitAddon();

    terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, monospace",
      fontSize: 12,
      lineHeight: 1.4,
      theme: getTerminalTheme(),
      allowProposedApi: true,
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(terminalEl);
    fitAddon.fit();
    terminalReady = true;

    // Send keyboard input to the backend via command (not event, to avoid duplication)
    terminal.onData((data) => {
      if (isConnected) {
        invoke("send_terminal_input", { data }).catch(() => {});
      }
    });

    // Send resize via command
    terminal.onResize(({ cols, rows }) => {
      if (isConnected) {
        invoke("resize_terminal", { width: cols, height: rows }).catch(() => {});
      }
    });

    // Handle window resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon?.fit();
    });
    resizeObserver.observe(terminalEl);

    resizeCleanup = () => resizeObserver.disconnect();
  }

  async function connect() {
    if (!k8sStore.selectedResource || !selectedContainer || destroyed) return;
    disconnect();

    // Init terminal if not yet created
    if (!terminal) {
      // Wait a tick for the DOM element to be available
      await new Promise((r) => requestAnimationFrame(r));
      if (destroyed) return;
      initTerminal();
    }

    if (!terminal) return;

    terminal.clear();
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
      terminal?.writeln(`\r\n\x1b[31mError: ${err}\x1b[0m`);
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
    terminal?.clear();
  }

  function handleContainerSelect(container: string) {
    selectedContainer = container;
    openDropdown = null;
    if (isConnected) connect();
  }

  function handleShellSelect(shell: string) {
    selectedShell = shell;
    openDropdown = null;
    if (isConnected) connect();
  }

  function toggleDropdown(id: DropdownId, e: MouseEvent) {
    e.stopPropagation();
    openDropdown = openDropdown === id ? null : id;
  }

  let autoStarted = false;

  onMount(() => {
    return () => {
      destroyed = true;
      disconnect();
      resizeCleanup?.();
      terminal?.dispose();
      terminal = null;
      terminalReady = false;
    };
  });

  $effect(() => {
    if (selectedContainer && !autoStarted) {
      autoStarted = true;
      connect();
    }
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex h-full flex-col bg-[var(--bg-primary)]" onclick={() => (openDropdown = null)}>
  <!-- Header -->
  <div
    class="flex h-[68px] shrink-0 items-center justify-between border-b border-[var(--border-color)] px-6"
  >
    <!-- Left: Title -->
    <div class="flex flex-col gap-0.5">
      <span class="font-mono text-base font-semibold text-[var(--text-primary)]">Terminal</span>
      <span class="font-mono text-[11px] text-[var(--text-muted)]">{podName}</span>
    </div>

    <!-- Right: Container, Shell, Connect -->
    <div class="flex items-center gap-2">
      <!-- Container Selector -->
      {#if containers.length > 0}
        <div class="relative">
          <button
            class="flex h-[34px] items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 font-mono text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            onclick={(e) => toggleDropdown("container", e)}
          >
            <Box class="h-3.5 w-3.5 text-[var(--text-muted)]" />
            <span>{selectedContainer}</span>
            <ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />
          </button>
          {#if openDropdown === "container"}
            <div
              class="absolute top-full right-0 z-50 mt-1 min-w-[160px] rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-lg"
            >
              {#each containers as container}
                <button
                  class={cn(
                    "block w-full px-3 py-1.5 text-left font-mono text-xs transition-colors hover:bg-[var(--table-row-hover)]",
                    container === selectedContainer
                      ? "text-[var(--accent)]"
                      : "text-[var(--text-secondary)]",
                  )}
                  onclick={(e) => {
                    e.stopPropagation();
                    handleContainerSelect(container);
                  }}
                >
                  {container}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Shell Selector -->
      <div class="relative">
        <button
          class="flex h-[34px] items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 font-mono text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          onclick={(e) => toggleDropdown("shell", e)}
        >
          <TerminalSquare class="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <span>{selectedShell}</span>
          <ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />
        </button>
        {#if openDropdown === "shell"}
          <div
            class="absolute top-full right-0 z-50 mt-1 min-w-[120px] rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-lg"
          >
            {#each SHELL_OPTIONS as shell}
              <button
                class={cn(
                  "block w-full px-3 py-1.5 text-left font-mono text-xs transition-colors hover:bg-[var(--table-row-hover)]",
                  shell === selectedShell
                    ? "text-[var(--accent)]"
                    : "text-[var(--text-secondary)]",
                )}
                onclick={(e) => {
                  e.stopPropagation();
                  handleShellSelect(shell);
                }}
              >
                {shell}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Connect/Disconnect Button -->
      {#if !isConnected}
        <button
          class="flex h-[34px] items-center gap-1.5 rounded bg-[var(--status-running)] px-3.5 font-mono text-xs font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
          onclick={connect}
          disabled={!selectedContainer}
        >
          <TerminalSquare class="h-3.5 w-3.5" />
          <span>Connect</span>
        </button>
      {:else}
        <button
          class="flex h-[34px] items-center gap-1.5 rounded bg-[var(--status-failed)] px-3.5 font-mono text-xs font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90"
          onclick={disconnect}
        >
          <TerminalSquare class="h-3.5 w-3.5" />
          <span>Disconnect</span>
        </button>
      {/if}
    </div>
  </div>

  <!-- Toolbar -->
  <div
    class="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-color)] px-6"
  >
    <div class="flex items-center gap-2">
      <span class="font-mono text-xs text-[var(--text-muted)]">shell:</span>
      <span class="font-mono text-xs text-[var(--text-secondary)]">{selectedShell}</span>
      <div class="mx-1 h-5 w-px bg-[var(--border-color)]"></div>
      <span class="font-mono text-xs text-[var(--text-muted)]">container:</span>
      <span class="font-mono text-xs text-[var(--text-secondary)]">{selectedContainer || "none"}</span>
    </div>

    <div class="flex items-center gap-1.5">
      <button
        class="flex h-7 items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 font-mono text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        onclick={clearTerminal}
      >
        <Trash2 class="h-3 w-3" />
        <span>Clear</span>
      </button>
    </div>
  </div>

  <!-- Terminal -->
  <div class="flex-1 overflow-hidden px-6 py-4">
    <div class="flex h-full flex-col">
      <!-- Prompt Bar -->
      <div
        class="flex h-9 shrink-0 items-center justify-between rounded-t border border-[var(--border-color)] bg-[var(--bg-tertiary,var(--bg-secondary))] px-4"
      >
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs font-semibold text-[var(--accent)]">&gt;_</span>
          <span class="font-mono text-xs text-[var(--text-secondary)]">{podName}</span>
        </div>
        {#if isConnected}
          <div class="flex items-center gap-1.5">
            <div class="h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--status-running)]"></div>
            <span class="font-mono text-[11px] font-semibold text-[var(--status-running)]">CONNECTED</span>
          </div>
        {/if}
      </div>

      <!-- Terminal Container -->
      <div
        class="relative flex-1 overflow-hidden rounded-b border-x border-b border-[var(--border-color)] bg-[var(--log-bg)] p-2"
      >
        {#if !terminalReady}
          <div class="absolute inset-0 z-10 flex items-center justify-center text-xs text-[var(--text-muted)]">
            Select a container and press Connect to start
          </div>
        {/if}
        <div
          bind:this={terminalEl}
          class="h-full w-full"
          class:invisible={!terminalReady}
          onclick={() => terminal?.focus()}
        ></div>
      </div>
    </div>
  </div>
</div>
