<script lang="ts">
  import { Badge, Button, Input, Menu, MenuItem } from "$lib/components/ui";
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
    <span class="font-mono text-[15px] font-semibold text-[var(--text-primary)]">Logs</span>
    <span class="font-mono text-[11px] text-[var(--text-muted)]">{resourceName}</span>
  </div>

  <!-- Right: Container, Filter, Stream -->
  <div class="flex items-center gap-2">
    <!-- Pod count badge for deployments -->
    {#if isDeployment && deploymentPodNames.length > 0}
      <Badge appearance="outline" tone="muted" size="sm" mono class="h-9 px-3">
        <Box class="h-3.5 w-3.5" />
        {deploymentPodNames.length} pods
      </Badge>
    {:else if isDeployment && podsLoading}
      <span class="font-mono text-[12px] text-[var(--text-muted)]">Loading pods...</span>
    {/if}

    <!-- Container Selector -->
    {#if containers.length > 0}
      <div class="relative">
        <Button variant="toolbar" size="lg" mono onclick={(e) => onToggleDropdown("container", e)}>
          <Box class="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <span>{selectedContainer}</span>
          <ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />
        </Button>
        {#if openDropdown === "container"}
          <Menu align="right" class="min-w-[160px]">
            {#each containers as container}
              <MenuItem
                mono
                selected={container === selectedContainer}
                onclick={(e) => {
                  e.stopPropagation();
                  onContainerSelect(container);
                }}
              >
                {container}
              </MenuItem>
            {/each}
          </Menu>
        {/if}
      </div>
    {/if}

    <!-- Filter Input -->
    <div class="relative w-[180px]">
      <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
      <Input
        type="text"
        size="lg"
        mono
        placeholder="Filter logs..."
        class="bg-[var(--bg-secondary)] pl-8"
        bind:value={filterText}
      />
    </div>

    <!-- Stream Button -->
    {#if !isStreaming}
      <Button
        variant="solid-tone"
        tone="success"
        size="lg"
        mono
        onclick={onStartStreaming}
        disabled={!selectedContainer}
      >
        <Play class="h-3.5 w-3.5" />
        <span>Stream</span>
      </Button>
    {:else}
      <Button variant="solid-tone" tone="error" size="lg" mono onclick={onStopStreaming}>
        <Square class="h-3.5 w-3.5" />
        <span>Stop</span>
      </Button>
    {/if}
  </div>
</div>
