<script lang="ts">
  import { Play, Box, Info, Square, ExternalLink, Loader2 } from "lucide-svelte";
  import { open } from "@tauri-apps/plugin-shell";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { getContainerIconUrl } from "$lib/utils/container-icon";
  import type { PortInfo, SpecContainer } from "./pod-utils";

  interface Props {
    allPorts: PortInfo[];
    podName: string;
    namespace: string;
    specContainerMap: Map<string, SpecContainer>;
    failedIcons: Set<string>;
    onIconError: (url: string) => void;
  }

  let { allPorts, podName, namespace, specContainerMap, failedIcons, onIconError }: Props = $props();

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

<div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
  <div class="flex items-center justify-between px-5 py-4">
    <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Port Forward</h3>
    <span class="text-xs text-[var(--text-muted)]">{allPorts.length} ports</span>
  </div>

  {#each allPorts as port}
    {@const activePf = activeForwardsByPort.get(port.containerPort)}
    {@const forwarded = !!activePf}
    {@const loading = portForwardingPorts.has(port.containerPort)}
    {@const containerImage = specContainerMap.get(port.containerName)?.image ?? ""}
    {@const rawIcon = getContainerIconUrl(containerImage)}
    {@const portIcon = rawIcon && !failedIcons.has(rawIcon) ? rawIcon : null}
    <div class="border-t border-[var(--border-hover)] px-4 py-3">
      {#if forwarded && activePf}
        <!-- Active state: compact with status -->
        <div class="flex items-center gap-3 rounded-md bg-[var(--status-running)]/5 px-3 py-2.5">
          <div class="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--bg-secondary)]">
            {@render containerIcon(portIcon, port.containerName)}
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[12px] font-medium text-[var(--text-primary)]">
              :{activePf.local_port} → {port.containerPort}/{port.protocol}
            </div>
            <div class="text-[11px] text-[var(--text-muted)]">{port.containerName}</div>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <button
              class="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-hover)] bg-[var(--bg-secondary)] transition-colors hover:border-[var(--accent)]"
              onclick={() => open(`http://localhost:${activePf.local_port}`)}
              title="Open in browser"
            >
              <ExternalLink class="h-3 w-3 text-[var(--accent)]" />
            </button>
            <button
              class="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-hover)] bg-[var(--bg-secondary)] transition-colors hover:border-[var(--status-failed)]"
              onclick={() => handleStopPortForward(port.containerPort)}
              title="Stop"
            >
              <Square class="h-3 w-3 text-[var(--status-failed)]" />
            </button>
          </div>
        </div>
      {:else}
        <!-- Inactive state: port info + inline forward action -->
        <div class="flex items-center gap-2.5">
          <div class="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--bg-tertiary)]">
            {@render containerIcon(portIcon, port.containerName)}
          </div>
          <div class="min-w-0 flex-1">
            <span class="text-[12px] font-medium text-[var(--text-primary)]">{port.containerPort}<span class="text-[var(--text-dimmed)]">/{port.protocol}</span></span>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <div class="flex h-7 w-14 items-center rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] px-2">
              <input
                type="text"
                class="w-full bg-transparent text-center text-[12px] text-[var(--text-primary)] outline-none"
                value={getLocalPort(port.containerPort)}
                oninput={(e) => {
                  const target = e.target as HTMLInputElement;
                  portInputs[port.containerPort] = target.value;
                }}
                disabled={loading}
                title="Local port"
              />
            </div>
            <button
              class="flex h-7 items-center gap-1 rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] px-2.5 transition-colors hover:border-[var(--status-running)] disabled:opacity-50"
              onclick={() => handlePortForward(port.containerPort)}
              disabled={loading}
            >
              {#if loading}
                <Loader2 class="h-3 w-3 animate-spin text-[var(--status-running)]" />
              {:else}
                <Play class="h-3 w-3 text-[var(--status-running)]" />
              {/if}
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/each}

  {#if portForwardError}
    <div class="flex items-center gap-1.5 border-t border-[var(--border-hover)] bg-[var(--status-failed)]/5 px-5 py-3">
      <Info class="h-3.5 w-3.5 shrink-0 text-[var(--status-failed)]" />
      <span class="text-xs text-[var(--status-failed)]">{portForwardError}</span>
    </div>
  {/if}

  {#if allPorts.length === 0}
    <div class="border-t border-[var(--border-hover)] px-5 py-3.5">
      <p class="text-xs text-[var(--text-muted)]">No ports defined</p>
    </div>
  {/if}
</div>
