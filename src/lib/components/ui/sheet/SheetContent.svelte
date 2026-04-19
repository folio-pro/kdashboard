<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { Dialog } from "bits-ui";
  import { X } from "lucide-svelte";
  import type { Snippet } from "svelte";

  type Side = "top" | "bottom" | "left" | "right";

  interface Props {
    class?: string;
    side?: Side;
    overlay?: boolean;
    interactOutside?: boolean;
    children?: Snippet;
    [key: string]: unknown;
  }

  const sideStyles: Record<Side, string> = {
    top: "inset-x-0 top-0 border-b data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top",
    bottom: "inset-x-0 bottom-0 border-t data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
    left: "inset-y-0 left-0 h-full border-r data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
    right: "inset-y-0 right-0 h-full border-l data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
  };

  let { class: className, side = "right", overlay = true, interactOutside = true, children, ...restProps }: Props = $props();

  function handleInteractOutside(e: Event) {
    if (!interactOutside) e.preventDefault();
  }
</script>

<Dialog.Portal>
  {#if overlay}
    <Dialog.Overlay
      class={cn(
        "fixed inset-0 z-50 bg-black/50",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
      )}
    />
  {/if}
  <Dialog.Content
    class={cn(
      "fixed z-50 flex flex-col border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg transition-transform duration-200 ease-in-out",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      sideStyles[side],
      className,
    )}
    onInteractOutside={handleInteractOutside}
    {...restProps}
  >
    {#if children}{@render children()}{/if}
    <Dialog.Close
      class="absolute right-4 top-4 rounded-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus:outline-none"
    >
      <X class="h-4 w-4" />
      <span class="sr-only">Close</span>
    </Dialog.Close>
  </Dialog.Content>
</Dialog.Portal>
