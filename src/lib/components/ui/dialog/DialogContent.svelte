<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { Dialog } from "bits-ui";
  import { X } from "lucide-svelte";
  import DialogOverlay from "./DialogOverlay.svelte";
  import type { Snippet } from "svelte";

  interface Props {
    class?: string;
    children?: Snippet;
    [key: string]: unknown;
  }

  let { class: className, children, ...restProps }: Props = $props();
</script>

<Dialog.Portal>
  <DialogOverlay />
  <Dialog.Content
    class={cn(
      "fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border border-[var(--border-color)] bg-[var(--bg-primary)] p-6 shadow-lg duration-200",
      "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
      "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
      "sm:rounded-lg",
      className
    )}
    {...restProps}
  >
    {#if children}{@render children()}{/if}
    <Dialog.Close
      class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-[var(--bg-primary)] transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 disabled:pointer-events-none"
    >
      <X class="h-4 w-4" />
      <span class="sr-only">Close</span>
    </Dialog.Close>
  </Dialog.Content>
</Dialog.Portal>
