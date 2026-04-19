<script lang="ts">
  import { ChevronDown } from "lucide-svelte";
  import { cn } from "$lib/utils";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";

  interface Condition {
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }

  interface Props {
    conditions: Condition[];
    healthFn?: (type: string, status: string) => boolean;
  }

  let { conditions, healthFn }: Props = $props();

  let expanded = $state(false);

  function isHealthy(type: string, status: string): boolean {
    if (healthFn) return healthFn(type, status);
    return status === "True";
  }
</script>

{#if conditions.length > 0}
  <div class="border-t border-[var(--border-hover)]">
    <button
      class="flex w-full items-center justify-between px-5 py-3 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
      onclick={() => expanded = !expanded}
    >
      <span class="text-xs font-medium text-[var(--text-dimmed)]">Conditions</span>
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-1.5">
          {#each conditions as condition}
            <span
              class="h-1.5 w-1.5 rounded-full"
              style:background-color={isHealthy(condition.type, condition.status) ? "var(--status-running)" : "var(--status-failed)"}
              title="{condition.type}: {condition.status}"
            ></span>
          {/each}
        </div>
        <ChevronDown class={cn("h-3.5 w-3.5 text-[var(--text-dimmed)] transition-transform", expanded && "rotate-180")} />
      </div>
    </button>
    {#if expanded}
      {#each conditions as condition}
        <div class="flex items-center justify-between border-t border-[var(--border-hover)] px-5 py-3">
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-[12px] font-medium text-[var(--text-primary)]">{condition.type}</span>
            {#if condition.message}
              <span class="text-[11px] text-[var(--text-muted)]">{condition.message}</span>
            {/if}
          </div>
          {#if healthFn}
            <span class="text-[10px] font-medium" class:text-[var(--status-running)]={isHealthy(condition.type, condition.status)} class:text-[var(--status-failed)]={!isHealthy(condition.type, condition.status)}>
              {condition.status}
            </span>
          {:else}
            <StatusBadge status={condition.status} />
          {/if}
        </div>
      {/each}
    {/if}
  </div>
{/if}
