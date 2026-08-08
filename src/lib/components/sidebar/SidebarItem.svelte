<script lang="ts">
  import { cn } from "$lib/utils";
  import {
    Box, Layers, GitBranch, Database, Copy, Play, Clock,
    Globe, Network, FileText, Lock, TrendingUp, Server, FolderOpen, Unplug, Activity,
    HardDrive, HardDriveDownload, Archive, Key, Link, KeyRound, Users,
    Shield, ShieldCheck, ShieldAlert, PieChart, SlidersHorizontal, Share2
  } from "lucide-svelte";

  interface Props {
    name: string;
    resourceType: string;
    short?: string;
    count?: number;
    active: boolean;
    collapsed: boolean;
    onclick: () => void;
  }

  let { name, resourceType, short, count, active, collapsed, onclick }: Props = $props();

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
    wpa: TrendingUp,
    nodes: Server,
    namespaces: FolderOpen,
    portforwards: Unplug,
    persistentvolumes: HardDrive,
    persistentvolumeclaims: HardDriveDownload,
    storageclasses: Archive,
    roles: Key,
    rolebindings: Link,
    clusterroles: KeyRound,
    clusterrolebindings: Users,
    networkpolicies: Shield,
    resourcequotas: PieChart,
    limitranges: SlidersHorizontal,
    poddisruptionbudgets: ShieldAlert,
    topology: Share2,
    security: ShieldCheck,
  };

  let IconComponent = $derived(iconMap[resourceType] ?? Box);
</script>

{#if collapsed}
  <button
    class={cn(
      "mx-auto flex h-[30px] w-[30px] items-center justify-center rounded-[6px] transition-colors",
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
      "flex w-full min-w-0 items-center gap-2.5 border-l-2 px-[13px] py-2 text-[13.5px] transition-colors",
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
      <span class="shrink-0 font-mono text-[10px] text-[var(--text-dimmed)]">{short}</span>
    {/if}
    {#if count !== undefined && count > 0}
      <span class={cn(
        "min-w-[26px] shrink-0 text-right font-mono tabular-nums text-[11px]",
        active ? "text-[var(--text-secondary)]" : "text-[var(--text-dimmed)]"
      )}>{count}</span>
    {/if}
  </button>
{/if}
