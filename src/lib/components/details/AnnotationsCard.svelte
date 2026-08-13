<script lang="ts">
  import AnnotationValue from "./AnnotationValue.svelte";

  interface Props {
    annotations: Record<string, string>;
  }

  let { annotations }: Props = $props();

  let expanded = $state<Set<string>>(new Set());

  // Precompute JSON detection + prettified values once per annotations change
  let jsonMap = $derived<Record<string, string>>(
    Object.fromEntries(
      Object.entries(annotations)
        .filter(([, v]) => {
          const t = v.trimStart();
          if (!t.startsWith("{") && !t.startsWith("[")) return false;
          try { JSON.parse(v); return true; } catch { return false; }
        })
        .map(([k, v]) => [k, JSON.stringify(JSON.parse(v), null, 2)])
    )
  );

  function toggle(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }
</script>

{#if Object.keys(annotations).length > 0}
  <div class="overflow-hidden rounded-sm border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center justify-between px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Annotations</h3>
      <span class="text-[12px] text-[var(--text-muted)]">{Object.keys(annotations).length}</span>
    </div>
    {#each Object.entries(annotations) as [key, value]}
      {@const pretty = jsonMap[key]}
      {@const isExpanded = expanded.has(key)}
      <div class="flex flex-col gap-0.5 border-t border-[var(--border-hover)] px-5 py-3.5">
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{key}</span>
        {#if pretty}
          <AnnotationValue
            {value}
            formatted={pretty}
            expanded={isExpanded}
            ontoggle={() => toggle(key)}
          />
        {:else}
          <span class="truncate font-mono text-[11px] text-[var(--text-primary)]">{value}</span>
        {/if}
      </div>
    {/each}
  </div>
{/if}
