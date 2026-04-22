<script lang="ts">
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loader = () => Promise<{ default: any }>;

  let { loader, label }: { loader: Loader; label: string } = $props();

  // Pin the Promise at mount so {#await} doesn't re-subscribe (and remount
  // the child) when the parent re-renders with a fresh loader closure.
  // svelte-ignore state_referenced_locally
  const importPromise = loader();
</script>

{#await importPromise then mod}
  <mod.default />
{:catch}
  <p class="p-4 text-xs text-[var(--status-failed)]">Failed to load {label}.</p>
{/await}
