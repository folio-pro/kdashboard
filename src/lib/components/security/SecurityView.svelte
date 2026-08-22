<script lang="ts">
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Badge, Card, type BadgeTone } from "$lib/components/ui";
  import { Shield, ShieldAlert, ShieldCheck, ChevronDown, ChevronRight } from "lucide-svelte";
  import { securityStore } from "$lib/stores/security.svelte";
  import { rbacStore } from "$lib/stores/rbac.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { Button } from "$lib/components/ui/button";
  import { cn } from "$lib/utils";
  import RbacPanel from "./RbacPanel.svelte";

  let expandedPods = $state<Set<string>>(new Set());
  /** "posture" = image scans and compliance; "permissions" = the RBAC explorer. */
  let mode = $state<"posture" | "permissions">("posture");

  function handleBack() {
    securityStore.reset();
    rbacStore.reset();
    uiStore.backToPrevious();
  }

  function handleRefresh() {
    if (mode === "permissions") {
      rbacStore.reset();
      void rbacStore.loadSubjects(k8sStore.currentNamespace);
    } else {
      securityStore.loadSecurityOverview(k8sStore.currentNamespace);
    }
  }

  function togglePod(key: string) {
    const next = new Set(expandedPods);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    expandedPods = next;
  }

  function vulnTotal(v: { critical: number; high: number; medium: number; low: number; unknown: number }): number {
    return v.critical + v.high + v.medium + v.low + v.unknown;
  }

  /**
   * CVSS severity mapped onto the design system's semantic tones. This view
   * used to reach straight for raw Tailwind palette classes, which are fixed
   * to a dark background and wash out to unreadable on the five light theme
   * presets.
   */
  type Severity = "critical" | "high" | "medium" | "low";

  const severityTone: Record<Severity, BadgeTone> = {
    critical: "error",
    high: "terminating",
    medium: "warning",
    low: "info",
  };

  const severityVar: Record<Severity, string> = {
    critical: "var(--status-failed)",
    high: "var(--status-terminating)",
    medium: "var(--status-pending)",
    low: "var(--status-succeeded)",
  };

  const severities: { key: Severity; label: string; initial: string }[] = [
    { key: "critical", label: "Critical", initial: "C" },
    { key: "high", label: "High", initial: "H" },
    { key: "medium", label: "Medium", initial: "M" },
    { key: "low", label: "Low", initial: "L" },
  ];

</script>

<ViewPanel
  title="Security Overview"
  icon={Shield}
  isLoading={mode === "posture" ? securityStore.isLoading : false}
  error={mode === "posture" ? securityStore.error : null}
  hasData={mode === "posture" ? !!securityStore.overview : true}
  onBack={handleBack}
  onRefresh={handleRefresh}
  loadingMessage="Scanning images..."
  errorMessage="Failed to load security data"
  emptyMessage="No security data available"
  emptyHelper="Install trivy or grype to scan container images"
