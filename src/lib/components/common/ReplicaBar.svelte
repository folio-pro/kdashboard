<script lang="ts">
  import { cn } from "$lib/utils";

  /**
   * The replica count as a bar: ready (accent), pods that exist but are not
   * ready yet (pending tone), and the gap to the desired count (a faint
   * failed tint). One glance says "2 of 3, one still coming up" where
   * "2/3" alone does not.
   */
  interface Props {
    ready: number;
    pending: number;
    missing: number;
    class?: string;
    /** Bar thickness, in px. */
    height?: number;
  }

  let { ready, pending, missing, class: className, height = 4 }: Props = $props();

  let total = $derived(ready + pending + missing);
  let title = $derived(
    total === 0
      ? "No replicas desired"
      : `${ready} ready · ${pending} not ready · ${missing} missing`,
  );
</script>

<span
  class={cn("inline-flex w-16 shrink-0 overflow-hidden rounded-full bg-[var(--bg-tertiary)]", className)}
  style:height="{height}px"
  style:gap="1px"
  role="img"
  aria-label={title}
  {title}
>
  {#if ready > 0}
    <span class="block h-full bg-[var(--accent)]" style:flex="{ready} {ready} 0"></span>
  {/if}
  {#if pending > 0}
    <span class="block h-full bg-[var(--status-pending)]" style:flex="{pending} {pending} 0"></span>
  {/if}
  {#if missing > 0}
    <span
      class="block h-full"
      style:flex="{missing} {missing} 0"
      style:background-color="color-mix(in srgb, var(--status-failed) 55%, transparent)"
    ></span>
  {/if}
</span>
