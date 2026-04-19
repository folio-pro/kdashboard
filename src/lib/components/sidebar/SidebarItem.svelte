<script lang="ts">
  import { cn } from "$lib/utils";
  import {
    Box, Layers, GitBranch, Database, Copy, Play, Clock,
    Globe, Network, FileText, Lock, TrendingUp, Server, FolderOpen, Unplug, Activity
  } from "lucide-svelte";

  interface Props {
    name: string;
    resourceType: string;
    count?: number;
    active: boolean;
    collapsed: boolean;
    onclick: () => void;
  }

  let { name, resourceType, count, active, collapsed, onclick }: Props = $props();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iconMap: Record<string, any> = {
    overview: Activity,
    pods: Box,
    deployments: Layers,
    replicasets: GitBranch,
    statefulsets: Database,
    daemonsets: Copy,
    jobs: Play,
    cronjobs: Clock,
    services: Globe,
    ingresses: Network,
    configmaps: FileText,
    secrets: Lock,
    hpa: TrendingUp,
    vpa: TrendingUp,
    nodes: Server,
    namespaces: FolderOpen,
    portforwards: Unplug,
  };

  let IconComponent = $derived(iconMap[resourceType] ?? Box);
</script>

{#if collapsed}
  <button
    class={cn(
      "mx-auto flex h-8 w-8 items-center justify-center rounded-md transition-colors",
      active
        ? "bg-[var(--sidebar-active)] text-[var(--accent)]"
        : "text-[var(--text-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)]"
    )}
    {onclick}
    title={name}
  >
    <IconComponent class="h-4 w-4" />
  </button>
{:else}
  <button
    class={cn(
      "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-3 text-xs transition-colors",
      active
        ? "bg-[var(--sidebar-active)] text-[var(--text-primary)]"
        : "text-[var(--text-secondary)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)]"
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
    {#if count !== undefined && count > 0}
      <span class={cn(
        "ml-auto shrink-0 tabular-nums text-[10px]",
        active ? "text-[var(--text-secondary)]" : "text-[var(--text-dimmed)]"
      )}>{count}</span>
    {/if}
  </button>
{/if}
