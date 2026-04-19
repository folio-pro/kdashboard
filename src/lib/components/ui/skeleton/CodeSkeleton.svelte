<script lang="ts">
  import Skeleton from "./Skeleton.svelte";

  interface Props {
    lines?: number;
    lineHeight?: string;
    spacing?: string;
    gutterPadding?: string;
    contentPadding?: string;
    fullHeight?: boolean;
  }

  let {
    lines = 20,
    lineHeight = "h-2.5",
    spacing = "space-y-2",
    gutterPadding = "px-3 py-3",
    contentPadding = "p-3",
    fullHeight = false,
  }: Props = $props();

  const widths = ["w-1/3", "w-3/4", "w-1/2", "w-5/6", "w-2/5", "w-2/3", "w-1/4", "w-4/5", "w-3/5", "w-1/2"];
  let opacityStep = $derived(0.8 / Math.max(1, lines - 1));
</script>

<div class="flex" class:h-full={fullHeight}>
  <!-- Line numbers gutter -->
  <div class="shrink-0 border-r border-[var(--border-color)] bg-[var(--bg-secondary)] {gutterPadding} {spacing}">
    {#each Array(lines) as _, i}
      <Skeleton class="{lineHeight} w-5 ml-auto" style="opacity: {Math.max(0.1, 1 - i * opacityStep)}" />
    {/each}
  </div>
  <!-- Code lines -->
  <div class="flex-1 {contentPadding} {spacing}">
    {#each Array(lines) as _, i}
      <Skeleton class="{lineHeight} {widths[i % widths.length]}" style="opacity: {Math.max(0.1, 1 - i * opacityStep)}" />
    {/each}
  </div>
</div>
