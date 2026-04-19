<script lang="ts">
  import { cn } from "$lib/utils";
  import type { Resource, Column } from "$lib/types";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { formatAge } from "$lib/utils/age";
  import { Box } from "lucide-svelte";
  import { getContainerIconUrl } from "$lib/utils/container-icon";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { costStore } from "$lib/stores/cost.svelte";
  import { extensions } from "$lib/extensions";

  interface Props {
    resource: Resource;
    columns: Column[];
    selected: boolean;
    highlighted: boolean;
    resourceType: string;
    onclick: () => void;
    ondblclick?: () => void;
    oncontextmenu?: (event: MouseEvent) => void;
    density: "comfortable" | "compact";
    checkboxChecked?: boolean;
    oncheck?: () => void;
    ondblclickcopy?: (value: string) => void;
  }

  let { resource, columns, selected, highlighted, resourceType, onclick, ondblclick, oncontextmenu, density, checkboxChecked = false, oncheck, ondblclickcopy }: Props = $props();

  let trailingMounts = $derived(
    extensions.mountsFor("table-row-trailing").filter((m) => !m.visible || m.visible()),
  );

  let rowHeight = $derived(density === "compact" ? "h-8" : "h-10");

  let failedIcons: Set<string> = $state(new Set());

  type ContainerState = "running" | "waiting" | "error" | "terminated";

  interface ContainerInfo {
    name: string;
    ready: boolean;
    iconUrl: string | null;
    state: ContainerState;
  }

  let containerStatuses = $derived.by((): ContainerInfo[] => {
    const cs = resource.status?.containerStatuses as Array<{ name: string; ready: boolean; image: string; state?: Record<string, unknown> }> | undefined;
    if (!cs) return [];
    return cs.map((c) => {
      const img = c.image ?? "";
      const url = img ? getContainerIconUrl(img) : null;
      let state: ContainerState = "running";
      if (c.state) {
        if (c.state.waiting) {
          const reason = (c.state.waiting as { reason?: string }).reason ?? "";
          state = /error|crash|backoff/i.test(reason) ? "error" : "waiting";
        } else if (c.state.terminated) {
          const exitCode = (c.state.terminated as { exitCode?: number }).exitCode;
          state = exitCode && exitCode !== 0 ? "error" : "terminated";
        }
      }
      if (!c.ready && state === "running") state = "waiting";
      return {
        name: c.name,
        ready: c.ready,
        iconUrl: (url && !failedIcons.has(url)) ? url : null,
        state,
      };
    });
  });

  function containerStateColor(state: ContainerState): string {
    switch (state) {
      case "running": return "var(--status-running)";
      case "waiting": return "var(--status-pending)";
      case "error": return "var(--status-failed)";
      case "terminated": return "var(--text-muted)";
    }
  }

  function containerIconFilter(state: ContainerState): string {
    switch (state) {
      case "error": return "grayscale(1) brightness(0.7) sepia(1) hue-rotate(-30deg) saturate(5)";
      case "waiting": return "grayscale(1) brightness(0.9) sepia(1) hue-rotate(15deg) saturate(3)";
      default: return "none";
    }
  }

  function handleIconError(url: string) {
    if (failedIcons.has(url)) return;
    const next = new Set(failedIcons);
    next.add(url);
    failedIcons = next;
  }

  function getCellValue(key: string): string {
    const meta = resource.metadata;
    const status = resource.status ?? {};
    const spec = resource.spec ?? {};

    switch (key) {
      case "name":
        return meta.name;
      case "namespace":
        return meta.namespace ?? "-";
      case "age":
        // Read ageTick to trigger re-render every 30s
        void k8sStore.ageTick;
        return formatAge(meta.creation_timestamp);
      case "status":
      case "phase":
        return (status.phase as string) ?? (status.status as string) ?? "-";
      case "ready": {
        const cs = status.containerStatuses as Array<{ ready: boolean }> | undefined;
        if (!cs) return "-";
        const readyCount = cs.filter((c) => c.ready).length;
        return `${readyCount}/${cs.length}`;
      }
      case "restarts": {
        const cs2 = status.containerStatuses as Array<{ restartCount: number }> | undefined;
        if (!cs2) return "0";
        return cs2.reduce((sum, c) => sum + (c.restartCount ?? 0), 0).toString();
      }
      case "node":
        return (spec.nodeName as string) ?? (status.nodeName as string) ?? "-";
      case "ip":
        return (status.podIP as string) ?? "-";
      case "deployReady": {
        const desired = (spec.replicas as number) ?? 0;
        const ready = (status.readyReplicas as number) ?? 0;
        return `${ready}/${desired}`;
      }
      case "upToDate":
        return ((status.updatedReplicas as number) ?? 0).toString();
      case "available":
        return ((status.availableReplicas as number) ?? 0).toString();
      case "type":
        return (spec.type as string) ?? "-";
      case "clusterIP":
        return (spec.clusterIP as string) ?? "-";
      case "externalIP": {
        const lb = status.loadBalancer as Record<string, unknown> | undefined;
        const ext = lb?.ingress as Array<{ ip: string }> | undefined;
        if (ext && ext.length > 0) return ext.map((e) => e.ip).join(", ");
        return (spec.externalIPs as string[])?.join(", ") ?? "-";
      }
      case "ports": {
        const ports = spec.ports as Array<{ port: number; protocol: string; targetPort?: number }> | undefined;
        if (!ports) return "-";
        return ports.map((p) => `${p.port}/${p.protocol ?? "TCP"}`).join(", ");
      }
      case "roles": {
        const labels = meta.labels ?? {};
        const roles = Object.keys(labels)
          .filter((l) => l.startsWith("node-role.kubernetes.io/"))
          .map((l) => l.replace("node-role.kubernetes.io/", ""));
        return roles.length > 0 ? roles.join(", ") : "-";
      }
      case "version": {
        const nodeInfo = status.nodeInfo as Record<string, unknown> | undefined;
        return (nodeInfo?.kubeletVersion as string) ?? "-";
      }
      case "instanceType": {
        const nc = costStore.getNodeCost(meta.name);
        return nc ? nc.instance_type : (meta.labels?.["node.kubernetes.io/instance-type"] ?? "-");
      }
      case "nodeCost": {
        const nc2 = costStore.getNodeCost(meta.name);
        if (!nc2 || nc2.price_per_month <= 0) return "-";
        return `$${nc2.price_per_month.toFixed(2)}`;
      }
      case "data": {
        const data = resource.data ?? resource.spec?.data ?? resource.status?.data;
        if (data && typeof data === "object") return Object.keys(data).length.toString();
        return "0";
      }
      default:
        return "-";
    }
  }

  function getStatusValue(): string {
    const status = resource.status ?? {};
    return (status.phase as string) ?? (status.status as string) ?? "";
  }

  let isStatusColumn = (key: string) => key === "status" || key === "phase";
  let isContainersColumn = (key: string) => key === "containers";
  let isUsageColumn = (key: string) => key === "cpuUsage" || key === "memUsage";

  function getUsageData(key: string): { percent: number; label: string } | null {
    const m = costStore.getNodeMetrics(resource.metadata.name);
    if (!m) return null;
    if (key === "cpuUsage") {
      const cores = m.cpu_usage < 1 ? `${Math.round(m.cpu_usage * 1000)}m` : m.cpu_usage.toFixed(1);
      return { percent: m.cpu_percent, label: `${cores} / ${m.cpu_capacity.toFixed(0)}` };
    }
    const used = m.memory_usage / (1024 * 1024 * 1024);
    const cap = m.memory_capacity / (1024 * 1024 * 1024);
    return { percent: m.memory_percent, label: `${used.toFixed(1)} / ${cap.toFixed(0)} Gi` };
  }

  function usageBarColor(pct: number): string {
    if (pct >= 90) return "var(--status-failed)";
    if (pct >= 70) return "var(--status-pending)";
    return "var(--status-running)";
  }

  function handleCellDblClick(event: MouseEvent, key: string) {
    event.stopPropagation();
    const value = getCellValue(key);
    if (!value || value === "-" || value === "<none>") return;

    const td = (event.target as HTMLElement).closest("td") as HTMLElement | null;

    navigator.clipboard.writeText(value).then(() => {
      if (td) {
        td.classList.add("cell-copied-flash");
        setTimeout(() => td.classList.remove("cell-copied-flash"), 600);
      }
      ondblclickcopy?.(value);
    }).catch(() => {
      // clipboard write failed silently
    });
  }
