<script lang="ts">
  import type { Component } from "svelte";

  interface Props {
    loader: () => Promise<{ default: Component<any> }>;
    /** Bindable dialog open flag. Omit for dialogs that take no `open` prop. */
    open?: boolean;
    /** Extra props forwarded verbatim to the loaded component. */
    props?: Record<string, unknown>;
    /** Display label used in the error fallback. */
    name?: string;
  }

  let { loader, open = $bindable(), props = {}, name = "dialog" }: Props = $props();

  // Pin the promise to this instance so a parent re-render (which passes a
  // fresh arrow for `loader`) does not restart the import. The enclosing
  // {#if} remounts this component per open, which is when a real re-import
  // would be wanted anyway.
  // svelte-ignore state_referenced_locally
  const promise = loader();
</script>

{#await promise then mod}
  {#if open === undefined}
    <mod.default {...props} />
  {:else}
    <mod.default bind:open {...props} />
  {/if}
{:catch}
  <p class="p-4 text-[12px] text-[var(--status-failed)]">
    Failed to load {name}.
  </p>
{/await}
