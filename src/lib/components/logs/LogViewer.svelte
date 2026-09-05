<script lang="ts">
  import { cn } from "$lib/utils";
  import { ArrowDown } from "lucide-svelte";
  import { Button } from "$lib/components/ui";
  import { invoke } from "$lib/ipc/core";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { scheduleFlush } from "$lib/utils/frame-scheduler";
  import type { Resource } from "$lib/types";
  import { onMount, untrack } from "svelte";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import {
    type LogLine,
    type LogLevel,
    shortPodName,
    parseLogLine,
    resetLogIdCounter,
    buildStreamRequest,
    streamEmptyStateMessage,
    filterLogs,
    formatLogsForExport,
    exportFileName,
    readWrapPreference,
    writeWrapPreference,
    ALL_CONTAINERS,
  } from "./log-viewer";
  import { createLogStream } from "./log-stream.svelte";
  import {
    SINCE_LABELS,
    SINCE_WINDOW_LABELS,
    SINCE_SECONDS,
    LEVEL_BADGE_COLORS,
    LEVEL_LABELS,
    messageColor,
    type TailLines,
    type SinceDuration,
  } from "./log-constants";
  import { getJsonHighlighted } from "./log-highlighting";
  import LogControlBar from "./LogControlBar.svelte";
  import { agentStore } from "$lib/stores/agent.svelte";
  import { buildLogsPrompt } from "$lib/components/agent/prompts";
  import LogDetailSheet from "./LogDetailSheet.svelte";

  // --- Core state ---
  // $state.raw: at streaming rates a deep proxy would wrap every LogLine (and
  // the template's _jsonHighlightedCache writes through the proxy would
  // invalidate the very render effect that reads them, double-rendering JSON
  // rows). The array is only ever replaced wholesale, never mutated in place.
  let logs = $state.raw<LogLine[]>([]);
  let filterText = $state("");
  let showTimestamps = $state(true);
  /** A container name, or ALL_CONTAINERS. */
  let selectedContainer = $state("");

  // Line wrap is a per-machine display preference, so it lives in
  // localStorage like the sidebar state rather than in cluster settings.
  const wrapStorage = typeof localStorage === "undefined" ? undefined : localStorage;
  let wrapLines = $state(readWrapPreference(wrapStorage));
  $effect(() => writeWrapPreference(wrapStorage, wrapLines));
  let containerSourcePod = $state<Resource | null>(null);
  let deploymentPodNames = $state<string[]>([]);
  let podsLoading = $state(false);
  let logContainer: HTMLDivElement | undefined = $state();

  // The whole connect/live/ended/error state machine lives in log-stream.logic.ts.
  const stream = createLogStream({
    onLines: (payload) => {
      for (const line of payload) enqueueLogLine(parseLogLine(line));
    },
    onReset: () => clearLogs(),
  });

  // "Is there a stream at all" — what the control bar's Stream/Stop toggle
  // needs. The finer phase distinction only matters for the badge and the empty
  // state.
  const isStreaming = $derived(stream.isActive);

  // --- Virtualizer ---
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => logContainer ?? null,
    estimateSize: () => 26,
    overscan: 30,
    // Inset the first and last rows from the frame. Rows used to start at the
    // very top edge of the scroll box, so the first line sat flush under the
    // border — and under the panel header it visually merges with — and read
    // as clipped; the last line likewise touched the bottom edge.
    paddingStart: 4,
    paddingEnd: 4,
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

    // Cap the pending buffer the same way flushLogs caps `logs`: only the last
    // `tailLines` can ever be displayed, so anything older is already garbage.
    // This matters while the window is backgrounded — the flush is throttled but
    // the backend keeps streaming (electron/handlers/logs.ts emits every 50ms),
    // so an uncapped buffer would grow for as long as the window stays hidden.
    // Trim at 2x so the splice is amortised O(1) instead of running per line.
    if (pendingLogs.length > tailLines * 2) {
      pendingLogs.splice(0, pendingLogs.length - tailLines);
    }

    if (!flushScheduled) {
      flushScheduled = true;
      // NOT a bare requestAnimationFrame: rAF is paused while the window is
      // minimized or occluded, which would strand the buffer until refocus.
      scheduleFlush(flushLogs);
    }
  }

  function isAtBottom(): boolean {
    if (!logContainer) return true;
    return logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 50;
  }

  function flushLogs() {
    const shouldScroll = !userScrolledAway;

    if (pendingLogs.length > 0) {
      // Reassign (never push): `logs` is $state.raw, in-place mutation would
      // not be tracked.
      const merged = logs.length > 0 ? logs.concat(pendingLogs) : pendingLogs;
      logs = merged.length > tailLines ? merged.slice(-tailLines) : merged;
      pendingLogs = [];
    }
    flushScheduled = false;

    if (shouldScroll) {
      // Same reason as above: a hidden window gets no frames, and the tail must
      // still be pinned to the bottom by the time it is shown again.
      scheduleFlush(() => {
        $virtualizer.scrollToIndex(filteredLogs.length - 1, { align: "end" });
      });
    }
  }

  // Coalesce to one layout read per frame: isAtBottom() reads
  // scrollHeight/scrollTop synchronously, and scroll events fire far more
  // often than frames during a fast wheel/drag.
  let scrollCheckScheduled = false;
  function handleScroll() {
    if (scrollCheckScheduled) return;
    scrollCheckScheduled = true;
    requestAnimationFrame(() => {
      scrollCheckScheduled = false;
      userScrolledAway = !isAtBottom();
    });
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

  /** Hand the current view (resource, container, filter) to the AI agent. */
  function askAgent(): void {
    const resource = k8sStore.selectedResource;
    if (!resource) return;
    void agentStore.quickAction(
      buildLogsPrompt(
        { context: k8sStore.currentContext },
        {
          namespace: resource.metadata.namespace ?? k8sStore.currentNamespace,
          kind: resource.kind,
          name: resource.metadata.name,
          container: selectedContainer && selectedContainer !== ALL_CONTAINERS ? selectedContainer : undefined,
          filterText,
          useRegex,
          level: levelFilter,
          previous: showPrevious,
        },
      ),
    );
  }
  let useRegex = $state(false);
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
  // filterLogs returns `logs` itself when no filter is active, so the common
  // case allocates nothing. Level semantics (what `info` does with unlevelled
  // lines) are defined once, in levelMatches().
  let filteredLogs = $derived(
    filterLogs(logs, { podFilter, levelFilter, filterText, useRegex }),
  );

  $effect.pre(() => {
    const count = filteredLogs.length;
    untrack(() => {
      $virtualizer.setOptions({ count });
    });
  });

  const isDeployment = $derived(
    k8sStore.selectedResource?.kind?.toLowerCase() === "deployment"
  );

  const sinceLabel = $derived(SINCE_LABELS.get(sinceDuration) ?? "1 day ago");
  const sinceWindowLabel = $derived(SINCE_WINDOW_LABELS.get(sinceDuration) ?? "1 day");

  let emptyStateMessage = $derived(
    streamEmptyStateMessage({
      phase: stream.phase,
      hasLogs: logs.length > 0,
      levelFilter,
      filterText,
      isDeployment,
      podsLoading,
      deploymentPodCount: deploymentPodNames.length,
      sinceWindowLabel,
      errorMessage: stream.error ?? undefined,
    }),
  );

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

  // Keep the selection valid for the CURRENT pod: switching to a pod whose
  // containers differ used to keep the old name and stream a container the new
  // pod does not have. "All containers" only stands while there are several.
  $effect(() => {
    const names = containers;
    if (names.length === 0) {
      selectedContainer = "";
      return;
    }
    const valid =
      selectedContainer === ALL_CONTAINERS ? names.length > 1 : names.includes(selectedContainer);
    if (!valid) selectedContainer = names[0];
  });

  // --- Streaming lifecycle ---

  /** uid of the resource the current stream belongs to. */
  let _streamedUid: string | null = null;
  let autoStarted = false;

  onMount(() => {
    return () => stream.destroy();
  });

  /**
   * The viewer is mounted per-VIEW, not per-resource (App.svelte renders it when
   * activeView === "logs"), so switching pods has to be handled here: tear the
   * old stream down, drop its lines, and auto-start the new one as soon as a
   * container is known. Without this the viewer kept streaming the previous pod.
   */
  $effect(() => {
    const uid = k8sStore.selectedResource?.metadata?.uid ?? null;
    const container = selectedContainer;

    untrack(() => {
      if (uid !== _streamedUid) {
        _streamedUid = uid;
        autoStarted = false;
        if (stream.phase !== "idle") stopStreaming();
        clearLogs();
      }
      if (container && !autoStarted) {
        autoStarted = true;
        startStreaming();
      }
    });
  });

  function startStreaming() {
    if (!selectedContainer) return;
    void stream.start(
      buildStreamRequest({
        resource: k8sStore.selectedResource,
        isDeployment,
        deploymentPodNames,
        container: selectedContainer,
        containers,
        tailLines,
        sinceSeconds: SINCE_SECONDS.get(sinceDuration) ?? null,
        // Always ask the backend for timestamps; showTimestamps only decides
        // whether the rendered row prints them. Wiring it to the request made one
        // flag mean two things: toggling it mid-stream left the live stream on
        // the old setting, and honouring it would have meant restarting the
        // stream — clearing the whole buffer — for a display-only switch.
        // parseLogLine strips the prefix either way, so the message is identical.
        timestamps: true,
        previous: showPrevious,
      }),
    );
  }

  function stopStreaming() {
    stream.stop();
  }

  /** Empty the view: both the rendered lines and the not-yet-flushed buffer. */
  function clearLogs() {
    logs = [];
    resetLogIdCounter();
    pendingLogs = [];
    flushScheduled = false;
    _seenPodNames = new Set();
    logPodNames = [];
    userScrolledAway = false;
  }

  // --- Callback handlers for sub-components ---
  function handleContainerSelect(container: string) {
    selectedContainer = container;
    if (isStreaming) startStreaming();
  }

  function handleSinceSelect(value: SinceDuration) {
    sinceDuration = value;
    if (isStreaming) startStreaming();
  }

  function handleTailSelect(value: TailLines) {
    tailLines = value;
    if (isStreaming) startStreaming();
  }

  function togglePrevious() {
    showPrevious = !showPrevious;
    if (isStreaming) startStreaming();
  }

  // --- Export (the displayed lines, i.e. after every filter) ---
  function exportText(): string {
    return formatLogsForExport(filteredLogs, { timestamps: showTimestamps });
  }

  async function copyLogs() {
    await navigator.clipboard.writeText(exportText());
  }

  async function downloadLogs() {
    const defaultName = exportFileName(k8sStore.selectedResource?.metadata?.name, selectedContainer);
    try {
      // null: the user cancelled the save dialog — nothing to report.
      const saved = await invoke<{ path: string } | null>("save_text_file", {
        defaultName,
        content: exportText(),
      });
      if (saved) toastStore.success("Logs saved", saved.path);
    } catch (err) {
      toastStore.error("Could not save logs", err instanceof Error ? err.message : String(err));
    }
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

<div data-testid="log-viewer" class="flex h-full flex-col bg-[var(--bg-primary)]">
  <!-- Log Viewer: the tab bar already names the view and the resource, so this
       panel carries no title of its own. -->
  <div class="flex-1 overflow-hidden px-4 pt-3 pb-2">
    <div class="relative flex h-full flex-col">
      <!-- Log Entries (virtualized) -->
      <div
        data-testid="log-scroll"
        class={cn(
          "relative min-h-0 flex-1 overflow-y-auto rounded-sm border border-[var(--border-color)] bg-[var(--log-bg)] font-mono",
          wrapLines ? "overflow-x-hidden" : "overflow-x-auto",
        )}
        bind:this={logContainer}
        onscroll={handleScroll}
      >
        {#if filteredLogs.length === 0}
          <div class="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">
            {emptyStateMessage}
          </div>
        {:else}
          <div style="height: {$virtualizer.getTotalSize()}px; position: relative; width: 100%;">
            {#each $virtualizer.getVirtualItems() as row (row.index)}
              {@const line = filteredLogs[row.index]}
              {#if line}
                <!-- Rows open the detail sheet on click. They are not tab
                     stops — there can be thousands — so the keyboard path is
                     the arrow-key navigation in handleGlobalKeydown, not a
                     per-row key handler. -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  role="button"
                  tabindex="-1"
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
                    <span class="shrink-0 max-w-[140px] truncate rounded-sm bg-[var(--accent)]/10 px-1.5 py-0 text-[10px] font-medium leading-[20px] text-[var(--accent)]" title={line.podName}>
                      {shortPodName(line.podName)}
                    </span>
                  {/if}
                  {#if showTimestamps && line.timestamp}
                    <span class="shrink-0 text-[11px] leading-[20px] text-[var(--log-timestamp)]">{line.timestamp}</span>
                  {/if}
                  <!-- No badge for a line that declares no level: a guessed
                       one is wrong on its face (nginx access lines are not
                       DEBUG). -->
                  {#if line.level}
                    <span
                      class={cn("shrink-0 text-[11px] leading-[20px] font-semibold", LEVEL_BADGE_COLORS[line.level])}
                    >
                      {LEVEL_LABELS[line.level]}
                    </span>
                  {/if}
                  {#if line.isJson && line.jsonFormatted}
                    <pre class={cn("min-w-0 text-[11px] leading-[20px] text-[var(--text-secondary)]", wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>{@html getJsonHighlighted(line)}</pre>
                  {:else}
                    <span class={cn("min-w-0 text-[11px] leading-[20px]", wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre", messageColor(line.level))}>
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
        <Button
          variant="toolbar"
          size="sm"
          mono
          class="absolute bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-full px-3 shadow-lg"
          onclick={jumpToBottom}
        >
          <ArrowDown class="h-3 w-3" />
          Jump to bottom
        </Button>
      {/if}
    </div>
  </div>

  <!-- Controls: single bar at the bottom of the panel -->
  <LogControlBar
    {selectedContainer}
    {containers}
    bind:filterText
    {isStreaming}
    streamPhase={stream.phase}
    {isDeployment}
    {deploymentPodNames}
    {podsLoading}
    bind:levelFilter
    bind:podFilter
    {sinceDuration}
    {sinceLabel}
    {tailLines}
    bind:showTimestamps
    {showPrevious}
    bind:useRegex
    bind:wrapLines
    hasLines={filteredLogs.length > 0}
    {logPodNames}
    onStartStreaming={startStreaming}
    onStopStreaming={stopStreaming}
    onContainerSelect={handleContainerSelect}
    onSinceSelect={handleSinceSelect}
    onTailSelect={handleTailSelect}
    onTogglePrevious={togglePrevious}
    onClear={clearLogs}
    onCopy={copyLogs}
    onDownload={downloadLogs}
    onAskAgent={askAgent}
  />

  <!-- Log Detail Sheet -->
  <LogDetailSheet {selectedLog} onClose={closeDetail} />
</div>
