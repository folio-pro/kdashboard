<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<!-- Reference console kv-grid: responsive key/value columns. Single source of
     truth for the layout shared by every detail view's Metadata/Spec sections. -->
<div class="grid gap-x-8 gap-y-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
  {@render children()}
</div>
