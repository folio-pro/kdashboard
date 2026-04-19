<script lang="ts">
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { cn } from "$lib/utils";
  import { formatAge } from "$lib/utils/age";
  import { resolveJsonPath } from "$lib/utils/k8s-helpers";
  import { ArrowLeft, Copy, Check } from "lucide-svelte";
  import type { Resource, CrdColumn, StatusCondition } from "$lib/types/index.js";

  interface Props {
    resource: Resource;
    columns: CrdColumn[];
    onback: () => void;
  }

  let { resource, columns, onback }: Props = $props();

  let copiedField = $state<string | null>(null);

  function copyValue(value: string, field: string) {
    navigator.clipboard.writeText(value);
    copiedField = field;
    setTimeout(() => (copiedField = null), 1500);
  }

  // Extract status conditions
  let conditions = $derived.by(() => {
    const conds = resource.status?.conditions;
    if (!Array.isArray(conds)) return [] as StatusCondition[];
    return conds.filter(
      (c: Record<string, unknown>) => typeof c.type === "string" && typeof c.status === "string"
    ) as StatusCondition[];
  });

  function conditionColor(status: string): string {
    if (status === "True") return "var(--status-running)";
    if (status === "False") return "var(--status-failed)";
    return "var(--status-pending)";
  }
</script>

<div class="flex h-full flex-col">
  <!-- Header -->
  <div class="flex items-center gap-2 border-b border-[var(--border-color)] px-4 py-2">
    <button
      class="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
      onclick={onback}
    >
      <ArrowLeft class="h-3.5 w-3.5" />
      Back
    </button>
    <span class="text-xs text-[var(--text-muted)]">/</span>
    <span class="text-sm font-medium text-[var(--text-primary)]">{resource.kind}</span>
    <span class="text-xs text-[var(--text-muted)]">/</span>
    <span class="text-sm text-[var(--text-primary)]">{resource.metadata.name}</span>
  </div>

  <ScrollArea class="flex-1">
    <div class="mx-auto max-w-3xl space-y-4 p-4">
      <!-- Overview Card -->
      <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Overview</h3>
        <div class="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span class="text-[var(--text-muted)]">Name</span>
            <div class="flex items-center gap-1">
              <span class="text-[var(--text-primary)]">{resource.metadata.name}</span>
              <button class="opacity-0 hover:opacity-100 focus:opacity-100 transition-opacity" onclick={() => copyValue(resource.metadata.name, "name")}>
                {#if copiedField === "name"}<Check class="h-3 w-3 text-[var(--status-running)]" />{:else}<Copy class="h-3 w-3 text-[var(--text-muted)]" />{/if}
              </button>
            </div>
          </div>
          {#if resource.metadata.namespace}
            <div>
              <span class="text-[var(--text-muted)]">Namespace</span>
              <div class="text-[var(--text-primary)]">{resource.metadata.namespace}</div>
            </div>
          {/if}
          <div>
            <span class="text-[var(--text-muted)]">API Version</span>
            <div class="text-[var(--text-primary)]">{resource.api_version}</div>
          </div>
          <div>
            <span class="text-[var(--text-muted)]">Age</span>
            <div class="text-[var(--text-primary)]">
              {resource.metadata.creation_timestamp ? formatAge(resource.metadata.creation_timestamp) : "—"}
            </div>
          </div>
          {#if resource.metadata.uid}
            <div class="col-span-2">
              <span class="text-[var(--text-muted)]">UID</span>
              <div class="text-[var(--text-primary)] font-mono text-[10px]">{resource.metadata.uid}</div>
            </div>
          {/if}
        </div>
      </div>

      <!-- Smart Columns Card -->
      {#if columns.length > 0}
        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
          <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Properties</h3>
          <div class="grid grid-cols-2 gap-2 text-xs">
            {#each columns as col}
              <div>
                <span class="text-[var(--text-muted)]">{col.name}</span>
                <div class="text-[var(--text-primary)]">
                  {resolveJsonPath(resource, col.json_path) || "—"}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Status Conditions Card -->
      {#if conditions.length > 0}
        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
          <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Conditions</h3>
          <div class="space-y-2">
            {#each conditions as cond}
              <div class="flex items-start gap-2 rounded-md bg-[var(--bg-primary)] p-2">
                <span
                  class="mt-0.5 h-2 w-2 shrink-0 rounded-full"
                  style="background-color: {conditionColor(cond.status)}"
                ></span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-medium text-[var(--text-primary)]">{cond.type}</span>
                    <span class={cn(
                      "rounded px-1 py-0.5 text-[10px] font-medium",
                      cond.status === "True" ? "bg-[var(--status-running)]/10 text-[var(--status-running)]" :
                      cond.status === "False" ? "bg-[var(--status-failed)]/10 text-[var(--status-failed)]" :
                      "bg-[var(--status-pending)]/10 text-[var(--status-pending)]"
                    )}>
                      {cond.status}
                    </span>
                    {#if cond.reason}
                      <span class="text-[10px] text-[var(--text-muted)]">{cond.reason}</span>
                    {/if}
                  </div>
                  {#if cond.message}
                    <p class="mt-0.5 text-[10px] text-[var(--text-secondary)] leading-relaxed">{cond.message}</p>
                  {/if}
                  {#if cond.last_transition_time}
                    <p class="mt-0.5 text-[10px] text-[var(--text-dimmed)]">
                      {formatAge(cond.last_transition_time)} ago
                    </p>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Labels Card -->
      {#if resource.metadata.labels && Object.keys(resource.metadata.labels).length > 0}
        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
          <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Labels</h3>
          <div class="flex flex-wrap gap-1">
            {#each Object.entries(resource.metadata.labels) as [key, value]}
              <span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                {key}={value}
              </span>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Spec Card (collapsible JSON) -->
      {#if resource.spec && Object.keys(resource.spec).length > 0}
        <details class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <summary class="cursor-pointer p-4 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Spec
          </summary>
          <pre class="overflow-x-auto border-t border-[var(--border-color)] p-4 text-[10px] text-[var(--text-secondary)]">{JSON.stringify(resource.spec, null, 2)}</pre>
        </details>
      {/if}

      <!-- Status Card (collapsible JSON) -->
      {#if resource.status && Object.keys(resource.status).length > 0}
        <details class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <summary class="cursor-pointer p-4 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Status
          </summary>
          <pre class="overflow-x-auto border-t border-[var(--border-color)] p-4 text-[10px] text-[var(--text-secondary)]">{JSON.stringify(resource.status, null, 2)}</pre>
        </details>
      {/if}
    </div>
  </ScrollArea>
</div>
