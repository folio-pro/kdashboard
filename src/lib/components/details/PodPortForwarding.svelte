<script lang="ts">
  import { Play, Box, Info, Square, ExternalLink, ArrowRight, Bookmark, BookmarkCheck } from "lucide-svelte";
  import { Button, Input, Spinner } from "$lib/components/ui";
  import { open } from "$lib/ipc/shell";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { portForwardStore } from "$lib/stores/port-forwards.svelte";
  import { describeTarget, inferForwardTarget } from "$lib/stores/port-forwards.logic";
  import { getContainerIconUrl } from "$lib/utils/container-icon";
  import type { Resource } from "$lib/types";
  import type { PortInfo, SpecContainer } from "./pod-utils";

  interface Props {
    allPorts: PortInfo[];
    /** The pod itself — a saved forward follows its owning workload. */
    pod?: Pick<Resource, "metadata">;
    podName: string;
    namespace: string;
    specContainerMap: Map<string, SpecContainer>;
    failedIcons: Set<string>;
    onIconError: (url: string) => void;
  }

  let { allPorts, pod, podName, namespace, specContainerMap, failedIcons, onIconError }: Props = $props();

  // Where a saved forward would point: the Deployment/StatefulSet/DaemonSet
  // behind the pod when known, else the pod itself.
  let saveTarget = $derived(pod ? inferForwardTarget(pod) : { kind: "Pod" as const, name: podName });

  function toggleSaved(pf: typeof k8sStore.portForwards[0]) {
    const saved = portForwardStore.savedFor(pf) ?? portForwardStore.findEquivalent(pf, saveTarget);
    if (saved) portForwardStore.forget(saved.id);
    else portForwardStore.save(pf, saveTarget);
  }

  let portInputs = $state<Record<number, string>>({});
  let portForwardingPorts = $state<Set<number>>(new Set());
  let portForwardError = $state<string | null>(null);

  function getLocalPort(containerPort: number): string {
    return portInputs[containerPort] ?? String(containerPort);
  }

  let activeForwardsByPort = $derived.by(() => {
    const map = new Map<number, typeof k8sStore.portForwards[0]>();
    for (const pf of k8sStore.portForwards) {
      if (pf.pod_name === podName && pf.namespace === namespace) {
        map.set(pf.container_port, pf);
      }
    }
    return map;
  });

  async function handlePortForward(containerPort: number) {
    if (activeForwardsByPort.has(containerPort)) return;
    const localPort = parseInt(portInputs[containerPort] ?? String(containerPort), 10);
    if (isNaN(localPort) || localPort < 1 || localPort > 65535) {
      portForwardError = "Invalid port number";
      return;
    }
    portForwardError = null;
    const next = new Set(portForwardingPorts);
    next.add(containerPort);
    portForwardingPorts = next;
    try {
      const sessionId = crypto.randomUUID();
      await k8sStore.addPortForward({
        session_id: sessionId,
        pod_name: podName,
        namespace: namespace,
        container_port: containerPort,
        local_port: localPort,
      });
      if (k8sStore.error) {
        portForwardError = k8sStore.error;
        k8sStore.error = null;
      }
    } catch (err) {
      portForwardError = `Port forward failed: ${err}`;
    } finally {
      const cleaned = new Set(portForwardingPorts);
      cleaned.delete(containerPort);
      portForwardingPorts = cleaned;
    }
  }

  async function handleStopPortForward(containerPort: number) {
    const pf = activeForwardsByPort.get(containerPort);
    if (pf) {
      await k8sStore.removePortForward(pf.session_id);
    }
  }
</script>

