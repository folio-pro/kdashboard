<script lang="ts">
  import { Dialog as SheetPrimitive } from "bits-ui";
  import type { Snippet } from "svelte";

  interface Props {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: Snippet;
  }

  let { open = $bindable(false), onOpenChange, children }: Props = $props();
</script>

<SheetPrimitive.Root bind:open {onOpenChange}>
  {#if children}{@render children()}{/if}
</SheetPrimitive.Root>
