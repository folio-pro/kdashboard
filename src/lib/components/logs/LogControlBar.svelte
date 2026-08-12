<script lang="ts">
  import { cn } from "$lib/utils";
  import { Box, Search, Clock, History, Regex, Trash2, Play, Square } from "lucide-svelte";
  import { SelectMenu } from "$lib/components/ui/select-menu";
  import { shortPodName } from "./log-viewer";
  import type { LogLevel } from "./log-viewer";
  import {
    SINCE_OPTIONS,
    TAIL_OPTIONS,
    type TailLines,
    type SinceDuration,
  } from "./log-constants";

  let {
    selectedContainer,
    containers,
    filterText = $bindable(),
    isStreaming,
    isDeployment,
    deploymentPodNames,
    podsLoading,
    levelFilter = $bindable(),
    podFilter = $bindable(),
    sinceDuration,
    sinceLabel,
    tailLines,
    showTimestamps = $bindable(),
    showPrevious,
    useRegex = $bindable(),
    logPodNames,
    onStartStreaming,
    onStopStreaming,
    onContainerSelect,
    onSinceSelect,
    onTailSelect,
    onTogglePrevious,
    onClear,
  }: {
    selectedContainer: string;
    containers: string[];
    filterText: string;
    isStreaming: boolean;
    isDeployment: boolean;
    deploymentPodNames: string[];
    podsLoading: boolean;
    levelFilter: LogLevel;
    podFilter: string | null;
    sinceDuration: SinceDuration;
    sinceLabel: string;
    tailLines: TailLines;
    showTimestamps: boolean;
    showPrevious: boolean;
    useRegex: boolean;
    logPodNames: string[];
    onStartStreaming: () => void;
    onStopStreaming: () => void;
    onContainerSelect: (container: string) => void;
    onSinceSelect: (value: SinceDuration) => void;
    onTailSelect: (value: TailLines) => void;
    onTogglePrevious: () => void;
    onClear: () => void;
  } = $props();

  // "all pods" is the null pod filter; SelectMenu keys on the item value, so it
  // needs a non-null stand-in.
  const ALL_PODS = "";

  const LEVELS: { value: LogLevel; on: string; off: string }[] = [
    {
      value: "all",
      on: "bg-[var(--accent)] font-semibold text-[var(--bg-primary)]",
      off: "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
    },
    {
      value: "info",
      on: "bg-[var(--log-info)]/20 text-[var(--log-info)]",
      off: "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--log-info)]",
    },
    {
      value: "warn",
      on: "bg-[var(--log-warn)]/20 text-[var(--log-warn)]",
      off: "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--log-warn)]",
    },
    {
      value: "error",
      on: "bg-[var(--log-error)]/20 text-[var(--log-error)]",
      off: "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--log-error)]",
    },
  ];

  const TOGGLES = $derived([
    { icon: Regex, label: "Regex filter", on: useRegex, toggle: () => (useRegex = !useRegex) },
    { icon: Clock, label: "Timestamps", on: showTimestamps, toggle: () => (showTimestamps = !showTimestamps) },
    { icon: History, label: "Previous container logs", on: showPrevious, toggle: onTogglePrevious },
  ]);

  const TOGGLE_BTN = "flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors";
  const TOGGLE_ON = "bg-[var(--accent)] text-[var(--bg-primary)]";
  const TOGGLE_OFF = "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]";
</script>

