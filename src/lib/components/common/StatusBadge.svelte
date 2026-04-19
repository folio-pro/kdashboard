<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    status: string;
  }

  let { status }: Props = $props();

  type StatusCategory = "success" | "warning" | "error" | "info" | "orange" | "muted";

  const statusCategoryMap: Record<string, StatusCategory> = {
    running: "success",
    active: "success",
    ready: "success",
    available: "success",
    bound: "success",
    "true": "success",
    succeeded: "info",
    completed: "info",
    complete: "info",
    pending: "warning",
    containercreating: "warning",
    waiting: "warning",
    failed: "error",
    error: "error",
    crashloopbackoff: "error",
    imagepullbackoff: "error",
    evicted: "error",
    oomkilled: "error",
    "false": "error",
    terminating: "orange",
    unknown: "muted",
  };

  const categoryColors: Record<StatusCategory, string> = {
    success: "var(--status-running)",
    warning: "var(--status-pending)",
    error: "var(--status-failed)",
    info: "var(--status-succeeded)",
    orange: "var(--status-terminating)",
    muted: "var(--text-muted)",
  };

  let category = $derived<StatusCategory>(
    statusCategoryMap[status.toLowerCase()] ?? "muted"
  );

  let color = $derived(categoryColors[category]);
  let displayText = $derived(status.toLowerCase());
</script>

<span class="inline-flex items-center gap-1.5">
  <span
    class="h-1.5 w-1.5 shrink-0 rounded-full"
    style="background-color: {color};"
  ></span>
  <span
    class="text-xs font-medium"
    style="color: {color};"
  >
    {displayText}
  </span>
</span>
