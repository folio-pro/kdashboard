<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Pencil, Terminal, Trash2, Scale, RotateCcw, History, ChevronRight, Info, ScrollText, FileCode, Bell } from "lucide-svelte";
  import type { IconComponent } from "$lib/actions/types";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { restartWorkload, rollbackDeployment } from "$lib/actions/registry";
  import { extensions } from "$lib/extensions";
  import { dialogStore } from "$lib/stores/dialogs.svelte";
  import { cn } from "$lib/utils";
  import { deriveKind, deriveShowLogsButton, deriveNodeName, deriveResourceType, deriveIsScalable, deriveIsRestartable, deriveIsRollbackable, deriveCurrentReplicas } from "./detail-panel";
  import LazyView from "$lib/components/common/LazyView.svelte";
  import EventsCard from "./EventsCard.svelte";
  import PodDetails from "./PodDetails.svelte";
  import DeploymentDetails from "./DeploymentDetails.svelte";
  import StatefulSetDetails from "./StatefulSetDetails.svelte";
  import DaemonSetDetails from "./DaemonSetDetails.svelte";
  import JobDetails from "./JobDetails.svelte";
  import CronJobDetails from "./CronJobDetails.svelte";
  import ServiceDetails from "./ServiceDetails.svelte";
  import IngressDetails from "./IngressDetails.svelte";
  import HpaDetails from "./HpaDetails.svelte";
  import NodeDetails from "./NodeDetails.svelte";
  import GenericDetails from "./GenericDetails.svelte";

  let resource = $derived(k8sStore.selectedResource);

  let kind = $derived(deriveKind(resource));
  let showLogsButton = $derived(deriveShowLogsButton(kind));
  let nodeName = $derived(deriveNodeName(resource));

  // --- Subtabs (in-panel) ---------------------------------------------------
  type Subtab = "overview" | "logs" | "shell" | "yaml" | "events";

  const SUBTAB_META: Record<Subtab, { label: string; icon: IconComponent }> = {
    overview: { label: "Overview", icon: Info },
    logs: { label: "Logs", icon: ScrollText },
    shell: { label: "Shell", icon: Terminal },
    yaml: { label: "YAML", icon: FileCode },
    events: { label: "Events", icon: Bell },
  };

  let subtabs = $derived.by<Subtab[]>(() => {
    const tabs: Subtab[] = ["overview"];
    if (showLogsButton) tabs.push("logs");
    if (kind === "pod") tabs.push("shell");
    tabs.push("yaml", "events");
    return tabs;
  });

  // The active sub-tab is backed by the store so header buttons, keyboard
  // shortcuts and the command palette all drive it in place. Clamp to a valid
  // tab for the current kind (e.g. ignore "shell" on a non-pod).
  let activeSubtab = $derived<Subtab>(
    subtabs.includes(uiStore.detailSubtab as Subtab) ? (uiStore.detailSubtab as Subtab) : "overview"
  );

  function setSubtab(t: Subtab) {
    uiStore.detailSubtab = t;
  }

  // Reset to Overview whenever the selected resource changes. Tracks only the
  // uid so flipping subtabs doesn't retrigger the reset.
  let lastUid = "";
  $effect(() => {
    const uid = resource?.metadata.uid ?? "";
    if (uid !== lastUid) {
      lastUid = uid;
      uiStore.detailSubtab = "overview";
    }
  });

  function close() {
    if (k8sStore.navigateBack()) return;
    k8sStore.selectResource(null);
    if (uiStore.activeTab?.closable) {
      uiStore.closeTab(uiStore.activeTabId);
    }
  }

  let restartLoading = $state(false);
  let rollbackLoading = $state(false);

  let resourceType = $derived(deriveResourceType(kind));
  let isScalable = $derived(deriveIsScalable(resourceType));
  let isRestartable = $derived(deriveIsRestartable(resourceType));
  let isRollbackable = $derived(deriveIsRollbackable(kind));
  let currentReplicas = $derived(deriveCurrentReplicas(resource));

  async function doRestart() {
    if (!resource) return;
    restartLoading = true;
    try {
      await restartWorkload(resource);
    } catch (err) {
      toastStore.error("Restart failed", String(err));
    } finally {
      restartLoading = false;
    }
  }

  async function doRollback() {
    if (!resource) return;
    rollbackLoading = true;
    try {
      await rollbackDeployment(resource);
    } catch (err) {
      toastStore.error("Rollback failed", String(err));
    } finally {
      rollbackLoading = false;
    }
  }

  function handleDelete() {
    if (!resource) return;
    dialogStore.openDelete(resource);
  }
</script>

