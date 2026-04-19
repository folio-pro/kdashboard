<script lang="ts">
  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Shield, ShieldAlert, ShieldCheck, ChevronDown, ChevronRight } from "lucide-svelte";
  import { securityStore } from "$lib/stores/security.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";

  let expandedPods = $state<Set<string>>(new Set());

  function handleBack() {
    securityStore.reset();
    uiStore.backToPrevious();
  }

  function handleRefresh() {
    securityStore.loadSecurityOverview(k8sStore.currentNamespace);
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

  let namespaceLabel = $derived(
    k8sStore.currentNamespace === "All Namespaces"
      ? "All Namespaces"
      : k8sStore.currentNamespace || "default"
  );
</script>

<ViewPanel
  title="Security Overview"
  icon={Shield}
  namespace={namespaceLabel}
  isLoading={securityStore.isLoading}
  error={securityStore.error}
  hasData={!!securityStore.overview}
  onBack={handleBack}
  onRefresh={handleRefresh}
  loadingMessage="Scanning images..."
  errorMessage="Failed to load security data"
  emptyMessage="No security data available"
  emptyHelper="Install trivy or grype to scan container images"
>
  {#snippet badge()}
    {#if securityStore.overview}
      <span class="rounded-md bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
        {securityStore.overview.scanner}
      </span>
    {/if}
  {/snippet}

  <ScrollArea class="h-full">
    <div class="p-4 space-y-4">
      <!-- Summary Cards -->
      <div class="grid grid-cols-5 gap-3">
        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div class="text-xs text-[var(--text-muted)]">Images Scanned</div>
          <div class="mt-1 text-lg font-semibold text-[var(--text-primary)]">
            {securityStore.overview!.total_images_scanned}
          </div>
        </div>

        <div class="rounded-lg border border-red-500/30 bg-[var(--bg-secondary)] p-3">
          <div class="text-xs text-red-400">Critical</div>
          <div class="mt-1 text-lg font-semibold text-red-400">
            {securityStore.overview!.total_vulns.critical}
          </div>
        </div>

        <div class="rounded-lg border border-orange-500/30 bg-[var(--bg-secondary)] p-3">
          <div class="text-xs text-orange-400">High</div>
          <div class="mt-1 text-lg font-semibold text-orange-400">
            {securityStore.overview!.total_vulns.high}
          </div>
        </div>

        <div class="rounded-lg border border-yellow-500/30 bg-[var(--bg-secondary)] p-3">
          <div class="text-xs text-yellow-400">Medium</div>
          <div class="mt-1 text-lg font-semibold text-yellow-400">
            {securityStore.overview!.total_vulns.medium}
          </div>
        </div>

        <div class="rounded-lg border border-blue-500/30 bg-[var(--bg-secondary)] p-3">
          <div class="text-xs text-blue-400">Low</div>
          <div class="mt-1 text-lg font-semibold text-blue-400">
            {securityStore.overview!.total_vulns.low}
          </div>
        </div>
      </div>

      <!-- Compliance Bar -->
      <div class="flex items-center gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-3">
        <div class="flex items-center gap-2">
          <ShieldCheck class="h-4 w-4 text-[var(--status-running)]" />
          <span class="text-sm text-[var(--text-primary)]">{securityStore.overview!.compliant_pods} compliant</span>
        </div>
        <div class="h-4 w-px bg-[var(--border-color)]"></div>
        <div class="flex items-center gap-2">
          <ShieldAlert class="h-4 w-4 text-[var(--status-failed)]" />
          <span class="text-sm text-[var(--text-primary)]">{securityStore.overview!.non_compliant_pods} non-compliant</span>
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
            <span class="text-xs text-[var(--text-muted)]">{Math.round(pct)}%</span>
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
                <span class="text-sm font-medium text-[var(--text-primary)]">{pod.name}</span>
                <span class="text-[11px] text-[var(--text-muted)]">{pod.namespace}</span>
              </div>

              <div class="flex items-center gap-1.5">
                {#if pod.total_vulns.critical > 0}
                  <span class="rounded bg-red-500/20 px-1.5 py-0.5 text-[11px] font-medium text-red-400">
                    {pod.total_vulns.critical} C
                  </span>
                {/if}
                {#if pod.total_vulns.high > 0}
                  <span class="rounded bg-orange-500/20 px-1.5 py-0.5 text-[11px] font-medium text-orange-400">
                    {pod.total_vulns.high} H
                  </span>
                {/if}
                {#if pod.total_vulns.medium > 0}
                  <span class="rounded bg-yellow-500/20 px-1.5 py-0.5 text-[11px] font-medium text-yellow-400">
                    {pod.total_vulns.medium} M
                  </span>
                {/if}
                {#if pod.total_vulns.low > 0}
                  <span class="rounded bg-blue-500/20 px-1.5 py-0.5 text-[11px] font-medium text-blue-400">
                    {pod.total_vulns.low} L
                  </span>
                {/if}
                {#if vulnTotal(pod.total_vulns) === 0}
                  <span class="text-xs text-[var(--text-muted)]">No vulnerabilities</span>
                {/if}
              </div>
            </button>

            {#if expandedPods.has(podKey)}
              <div class="border-t border-[var(--border-color)]">
                <table class="w-full text-xs">
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
                        <td class="px-3 py-1.5 text-right {img.vulns.critical > 0 ? 'text-red-400 font-medium' : ''}">
                          {img.vulns.critical}
                        </td>
                        <td class="px-3 py-1.5 text-right {img.vulns.high > 0 ? 'text-orange-400 font-medium' : ''}">
                          {img.vulns.high}
                        </td>
                        <td class="px-3 py-1.5 text-right {img.vulns.medium > 0 ? 'text-yellow-400' : ''}">
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
</ViewPanel>
