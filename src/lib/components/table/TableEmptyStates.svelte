<script lang="ts">
  import type { Column } from "$lib/types";
  import { AlertTriangle, Inbox, Lock, PackageX, RefreshCw } from "lucide-svelte";
  import { classifyLoadError } from "./table-load-error";
  import { Button } from "$lib/components/ui";
  import { Skeleton } from "$lib/components/ui/skeleton";

  let {
    state,
    columns,
    resourceTypeLabel,
    error = null,
    hasStatFilter = false,
    hasTextFilter = false,
    clusterScoped = false,
    onretry,
    onclearStatFilter,
    onclearTextFilter,
  }: {
    state: "loading" | "error" | "empty";
    columns: Column[];
    resourceTypeLabel: string;
    error?: string | null;
    hasStatFilter?: boolean;
    hasTextFilter?: boolean;
    /** The kind lives outside namespaces (Node, ClusterRole, a Cluster CRD): "in this cluster", not "in this namespace". */
    clusterScoped?: boolean;
    onretry: () => void;
    onclearStatFilter: () => void;
    onclearTextFilter: () => void;
  } = $props();
</script>

{#if state === "loading"}
  <table class="w-full" style="table-layout: fixed;">
    <thead class="sticky top-0 z-10 bg-[var(--bg-primary)]">
      <tr class="border-b border-[var(--border-color)]">
        <th class="h-8 p-0" style="width: 28px;"></th>
        {#each columns as column}
          <th
            class="h-8 overflow-hidden px-3.5 text-left"
            style={column.width ? `width: ${column.width}` : ""}
          >
            <Skeleton class="h-3 w-16" />
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each Array(12) as _, i}
        <tr
          class="h-9 border-b border-[var(--hairline)]"
          style="opacity: {Math.max(0.1, 1 - i * 0.06)}"
        >
          <td class="p-0" style="width: 28px;"></td>
          {#each columns as column, j}
            <td
              class="overflow-hidden px-3.5"
              style={column.width ? `width: ${column.width}` : ""}
            >
              <Skeleton class="h-3 {j === 0 ? 'w-3/4' : 'w-1/2'}" />
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
{:else if state === "error"}
  {@const view = classifyLoadError(error, resourceTypeLabel)}
  {@const unreachable = view.kind === "unreachable"}
  <div class="flex h-full items-center justify-center" data-testid="table-error" data-error-kind={view.kind}>
    <div class="flex max-w-md flex-col items-center gap-4 px-10 py-16 text-center">
      <div
        class={unreachable
          ? "flex h-14 w-14 items-center justify-center rounded-xl border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/10 text-[var(--status-failed)]"
          : "flex h-14 w-14 items-center justify-center rounded-xl border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 text-[var(--status-warning)]"}
      >
        {#if view.kind === "not-installed"}
          <PackageX class="h-6 w-6" />
        {:else if view.kind === "forbidden"}
          <Lock class="h-6 w-6" />
        {:else}
          <AlertTriangle class="h-6 w-6" />
        {/if}
      </div>
      <div class="text-[15px] font-semibold text-[var(--text-primary)]">{view.title}</div>
      <p class="max-w-sm text-[13px] leading-relaxed text-[var(--text-muted)]" title={error ?? ""}>{view.detail}</p>
      <Button variant="toolbar" size="md" class="mt-1" onclick={onretry}>
        <RefreshCw class="h-3.5 w-3.5" />
        {view.action}
      </Button>
    </div>
  </div>
{:else}
  <div class="flex h-full items-center justify-center">
    <div class="flex max-w-md flex-col items-center gap-4 px-10 py-16 text-center">
      <div class="flex h-14 w-14 items-center justify-center rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
        <Inbox class="h-6 w-6" />
      </div>
      <div class="text-[15px] font-semibold text-[var(--text-primary)]">No {resourceTypeLabel.toLowerCase()} found</div>
      {#if hasStatFilter}
        <p class="max-w-sm text-[13px] leading-relaxed text-[var(--text-muted)]">No resources match the active stat filter.</p>
        <Button variant="link" size="inline-sm" class="mt-1" onclick={onclearStatFilter}>
          Clear stat filter
        </Button>
      {:else if hasTextFilter}
        <p class="max-w-sm text-[13px] leading-relaxed text-[var(--text-muted)]">No resources match your search and filters.</p>
        <Button variant="link" size="inline-sm" class="mt-1" onclick={onclearTextFilter}>
          Clear filters
        </Button>
      {:else}
        <p class="max-w-sm text-[13px] leading-relaxed text-[var(--text-muted)]">
          {#if clusterScoped}There are none in this cluster. Try switching context to see results.{:else}There are none in this namespace. Try switching namespace or context to see results.{/if}
        </p>
      {/if}
    </div>
  </div>
{/if}
