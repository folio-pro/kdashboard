<script lang="ts">
  import { cn } from "$lib/utils";
  import { resourceIcon } from "$lib/resource-icons";

  interface Props {
    name: string;
    resourceType: string;
    short?: string;
    active: boolean;
    collapsed: boolean;
    onclick: () => void;
  }

  let { name, resourceType, short, active, collapsed, onclick }: Props = $props();

  let IconComponent = $derived(resourceIcon(resourceType));
</script>

{#if collapsed}
  <button
    class={cn(
      "mx-auto flex h-[30px] w-[30px] items-center justify-center rounded-md transition-colors",
      active
        ? "bg-[var(--sidebar-active)] text-[var(--accent)]"
        : "text-[var(--text-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)]"
    )}
    {onclick}
    title={name}
    aria-label={name}
  >
    <IconComponent class="h-4 w-4" />
  </button>
{:else}
  <button
    class={cn(
      "flex w-full min-w-0 items-center gap-2.5 border-l-2 px-[13px] py-[6px] text-[12px] transition-colors",
      active
        ? "border-[var(--accent)] bg-[var(--sidebar-hover)] text-[var(--text-primary)]"
        : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)]"
    )}
    {onclick}
    title={name}
  >
    <IconComponent
      class={cn(
        "h-4 w-4 shrink-0",
        active ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
      )}
    />
    <span class="flex-1 truncate text-left">{name}</span>
    {#if short}
      <span class="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">{short}</span>
    {/if}
  </button>
{/if}
