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
   *
   * The <pre> is a sibling of the button, not its child: <button> takes
   * phrasing content, and a flow element inside it is invalid markup that
   * browsers recover from by hoisting the block out, which is how the value
   * ended up outside the control it was supposed to be inside.
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

<div class="flex min-w-0 flex-col gap-1">
  <!-- The trigger keeps showing the one-line value in both states, so the
       affordance does not move when it expands. Previously the expanded <pre>
       WAS the button, which meant selecting text inside it also collapsed it. -->
  <button
    type="button"
    class="truncate text-left font-mono text-[11px] text-[var(--accent)] hover:underline"
    onclick={ontoggle}
    aria-expanded={expanded}
  >
    {value}
  </button>
  {#if expanded}
    <pre
      class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">{formatted ??
        value}</pre>
  {/if}
</div>
