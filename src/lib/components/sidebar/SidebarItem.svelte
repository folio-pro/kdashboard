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
        ? "bg-[var(--sidebar-active)] text-[var(--text-primary)]"
        : "text-[var(--text-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)]"
    )}
    {onclick}
    title={name}
    aria-label={name}
  >
    <IconComponent class="h-4 w-4" />
  </button>
{:else}
  <!-- scroll-mt matches the sticky section header's height, so scrolling a
       row into view never parks it underneath the header. -->
  <button
    class={cn(
      "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-[12px] transition-colors scroll-mt-8",
      active
        ? "bg-[var(--sidebar-active)] font-medium text-[var(--text-primary)]"
        : "text-[var(--text-secondary)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)]"
    )}
    {onclick}
    title={name}
    aria-current={active ? "page" : undefined}
  >
    <IconComponent
      class={cn(
        "h-4 w-4 shrink-0",
        active ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"
      )}
    />
    <span class="flex-1 truncate text-left">{name}</span>
    {#if short}
      <span class="shrink-0 font-mono text-[11px] font-normal text-[var(--text-muted)]">{short}</span>
    {/if}
  </button>
{/if}
