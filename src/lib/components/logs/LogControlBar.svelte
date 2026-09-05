<script lang="ts">
  import {
    Bot,
    Box,
    Check,
    Clock,
    Copy,
    Download,
    History,
    Regex,
    Trash2,
    Play,
    Square,
    WrapText,
  } from "lucide-svelte";
  import {
    Badge,
    Button,
    SearchField,
    type ButtonActiveStyle,
    type ButtonTone,
    type ButtonVariant,
  } from "$lib/components/ui";
  import { SelectMenu } from "$lib/components/ui/select-menu";
  import { ALL_CONTAINERS, shortPodName } from "./log-viewer";
  import type { LogLevel, StreamPhase } from "./log-viewer";
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
    streamPhase,
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
    wrapLines = $bindable(),
    hasLines,
    logPodNames,
    onStartStreaming,
    onStopStreaming,
    onContainerSelect,
    onSinceSelect,
    onTailSelect,
    onTogglePrevious,
    onClear,
    onCopy,
    onDownload,
    onAskAgent,
  }: {
    /** A container name, or ALL_CONTAINERS. */
    selectedContainer: string;
    containers: string[];
    filterText: string;
    isStreaming: boolean;
    streamPhase: StreamPhase;
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
    wrapLines: boolean;
    /** Whether anything is displayed — Copy and Download need lines to act on. */
    hasLines: boolean;
    logPodNames: string[];
    onStartStreaming: () => void;
    onStopStreaming: () => void;
    onContainerSelect: (container: string) => void;
    onSinceSelect: (value: SinceDuration) => void;
    onTailSelect: (value: TailLines) => void;
    onTogglePrevious: () => void;
    onClear: () => void;
    /** Copies the displayed lines; resolves once they are on the clipboard. */
    onCopy: () => Promise<void>;
    onDownload: () => void;
    /** Hand the current logs (pod, container, filter) to the AI agent. */
    onAskAgent: () => void;
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
   *
   * What each filter shows is decided by levelMatches() in log-viewer.ts —
   * in particular `info` keeps lines that carry no level at all.
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
    { icon: WrapText, label: "Wrap lines", on: wrapLines, toggle: () => (wrapLines = !wrapLines) },
    { icon: History, label: "Previous container logs", on: showPrevious, toggle: onTogglePrevious },
  ]);

  /**
   * "All containers" only makes sense for a pod with several; a deployment
   * stream already fans out across pods with one container each, and stacking
   * both would need a two-part source prefix the rows do not have.
   */
  const containerItems = $derived.by(() => {
    const items = containers.map((c) => ({ value: c, label: c, onSelect: () => onContainerSelect(c) }));
    if (!isDeployment && containers.length > 1) {
      items.unshift({
        value: ALL_CONTAINERS,
        label: "All containers",
        onSelect: () => onContainerSelect(ALL_CONTAINERS),
      });
    }
    return items;
  });

  const containerLabel = $derived(
    selectedContainer === ALL_CONTAINERS ? "all containers" : selectedContainer,
  );

  // Copy feedback: the icon flips to a check for a moment, as it does in the
  // detail sheet, instead of raising a toast for a one-line action.
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  async function copy() {
    await onCopy();
    if (copiedTimer) clearTimeout(copiedTimer);
    copied = true;
    copiedTimer = setTimeout(() => (copied = false), 1500);
  }
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
      label={containerLabel}
      items={containerItems}
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

  <!-- Export: both act on the DISPLAYED lines — after the level, pod and text
       filters — so what leaves the viewer is what the user was looking at. -->
  <Button
    variant="toolbar"
    size="icon-sm"
    title="Copy logs"
    aria-label="Copy logs"
    disabled={!hasLines}
    onclick={copy}
  >
    {#if copied}
      <Check class="h-3 w-3 text-[var(--status-running)]" />
    {:else}
      <Copy class="h-3 w-3" />
    {/if}
  </Button>
  <Button
    variant="toolbar"
    size="icon-sm"
    title="Download logs"
    aria-label="Download logs"
    disabled={!hasLines}
    onclick={onDownload}
  >
    <Download class="h-3 w-3" />
  </Button>

  <Button
    variant="toolbar"
    size="icon-sm"
    title="Analyze these logs with the AI agent"
    aria-label="Analyze logs with AI agent"
    onclick={onAskAgent}
    data-testid="logs-ask-agent"
  >
    <Bot class="h-3 w-3" />
  </Button>

  <Button variant="toolbar" size="icon-sm" title="Clear logs" aria-label="Clear logs" onclick={onClear}>
    <Trash2 class="h-3 w-3" />
  </Button>

  <!-- The badge reports the stream phase, not merely "a stream exists": a LIVE
       badge over a viewer that is still dialling is what made a slow connect
       look like a hung one. -->
  {#if streamPhase === "live"}
    <div class="flex shrink-0 items-center gap-1.5">
      <div class="h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--status-running)]"></div>
      <span class="font-mono text-[11px] font-semibold text-[var(--status-running)]">LIVE</span>
    </div>
  {:else if streamPhase === "connecting"}
    <div class="flex shrink-0 items-center gap-1.5">
      <div class="h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--text-muted)]"></div>
      <span class="font-mono text-[11px] font-semibold text-[var(--text-muted)]">CONNECTING</span>
    </div>
  {/if}
</div>
