<script lang="ts">
  import type { Snippet } from "svelte";
  import { AlertTriangle } from "lucide-svelte";

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
  class="mx-6 mt-4 rounded-md p-3.5"
  style="background-color: color-mix(in srgb, {color} 8%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, {color} 25%, transparent);"
  role="status"
  data-testid="attention-block"
>
  <div class="flex items-start gap-2 text-[12px] font-semibold leading-[17px]" style:color>
    <AlertTriangle class="mt-px h-3.5 w-3.5 shrink-0" />
    <span class="min-w-0 break-words">{title}</span>
  </div>
  {#if children}
    <div class="mt-2 flex flex-col gap-1 text-[12px] leading-[17px] text-[var(--text-secondary)] [&_code]:font-mono [&_code]:text-[var(--text-primary)] [&_b]:font-medium [&_b]:text-[var(--text-primary)]">
      {@render children()}
    </div>
  {/if}
  {#if actions}
    <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
      {@render actions()}
    </div>
  {/if}
</div>
