<script lang="ts">
  import { statusCategory, statusColor } from "$lib/components/table/status-category";

  interface Props {
    status: string;
  }

  let { status }: Props = $props();

  let category = $derived(statusCategory(status));
  let color = $derived(statusColor(category));
</script>

<!-- The reason stays exactly as Kubernetes spells it: CrashLoopBackOff is a
     term people search for, not a sentence to lowercase. -->
<span class="inline-flex items-center gap-1.5">
  <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background-color: {color};"></span>
  <span class="text-[12px] font-medium" style="color: {color};">{status}</span>
</span>
