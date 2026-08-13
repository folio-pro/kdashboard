<script lang="ts">
  /**
   * One annotation value: truncated to a single line, expanding to a scrollable
   * pre on click.
   *
   * The same button/pre pair was written out five times — AnnotationsCard, the
   * generic tool group, and the Istio and Ambassador groups (twice) — always
   * with the same classes and the same `hover:underline` only-while-collapsed
   * rule. The set of expanded keys stays with the caller, which is what decides
   * whether keys collapse independently or together.
   */
  interface Props {
    /** The one-line form shown while collapsed. */
    value: string;
    /** The formatted form shown while expanded; defaults to `value`. */
    formatted?: string;
    expanded: boolean;
    ontoggle: () => void;
  }

  let { value, formatted, expanded, ontoggle }: Props = $props();
</script>

<button
  class="text-left font-mono text-[11px] text-[var(--accent)] {expanded ? '' : 'hover:underline'}"
  onclick={ontoggle}
  aria-expanded={expanded}
>
  {#if expanded}
    <pre
      class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">{formatted ??
        value}</pre>
  {:else}
    <span class="block truncate">{value}</span>
  {/if}
</button>
