<script lang="ts">
  import CollapsibleCard from "./CollapsibleCard.svelte";

  interface Props {
    spec: Record<string, unknown>;
  }

  let { spec }: Props = $props();

  interface VolumeInfo {
    name: string;
    type: string;
    detail: string;
  }

  const typeColors: Record<string, string> = {
    emptyDir: "var(--text-dimmed)",
    hostPath: "var(--status-pending)",
    configMap: "var(--status-running)",
    secret: "var(--status-pending)",
    persistentVolumeClaim: "var(--accent)",
    projected: "#a78bfa",
    downwardAPI: "var(--text-muted)",
    nfs: "var(--status-succeeded)",
    csi: "var(--accent)",
  };

  function extractVolumeInfo(vol: Record<string, unknown>): VolumeInfo {
    const name = (vol.name as string) ?? "unknown";

    if (vol.emptyDir) {
      const e = vol.emptyDir as Record<string, unknown>;
      const medium = (e.medium as string) ?? "default";
      const sizeLimit = e.sizeLimit ? `, limit: ${e.sizeLimit}` : "";
      return { name, type: "emptyDir", detail: `medium: ${medium}${sizeLimit}` };
    }
    if (vol.hostPath) {
      const h = vol.hostPath as Record<string, unknown>;
      return { name, type: "hostPath", detail: `${h.path ?? "?"}${h.type ? ` (${h.type})` : ""}` };
    }
    if (vol.configMap) {
      const c = vol.configMap as Record<string, unknown>;
      return { name, type: "configMap", detail: (c.name as string) ?? "?" };
    }
    if (vol.secret) {
      const s = vol.secret as Record<string, unknown>;
      return { name, type: "secret", detail: (s.secretName as string) ?? "?" };
    }
    if (vol.persistentVolumeClaim) {
      const p = vol.persistentVolumeClaim as Record<string, unknown>;
      return { name, type: "persistentVolumeClaim", detail: `claim: ${(p.claimName as string) ?? "?"}${p.readOnly ? " (ro)" : ""}` };
    }
    if (vol.projected) {
      const p = vol.projected as Record<string, unknown>;
      const sources = (p.sources as Array<Record<string, unknown>>) ?? [];
      return { name, type: "projected", detail: `${sources.length} source${sources.length !== 1 ? "s" : ""}` };
    }
    if (vol.downwardAPI) {
      return { name, type: "downwardAPI", detail: "pod metadata" };
    }
    if (vol.nfs) {
      const n = vol.nfs as Record<string, unknown>;
      return { name, type: "nfs", detail: `${n.server ?? "?"}:${n.path ?? "?"}` };
    }
    if (vol.csi) {
      const c = vol.csi as Record<string, unknown>;
      return { name, type: "csi", detail: (c.driver as string) ?? "?" };
    }

    // Fallback: try to detect the type from keys
    const knownKeys = ["emptyDir", "hostPath", "configMap", "secret", "persistentVolumeClaim", "projected", "downwardAPI", "nfs", "csi", "name"];
    const otherKey = Object.keys(vol).find(k => !knownKeys.includes(k));
    if (otherKey) {
      return { name, type: otherKey, detail: "" };
    }
    return { name, type: "unknown", detail: "" };
  }

  let volumes = $derived.by(() => {
    const rawVolumes = (spec.volumes as Array<Record<string, unknown>>) ?? [];
    return rawVolumes.map(extractVolumeInfo);
  });

  let hasContent = $derived(volumes.length > 0);
</script>

{#if hasContent}
  <CollapsibleCard title="Volumes" count={volumes.length}>
    {#each volumes as vol}
      <div class="flex items-start gap-3 border-t border-[var(--border-hover)] px-5 py-3.5">
        <span
          class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
          style="color: {typeColors[vol.type] ?? 'var(--text-dimmed)'}; background-color: color-mix(in srgb, {typeColors[vol.type] ?? 'var(--text-dimmed)'} 12%, transparent);"
        >
          {vol.type}
        </span>
        <div class="min-w-0 flex-1">
          <div class="text-[12px] font-medium text-[var(--text-primary)]">{vol.name}</div>
          {#if vol.detail}
            <div class="mt-0.5 truncate font-mono text-[11px] text-[var(--text-muted)]">{vol.detail}</div>
          {/if}
        </div>
      </div>
    {/each}
  </CollapsibleCard>
{/if}
