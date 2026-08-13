<script lang="ts">
  import { cn } from "$lib/utils.js";

  let { class: className }: { class?: string } = $props();
</script>

<div class={cn("my-1 h-px bg-[var(--border-color)]", className)} role="separator"></div>
