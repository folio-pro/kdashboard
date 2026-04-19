<script lang="ts">
  import { cn } from "$lib/utils.js";

  interface Props {
    class?: string;
  }

  let { class: className }: Props = $props();
</script>

<div class={cn("-mx-1 h-px bg-[var(--border-color)]", className)}></div>
