<script lang="ts">
  import { cn } from "$lib/utils";
  import type { Resource } from "$lib/types";
  import { containerStates, type ContainerState } from "./container-state";

  /**
   * One tick per container: a real object, not a percentage. Quiet while
   * healthy, coloured only when it needs a look, so a failing row is found by
   * eye in a column of grey.
   */
  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  const TICK: Record<ContainerState, string> = {
    running: "bg-[var(--text-muted)] opacity-50",
    waiting: "bg-[var(--status-pending)]",
    error: "bg-[var(--status-failed)]",
    terminated: "bg-[var(--text-muted)] opacity-25",
  };
</script>

<div class="flex shrink-0 items-center gap-0.5">
  {#each containerStates(resource) as c (c.name)}
    <span class={cn("h-3.5 w-1 rounded-[1px]", TICK[c.state])} title="{c.name} ({c.state})"></span>
  {/each}
</div>
