<script lang="ts">
  import { cn } from "$lib/utils";
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
</script>

<div
  class="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-color)] px-6"
>
  <!-- Left: Level filters, since, tail -->
  <div class="flex items-center gap-2">
    <span class="font-mono text-xs text-[var(--text-muted)]">level:</span>
    <div class="flex items-center gap-1">
      <button
        class={cn(
          "flex h-7 items-center justify-center rounded px-2.5 font-mono text-[11px] font-semibold transition-colors",
          levelFilter === "all"
            ? "bg-[var(--accent)] text-[var(--bg-primary)]"
            : "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
        )}
        onclick={() => (levelFilter = "all")}
      >
        all
      </button>
      <button
        class={cn(
          "flex h-7 items-center justify-center rounded px-2.5 font-mono text-[11px] font-medium transition-colors",
          levelFilter === "info"
            ? "bg-[var(--log-info)]/20 text-[var(--log-info)]"
            : "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--log-info)]",
        )}
        onclick={() => (levelFilter = "info")}
      >
        info
      </button>
      <button
        class={cn(
          "flex h-7 items-center justify-center rounded px-2.5 font-mono text-[11px] font-medium transition-colors",
          levelFilter === "warn"
            ? "bg-[var(--log-warn)]/20 text-[var(--log-warn)]"
            : "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--log-warn)]",
        )}
        onclick={() => (levelFilter = "warn")}
      >
        warn
      </button>
      <button
        class={cn(
          "flex h-7 items-center justify-center rounded px-2.5 font-mono text-[11px] font-medium transition-colors",
          levelFilter === "error"
            ? "bg-[var(--log-error)]/20 text-[var(--log-error)]"
            : "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--log-error)]",
        )}
        onclick={() => (levelFilter = "error")}
      >
        error
      </button>
    </div>

    {#if isDeployment && logPodNames.length > 1}
      <div class="mx-1 h-5 w-px bg-[var(--border-color)]"></div>

      <!-- Pod Filter -->
      <span class="font-mono text-xs text-[var(--text-muted)]">pod:</span>
      <div class="relative">
        <button
          class="flex h-7 items-center gap-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 font-mono text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          onclick={(e) => onToggleDropdown("pod", e)}
        >
          <span class="max-w-[120px] truncate">{podFilter === null ? "all pods" : shortPodName(podFilter)}</span>
          <ChevronDown class="h-2.5 w-2.5 text-[var(--text-muted)]" />
        </button>
        {#if openDropdown === "pod"}
          <div
            class="absolute top-full left-0 z-50 mt-1 max-h-[200px] min-w-[160px] overflow-y-auto rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-lg"
          >
            <button
              class={cn(
                "block w-full px-3 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-[var(--table-row-hover)]",
                podFilter === null ? "text-[var(--accent)]" : "text-[var(--text-secondary)]",
              )}
              onclick={(e) => { e.stopPropagation(); podFilter = null; openDropdown = null; }}
            >
              all pods
            </button>
            {#each logPodNames as pName}
              <button
                class={cn(
                  "block w-full px-3 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-[var(--table-row-hover)]",
                  pName === podFilter ? "text-[var(--accent)]" : "text-[var(--text-secondary)]",
                )}
                onclick={(e) => { e.stopPropagation(); podFilter = pName; openDropdown = null; }}
              >
                {pName}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <div class="mx-1 h-5 w-px bg-[var(--border-color)]"></div>

    <!-- Since Selector -->
    <span class="font-mono text-xs text-[var(--text-muted)]">since:</span>
    <div class="relative">
      <button
        class="flex h-7 items-center gap-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 font-mono text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        onclick={(e) => onToggleDropdown("since", e)}
      >
        <span>{sinceLabel}</span>
        <ChevronDown class="h-2.5 w-2.5 text-[var(--text-muted)]" />
      </button>
      {#if openDropdown === "since"}
        <div
          class="absolute top-full left-0 z-50 mt-1 min-w-[120px] rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-lg"
        >
          {#each SINCE_OPTIONS as option}
            <button
              class={cn(
                "block w-full px-3 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-[var(--table-row-hover)]",
                option.value === sinceDuration
                  ? "text-[var(--accent)]"
                  : "text-[var(--text-secondary)]",
              )}
              onclick={(e) => {
                e.stopPropagation();
                onSinceSelect(option.value);
              }}
            >
              {option.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Tail Selector -->
    <span class="font-mono text-xs text-[var(--text-muted)]">tail:</span>
    <div class="relative">
      <button
        class="flex h-7 items-center gap-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 font-mono text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        onclick={(e) => onToggleDropdown("tail", e)}
      >
        <span>{tailLines}</span>
        <ChevronDown class="h-2.5 w-2.5 text-[var(--text-muted)]" />
      </button>
      {#if openDropdown === "tail"}
        <div
          class="absolute top-full left-0 z-50 mt-1 min-w-[80px] rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-lg"
        >
          {#each TAIL_OPTIONS as option}
            <button
              class={cn(
                "block w-full px-3 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-[var(--table-row-hover)]",
                option === tailLines
                  ? "text-[var(--accent)]"
                  : "text-[var(--text-secondary)]",
              )}
              onclick={(e) => {
                e.stopPropagation();
                onTailSelect(option);
              }}
            >
              {option}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Right: Timestamps, Previous, Regex, Clear -->
  <div class="flex items-center gap-1.5">
    <button
      class={cn(
        "flex h-7 items-center gap-1.5 rounded px-2.5 font-mono text-[11px] font-medium transition-colors",
        showTimestamps
          ? "bg-[var(--accent)] text-[var(--bg-primary)]"
          : "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
      )}
      onclick={() => (showTimestamps = !showTimestamps)}
    >
      <Calendar class="h-3 w-3" />
      <span>timestamps</span>
    </button>
    <button
      class={cn(
        "flex h-7 items-center rounded px-2.5 font-mono text-[11px] transition-colors",
        showPrevious
          ? "bg-[var(--accent)] text-[var(--bg-primary)]"
          : "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
      )}
      onclick={onTogglePrevious}
    >
      Previous
    </button>
    <button
      class={cn(
        "flex h-7 items-center gap-1.5 rounded px-2.5 font-mono text-[11px] transition-colors",
        useRegex
          ? "bg-[var(--accent)] text-[var(--bg-primary)]"
          : "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
      )}
      onclick={() => (useRegex = !useRegex)}
    >
      <Search class="h-3 w-3" />
      <span>regex</span>
    </button>
    <button
      class="flex h-7 items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 font-mono text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      onclick={onClear}
    >
      <Trash2 class="h-3 w-3" />
      <span>Clear</span>
    </button>
  </div>
</div>
