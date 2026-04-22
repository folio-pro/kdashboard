<script lang="ts">
  import type { Component } from "svelte";

  interface Props {
    loader: () => Promise<{ default: Component }>;
    /** Display label used in the error fallback (e.g. "overview", "settings"). */
    name: string;
  }

  const { loader, name }: Props = $props();

  // Pin the promise to this component instance so parent re-renders (which
  // pass a fresh arrow for `loader`) don't trigger a remount of the loaded
  // view. A real re-import happens naturally when the parent's {#if} branch
  // changes, because that mounts a new LazyView instance.
  // svelte-ignore state_referenced_locally
  const promise = loader();
</script>

{#await promise then mod}
  <mod.default />
{:catch}
  <p class="p-4 text-xs text-[var(--status-failed)]">
    Failed to load {name} view.
  </p>
{/await}
