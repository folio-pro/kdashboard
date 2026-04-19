<script lang="ts">
  import { cn } from "$lib/utils";
  import { ArrowDown } from "lucide-svelte";
  import { listen } from "@tauri-apps/api/event";
  import { invoke } from "@tauri-apps/api/core";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import type { Resource } from "$lib/types";
  import { onMount, untrack } from "svelte";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import {
    type LogLine,
    type LogLevel,
    shortPodName,
    parseLogLine,
    resetLogIdCounter,
    nextLogId,
  } from "./log-viewer";
  import {
    SINCE_LABELS,
    SINCE_SECONDS,
    LEVEL_BADGE_COLORS,
    LEVEL_LABELS,
    MESSAGE_COLORS,
    type TailLines,
    type SinceDuration,
    type DropdownId,
  } from "./log-constants";
  import { getJsonHighlighted } from "./log-highlighting";
  import LogHeader from "./LogHeader.svelte";
  import LogFilterBar from "./LogFilterBar.svelte";
  import LogDetailSheet from "./LogDetailSheet.svelte";

  // --- Core state ---
  let logs = $state<LogLine[]>([]);
  let filterText = $state("");
  let showTimestamps = $state(true);
  let selectedContainer = $state("");
  let containerSourcePod = $state<Resource | null>(null);
  let deploymentPodNames = $state<string[]>([]);
  let podsLoading = $state(false);
  let isStreaming = $state(false);
  let logContainer: HTMLDivElement | undefined = $state();
  let unlisten: (() => void) | null = null;
  let destroyed = false;

  // --- Virtualizer ---
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => logContainer ?? null,
    estimateSize: () => 22,
    overscan: 30,
  });

  function measureElement(el: HTMLDivElement) {
    $virtualizer.measureElement(el);
  }

  // --- Batching ---
  let pendingLogs: LogLine[] = [];
  let flushScheduled = false;
  let userScrolledAway = $state(false);

  function enqueueLogLine(line: LogLine) {
    trackPodName(line.podName);
    pendingLogs.push(line);
    if (!flushScheduled) {
      flushScheduled = true;
      requestAnimationFrame(flushLogs);
    }
  }

  function isAtBottom(): boolean {
    if (!logContainer) return true;
    return logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 50;
  }

  function flushLogs() {
    const shouldScroll = !userScrolledAway;

    if (pendingLogs.length > 0) {
      logs.push(...pendingLogs);
      pendingLogs = [];
      if (logs.length > tailLines) {
        logs = logs.slice(-tailLines);
      }
    }
    flushScheduled = false;

    if (shouldScroll) {
      requestAnimationFrame(() => {
        $virtualizer.scrollToIndex(filteredLogs.length - 1, { align: "end" });
      });
    }
  }

  function handleScroll() {
    userScrolledAway = !isAtBottom();
  }

  function jumpToBottom() {
    userScrolledAway = false;
    $virtualizer.scrollToIndex(filteredLogs.length - 1, { align: "end" });
  }

  // --- Filter state ---
  let levelFilter = $state<LogLevel>("all");
  let podFilter = $state<string | null>(null);
  let tailLines = $state<TailLines>(100);
  let sinceDuration = $state<SinceDuration>("1d");
  let showPrevious = $state(false);
  let useRegex = $state(false);
  let openDropdown = $state<DropdownId>(null);
  let selectedLog = $state<LogLine | null>(null);

  // --- Pod name tracking ---
  let _seenPodNames = new Set<string>();
  let logPodNames = $state<string[]>([]);

  function trackPodName(name: string | undefined) {
    if (name && !_seenPodNames.has(name)) {
      _seenPodNames.add(name);
      logPodNames = [..._seenPodNames].sort();
    }
  }

  // --- Derived state ---
  let filteredLogs = $derived.by(() => {
    const hasPodFilter = podFilter !== null;
    const hasLevelFilter = levelFilter !== "all";
    const hasTextFilter = filterText.length > 0;

    if (!hasPodFilter && !hasLevelFilter && !hasTextFilter) return logs;

    let textMatcher: ((msg: string) => boolean) | null = null;
    if (hasTextFilter) {
      if (useRegex) {
        try {
          const regex = new RegExp(filterText, "i");
          textMatcher = (msg) => regex.test(msg);
        } catch {
          textMatcher = null;
        }
      } else {
        const lower = filterText.toLowerCase();
        textMatcher = (msg) => msg.toLowerCase().includes(lower);
      }
    }

    return logs.filter((l) =>
      (!hasPodFilter || l.podName === podFilter) &&
      (!hasLevelFilter || l.level === levelFilter) &&
      (!textMatcher || textMatcher(l.message))
    );
  });

  let lastLogTime = $derived.by(() => {
    if (logs.length === 0) return "";
    const last = logs[logs.length - 1];
    return last.timestamp ?? "";
  });

  $effect.pre(() => {
    const count = filteredLogs.length;
    untrack(() => {
      $virtualizer.setOptions({ count });
    });
  });

  let emptyStateMessage = $derived.by(() => {
    const hasLevelFilter = levelFilter !== "all";
    const hasSearchFilter = filterText.trim().length > 0;

    if (logs.length > 0 && filteredLogs.length === 0) {
      if (hasLevelFilter && hasSearchFilter) {
        return `No ${levelFilter.toUpperCase()} logs match the current search.`;
      }
      if (hasLevelFilter) {
        return `No logs found for level ${levelFilter.toUpperCase()}.`;
      }
      if (hasSearchFilter) {
        return "No logs match the current search.";
      }
    }

    if (isStreaming) return "Connecting to log stream...";
    if (isDeployment && podsLoading) return "Loading pods...";
    if (isDeployment && deploymentPodNames.length === 0) return "No pods found for this deployment";
    return "Select a container and press Stream to start";
  });

  const isDeployment = $derived(
    k8sStore.selectedResource?.kind?.toLowerCase() === "deployment"
  );

  const resourceName = $derived(k8sStore.selectedResource?.metadata?.name ?? "Pod");
  const sinceLabel = $derived(SINCE_LABELS.get(sinceDuration) ?? "1 day ago");

  // --- Deployment pod fetching ---
  let _fetchGeneration = 0;
  $effect(() => {
    const resource = k8sStore.selectedResource;
    if (!resource || resource.kind.toLowerCase() !== "deployment") {
      deploymentPodNames = [];
      containerSourcePod = null;
      return;
    }
    const selector = (resource.spec?.selector as { matchLabels?: Record<string, string> })?.matchLabels ?? {};
    const selectorString = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",");
    if (!selectorString) return;

    const gen = ++_fetchGeneration;
    containerSourcePod = null;
    podsLoading = true;
    invoke<{ items: Resource[] }>("list_pods_by_selector", {
      namespace: resource.metadata.namespace ?? "",
      selector: selectorString,
    }).then((result) => {
      if (gen !== _fetchGeneration) return;
      deploymentPodNames = result.items.map((p) => p.metadata.name);
      if (result.items.length > 0) {
        containerSourcePod = result.items[0];
      }
    }).catch(() => {
      if (gen !== _fetchGeneration) return;
      deploymentPodNames = [];
    }).finally(() => {
      if (gen === _fetchGeneration) podsLoading = false;
    });
  });

  const containers = $derived.by(() => {
    const resource = k8sStore.selectedResource;
    if (!resource) return [] as string[];
    const pod = resource.kind.toLowerCase() === "pod" ? resource : containerSourcePod;
    if (pod) {
      const statuses = pod.status?.containerStatuses as Array<{ name: string }> | undefined;
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

  // --- Streaming lifecycle ---
  let autoStarted = false;

  onMount(() => {
    return () => {
      destroyed = true;
      stopStreaming();
    };
  });

  $effect(() => {
    if (selectedContainer && !autoStarted) {
      autoStarted = true;
      startStreaming();
    }
  });

  async function startStreaming() {
    if (!selectedContainer) return;
    if (isStreaming) stopStreaming();
    isStreaming = true;
    logs = [];
    resetLogIdCounter();
    pendingLogs = [];
    flushScheduled = false;
    userScrolledAway = false;
    _seenPodNames = new Set();
    logPodNames = [];

    const streamOpts = {
      container: selectedContainer,
      tailLines,
      sinceSeconds: SINCE_SECONDS.get(sinceDuration) ?? null,
      timestamps: showTimestamps,
      previous: showPrevious || null,
    };

    try {
      const unlistenFn = await listen<string[]>("log-lines", (event) => {
        for (const line of event.payload) {
          enqueueLogLine(parseLogLine(line));
        }
      });

      if (destroyed) {
        unlistenFn();
        return;
      }
      unlisten = unlistenFn;

      if (isDeployment && deploymentPodNames.length > 0) {
        await invoke("stream_multi_pod_logs", {
          pods: deploymentPodNames,
          namespace: k8sStore.selectedResource?.metadata?.namespace ?? "",
          ...streamOpts,
        });
      } else {
        const resource = k8sStore.selectedResource;
        if (!resource || resource.kind.toLowerCase() !== "pod") return;
        await invoke("stream_pod_logs", {
          name: resource.metadata.name,
          namespace: resource.metadata.namespace ?? "",
          ...streamOpts,
        });
      }
    } catch (err) {
      logs = [{ id: nextLogId(), message: `Error starting log stream: ${err}`, level: "error" as const, isJson: false }];
      isStreaming = false;
    }
  }

  function stopStreaming() {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    isStreaming = false;
    invoke("stop_log_stream").catch(() => {});
  }

  function clearLogs() {
    logs = [];
    _seenPodNames = new Set();
    logPodNames = [];
    userScrolledAway = false;
  }

  // --- Callback handlers for sub-components ---
  function handleContainerSelect(container: string) {
    selectedContainer = container;
    openDropdown = null;
    if (isStreaming) startStreaming();
  }

  function handleSinceSelect(value: SinceDuration) {
    sinceDuration = value;
    openDropdown = null;
    if (isStreaming) startStreaming();
  }

  function handleTailSelect(value: TailLines) {
    tailLines = value;
    openDropdown = null;
    if (isStreaming) startStreaming();
  }

  function togglePrevious() {
    showPrevious = !showPrevious;
    if (isStreaming) startStreaming();
  }

  function toggleDropdown(id: DropdownId, e: MouseEvent) {
    e.stopPropagation();
    openDropdown = openDropdown === id ? null : id;
  }

  // --- Log detail / navigation ---
  function selectLog(log: LogLine) {
    selectedLog = log;
  }

  function closeDetail() {
    selectedLog = null;
  }

  function selectedLogIndex(): number {
    if (!selectedLog) return -1;
    return filteredLogs.indexOf(selectedLog);
  }

  function navigateLog(direction: -1 | 1) {
    if (filteredLogs.length === 0) return;
    const current = selectedLogIndex();
    const next = Math.max(0, Math.min(filteredLogs.length - 1, current + direction));
    selectedLog = filteredLogs[next];
    scrollToIndex(next);
  }

  function scrollToIndex(index: number) {
    if (index < 0 || index >= filteredLogs.length) return;
    $virtualizer.scrollToIndex(index, { align: "auto" });
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (!selectedLog) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateLog(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateLog(-1);
    }
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex h-full flex-col bg-[var(--bg-primary)]" onclick={() => (openDropdown = null)}>
  <!-- Header -->
  <LogHeader
    {resourceName}
    {selectedContainer}
    {containers}
    bind:filterText
    {isStreaming}
    {isDeployment}
    {deploymentPodNames}
    {podsLoading}
    bind:openDropdown
    onStartStreaming={startStreaming}
    onStopStreaming={stopStreaming}
    onContainerSelect={handleContainerSelect}
    onToggleDropdown={toggleDropdown}
  />

  <!-- Filter Bar -->
  <LogFilterBar
    bind:levelFilter
    bind:podFilter
    {sinceDuration}
    {sinceLabel}
    {tailLines}
    bind:showTimestamps
    {showPrevious}
    bind:useRegex
    bind:openDropdown
    {isDeployment}
    {logPodNames}
    onSinceSelect={handleSinceSelect}
    onTailSelect={handleTailSelect}
    onTogglePrevious={togglePrevious}
    onToggleDropdown={toggleDropdown}
    onClear={clearLogs}
  />

  <!-- Log Viewer -->
  <div class="flex-1 overflow-hidden px-6 py-4">
    <div class="relative flex h-full flex-col">
      <!-- Prompt Bar -->
      <div
        class="flex h-9 shrink-0 items-center justify-between rounded-t border border-[var(--border-color)] bg-[var(--bg-tertiary,var(--bg-secondary))] px-4"
      >
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs font-semibold text-[var(--accent)]">&gt;_</span>
          <span class="font-mono text-xs text-[var(--text-secondary)]">{resourceName}</span>
        </div>
        <div class="flex items-center gap-3">
          {#if lastLogTime}
            <span class="font-mono text-[11px] text-[var(--text-muted)]">last: {lastLogTime}</span>
          {/if}
          {#if isStreaming}
            <div class="flex items-center gap-1.5">
              <div class="h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--status-running)]"></div>
              <span class="font-mono text-[11px] font-semibold text-[var(--status-running)]">LIVE</span>
            </div>
          {/if}
        </div>
      </div>

      <!-- Log Entries (virtualized) -->
      <div
        class="relative min-h-0 flex-1 overflow-y-auto rounded-b border-x border-b border-[var(--border-color)] bg-[var(--log-bg)] font-mono"
        bind:this={logContainer}
        onscroll={handleScroll}
      >
        {#if filteredLogs.length === 0}
          <div class="flex h-full items-center justify-center text-xs text-[var(--text-muted)]">
            {emptyStateMessage}
          </div>
        {:else}
          <div style="height: {$virtualizer.getTotalSize()}px; position: relative; width: 100%;">
            {#each $virtualizer.getVirtualItems() as row (row.index)}
              {@const line = filteredLogs[row.index]}
              {#if line}
                <div
                  data-index={row.index}
                  use:measureElement
                  style="position: absolute; top: 0; left: 0; width: 100%; transform: translateY({row.start}px);"
                  class={cn(
                    "flex cursor-pointer items-start gap-3 px-3 py-[3px]",
                    selectedLog === line
                      ? "bg-[var(--log-row-selected)]"
                      : "hover:bg-[var(--log-row-hover)]",
                  )}
                  onclick={() => selectLog(line)}
                >
                  {#if line.podName}
                    <span class="shrink-0 max-w-[140px] truncate rounded bg-[var(--accent)]/10 px-1.5 py-0 text-[10px] font-medium leading-[20px] text-[var(--accent)]" title={line.podName}>
                      {shortPodName(line.podName)}
                    </span>
                  {/if}
                  {#if showTimestamps && line.timestamp}
                    <span class="shrink-0 text-[11px] leading-[20px] text-[var(--log-timestamp)]">{line.timestamp}</span>
                  {/if}
                  <span
                    class={cn("shrink-0 text-[11px] leading-[20px] font-semibold", LEVEL_BADGE_COLORS[line.level])}
                  >
                    {LEVEL_LABELS[line.level]}
                  </span>
                  {#if line.isJson && line.jsonFormatted}
                    <pre class="min-w-0 whitespace-pre-wrap break-all text-[11px] leading-[20px] text-[var(--text-secondary)]">{@html getJsonHighlighted(line)}</pre>
                  {:else}
                    <span class={cn("min-w-0 break-all text-[11px] leading-[20px]", MESSAGE_COLORS[line.level])}>
                      {line.message}
                    </span>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      <!-- Jump to Bottom -->
      {#if userScrolledAway && filteredLogs.length > 0}
        <button
          class="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1.5 font-mono text-[11px] text-[var(--text-secondary)] shadow-lg transition-colors hover:bg-[var(--bg-tertiary,var(--bg-secondary))] hover:text-[var(--text-primary)]"
          onclick={jumpToBottom}
        >
          <ArrowDown class="h-3 w-3" />
          Jump to bottom
        </button>
      {/if}
    </div>
  </div>

  <!-- Log Detail Sheet -->
  <LogDetailSheet {selectedLog} onClose={closeDetail} />
</div>
