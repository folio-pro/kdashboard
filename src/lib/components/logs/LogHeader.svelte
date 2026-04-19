<script lang="ts">
  import { cn } from "$lib/utils";
  import {
    Play,
    Square,
    Box,
    ChevronDown,
    Search,
  } from "lucide-svelte";
  import type { DropdownId } from "./log-constants";

  let {
    resourceName,
    selectedContainer,
    containers,
    filterText = $bindable(),
    isStreaming,
    isDeployment,
    deploymentPodNames,
    podsLoading,
    openDropdown = $bindable(),
    onStartStreaming,
    onStopStreaming,
    onContainerSelect,
    onToggleDropdown,
  }: {
    resourceName: string;
    selectedContainer: string;
    containers: string[];
    filterText: string;
    isStreaming: boolean;
    isDeployment: boolean;
    deploymentPodNames: string[];
    podsLoading: boolean;
    openDropdown: DropdownId;
    onStartStreaming: () => void;
    onStopStreaming: () => void;
    onContainerSelect: (container: string) => void;
    onToggleDropdown: (id: DropdownId, e: MouseEvent) => void;
  } = $props();
</script>

<div
  class="flex h-[68px] shrink-0 items-center justify-between border-b border-[var(--border-color)] px-6"
>
  <!-- Left: Title -->
  <div class="flex flex-col gap-0.5">
    <span class="font-mono text-base font-semibold text-[var(--text-primary)]">Logs</span>
    <span class="font-mono text-[11px] text-[var(--text-muted)]">{resourceName}</span>
  </div>

  <!-- Right: Container, Filter, Stream -->
  <div class="flex items-center gap-2">
    <!-- Pod count badge for deployments -->
    {#if isDeployment && deploymentPodNames.length > 0}
      <span class="flex h-[34px] items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 font-mono text-xs text-[var(--text-muted)]">
        <Box class="h-3.5 w-3.5" />
        {deploymentPodNames.length} pods
      </span>
    {:else if isDeployment && podsLoading}
      <span class="font-mono text-xs text-[var(--text-muted)]">Loading pods...</span>
    {/if}

    <!-- Container Selector -->
    {#if containers.length > 0}
      <div class="relative">
        <button
          class="flex h-[34px] items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 font-mono text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          onclick={(e) => onToggleDropdown("container", e)}
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
                  onContainerSelect(container);
                }}
              >
                {container}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Filter Input -->
    <div
      class="flex h-[34px] w-[180px] items-center gap-2 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5"
    >
      <Search class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      <input
        type="text"
        placeholder="Filter logs..."
        class="w-full bg-transparent font-mono text-xs text-[var(--text-secondary)] outline-none placeholder:text-[var(--text-muted)]"
        bind:value={filterText}
      />
    </div>

    <!-- Stream Button -->
    {#if !isStreaming}
      <button
        class="flex h-[34px] items-center gap-1.5 rounded bg-[var(--status-running)] px-3.5 font-mono text-xs font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
        onclick={onStartStreaming}
        disabled={!selectedContainer}
      >
        <Play class="h-3.5 w-3.5" />
        <span>Stream</span>
      </button>
    {:else}
      <button
        class="flex h-[34px] items-center gap-1.5 rounded bg-[var(--status-failed)] px-3.5 font-mono text-xs font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90"
        onclick={onStopStreaming}
      >
        <Square class="h-3.5 w-3.5" />
        <span>Stop</span>
      </button>
    {/if}
  </div>
</div>
