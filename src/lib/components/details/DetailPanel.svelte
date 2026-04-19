<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Pencil, FileText, Terminal, Trash2, Scale, RotateCcw, History, ChevronRight } from "lucide-svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { restartWorkload, rollbackDeployment } from "$lib/actions/registry";
  import { extensions } from "$lib/extensions";
  import { dialogStore } from "$lib/stores/dialogs.svelte";
  import { deriveKind, deriveShowLogsButton, deriveNodeName, deriveResourceType, deriveIsScalable, deriveIsRestartable, deriveIsRollbackable, deriveCurrentReplicas } from "./detail-panel";
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

  function close() {
    if (k8sStore.navigateBack()) return;
    k8sStore.selectResource(null);
    if (uiStore.activeTab?.closable) {
      uiStore.closeTab(uiStore.activeTabId);
    }
  }

  function handleViewLogs() {
    uiStore.showLogs(resource?.metadata.name);
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
          <span class="text-[15px] font-semibold text-[var(--text-primary)]">{resource.metadata.name}</span>
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
        <Button variant="outline" size="sm" class="gap-2" onclick={() => uiStore.showYamlEditor(resource?.metadata.name)} title="Edit YAML">
          <Pencil class="h-3.5 w-3.5" />
          Edit
        </Button>
        {#if showLogsButton}
          <Button variant="outline" size="sm" class="gap-2" onclick={handleViewLogs} title="View Logs">
            <FileText class="h-3.5 w-3.5" />
            Logs
          </Button>
        {/if}
        {#if kind === "pod"}
          <Button variant="outline" size="sm" class="gap-2" onclick={() => uiStore.showTerminal(resource?.metadata.name)} title="Terminal">
            <Terminal class="h-3.5 w-3.5" />
            Terminal
          </Button>
        {/if}
        <Button variant="destructive" size="sm" class="gap-2" onclick={handleDelete} title="Delete Resource">
          <Trash2 class="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>

    <!-- Content -->
    <ScrollArea class="min-h-0 flex-1 select-text">
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
  </div>

{/if}
