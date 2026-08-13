<script lang="ts">
  import { Button, Menu, MenuItem, type ButtonVariant, type ButtonTone, type ButtonActiveStyle } from "$lib/components/ui";
  import {
    ChevronDown,
    Search,
    Calendar,
    Trash2,
  } from "lucide-svelte";
  import { shortPodName } from "./log-viewer";
  import type { LogLevel } from "./log-viewer";
  import {
    SINCE_OPTIONS,
    TAIL_OPTIONS,
    type TailLines,
    type SinceDuration,
    type DropdownId,
  } from "./log-constants";

  let {
    levelFilter = $bindable(),
    podFilter = $bindable(),
    sinceDuration,
    sinceLabel,
    tailLines,
    showTimestamps = $bindable(),
    showPrevious,
    useRegex = $bindable(),
    openDropdown = $bindable(),
    isDeployment,
    logPodNames,
    onSinceSelect,
    onTailSelect,
    onTogglePrevious,
    onToggleDropdown,
    onClear,
  }: {
    levelFilter: LogLevel;
    podFilter: string | null;
    sinceDuration: SinceDuration;
    sinceLabel: string;
    tailLines: TailLines;
    showTimestamps: boolean;
    showPrevious: boolean;
    useRegex: boolean;
    openDropdown: DropdownId;
    isDeployment: boolean;
    logPodNames: string[];
    onSinceSelect: (value: SinceDuration) => void;
    onTailSelect: (value: TailLines) => void;
    onTogglePrevious: () => void;
    onToggleDropdown: (id: DropdownId, e: MouseEvent) => void;
    onClear: () => void;
  } = $props();

  /**
   * The level segmented control. `all` reads as a plain toolbar button that
   * fills with the accent when selected; the three level buttons carry their
   * own log colour at rest and tint with it when selected.
   */
  const LEVEL_FILTERS: {
    value: LogLevel;
    variant: ButtonVariant;
    tone: ButtonTone;
    activeStyle: ButtonActiveStyle;
  }[] = [
    { value: "all", variant: "toolbar", tone: "accent", activeStyle: "solid" },
    { value: "info", variant: "toolbar-tone", tone: "info", activeStyle: "soft" },
    { value: "warn", variant: "toolbar-tone", tone: "warn", activeStyle: "soft" },
    { value: "error", variant: "toolbar-tone", tone: "error", activeStyle: "soft" },
  ];
</script>

<div
  class="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-color)] px-6"
>
  <!-- Left: Level filters, since, tail -->
  <div class="flex items-center gap-2">
    <span class="font-mono text-[12px] text-[var(--text-muted)]">level:</span>
    <div class="flex items-center gap-1">
      {#each LEVEL_FILTERS as level}
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

    {#if isDeployment && logPodNames.length > 1}
      <div class="mx-1 h-5 w-px bg-[var(--border-color)]"></div>

      <!-- Pod Filter -->
      <span class="font-mono text-[12px] text-[var(--text-muted)]">pod:</span>
      <div class="relative">
        <Button variant="toolbar" size="sm" mono class="gap-1" onclick={(e) => onToggleDropdown("pod", e)}>
          <span class="max-w-[120px] truncate">{podFilter === null ? "all pods" : shortPodName(podFilter)}</span>
          <ChevronDown class="h-2.5 w-2.5 text-[var(--text-muted)]" />
        </Button>
        {#if openDropdown === "pod"}
          <Menu class="max-h-[200px] min-w-[160px] overflow-y-auto">
            <MenuItem
              mono
              selected={podFilter === null}
              onclick={(e) => { e.stopPropagation(); podFilter = null; openDropdown = null; }}
            >
              all pods
            </MenuItem>
            {#each logPodNames as pName}
              <MenuItem
                mono
                selected={pName === podFilter}
                onclick={(e) => { e.stopPropagation(); podFilter = pName; openDropdown = null; }}
              >
                {pName}
              </MenuItem>
            {/each}
          </Menu>
        {/if}
      </div>
    {/if}

    <div class="mx-1 h-5 w-px bg-[var(--border-color)]"></div>

    <!-- Since Selector -->
    <span class="font-mono text-[12px] text-[var(--text-muted)]">since:</span>
    <div class="relative">
      <Button variant="toolbar" size="sm" mono class="gap-1" onclick={(e) => onToggleDropdown("since", e)}>
        <span>{sinceLabel}</span>
        <ChevronDown class="h-2.5 w-2.5 text-[var(--text-muted)]" />
      </Button>
      {#if openDropdown === "since"}
        <Menu class="min-w-[120px]">
          {#each SINCE_OPTIONS as option}
            <MenuItem
              mono
              selected={option.value === sinceDuration}
              onclick={(e) => {
                e.stopPropagation();
                onSinceSelect(option.value);
              }}
            >
              {option.label}
            </MenuItem>
          {/each}
        </Menu>
      {/if}
    </div>

    <!-- Tail Selector -->
    <span class="font-mono text-[12px] text-[var(--text-muted)]">tail:</span>
    <div class="relative">
      <Button variant="toolbar" size="sm" mono class="gap-1" onclick={(e) => onToggleDropdown("tail", e)}>
        <span>{tailLines}</span>
        <ChevronDown class="h-2.5 w-2.5 text-[var(--text-muted)]" />
      </Button>
      {#if openDropdown === "tail"}
        <Menu class="min-w-[80px]">
          {#each TAIL_OPTIONS as option}
            <MenuItem
              mono
              selected={option === tailLines}
              onclick={(e) => {
                e.stopPropagation();
                onTailSelect(option);
              }}
            >
              {option}
            </MenuItem>
          {/each}
        </Menu>
      {/if}
    </div>
  </div>

  <!-- Right: Timestamps, Previous, Regex, Clear -->
  <div class="flex items-center gap-1.5">
    <Button
      variant="toolbar"
      size="sm"
      mono
      active={showTimestamps}
      onclick={() => (showTimestamps = !showTimestamps)}
    >
      <Calendar class="h-3 w-3" />
      <span>timestamps</span>
    </Button>
    <Button variant="toolbar" size="sm" mono active={showPrevious} onclick={onTogglePrevious}>
      Previous
    </Button>
    <Button variant="toolbar" size="sm" mono active={useRegex} onclick={() => (useRegex = !useRegex)}>
      <Search class="h-3 w-3" />
      <span>regex</span>
    </Button>
    <Button variant="toolbar" size="sm" mono onclick={onClear}>
      <Trash2 class="h-3 w-3" />
      <span>Clear</span>
    </Button>
  </div>
</div>
