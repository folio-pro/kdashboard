<script lang="ts">
  import { cn } from "$lib/utils";

  let { class: className = "", ...restProps }: { class?: string; [key: string]: unknown } = $props();
</script>

<div
  class={cn("animate-pulse rounded bg-[var(--bg-tertiary)]", className)}
  {...restProps}
></div>
