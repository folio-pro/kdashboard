<script lang="ts">
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { SegmentedControl } from "$lib/components/ui";
  import { Shield, ChevronDown, ChevronRight } from "lucide-svelte";
  import { healthTicks } from "$lib/utils/workload-stats";
  import { securityStore } from "$lib/stores/security.svelte";
  import { podScanLabel, podScanSummary, vulnTotal } from "$lib/stores/security.logic";
  import { rbacStore } from "$lib/stores/rbac.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
    import RbacPanel from "./RbacPanel.svelte";

  let expandedPods = $state<Set<string>>(new Set());
  /** "posture" = image scans and compliance; "permissions" = the RBAC explorer. */
  let mode = $state<"posture" | "permissions">("posture");

  // ViewPanel reads one state object whichever mode is showing; the RBAC
  // explorer loads its own two lists and renders its own progress.
  let panel = $derived(
    mode === "posture"
      ? { isLoading: securityStore.isLoading, error: securityStore.error, hasData: !!securityStore.overview }
      : { isLoading: false, error: null, hasData: true },
  );

  // Reload the mode on screen and drop the other one: both skip their fetch
  // when data is already there (RbacPanel guards on an empty subject list and
  // reloads by itself after a reset), so keeping it would show the old
  // namespace's rows on the next mode switch.
  function handleNamespaceChange(ns: string) {
    rbacStore.reset();
    if (mode === "permissions") securityStore.reset();
    else securityStore.loadSecurityOverview(ns);
  }

  // Posture loads on entry when its store is empty: a namespace change made in
  // Permissions dropped it. (RbacPanel loads its own list on mount.)
  function setMode(next: "posture" | "permissions") {
    mode = next;
    if (next === "posture" && !securityStore.overview && !securityStore.isLoading) {
      securityStore.loadSecurityOverview(k8sStore.currentNamespace);
    }
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

  /**
   * CVSS severity on the semantic scale. Low is deliberately neutral: it is
   * the long tail, and painting it blue made the quietest number the loudest.
   */
  type Severity = "critical" | "high" | "medium" | "low";

  const severityColor: Record<Severity, string> = {
    critical: "var(--status-failed)",
    high: "var(--status-terminating)",
    medium: "var(--status-pending)",
    low: "var(--text-secondary)",
  };

  const severities: { key: Severity; label: string }[] = [
    { key: "critical", label: "Critical" },
    { key: "high", label: "High" },
    { key: "medium", label: "Medium" },
    { key: "low", label: "Low" },
  ];

  let compliance = $derived(
    securityStore.overview
      ? [
          { key: "compliant", value: securityStore.overview.compliant_pods, color: "var(--status-running)" },
          { key: "non-compliant", value: securityStore.overview.non_compliant_pods, color: "var(--status-failed)" },
        ]
      : [],
  );
  let complianceTicks = $derived(healthTicks(compliance));
  let compliancePct = $derived.by(() => {
    const total = compliance.reduce((sum, c) => sum + c.value, 0);
    return total > 0 ? Math.round((compliance[0].value / total) * 100) : 0;
  });
</script>

<ViewPanel
  title="Security"
  icon={Shield}
  isLoading={panel.isLoading}
  error={panel.error}
  hasData={panel.hasData}
  onRefresh={handleRefresh}
  onNamespaceChange={handleNamespaceChange}
  loadingMessage="Scanning images…"
  errorMessage="Failed to load security data"
  emptyMessage="No security data available"
  emptyHelper="Install trivy or grype to scan container images"
>
  {#snippet badge()}
    {#if mode === "posture" && securityStore.overview}
      <span class="font-mono text-[11px] text-[var(--text-muted)]">{securityStore.overview.scanner}</span>
    {/if}
  {/snippet}

  {#snippet headerActions()}
    <SegmentedControl
      ariaLabel="Security view mode"
      value={mode}
      onchange={setMode}
      items={[{ value: "posture", label: "Posture" }, { value: "permissions", label: "Permissions", testid: "security-mode-permissions" }]}
      testid="security-mode"
    />
  {/snippet}

  {#if mode === "permissions"}
    <!-- Keyed by namespace: the picked subject and the quick-check fields
         belong to the namespace being left. -->
    {#key k8sStore.currentNamespace}
      <RbacPanel />
    {/key}
  {:else}
  {@const overview = securityStore.overview!}
  <ScrollArea class="h-full">
    <div class="flex flex-col gap-3 py-3">
      <!-- One band, not five equal cards: compliance leads, the severities
           are its breakdown. -->
      <div class="mx-6 grid grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
        <div class="flex min-w-0 flex-col justify-between gap-2 px-4 py-3">
          <span class="text-[12px] text-[var(--text-muted)]">Compliance · {overview.total_images_scanned} images scanned · updated {new Date(overview.fetched_at).toLocaleTimeString()}</span>
          <div class="flex items-center gap-3">
            {#if complianceTicks}
              <div class="flex shrink-0 gap-0.5" role="img" aria-label={`${overview.compliant_pods} compliant, ${overview.non_compliant_pods} non-compliant`}>
                {#each complianceTicks as color, i (i)}
                  <span class="h-4 w-2 rounded-[2px]" style:background-color={color}></span>
                {/each}
              </div>
            {:else if overview.pods.length > 0}
              <span class="font-mono text-[12px] text-[var(--text-primary)]">{compliancePct}%</span>
            {/if}
            <span class="truncate text-[12px] text-[var(--text-secondary)]">
              <span class="font-mono text-[var(--text-primary)]">{overview.compliant_pods}</span> compliant ·
              <span class="font-mono text-[var(--text-primary)]">{overview.non_compliant_pods}</span> non-compliant
            </span>
          </div>
        </div>
        {#each severities as sev (sev.key)}
          {@const n = overview.total_vulns[sev.key]}
          <div class="flex min-w-0 flex-col gap-2 border-l border-[var(--border-color)] px-4 py-3">
            <span class="text-[12px] text-[var(--text-muted)]">{sev.label}</span>
            <span class="font-mono text-[26px] font-medium leading-none tabular-nums" style:color={n > 0 && sev.key !== "low" ? severityColor[sev.key] : "var(--text-primary)"}>{n}</span>
          </div>
        {/each}
      </div>

      <!-- Pods as rows: the same four columns on every line, where pills
           pushed to the right edge could not be compared down the list. -->
      <table class="w-full table-fixed text-[12px]">
        <colgroup>
          <col class="w-[46px]" /><col />
          <col class="w-[88px]" /><col class="w-[88px]" /><col class="w-[88px]" /><col class="w-[88px]" />
          <col class="w-[184px]" />
        </colgroup>
        <thead>
          <tr class="h-8 border-b border-[var(--border-color)] text-[11px] text-[var(--text-muted)]">
            <th></th>
            <th class="px-2 text-left font-medium">Pod</th>
            {#each severities as sev (sev.key)}
              <th class="px-2 text-right font-medium">{sev.label}</th>
            {/each}
            <th class="px-2 pr-4 text-left font-medium">Scan</th>
          </tr>
        </thead>
        <tbody>
          {#each overview.pods as pod (`${pod.namespace}/${pod.name}`)}
            {@const podKey = `${pod.namespace}/${pod.name}`}
            {@const scan = podScanSummary(pod)}
            {@const label = podScanLabel(scan)}
            {@const expanded = expandedPods.has(podKey)}
            {@const unscanned = scan.scanned === 0}
            <tr
              class="h-9 cursor-pointer border-b border-[var(--border-color)] hover:bg-[var(--table-row-hover)]"
              data-testid="security-pod"
              data-scan-state={label?.tone ?? "vulnerable"}
              onclick={() => togglePod(podKey)}
            >
              <td class="pl-6">
                {#if expanded}<ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />{:else}<ChevronRight class="h-3.5 w-3.5 text-[var(--text-muted)]" />{/if}
              </td>
              <td class="truncate px-2">
                <button type="button" class="flex w-full min-w-0 items-center gap-2 text-left" aria-expanded={expanded} onclick={(e) => { e.stopPropagation(); togglePod(podKey); }} title={podKey}>
                  <!-- A pod nobody scanned is neither compliant nor not: it is unknown. -->
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full" style:background-color={unscanned ? "var(--text-muted)" : pod.compliant ? "var(--status-running)" : "var(--status-failed)"}></span>
                  <span class="truncate text-[var(--text-primary)]">{pod.name}</span>
                </button>
              </td>
              {#each severities as sev (sev.key)}
                {@const n = pod.total_vulns[sev.key]}
                <td class="px-2 text-right font-mono tabular-nums" style:color={unscanned || n === 0 ? "var(--text-muted)" : severityColor[sev.key]}>{unscanned ? "—" : n}</td>
              {/each}
              <td class="truncate px-2 pr-4 text-[var(--text-muted)]" title={label?.text}>
                {label?.text ?? (pod.compliant ? "Compliant" : "Non-compliant")}{!label && scan.missing > 0 ? ` · ${scan.missing} not scanned` : ""}
              </td>
            </tr>
            {#if expanded}
              <tr class="border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
                <td colspan="7" class="pb-2 pl-[46px] pr-4">
                  <table class="w-full table-fixed">
                    <colgroup>
                      <col /><col class="w-[88px]" /><col class="w-[88px]" /><col class="w-[88px]" /><col class="w-[88px]" /><col class="w-[168px]" />
                    </colgroup>
                    <tbody>
                      {#each pod.images as img (img.image)}
                        <tr class="h-8 text-[var(--text-secondary)]">
                          <td class="truncate px-2 font-mono text-[var(--text-primary)]" title={img.image}>{img.image}</td>
                          {#if img.status === "failed"}
                            <td class="px-2 text-right text-[var(--text-muted)]" colspan="5" title={img.error ?? ""}>Scan failed</td>
                          {:else}
                            {#each severities as sev (sev.key)}
                              <td class="px-2 text-right font-mono tabular-nums" style:color={img.vulns[sev.key] > 0 ? severityColor[sev.key] : "var(--text-muted)"}>{img.vulns[sev.key]}</td>
                            {/each}
                            <td class="px-2 font-mono tabular-nums">{vulnTotal(img.vulns)} total</td>
                          {/if}
                        </tr>
                      {/each}
                      {#each pod.unscanned_images ?? [] as image (image)}
                        <tr class="h-8 text-[var(--text-muted)]">
                          <td class="truncate px-2 font-mono" title={image}>{image}</td>
                          <td class="px-2 text-right" colspan="5">Not scanned</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  </ScrollArea>
  {/if}
</ViewPanel>
