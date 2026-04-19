<script lang="ts">
  import { Box, Link } from "lucide-svelte";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import { getContainerState } from "$lib/utils/k8s-helpers";
  import { parseResourceValue, getUsagePercent, getBarColor, type ContainerStatus, type SpecContainer } from "./pod-utils";
  import { getContainerIconUrl } from "$lib/utils/container-icon";

  interface Props {
    containerStatuses: ContainerStatus[];
    specContainerMap: Map<string, SpecContainer>;
    failedIcons: Set<string>;
    onIconError: (url: string) => void;
  }

  let { containerStatuses, specContainerMap, failedIcons, onIconError }: Props = $props();

  function getContainerResources(containerName: string) {
    const specContainer = specContainerMap.get(containerName);
    return {
      cpuRequest: specContainer?.resources?.requests?.cpu ?? "-",
      cpuLimit: specContainer?.resources?.limits?.cpu ?? "-",
      memRequest: specContainer?.resources?.requests?.memory ?? "-",
      memLimit: specContainer?.resources?.limits?.memory ?? "-",
    };
  }

  function getContainerPorts(containerName: string): Array<{ containerPort: number; protocol?: string }> {
    const specContainer = specContainerMap.get(containerName);
    return specContainer?.ports ?? [];
  }
</script>

{#snippet containerIcon(iconUrl: string | null, name: string, size: "sm" | "md" = "sm")}
  {#if iconUrl}
    <img
      src={iconUrl}
      alt={name}
      class="{size === 'md' ? 'h-5 w-5' : 'h-4 w-4'} object-contain"
      onerror={() => onIconError(iconUrl)}
    />
  {:else}
    <Box class="{size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} text-[var(--text-muted)]" />
  {/if}
{/snippet}

{#snippet resourceBar(label: string, parsed: { value: string; unit: string }, limit: string, percent: number)}
  <div class="flex flex-col gap-1.5 rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] px-4 py-3">
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-medium text-[var(--text-muted)]">{label}</span>
      <span class="text-[11px] text-[var(--text-dimmed)]">/ {limit}</span>
    </div>
    <span class="text-lg font-bold leading-none text-[var(--text-primary)]">{parsed.value}<span class="ml-0.5 text-xs font-normal text-[var(--text-dimmed)]">{parsed.unit}</span></span>
    <div class="h-1 w-full overflow-hidden rounded-sm bg-[var(--border-color)]">
      <div
        class="h-full rounded-sm transition-[width,background-color] duration-300"
        style:width="{percent}%"
        style:background-color={getBarColor(percent)}
      ></div>
    </div>
  </div>
{/snippet}

<div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
  <div class="flex items-center justify-between px-5 py-4">
    <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Containers</h3>
    <span class="text-[11px] text-[var(--text-muted)]">{containerStatuses.length} containers</span>
  </div>

  {#each containerStatuses as container}
    {@const resources = getContainerResources(container.name)}
    {@const ports = getContainerPorts(container.name)}
    {@const cpuParsed = parseResourceValue(resources.cpuRequest)}
    {@const memParsed = parseResourceValue(resources.memRequest)}
    {@const cpuPercent = getUsagePercent(cpuParsed.value, parseResourceValue(resources.cpuLimit).value)}
    {@const memPercent = getUsagePercent(memParsed.value, parseResourceValue(resources.memLimit).value)}
    {@const rawIconUrl = getContainerIconUrl(container.image)}
    {@const iconUrl = rawIconUrl && !failedIcons.has(rawIconUrl) ? rawIconUrl : null}
    <div class="flex flex-col gap-4 border-t border-[var(--border-hover)] p-5">
      <!-- Container Header -->
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--bg-tertiary)]">
            {@render containerIcon(iconUrl, container.name, "md")}
          </div>
          <div class="flex flex-col gap-px">
            <span class="text-sm font-semibold text-[var(--text-primary)]">{container.name}</span>
            <span class="text-xs text-[var(--text-muted)]">{container.image}</span>
          </div>
        </div>
        <StatusBadge status={getContainerState(container.state ?? {})} />
      </div>

      <!-- CPU & Memory: compact inline -->
      <div class="grid grid-cols-2 gap-3">
        {@render resourceBar("CPU", cpuParsed, resources.cpuLimit, cpuPercent)}
        {@render resourceBar("Memory", memParsed, resources.memLimit, memPercent)}
      </div>

      <!-- Ports -->
      {#if ports.length > 0}
        <div class="flex items-center gap-1.5">
          <Link class="h-3 w-3 text-[var(--text-dimmed)]" />
          {#each ports as port}
            <span class="text-[11px] text-[var(--text-muted)]">{port.containerPort}/{port.protocol ?? "TCP"}</span>
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  {#if containerStatuses.length === 0}
    <div class="border-t border-[var(--border-hover)] p-5">
      <p class="text-xs text-[var(--text-muted)]">No container status available</p>
    </div>
  {/if}
</div>
