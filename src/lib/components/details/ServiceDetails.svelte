<script lang="ts">
  import { Badge, Button } from "$lib/components/ui";
  import { Globe, Server, Filter, Link, Unplug, Cloud } from "lucide-svelte";
  import type { Resource, ResourceList } from "$lib/types";
  import { invoke } from "$lib/ipc/core";
  import { formatAge } from "$lib/utils/age";
  import {
    endpointAddresses,
    isHeadless,
    serviceExternal,
    servicePorts,
    serviceSelector,
  } from "$lib/utils/service-info";
  import { podReadyCount, podStatus } from "$lib/utils/pod-status";
  import { statusCategory, statusColor, isQuietStatus } from "$lib/components/table/status-category";
  import { splitPodName } from "$lib/components/table/table-filter";
  import { endpointsStore } from "$lib/stores/endpoints.svelte";
  import { openRelatedResourceTab, openResourceDetail } from "$lib/actions/navigation";
  import SummaryStrip from "./SummaryStrip.svelte";
  import SummaryCell from "./SummaryCell.svelte";
  import AttentionBlock from "./AttentionBlock.svelte";
  import DetailColumns from "./DetailColumns.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvGrid from "./KvGrid.svelte";
  import KvField from "./KvField.svelte";
  import LinkRow from "./LinkRow.svelte";
  import RecentEventsCard from "./RecentEventsCard.svelte";
  import CollapsibleCard from "./CollapsibleCard.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import { ingressesForService, podControllers, podsMissingFromSlices, sliceSummaryLine } from "./service-details.logic";

  /**
   * A Service, read the way you debug one: does it have backends, where is
   * it reachable, which ports map where, which pods the selector catches and
   * which of them the EndpointSlice actually lists.
   */
  interface Props {
    resource: Resource;
    layout?: "page" | "aside";
  }

  let { resource, layout = "page" }: Props = $props();

  let spec = $derived(resource.spec ?? {});
  let status = $derived(resource.status ?? {});
  let namespace = $derived(resource.metadata.namespace ?? "");
  let name = $derived(resource.metadata.name);

  let serviceType = $derived((spec.type as string) ?? "ClusterIP");
  let clusterIP = $derived((spec.clusterIP as string) ?? "-");
  let headless = $derived(isHeadless(resource));
  let external = $derived(serviceExternal(resource));
  let selectorTerms = $derived(serviceSelector(resource));
  let selectorString = $derived(selectorTerms.join(","));
  let ports = $derived(servicePorts(resource));
  let hasNodePorts = $derived(ports.some((p) => p.nodePort));
  let hasAppProtocol = $derived(ports.some((p) => p.appProtocol));
  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  // --- EndpointSlices (store, throttled) -----------------------------------
  $effect(() => {
    void name;
    void endpointsStore.load(namespace || null, true);
  });
  let summary = $derived(endpointsStore.summaryFor(namespace, name));
  let slices = $derived(endpointsStore.slicesFor(namespace, name));
  let addresses = $derived(endpointAddresses(slices, name, namespace));
  let sliceLine = $derived(sliceSummaryLine(slices));
  let hasZones = $derived(addresses.some((a) => a.zone));

  // --- Pods behind the selector --------------------------------------------
  let pods = $state<Resource[]>([]);
  let podsLoading = $state(false);
  $effect(() => {
    const sel = selectorString;
    const ns = namespace;
    let cancelled = false;
    if (!sel) {
      pods = [];
      podsLoading = false;
      return;
    }
    podsLoading = true;
    invoke<ResourceList>("list_pods_by_selector", { namespace: ns, selector: sel })
      .then((r) => { if (!cancelled) pods = r.items; })
      .catch(() => { if (!cancelled) pods = []; })
      .finally(() => { if (!cancelled) podsLoading = false; });
    return () => { cancelled = true; };
  });
  let runningPods = $derived(pods.filter((p) => podStatus(p).label === "Running").length);
  let readyPods = $derived(pods.filter((p) => { const r = podReadyCount(p); return r.total > 0 && r.ready === r.total; }).length);
  let controllers = $derived(podControllers(pods));
  let missingPods = $derived(podsMissingFromSlices(pods, addresses));

  // --- Ingresses routing here ----------------------------------------------
  let ingresses = $state<Resource[]>([]);
  $effect(() => {
    const ns = namespace;
    void name;
    let cancelled = false;
    invoke<ResourceList>("list_resources", { resourceType: "ingresses", namespace: ns })
      .then((r) => { if (!cancelled) ingresses = r.items; })
      .catch(() => { if (!cancelled) ingresses = []; });
    return () => { cancelled = true; };
  });
  let routes = $derived(ingressesForService(ingresses, name, namespace));

  // --- Attention -------------------------------------------------------------
  let noBackends = $derived(
    summary !== undefined && selectorTerms.length > 0 && (summary === null || summary.total === 0),
  );

  // --- Load balancer -------------------------------------------------------
  let lbIngress = $derived(
    ((status.loadBalancer as { ingress?: Array<{ ip?: string; hostname?: string }> })?.ingress ?? [])
      .map((i) => i.ip ?? i.hostname ?? "")
      .filter(Boolean),
  );
  let sourceRanges = $derived((spec.loadBalancerSourceRanges as string[] | undefined) ?? []);
  let ipFamilies = $derived(((spec.ipFamilies as string[] | undefined) ?? []).join(", "));

  const TH = "pb-1.5 text-left text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]";
  const TD = "whitespace-nowrap py-1.5 pr-3 text-[12px]";
