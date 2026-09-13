<script lang="ts">
  import type { Component } from "svelte";
  import { toastStore } from "$lib/stores/toast.svelte";

  interface Props {
    loader: () => Promise<{ default: Component<any> }>;
    /** Bindable dialog open flag. Omit for dialogs that take no `open` prop. */
    open?: boolean;
    /** Extra props forwarded verbatim to the loaded component. */
    props?: Record<string, unknown>;
    /** Display label used in the failure toast. */
    name?: string;
    /**
     * Called when the chunk fails to load. The caller owns the flag that keeps
     * this component mounted, so it MUST clear it here: otherwise the app
     * believes a dialog is open that it can neither render nor dismiss, and
     * re-triggering the action stays a no-op.
     */
    onerror?: () => void;
  }

  let { loader, open = $bindable(), props = {}, name = "dialog", onerror }: Props = $props();

  // Pin the promise to this instance so a parent re-render (which passes a
  // fresh arrow for `loader`) does not restart the import. The enclosing
  // {#if} remounts this component per open, which is when a real re-import
  // would be wanted anyway.
  // svelte-ignore state_referenced_locally
  const promise = loader().catch((err) => {
    // svelte-ignore state_referenced_locally
    toastStore.error(`Couldn't open the ${name}`, String(err));
    // svelte-ignore state_referenced_locally
    onerror?.();
    throw err;
  });
</script>

{#await promise then mod}
  {#if open === undefined}
    <mod.default {...props} />
  {:else}
    <mod.default bind:open {...props} />
  {/if}
{:catch}
  <!-- Reported by the toast above and unwound through onerror, so a failed
       dialog leaves nothing stranded in the layout. -->
{/await}