>
  {#snippet badge()}
    {#if mode === "posture" && securityStore.overview}
      <Badge appearance="surface" size="sm">{securityStore.overview.scanner}</Badge>
    {/if}
  {/snippet}

  {#snippet headerActions()}
    <div class="flex gap-0.5 rounded-md bg-[var(--bg-tertiary)] p-0.5 text-[11px]" data-testid="security-mode">
      <Button variant="segment" size="xs" class={cn("h-6 rounded-sm px-2", mode === "posture" && "bg-[var(--bg-secondary)] text-[var(--text-primary)]")} onclick={() => (mode = "posture")}>Posture</Button>
      <Button variant="segment" size="xs" class={cn("h-6 rounded-sm px-2", mode === "permissions" && "bg-[var(--bg-secondary)] text-[var(--text-primary)]")} onclick={() => (mode = "permissions")} data-testid="security-mode-permissions">Permissions</Button>
    </div>
  {/snippet}

  {#if mode === "permissions"}
    <RbacPanel />
  {:else}
  <ScrollArea class="h-full">
    <div class="p-4 space-y-4">
      <!-- Summary Cards -->
      <div class="grid grid-cols-5 gap-3">
        <Card>
          <div class="text-[12px] text-[var(--text-muted)]">Images Scanned</div>
          <div class="mt-1 text-[18px] font-semibold text-[var(--text-primary)]">
            {securityStore.overview!.total_images_scanned}
          </div>
        </Card>

        {#each severities as sev}
          <Card tone={severityTone[sev.key]}>
            <div class="text-[12px]" style="color: {severityVar[sev.key]};">{sev.label}</div>
            <div class="mt-1 text-[18px] font-semibold" style="color: {severityVar[sev.key]};">
              {securityStore.overview!.total_vulns[sev.key]}
            </div>
          </Card>
        {/each}
      </div>

      <!-- Compliance Bar -->
      <div class="flex items-center gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-3">
        <div class="flex items-center gap-2">
          <ShieldCheck class="h-4 w-4 text-[var(--status-running)]" />
          <span class="text-[13px] text-[var(--text-primary)]">{securityStore.overview!.compliant_pods} compliant</span>
        </div>
        <div class="h-4 w-px bg-[var(--border-color)]"></div>
        <div class="flex items-center gap-2">
          <ShieldAlert class="h-4 w-4 text-[var(--status-failed)]" />
          <span class="text-[13px] text-[var(--text-primary)]">{securityStore.overview!.non_compliant_pods} non-compliant</span>
        </div>
        <div class="flex-1"></div>
        {#if securityStore.overview!.pods.length > 0}
          {@const total = securityStore.overview!.compliant_pods + securityStore.overview!.non_compliant_pods}
          {@const pct = total > 0 ? (securityStore.overview!.compliant_pods / total) * 100 : 0}
          <div class="flex items-center gap-2">
            <div class="h-2 w-32 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
              <div
                class="h-full rounded-full transition-all"
                style="width: {pct}%; background: var(--status-running);"
              ></div>
            </div>
            <span class="text-[12px] text-[var(--text-muted)]">{Math.round(pct)}%</span>
          </div>
        {/if}
        <span class="text-[11px] text-[var(--text-muted)]">
          Updated {new Date(securityStore.overview!.fetched_at).toLocaleTimeString()}
        </span>
      </div>

      <!-- Pod List -->
      <div class="space-y-1">
        {#each securityStore.overview!.pods as pod}
          {@const podKey = `${pod.namespace}/${pod.name}`}
          <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <button
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
              onclick={() => togglePod(podKey)}
            >
              {#if expandedPods.has(podKey)}
                <ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />
              {:else}
                <ChevronRight class="h-3.5 w-3.5 text-[var(--text-muted)]" />
              {/if}

              {#if pod.compliant}
                <ShieldCheck class="h-4 w-4 text-[var(--status-running)]" />
              {:else}
                <ShieldAlert class="h-4 w-4 text-[var(--status-failed)]" />
              {/if}

              <div class="flex flex-1 flex-col">
                <span class="text-[13px] font-medium text-[var(--text-primary)]">{pod.name}</span>
                <span class="text-[11px] text-[var(--text-muted)]">{pod.namespace}</span>
              </div>

              <div class="flex items-center gap-1.5">
                {#each severities as sev}
                  {#if pod.total_vulns[sev.key] > 0}
                    <Badge tone={severityTone[sev.key]} size="sm">
                      {pod.total_vulns[sev.key]}
                      {sev.initial}
                    </Badge>
                  {/if}
                {/each}
                {#if vulnTotal(pod.total_vulns) === 0}
                  <span class="text-[12px] text-[var(--text-muted)]">No vulnerabilities</span>
                {/if}
              </div>
            </button>

            {#if expandedPods.has(podKey)}
              <div class="border-t border-[var(--border-color)]">
                <table class="w-full text-[12px]">
                  <thead>
                    <tr class="text-[var(--text-muted)]">
                      <th class="px-3 py-1.5 text-left font-medium">Image</th>
                      <th class="px-3 py-1.5 text-right font-medium">Critical</th>
                      <th class="px-3 py-1.5 text-right font-medium">High</th>
                      <th class="px-3 py-1.5 text-right font-medium">Medium</th>
                      <th class="px-3 py-1.5 text-right font-medium">Low</th>
                      <th class="px-3 py-1.5 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each pod.images as img}
                      <tr class="border-t border-[var(--border-color)]/50 text-[var(--text-secondary)]">
                        <td class="max-w-[300px] truncate px-3 py-1.5 font-mono text-[var(--text-primary)]" title={img.image}>
                          {img.image}
                        </td>
                        <td
                          class="px-3 py-1.5 text-right {img.vulns.critical > 0 ? 'font-medium' : ''}"
                          style={img.vulns.critical > 0 ? `color: ${severityVar.critical};` : ""}
                        >
                          {img.vulns.critical}
                        </td>
                        <td
                          class="px-3 py-1.5 text-right {img.vulns.high > 0 ? 'font-medium' : ''}"
                          style={img.vulns.high > 0 ? `color: ${severityVar.high};` : ""}
                        >
                          {img.vulns.high}
                        </td>
                        <td
                          class="px-3 py-1.5 text-right"
                          style={img.vulns.medium > 0 ? `color: ${severityVar.medium};` : ""}
                        >
                          {img.vulns.medium}
                        </td>
                        <td class="px-3 py-1.5 text-right">{img.vulns.low}</td>
                        <td class="px-3 py-1.5 text-right font-medium">{vulnTotal(img.vulns)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </ScrollArea>
  {/if}
</ViewPanel>
