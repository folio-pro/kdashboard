<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The overview's body. In the detail tab (`page`) it is two columns: what
   * changes over time on the left (containers, rollout, endpoints, events),
   * what is structural in a 380px rail on the right (conditions, network,
   * related, labels). In the docked aside both stacks run in one column,
   * main first.
   */
  interface Props {
    layout: "page" | "aside";
    main: Snippet;
    rail: Snippet;
  }

  let { layout, main, rail }: Props = $props();
</script>

{#if layout === "page"}
  <!-- Two columns only when the tab is wide enough for both (container
       query, not viewport: the sidebar and the window both move the width).
       Below that the rail stacks under the main column, as in the aside. -->
  <div class="@container">
    <div class="grid grid-cols-1 items-start @[900px]:grid-cols-[minmax(0,1fr)_380px]">
      <div class="flex min-w-0 flex-col @[900px]:border-r @[900px]:border-[var(--border-color)]">{@render main()}</div>
      <div class="flex min-w-0 flex-col">{@render rail()}</div>
    </div>
  </div>
{:else}
  {@render main()}
  {@render rail()}
{/if}
