<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    children: Snippet;
  }

  let { title, children }: Props = $props();
</script>

<!-- Flat list: no accordion. The header sticks to the top of the scroll
     container while its section's rows pass underneath. -->
<div class="mt-3.5">
  <div
    class="sticky top-0 z-[1] border-t border-[var(--border-color)] px-[13px] pt-2.5 pb-1.5"
    style="background: linear-gradient(var(--sidebar-bg) 82%, transparent); backdrop-filter: blur(2px);"
  >
    <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">{title}</span>
  </div>
  <div class="flex flex-col">
    {@render children()}
  </div>
</div>
