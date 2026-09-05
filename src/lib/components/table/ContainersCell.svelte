<script lang="ts">
  import { Box } from "lucide-svelte";
  import { cn } from "$lib/utils";
  import type { Resource, TableDensity } from "$lib/types";
  import { getContainerIconUrl } from "$lib/utils/container-icon";
  import { DENSITY_CLASSES } from "./table-density";

  /**
   * One tile per container: its image's icon (or a box), tinted only when it
   * is waiting or erroring. A running container is the normal case and paints
   * neutral; a terminated one fades.
   */
  interface Props {
    resource: Resource;
    density: TableDensity;
  }

  let { resource, density }: Props = $props();
  let d = $derived(DENSITY_CLASSES[density]);

  type ContainerState = "running" | "waiting" | "error" | "terminated";

  interface ContainerInfo {
    name: string;
    iconUrl: string | null;
    state: ContainerState;
  }

  let failedIcons: Set<string> = $state(new Set());

  let containers = $derived.by((): ContainerInfo[] => {
    const cs = resource.status?.containerStatuses as
      | Array<{ name: string; ready: boolean; image: string; state?: Record<string, unknown> }>
      | undefined;
    if (!cs) return [];
    return cs.map((c) => {
      const url = c.image ? getContainerIconUrl(c.image) : null;
      let state: ContainerState = "running";
      if (c.state?.waiting) {
        const reason = (c.state.waiting as { reason?: string }).reason ?? "";
        state = /error|crash|backoff/i.test(reason) ? "error" : "waiting";
      } else if (c.state?.terminated) {
        const exitCode = (c.state.terminated as { exitCode?: number }).exitCode;
        state = exitCode && exitCode !== 0 ? "error" : "terminated";
      }
      if (!c.ready && state === "running") state = "waiting";
      return { name: c.name, iconUrl: url && !failedIcons.has(url) ? url : null, state };
    });
  });

  const TILE_STYLE: Record<ContainerState, string> = {
    running: "",
    waiting:
      "background-color: color-mix(in srgb, var(--status-pending) 14%, var(--bg-tertiary)); border-color: color-mix(in srgb, var(--status-pending) 28%, transparent); color: var(--status-pending);",
    error:
      "background-color: color-mix(in srgb, var(--status-failed) 14%, var(--bg-tertiary)); border-color: color-mix(in srgb, var(--status-failed) 28%, transparent); color: var(--status-failed);",
    terminated: "opacity: 0.5;",
  };

  const ICON_FILTER: Record<ContainerState, string> = {
    running: "none",
    terminated: "none",
    waiting: "grayscale(1) brightness(0.9) sepia(1) hue-rotate(15deg) saturate(3)",
    error: "grayscale(1) brightness(0.7) sepia(1) hue-rotate(-30deg) saturate(5)",
  };

  function handleIconError(url: string) {
    if (failedIcons.has(url)) return;
    failedIcons = new Set(failedIcons).add(url);
  }
</script>

<div class="flex items-center gap-1.5 overflow-hidden">
  {#each containers as c (c.name)}
    <div
      class={cn(
        "relative flex shrink-0 items-center justify-center rounded-[3px] border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)]",
        d.tile
      )}
      style={TILE_STYLE[c.state]}
      title="{c.name} ({c.state})"
    >
      {#if c.iconUrl}
        <img
          src={c.iconUrl}
          alt={c.name}
          class={cn("object-contain", d.tileImg)}
          style:filter={ICON_FILTER[c.state]}
          onerror={() => handleIconError(c.iconUrl!)}
        />
      {:else}
        <Box class={d.tileIcon} />
      {/if}
    </div>
  {/each}
</div>