{#if resource}
  <div class="flex h-full flex-col bg-[var(--bg-primary)]">
    <!-- Header -->
    <div class="flex h-[68px] items-center justify-between border-b border-[var(--border-color)] bg-[var(--bg-primary)] px-6">
      <!-- Left: Breadcrumbs + Info -->
      <div class="flex min-w-0 flex-col gap-1">
        <!-- Breadcrumb trail (when drill-down history exists) -->
        {#if k8sStore.hasNavHistory}
          <div class="flex items-center gap-1 text-[11px]">
            {#each k8sStore.breadcrumbTrail as crumb, i}
              {#if i > 0}
                <ChevronRight class="h-3 w-3 shrink-0 text-[var(--text-dimmed)]" />
              {/if}
              <button
                class="max-w-[120px] truncate text-[var(--text-muted)] transition-colors hover:text-[var(--accent)] hover:underline"
                onclick={() => k8sStore.navigateToHistoryIndex(i)}
                title="{crumb.kind}: {crumb.name}"
              >{crumb.name}</button>
            {/each}
            <ChevronRight class="h-3 w-3 shrink-0 text-[var(--text-dimmed)]" />
            <span class="max-w-[140px] truncate font-medium text-[var(--text-primary)]">{resource.metadata.name}</span>
          </div>
          <div class="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <span class="text-[var(--text-dimmed)]">{resource.kind}</span>
            <span>·</span>
            {#if resource.metadata.namespace}
              <span>{resource.metadata.namespace}</span>
            {/if}
          </div>
        {:else}
          <span class="truncate text-[15px] font-semibold text-[var(--text-primary)]">{resource.metadata.name}</span>
          <div class="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <span class="text-[var(--text-dimmed)]">{resource.kind}</span>
            {#if resource.metadata.namespace}
              <span>·</span>
              <span>{resource.metadata.namespace}</span>
            {/if}
            {#if nodeName}
              <span>·</span>
              <span>{nodeName}</span>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Right: Action buttons -->
      <div class="flex items-center gap-2">
        {#if isScalable}
          <Button variant="outline" size="sm" class="gap-2" onclick={() => resource && dialogStore.openScale(resource)} title="Scale (s)">
            <Scale class="h-3.5 w-3.5" />
            Scale
          </Button>
        {/if}
        {#if showLogsButton}
          <Button variant="outline" size="sm" class="gap-2" onclick={() => setSubtab("logs")} title="Logs (l)">
            <ScrollText class="h-3.5 w-3.5" />
            Logs
          </Button>
        {/if}
        {#if kind === "pod"}
          <Button variant="outline" size="sm" class="gap-2" onclick={() => setSubtab("shell")} title="Shell (t)">
            <Terminal class="h-3.5 w-3.5" />
            Shell
          </Button>
        {/if}
        {#if isRestartable}
          <Button variant="outline" size="sm" class="gap-2" onclick={doRestart} disabled={restartLoading} title="Restart">
            <RotateCcw class="h-3.5 w-3.5" />
            {restartLoading ? "Restarting..." : "Restart"}
          </Button>
        {/if}
        {#if isRollbackable}
          <Button variant="outline" size="sm" class="gap-2" onclick={doRollback} disabled={rollbackLoading} title="Rollback">
            <History class="h-3.5 w-3.5" />
            {rollbackLoading ? "Rolling back..." : "Rollback"}
          </Button>
        {/if}
        {#each extensions.mountsFor("detail-panel-actions") as mount (mount.id)}
          <mount.component {resource} />
        {/each}
        <Button variant="outline" size="sm" class="gap-2" onclick={() => setSubtab("yaml")} title="Edit YAML (e)">
          <Pencil class="h-3.5 w-3.5" />
          Edit
        </Button>
        <Button variant="destructive" size="sm" class="gap-2" onclick={handleDelete} title="Delete Resource">
          <Trash2 class="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>

    <!-- Subtab bar — px-3 here + px-3 per tab lands the first tab's content at
         24px, aligned with the header and the section titles below. -->
    <div class="flex shrink-0 items-stretch gap-0.5 border-b border-[var(--border-color)] px-3">
      {#each subtabs as t (t)}
        {@const TabIcon = SUBTAB_META[t].icon}
        {@const isActive = activeSubtab === t}
        <button
          class={cn(
            "relative flex items-center gap-1.5 px-3 pb-2.5 pt-2 text-[13px] transition-colors",
            isActive ? "text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          )}
          onclick={() => setSubtab(t)}
        >
          <TabIcon class={cn("h-3.5 w-3.5", isActive ? "text-[var(--accent)]" : "")} />
          {SUBTAB_META[t].label}
          {#if isActive}
            <span class="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-[var(--accent)]"></span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- Subtab content -->
    <div class="min-h-0 flex-1">
      {#if activeSubtab === "overview"}
        <ScrollArea class="h-full select-text">
          {#if kind === "pod"}
            <PodDetails {resource} />
          {:else if kind === "deployment"}
            <DeploymentDetails {resource} />
          {:else if kind === "statefulset"}
            <StatefulSetDetails {resource} />
          {:else if kind === "daemonset"}
            <DaemonSetDetails {resource} />
          {:else if kind === "job"}
            <JobDetails {resource} />
          {:else if kind === "cronjob"}
            <CronJobDetails {resource} />
          {:else if kind === "service"}
            <ServiceDetails {resource} />
          {:else if kind === "ingress"}
            <IngressDetails {resource} />
          {:else if kind === "horizontalpodautoscaler"}
            <HpaDetails {resource} />
          {:else if kind === "node"}
            <NodeDetails {resource} />
          {:else}
            <GenericDetails {resource} />
          {/if}
        </ScrollArea>
      {:else if activeSubtab === "logs"}
        <div class="h-full">
          <LazyView
            loader={() => import("$lib/components/logs/LogViewer.svelte")}
            name="logs"
          />
        </div>
      {:else if activeSubtab === "shell"}
        <div class="h-full">
          <LazyView
            loader={() => import("$lib/components/terminal/TerminalView.svelte")}
            name="terminal"
          />
        </div>
      {:else if activeSubtab === "yaml"}
        <div class="h-full">
          <LazyView
            loader={() => import("$lib/components/details/YamlEditor.svelte")}
            name="YAML editor"
          />
        </div>
      {:else if activeSubtab === "events"}
        <ScrollArea class="h-full select-text">
          <EventsCard {resource} />
        </ScrollArea>
      {/if}
    </div>
  </div>
{/if}