</script>

<div class="select-text" data-testid="service-details">
  <SummaryStrip>
    <SummaryCell label="Type">
      <span class="flex items-center gap-1.5">
        <Badge appearance="surface" size="sm" bordered mono class="px-1.5">{serviceType}</Badge>
        {#if headless}<span class="text-[11px] text-[var(--text-muted)]">headless</span>{/if}
      </span>
    </SummaryCell>
    <SummaryCell label="Cluster IP" value={clusterIP} />
    <SummaryCell label="External" title={external.label}>
      {#if external.label}
        <span class="truncate font-mono text-[12px] tabular-nums text-[var(--text-primary)]">{external.label}</span>
      {:else if external.pending}
        <span
          class="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-[11px] font-medium leading-4"
          style="color: var(--status-pending); background-color: color-mix(in srgb, var(--status-pending) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--status-pending) 25%, transparent);"
        ><span class="h-[5px] w-[5px] rounded-full bg-[var(--status-pending)]"></span>Pending</span>
      {:else}
        <span class="text-[12px] text-[var(--text-muted)]">—</span>
      {/if}
    </SummaryCell>
    <SummaryCell label="Endpoints">
      {#if summary === undefined}
        <span></span>
      {:else if summary === null}
        <span class="text-[12px] text-[var(--text-muted)]" title="No EndpointSlice for this service">—</span>
      {:else if summary.total === 0}
        <span class="inline-flex items-center gap-1.5" title="No endpoints: nothing backs this service">
          <span class="h-[5px] w-[5px] rounded-full bg-[var(--status-failed)]"></span>
          <span class="font-mono text-[13px] tabular-nums text-[var(--status-failed)]">0</span>
        </span>
      {:else}
        <span
          class="font-mono text-[13px] tabular-nums"
          style:color={summary.ready < summary.total ? "var(--status-pending)" : "var(--text-primary)"}
        >{summary.ready}/{summary.total}</span>
      {/if}
    </SummaryCell>
    {#if layout === "page"}
      <SummaryCell label="Ports" value={ports.length ? ports.map((p) => p.port).join(" · ") : "—"} />
      <SummaryCell label="Selector" value={selectorTerms.length ? selectorTerms.join(", ") : "—"} />
      <SummaryCell label="Traffic" value={`${(spec.internalTrafficPolicy as string) ?? "Cluster"} / ${(spec.externalTrafficPolicy as string) ?? "—"}`} mono={false} />
    {/if}
    <SummaryCell label="Age" value={formatAge(resource.metadata.creation_timestamp)} />
  </SummaryStrip>

  {#if noBackends}
    <AttentionBlock tone="error" title="No endpoints — traffic to this service has nowhere to go">
      <span>
        Selector <code>{selectorTerms.join(", ")}</code> matches
        <b>{podsLoading ? "…" : `${runningPods} running ${runningPods === 1 ? "pod" : "pods"}`}</b>
        in <code>{namespace || "default"}</code>.
      </span>
      {#if !podsLoading && pods.length > 0 && readyPods === 0}
        <span>{pods.length} {pods.length === 1 ? "pod matches" : "pods match"} but none is ready.</span>
      {/if}
      {#snippet actions()}
        {#if pods.length > 0}
          <Button variant="toolbar" size="xs" onclick={() => openResourceDetail(pods[0], "pods")}>
            <Filter class="h-3 w-3" />
            First matching pod
          </Button>
        {/if}
      {/snippet}
    </AttentionBlock>
  {/if}
  {#if external.pending}
    <AttentionBlock tone="warning" title="LoadBalancer has no address yet">
      <span>The cloud controller has not assigned an IP or hostname. If this persists, check the controller's events and the service's annotations.</span>
    </AttentionBlock>
  {/if}

  <DetailColumns {layout}>
    {#snippet main()}
      <!-- Ports -->
      <DetailSection title="Ports" icon={Globe}>
        {#snippet actions()}
          <span class="font-mono text-[11px] text-[var(--text-muted)]">{ports.length}</span>
        {/snippet}
        {#if ports.length > 0}
          <div class="overflow-x-auto">
          <table class="w-full border-collapse">
            <thead>
              <tr class="border-b border-[var(--border-color)]">
                <th class={TH}>Name</th>
                <th class="{TH} text-right">Port</th>
                <th class="{TH} text-right">→ Target</th>
                <th class="{TH} pl-4">Protocol</th>
                {#if hasAppProtocol}<th class={TH}>App protocol</th>{/if}
                {#if hasNodePorts}<th class="{TH} text-right">Node port</th>{/if}
              </tr>
            </thead>
            <tbody>
              {#each ports as port, i (`${port.name ?? ""}:${port.port ?? ""}:${i}`)}
                <tr class="border-b border-[var(--hairline)] last:border-b-0">
                  <td class="{TD} font-medium text-[var(--text-primary)]">{port.name ?? "-"}</td>
                  <td class="{TD} text-right font-mono tabular-nums text-[var(--text-primary)]">{port.port ?? "-"}</td>
                  <td class="{TD} text-right font-mono tabular-nums text-[var(--text-secondary)]">{port.targetPort ?? port.port ?? "-"}</td>
                  <td class="{TD} pl-4 font-mono text-[var(--text-secondary)]">{port.protocol ?? "TCP"}</td>
                  {#if hasAppProtocol}<td class="{TD} font-mono text-[var(--text-secondary)]">{port.appProtocol ?? "—"}</td>{/if}
                  {#if hasNodePorts}<td class="{TD} text-right font-mono tabular-nums text-[var(--text-secondary)]">{port.nodePort ?? "—"}</td>{/if}
                </tr>
              {/each}
            </tbody>
          </table>
          </div>
        {:else}
          <p class="text-[12px] text-[var(--text-muted)]">No ports configured</p>
        {/if}
      </DetailSection>

      <!-- Endpoints -->
      {#if serviceType !== "ExternalName"}
        <DetailSection title="Endpoints" icon={Server}>
          {#snippet actions()}
            <span class="font-mono text-[11px] text-[var(--text-muted)]">{summary === undefined ? "…" : summary === null ? "—" : summary.total}</span>
          {/snippet}
          <div class="flex flex-col gap-2.5">
            {#if addresses.length > 0}
              <div class="overflow-x-auto">
              <table class="w-full border-collapse">
                <thead>
                  <tr class="border-b border-[var(--border-color)]">
                    <th class={TH}>Address</th>
                    <th class={TH}>Pod</th>
                    <th class={TH}>Node</th>
                    {#if hasZones}<th class={TH}>Zone</th>{/if}
                    <th class={TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {#each addresses as ep, i (`${ep.address}:${ep.port ?? ""}:${i}`)}
                    <tr class="border-b border-[var(--hairline)] last:border-b-0">
                      <td class="{TD} font-mono tabular-nums text-[var(--text-primary)]">{ep.address}{ep.port ? `:${ep.port}` : ""}</td>
                      <td class="{TD} max-w-[220px] truncate">
                        {#if ep.targetRef?.name}
                          {@const ref = ep.targetRef}
                          <button
                            type="button"
                            class="max-w-full truncate font-mono text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:underline"
                            onclick={() => openRelatedResourceTab(ref.kind === "Pod" ? "pods" : (ref.kind ?? "pods").toLowerCase() + "s", ref.name ?? "", ref.namespace ?? namespace)}
                          >{ref.name}</button>
                        {:else}
                          <span class="text-[var(--text-muted)]">—</span>
                        {/if}
                      </td>
                      <td class="{TD} max-w-[160px] truncate font-mono text-[11px] text-[var(--text-muted)]" title={ep.nodeName ?? ""}>{ep.nodeName ?? "—"}</td>
                      {#if hasZones}<td class="{TD} font-mono text-[11px] text-[var(--text-muted)]">{ep.zone ?? "—"}</td>{/if}
                      <td class={TD}>
                        {#if ep.terminating}
                          <span class="text-[11px] text-[var(--text-muted)]">terminating</span>
                        {:else if ep.ready}
                          <span class="inline-flex items-center gap-1.5 text-[11px] text-[var(--status-running)]">✓ ready</span>
                        {:else}
                          <span class="inline-flex items-center gap-1.5 text-[11px] text-[var(--status-pending)]">✗ not ready</span>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              </div>
            {:else}
              <div class="rounded-sm border border-dashed border-[var(--border-color)] px-3 py-2.5 text-center text-[12px] text-[var(--text-muted)]">
                {summary === undefined ? "Loading endpoints…" : "No ready or terminating endpoints"}
              </div>
            {/if}
            {#if sliceLine || summary}
              <div class="flex flex-wrap gap-x-4 text-[11px] text-[var(--text-muted)]">
                {#if sliceLine}<span class="truncate font-mono">{sliceLine}</span>{/if}
                {#if summary}<span>{summary.ready} ready · {summary.terminating} terminating</span>{/if}
              </div>
            {/if}
            {#if missingPods.length > 0 && summary !== undefined}
              <div class="text-[11px] text-[var(--text-muted)]">
                Not in any slice yet:
                {#each missingPods as p, i (p.metadata.uid)}
                  <span class="font-mono">{p.metadata.name}</span><span class="text-[var(--text-muted)]"> ({podStatus(p).label})</span>{i < missingPods.length - 1 ? ", " : ""}
                {/each}
              </div>
            {/if}
          </div>
        </DetailSection>
      {/if}

      <!-- Selector → pods -->
      {#if selectorTerms.length > 0}
        <DetailSection title="Selector → pods" icon={Filter}>
          {#snippet actions()}
            <span class="font-mono text-[11px] text-[var(--text-muted)]">{podsLoading ? "…" : pods.length}</span>
          {/snippet}
          <div class="flex flex-col gap-2.5">
            <div class="flex flex-wrap gap-1.5">
              {#each selectorTerms as term (term)}
                <Badge appearance="surface" size="sm" bordered mono class="px-1.5">{term}</Badge>
              {/each}
            </div>
            {#if pods.length > 0}
              <div class="overflow-x-auto">
              <table class="w-full border-collapse">
                <thead>
                  <tr class="border-b border-[var(--border-color)]">
                    <th class={TH}>Name</th>
                    <th class={TH}>Status</th>
                    <th class="{TH} text-right">Ready</th>
                    <th class="{TH} text-right">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {#each pods as pod (pod.metadata.uid)}
                    {@const st = podStatus(pod)}
                    {@const cat = statusCategory(st.label)}
                    {@const ready = podReadyCount(pod)}
                    {@const parts = splitPodName(pod.metadata.name)}
                    <tr
                      class="cursor-pointer border-b border-[var(--hairline)] transition-colors last:border-b-0 hover:bg-[var(--table-row-hover)]"
                      onclick={() => openResourceDetail(pod, "pods")}
                    >
                      <td class="{TD} max-w-[220px] truncate font-medium text-[var(--text-primary)]" title={pod.metadata.name}>{parts.base}<span class="font-normal text-[var(--text-muted)]">{parts.suffix}</span></td>
                      <td class={TD}>
                        {#if isQuietStatus(cat)}
                          <span class="text-[var(--text-muted)]">{st.label}</span>
                        {:else}
                          <span
                            class="inline-flex items-center gap-1.5 rounded-sm px-1.5 text-[11px] font-medium leading-4"
                            style="color: {statusColor(cat)}; background-color: color-mix(in srgb, {statusColor(cat)} 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, {statusColor(cat)} 25%, transparent);"
                          ><span class="h-[5px] w-[5px] rounded-full" style="background-color: {statusColor(cat)}"></span>{st.label}</span>
                        {/if}
                      </td>
                      <td class="{TD} text-right font-mono tabular-nums" style:color={ready.total > 0 && ready.ready < ready.total ? "var(--status-pending)" : "var(--text-secondary)"}>{ready.ready}/{ready.total}</td>
                      <td class="{TD} text-right font-mono tabular-nums text-[var(--text-muted)]">{formatAge(pod.metadata.creation_timestamp)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              </div>
            {:else if !podsLoading}
              <p class="text-[12px] text-[var(--text-muted)]">No pods match this selector</p>
            {/if}
          </div>
        </DetailSection>
      {/if}

      <RecentEventsCard {resource} />
    {/snippet}

    {#snippet rail()}
      {#if serviceType === "LoadBalancer"}
        <DetailSection title="Load balancer" icon={Cloud}>
          <KvGrid>
            <KvField label={lbIngress.length > 1 ? "Addresses" : "Address"} value={lbIngress.length ? lbIngress.join(", ") : "pending"} />
            {#if spec.loadBalancerClass}<KvField label="Class" value={spec.loadBalancerClass as string} mono={false} />{/if}
            {#if sourceRanges.length > 0}<KvField label="Source ranges" value={sourceRanges.join(", ")} />{/if}
            {#if spec.allocateLoadBalancerNodePorts !== undefined}<KvField label="Allocate node ports" value={String(spec.allocateLoadBalancerNodePorts)} mono={false} />{/if}
          </KvGrid>
        </DetailSection>
      {/if}

      <DetailSection title="Traffic" icon={Unplug}>
        <KvGrid>
          <KvField label="Session affinity" value={(spec.sessionAffinity as string) ?? "None"} mono={false} />
          <KvField label="Internal traffic policy" value={(spec.internalTrafficPolicy as string) ?? "Cluster"} mono={false} />
          <KvField label="External traffic policy" value={(spec.externalTrafficPolicy as string) ?? "—"} mono={false} />
          <KvField label="IP families" value={ipFamilies ? `${ipFamilies}${spec.ipFamilyPolicy ? ` · ${spec.ipFamilyPolicy}` : ""}` : "—"} />
          <KvField label="Publish not-ready" value={String(spec.publishNotReadyAddresses === true)} mono={false} />
          {#if spec.healthCheckNodePort}<KvField label="Health check node port" value={String(spec.healthCheckNodePort)} />{/if}
        </KvGrid>
      </DetailSection>

      {#if controllers.length > 0 || routes.length > 0 || slices.length > 0 || spec.externalName}
        <DetailSection title="Related" icon={Link}>
          {#snippet actions()}
            <span class="font-mono text-[11px] text-[var(--text-muted)]">{controllers.length + routes.length + slices.length + (spec.externalName ? 1 : 0)}</span>
          {/snippet}
          <div class="flex flex-col gap-2.5">
            {#each controllers as c (`${c.kind}/${c.name}`)}
              <LinkRow
                kind={c.kind}
                name={c.name}
                color="var(--status-running)"
                onclick={() => openRelatedResourceTab(c.kind.toLowerCase() + "s", c.name, namespace)}
              />
            {/each}
            {#each routes as r (r.name)}
              <LinkRow
                kind="Ingress"
                name={r.name}
                color="var(--accent)"
                note={r.routes.join(", ")}
                onclick={() => openRelatedResourceTab("ingresses", r.name, namespace)}
              />
            {/each}
            {#each slices as s (s.metadata.uid)}
              <LinkRow
                kind="EndpointSlice"
                name={s.metadata.name}
                color="var(--accent)"
                onclick={() => openRelatedResourceTab("endpointslices", s.metadata.name, namespace)}
              />
            {/each}
            {#if spec.externalName}
              <LinkRow kind="ExternalName" name={spec.externalName as string} />
            {/if}
            {#if routes.length === 0 && serviceType !== "ExternalName"}
              <span class="text-[11px] text-[var(--text-muted)]">No Ingress routes to this service.</span>
            {/if}
          </div>
        </DetailSection>
      {/if}

      <LabelsSection {labels} />
    {/snippet}
  </DetailColumns>

  <CollapsibleCard title="Metadata">
    <div class="px-6 pt-1">
      <KvGrid>
        <KvField label="Name" value={resource.metadata.name} />
        {#if resource.metadata.namespace}<KvField label="Namespace" value={resource.metadata.namespace} />{/if}
        <KvField label="Created" value={resource.metadata.creation_timestamp} mono={false} />
        {#if resource.metadata.uid}<KvField label="UID" value={resource.metadata.uid} />{/if}
        {#if resource.metadata.resource_version}<KvField label="Resource version" value={resource.metadata.resource_version} />{/if}
      </KvGrid>
    </div>
  </CollapsibleCard>
  <SmartAnnotationsCard {annotations} />
</div>