<div class="flex h-11 shrink-0 items-center gap-2 border-t border-[var(--border-color)] px-4">
  <!-- Stream toggle -->
  {#if !isStreaming}
    <button
      class="flex h-7 shrink-0 items-center gap-1.5 rounded bg-[var(--status-running)] px-3 font-mono text-[11px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
      onclick={onStartStreaming}
      disabled={!selectedContainer}
    >
      <Play class="h-3 w-3" />
      <span>Stream</span>
    </button>
  {:else}
    <button
      class="flex h-7 shrink-0 items-center gap-1.5 rounded bg-[var(--status-failed)] px-3 font-mono text-[11px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90"
      onclick={onStopStreaming}
    >
      <Square class="h-3 w-3" />
      <span>Stop</span>
    </button>
  {/if}

  {#if containers.length > 0}
    <SelectMenu
      title="Container"
      value={selectedContainer}
      items={containers.map((c) => ({ value: c, label: c, onSelect: () => onContainerSelect(c) }))}
      contentClass="min-w-[160px]"
    >
      {#snippet icon()}<Box class="h-3 w-3 text-[var(--text-muted)]" />{/snippet}
    </SelectMenu>
  {/if}

  <div class="h-5 w-px shrink-0 bg-[var(--border-color)]"></div>

  <!-- Level filters -->
  <div class="flex shrink-0 items-center gap-1" role="group" aria-label="Log level filter">
    {#each LEVELS as level}
      <button
        class={cn(
          "flex h-7 items-center justify-center rounded px-2.5 font-mono text-[11px] font-medium transition-colors",
          levelFilter === level.value ? level.on : level.off,
        )}
        aria-pressed={levelFilter === level.value}
        onclick={() => (levelFilter = level.value)}
      >
        {level.value}
      </button>
    {/each}
  </div>

  <!-- Pod filter (deployments streaming more than one pod) -->
  {#if isDeployment && logPodNames.length > 1}
    <SelectMenu
      title="Pod"
      value={podFilter ?? ALL_PODS}
      label={podFilter === null ? "all pods" : shortPodName(podFilter)}
      items={[
        { value: ALL_PODS, label: "all pods", onSelect: () => (podFilter = null) },
        ...logPodNames.map((p) => ({ value: p, label: p, onSelect: () => (podFilter = p) })),
      ]}
      contentClass="max-h-[240px] min-w-[160px]"
    />
  {:else if isDeployment && podsLoading}
    <span class="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">loading pods…</span>
  {:else if isDeployment && deploymentPodNames.length > 0}
    <span class="flex h-7 shrink-0 items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 font-mono text-[11px] text-[var(--text-muted)]">
      <Box class="h-3 w-3" />
      {deploymentPodNames.length} pods
    </span>
  {/if}

  <SelectMenu
    title="Since"
    value={sinceDuration}
    label={sinceLabel}
    items={SINCE_OPTIONS.map((o) => ({ ...o, onSelect: () => onSinceSelect(o.value) }))}
  >
    {#snippet icon()}<Clock class="h-3 w-3 text-[var(--text-muted)]" />{/snippet}
  </SelectMenu>

  <SelectMenu
    title="Tail lines"
    value={tailLines}
    label={`tail ${tailLines}`}
    items={TAIL_OPTIONS.map((t) => ({ value: t, label: String(t), onSelect: () => onTailSelect(t) }))}
    contentClass="min-w-[80px]"
  />

  <!-- Filter input: the only element allowed to shrink, so a narrow window
       squeezes it instead of pushing the controls out of the bar. -->
  <div
    class="focus-ring-host flex h-7 min-w-[80px] flex-1 items-center gap-2 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 transition-colors focus-within:border-[var(--accent)]"
  >
    <Search class="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
    <input
      type="text"
      placeholder="Filter logs…"
      class="w-full bg-transparent font-mono text-[11px] text-[var(--text-secondary)] outline-none placeholder:text-[var(--text-muted)]"
      bind:value={filterText}
    />
  </div>

  <!-- Icon toggles -->
  {#each TOGGLES as toggle}
    <button
      class={cn(TOGGLE_BTN, toggle.on ? TOGGLE_ON : TOGGLE_OFF)}
      title={toggle.label}
      aria-label={toggle.label}
      aria-pressed={toggle.on}
      onclick={toggle.toggle}
    >
      <toggle.icon class="h-3 w-3" />
    </button>
  {/each}

  <button class={cn(TOGGLE_BTN, TOGGLE_OFF)} title="Clear logs" aria-label="Clear logs" onclick={onClear}>
    <Trash2 class="h-3 w-3" />
  </button>

  {#if isStreaming}
    <div class="flex shrink-0 items-center gap-1.5">
      <div class="h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--status-running)]"></div>
      <span class="font-mono text-[11px] font-semibold text-[var(--status-running)]">LIVE</span>
    </div>
  {/if}
</div>
