<script lang="ts">
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loader = () => Promise<{ default: any }>;

  let { loader, label }: { loader: Loader; label: string } = $props();
</script>

{#await loader() then mod}
  <mod.default />
{:catch}
  <p class="p-4 text-xs text-[var(--status-failed)]">Failed to load {label}.</p>
{/await}
