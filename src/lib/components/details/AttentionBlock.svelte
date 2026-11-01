<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * Why this thing is not healthy, and what to do next — shown only when
   * something is wrong. A title line, a few lines of evidence (last exit
   * code, the latest Warning event), and actions that jump to logs/events.
   */
  interface Props {
    tone?: "error" | "warning";
    title: string;
    children?: Snippet;
    actions?: Snippet;
  }

  let { tone = "error", title, children, actions }: Props = $props();
  let color = $derived(tone === "error" ? "var(--status-failed)" : "var(--status-pending)");
</script>

<div
  class="mx-4 mt-4 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3"
  role="status"
  data-testid="attention-block"
>
  <div class="flex items-center gap-2 text-[13px] font-medium" style:color>
    <span class="h-1.5 w-1.5 shrink-0 rounded-full" style:background-color={color}></span>
    <span class="min-w-0 break-words">{title}</span>
  </div>
  {#if children}
    <div class="mt-2 flex flex-col gap-1 pl-3.5 text-[12px] leading-[17px] text-[var(--text-secondary)] [&_code]:font-mono [&_code]:text-[var(--text-primary)] [&_b]:font-medium [&_b]:text-[var(--text-primary)]">
      {@render children()}
    </div>
  {/if}
  {#if actions}
    <div class="mt-2 flex flex-wrap items-center gap-2 pl-3.5">
      {@render actions()}
    </div>
  {/if}
</div>