</script>

<style>
  :global(.cell-copied-flash) {
    animation: cellFlash 0.6s ease-out;
  }

  @keyframes cellFlash {
    0% {
      background-color: var(--accent);
      color: white;
    }
    100% {
      background-color: transparent;
    }
  }
</style>

<tr
  class={cn(
    "cursor-pointer border-b border-[var(--border-hover)] transition-colors",
    rowHeight,
    selected
      ? "bg-[var(--accent)]/10"
      : highlighted
        ? "bg-[var(--accent)]/5 ring-1 ring-inset ring-[var(--accent)]/20"
        : "hover:bg-[var(--table-row-hover)]"
  )}
  onclick={onclick}
  ondblclick={ondblclick}
  oncontextmenu={oncontextmenu}
  tabindex={highlighted ? 0 : -1}
  aria-selected={selected || highlighted}
  role="row"
>
  {#if oncheck}
    <td class="w-10 px-4 text-center" onclick={(e) => e.stopPropagation()}>
      <Checkbox
        checked={checkboxChecked}
        onCheckedChange={oncheck}
        aria-label="Select row"
      />
    </td>
  {/if}
  {#each columns as column}
    <td
      class="overflow-hidden px-4 text-xs"
      ondblclick={(e) => handleCellDblClick(e, column.key)}
    >
      {#if isContainersColumn(column.key)}
        <div class="flex items-center gap-1.5 overflow-hidden">
          {#each containerStatuses as c}
            <div
              class="relative flex h-6 w-6 shrink-0 items-center justify-center rounded border border-[var(--border-hover)] bg-[var(--bg-tertiary)]"
              title="{c.name} ({c.state})"
            >
              {#if c.iconUrl}
                <img
                  src={c.iconUrl}
                  alt={c.name}
                  class="h-4 w-4 object-contain"
                  style:filter={containerIconFilter(c.state)}
                  onerror={() => handleIconError(c.iconUrl!)}
                />
              {:else}
                <span style:color={containerStateColor(c.state)}><Box class="h-3.5 w-3.5" /></span>
              {/if}
            </div>
          {/each}
        </div>
      {:else if isUsageColumn(column.key)}
        {@const usage = getUsageData(column.key)}
        {#if usage}
          <div class="flex items-center gap-2">
            <div class="h-1.5 flex-1 rounded-full bg-[var(--bg-tertiary)] overflow-hidden" title="{usage.percent}%">
              <div
                class="h-full rounded-full transition-all duration-300"
                style="width: {usage.percent}%; background-color: {usageBarColor(usage.percent)}"
              ></div>
            </div>
            <span class="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">{usage.label}</span>
          </div>
        {:else}
          <span class="text-[var(--text-muted)]">—</span>
        {/if}
      {:else if isStatusColumn(column.key)}
        {@const val = getStatusValue()}
        {#if val}
          <StatusBadge status={val} />
        {:else}
          <span class="text-[var(--text-muted)]">-</span>
        {/if}
      {:else}
        {@const cellValue = getCellValue(column.key)}
        <span
          class={cn(
            "block truncate text-[var(--text-secondary)]",
            column.key === "name" && "font-medium text-[var(--text-primary)]",
            column.key === "node" && "text-[11px] text-[var(--text-muted)]",
            column.key === "restarts" && cellValue !== "0" && "text-[var(--status-failed)] font-medium"
          )}
          title={cellValue}
        >
{#if column.key === "name" && uiStore.filter}{@const idx = cellValue.toLowerCase().indexOf(uiStore.filterLower)}{#if idx >= 0}{cellValue.slice(0, idx)}<span style="color:var(--accent)">{cellValue.slice(idx, idx + uiStore.filter.length)}</span>{cellValue.slice(idx + uiStore.filter.length)}{:else}{cellValue}{/if}{:else}{cellValue}{/if}
        </span>
      {/if}
    </td>
  {/each}
  {#each trailingMounts as mount (mount.id)}
    <mount.component {resource} />
  {/each}
</tr>