{#snippet containerIcon(iconUrl: string | null, name: string)}
  {#if iconUrl}
    <img
      src={iconUrl}
      alt={name}
      class="h-4 w-4 object-contain"
      onerror={() => onIconError(iconUrl)}
    />
  {:else}
    <Box class="h-3.5 w-3.5 text-[var(--text-muted)]" />
  {/if}
{/snippet}

<!-- Container query on the list, not the viewport: the same card sits in the
     full-width detail tab and in the 320–440px aside. Past ~460px each port is
     one line; under it the forward controls drop to a second line under the
     name so the input and button never get squeezed out. -->
<div class="@container flex flex-col gap-[7px]">
  {#each allPorts as port}
    {@const activePf = activeForwardsByPort.get(port.containerPort)}
    {@const forwarded = !!activePf}
    {@const loading = portForwardingPorts.has(port.containerPort)}
    {@const containerImage = specContainerMap.get(port.containerName)?.image ?? ""}
    {@const rawIcon = getContainerIconUrl(containerImage)}
    {@const portIcon = rawIcon && !failedIcons.has(rawIcon) ? rawIcon : null}
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2.5 {forwarded ? '' : 'border-[var(--border-color)] bg-[var(--bg-secondary)]'}"
      style={forwarded
        ? "border-color: color-mix(in srgb, var(--accent) 28%, transparent); background-color: color-mix(in srgb, var(--accent) 9%, transparent);"
        : ""}
    >
      <!-- Identity: icon · container · port. Takes the line on its own when narrow. -->
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-[var(--bg-tertiary)]">
          {@render containerIcon(portIcon, port.containerName)}
        </span>
        <span class="min-w-0 truncate text-[12px] font-medium text-[var(--text-primary)]" title={port.containerName}>{port.containerName}</span>
        <span class="shrink-0 font-mono text-[12px] text-[var(--text-secondary)]">{port.containerPort}/{port.protocol}</span>
      </div>
      <!-- Forward controls: inline on the right when there is room, a full
           second line (indented under the name) when there is not. -->
      {#if forwarded && activePf}
        {@const savedEntry = portForwardStore.savedFor(activePf) ?? portForwardStore.findEquivalent(activePf, saveTarget)}
        <div class="flex items-center gap-2 @max-[460px]:w-full @max-[460px]:pl-9">
          <ArrowRight class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
          <Button
            variant="link"
            size="inline-sm"
            mono
            class="min-w-0 truncate"
            onclick={() => open(`http://localhost:${activePf.local_port}`)}
            title="Open in browser"
          >localhost:{activePf.local_port} <ExternalLink class="h-3 w-3 shrink-0" /></Button>
          <span class="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--status-running)]">
            <span class="h-1.5 w-1.5 rounded-full bg-[var(--status-running)]"></span>active
          </span>
          <Button
            variant="toolbar"
            size="icon-sm"
            class="shrink-0"
            onclick={() => toggleSaved(activePf)}
            title={savedEntry
              ? `Saved as ${describeTarget(savedEntry)} → localhost:${savedEntry.local_port}. Click to forget.`
              : `Save this forward (${describeTarget({ target_kind: saveTarget.kind, target_name: saveTarget.name })} → localhost:${activePf.local_port}) so it can be restarted and reconnects when the pod changes`}
            data-testid="save-port-forward"
          >
            {#if savedEntry}
              <BookmarkCheck class="h-3.5 w-3.5 text-[var(--accent)]" />
            {:else}
              <Bookmark class="h-3.5 w-3.5" />
            {/if}
          </Button>
          <Button
            variant="toolbar"
            size="sm"
            class="shrink-0 hover:border-[var(--status-failed)]"
            onclick={() => handleStopPortForward(port.containerPort)}
          >
            <Square class="h-3 w-3 text-[var(--status-failed)]" /> Stop
          </Button>
        </div>
      {:else}
        <div class="flex items-center gap-2 @max-[460px]:w-full @max-[460px]:pl-9">
          <ArrowRight class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
          <span class="font-mono text-[12px] text-[var(--text-muted)]">localhost:</span>
          <Input
            type="text"
            size="sm"
            mono
            class="w-14 px-1.5 text-center"
            value={getLocalPort(port.containerPort)}
            oninput={(e) => {
              const target = e.target as HTMLInputElement;
              portInputs[port.containerPort] = target.value;
            }}
            disabled={loading}
            title="Local port"
          />
          <Button
            variant="toolbar"
            size="sm"
            class="ml-auto shrink-0 hover:border-[var(--status-running)]"
            onclick={() => handlePortForward(port.containerPort)}
            disabled={loading}
          >
            {#if loading}
              <Spinner size="xs" class="text-[var(--status-running)]" />
            {:else}
              <Play class="h-3 w-3 text-[var(--status-running)]" />
            {/if}
            Forward
          </Button>
        </div>
      {/if}
    </div>
  {/each}

  {#if portForwardError}
    <div class="flex items-center gap-1.5 rounded-md border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/5 px-3 py-2.5">
      <Info class="h-3.5 w-3.5 shrink-0 text-[var(--status-failed)]" />
      <span class="text-[12px] text-[var(--status-failed)]">{portForwardError}</span>
    </div>
  {/if}

  {#if allPorts.length === 0}
    <p class="text-[12px] text-[var(--text-muted)]">No ports defined</p>
  {/if}
</div>
