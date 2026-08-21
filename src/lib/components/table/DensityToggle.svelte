<script lang="ts">
  import { Rows3, Rows4, Terminal } from "lucide-svelte";
  import { Button } from "$lib/components/ui";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { DENSITY_ORDER, DENSITY_LABEL } from "./table-density";
  import type { TableDensity } from "$lib/types";

  /** Three presets, one click away — this setting used to live only in the context menu. */
  const ICON: Record<TableDensity, typeof Rows3> = { comfortable: Rows3, compact: Rows4, terminal: Terminal };
</script>

<div
  class="flex h-7 shrink-0 items-center gap-0.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-0.5"
  role="radiogroup"
  aria-label="Row density"
>
  {#each DENSITY_ORDER as d (d)}
    {@const Icon = ICON[d]}
    {@const active = settingsStore.settings.table_density === d}
    <Button
      variant="segment"
      size="icon-xs"
      {active}
      activeStyle="raised"
      role="radio"
      aria-checked={active}
      title={DENSITY_LABEL[d]}
      aria-label="{DENSITY_LABEL[d]} density"
      onclick={() => settingsStore.updateDensity(d)}
    >
      <Icon class="h-3.5 w-3.5" />
    </Button>
  {/each}
</div>
