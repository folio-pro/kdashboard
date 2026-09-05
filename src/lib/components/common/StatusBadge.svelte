<script lang="ts">
  import { statusCategory, statusColor } from "$lib/components/table/status-category";

  interface Props {
    status: string;
  }

  let { status }: Props = $props();

  let category = $derived(statusCategory(status));
  let color = $derived(statusColor(category));
  let displayText = $derived(status.toLowerCase());
  // A soft glow on success/error dots makes live status read at a glance,
  // matching the reference console's pill treatment.
  let glow = $derived(
    category === "success" || category === "error"
      ? `0 0 6px color-mix(in srgb, ${color} 55%, transparent)`
      : "none"
  );
</script>

<span class="inline-flex items-center gap-1.5">
  <span
    class="h-1.5 w-1.5 shrink-0 rounded-full"
    style="background-color: {color}; box-shadow: {glow};"
  ></span>
  <span
    class="text-[12px] font-medium"
    style="color: {color};"
  >
    {displayText}
  </span>
</span>
