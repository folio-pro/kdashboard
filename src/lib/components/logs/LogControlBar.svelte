<script lang="ts">
  import { Box, Clock, History, Regex, Trash2, Play, Square } from "lucide-svelte";
  import {
    Badge,
    Button,
    SearchField,
    type ButtonActiveStyle,
    type ButtonTone,
    type ButtonVariant,
  } from "$lib/components/ui";
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

  /**
   * `all` reads as a plain toolbar control that fills with the accent when
   * selected; the three level buttons carry their own status colour at rest
   * and tint with it when selected. Expressed as variants rather than an
   * on/off pair of class strings so the selected treatment is defined once,
   * in the design system, for every segmented control in the app.
   */
  const LEVELS: {
    value: LogLevel;
    variant: ButtonVariant;
    tone: ButtonTone;
    activeStyle: ButtonActiveStyle;
  }[] = [
    { value: "all", variant: "toolbar", tone: "accent", activeStyle: "solid" },
    { value: "info", variant: "toolbar-tone", tone: "info", activeStyle: "soft" },
    { value: "warn", variant: "toolbar-tone", tone: "warning", activeStyle: "soft" },
    { value: "error", variant: "toolbar-tone", tone: "error", activeStyle: "soft" },
  ];

  const TOGGLES = $derived([
    { icon: Regex, label: "Regex filter", on: useRegex, toggle: () => (useRegex = !useRegex) },
    { icon: Clock, label: "Timestamps", on: showTimestamps, toggle: () => (showTimestamps = !showTimestamps) },
    { icon: History, label: "Previous container logs", on: showPrevious, toggle: onTogglePrevious },
  ]);

</script>

<div class="flex h-11 shrink-0 items-center gap-2 border-t border-[var(--border-color)] px-4">
  <!-- Stream toggle -->
  {#if !isStreaming}
    <Button
      variant="solid-tone"
      tone="success"
      size="sm"
      mono
      onclick={onStartStreaming}
      disabled={!selectedContainer}
    >
      <Play class="h-3 w-3" />
      <span>Stream</span>
    </Button>
  {:else}
    <Button variant="solid-tone" tone="error" size="sm" mono onclick={onStopStreaming}>
      <Square class="h-3 w-3" />
      <span>Stop</span>
    </Button>
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
      <Button
        variant={level.variant}
        size="sm"
        mono
        tone={level.tone}
        active={levelFilter === level.value}
        activeStyle={level.activeStyle}
        onclick={() => (levelFilter = level.value)}
      >
        {level.value}
      </Button>
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
    <Badge appearance="outline" tone="muted" size="sm" mono class="h-7 px-2.5">
      <Box class="h-3 w-3" />
      {deploymentPodNames.length} pods
    </Badge>
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
  <SearchField
    size="sm"
    mono
    placeholder="Filter logs…"
    ariaLabel="Filter logs"
    class="min-w-[80px] flex-1"
    bind:value={filterText}
  />

  <!-- Icon toggles -->
  {#each TOGGLES as toggle}
    <Button
      variant="toolbar"
      size="icon-sm"
      active={toggle.on}
      title={toggle.label}
      aria-label={toggle.label}
      onclick={toggle.toggle}
    >
      <toggle.icon class="h-3 w-3" />
    </Button>
  {/each}

  <Button variant="toolbar" size="icon-sm" title="Clear logs" aria-label="Clear logs" onclick={onClear}>
    <Trash2 class="h-3 w-3" />
  </Button>

  {#if isStreaming}
    <div class="flex shrink-0 items-center gap-1.5">
      <div class="h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--status-running)]"></div>
      <span class="font-mono text-[11px] font-semibold text-[var(--status-running)]">LIVE</span>
    </div>
  {/if}
</div>
