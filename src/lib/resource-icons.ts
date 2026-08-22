// Icon per resource type, shared by the sidebar and the command palette.
// Kept apart from resource-catalog.ts so the catalog stays importable from
// plain logic modules and bun tests (no Svelte component imports).

import {
  Box, Layers, GitBranch, Database, Copy, Play, Clock,
  Globe, Network, FileText, Lock, TrendingUp, Server, FolderOpen, Unplug,
  HardDrive, HardDriveDownload, Archive, Key, Link, KeyRound, Users,
  Shield, ShieldCheck, ShieldAlert, PieChart, SlidersHorizontal, Share2,
  Plug, Route, UserCircle, Cable, Timer, Filter, CheckCircle2, ArrowUpNarrowWide,
  Cog, Package, Activity, LayoutDashboard, AlertTriangle,
} from "lucide-svelte";
import type { IconComponent } from "$lib/actions/types";

export const RESOURCE_ICONS: Record<string, IconComponent> = {
  // Workloads
  pods: Box,
  deployments: Layers,
  replicasets: GitBranch,
  statefulsets: Database,
  daemonsets: Copy,
  jobs: Play,
  cronjobs: Clock,
  // Network
  services: Globe,
  endpoints: Plug,
  endpointslices: Cable,
  ingresses: Network,
  ingressclasses: Route,
  portforwards: Unplug,
  // Configuration
  configmaps: FileText,
  secrets: Lock,
  // Scaling
  hpa: TrendingUp,
  vpa: TrendingUp,
  wpa: TrendingUp,
  // Storage
  persistentvolumes: HardDrive,
  persistentvolumeclaims: HardDriveDownload,
  storageclasses: Archive,
  csidrivers: HardDrive,
  volumeattachments: Link,
  // RBAC
  serviceaccounts: UserCircle,
  roles: Key,
  rolebindings: Link,
  clusterroles: KeyRound,
  clusterrolebindings: Users,
  // Policy
  networkpolicies: Shield,
  resourcequotas: PieChart,
  limitranges: SlidersHorizontal,
  poddisruptionbudgets: ShieldAlert,
  mutatingwebhookconfigurations: Filter,
  validatingwebhookconfigurations: CheckCircle2,
  // Cluster
  nodes: Server,
  namespaces: FolderOpen,
  events: Activity,
  priorityclasses: ArrowUpNarrowWide,
  runtimeclasses: Cog,
  leases: Timer,
  helm: Package,
  topology: Share2,
  security: ShieldCheck,
  overview: LayoutDashboard,
  problems: AlertTriangle,
};

/** Icon for a resource type, defaulting to the generic box. */
export function resourceIcon(type: string): IconComponent {
  return RESOURCE_ICONS[type] ?? Box;
}
