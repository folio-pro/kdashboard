<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { Dialog } from "bits-ui";

  interface Props {
    class?: string;
    [key: string]: unknown;
  }

  let { class: className, ...restProps }: Props = $props();
</script>

<Dialog.Overlay
  class={cn(
    "fixed inset-0 z-50 bg-black/80",
    "data-[state=open]:animate-in data-[state=open]:fade-in-0",
    "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
    className
  )}
  {...restProps}
/>
