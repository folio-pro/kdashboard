<script lang="ts">
  import { Button, CardSection, toneStyle } from "$lib/components/ui";
  import { Bookmark, ExternalLink, Square, Play, Trash2, RefreshCw, Zap, ZapOff } from "lucide-svelte";
  import { portForwardStore } from "$lib/stores/port-forwards.svelte";
  import { describeState, describeTarget } from "$lib/stores/port-forwards.logic";
  import type { SavedPortForward } from "$lib/types";

  interface Props {
    forwards: SavedPortForward[];
    onOpen: (localPort: number) => void;
  }

  let { forwards, onOpen }: Props = $props();

  // Sorted by target so the list is stable while states churn.
  let rows = $derived(
    [...forwards].sort((a, b) =>
      `${a.namespace}/${a.target_name}:${a.local_port}`.localeCompare(`${b.namespace}/${b.target_name}:${b.local_port}`),
    ),
  );
</script>

<CardSection title="Saved forwards" icon={Bookmark} subtitle="reconnect when the pod changes · auto-start opens them with the context" data-testid="saved-port-forwards">
  <table class="w-full" style="table-layout: fixed;">
    <tbody>
      {#each rows as saved (saved.id)}
        {@const state = portForwardStore.stateOf(saved.id)}
        {@const st = describeState(state)}
        <tr class="h-10 border-b border-[var(--border-hover)] last:border-b-0 hover:bg-[var(--table-row-hover)]" data-testid="saved-port-forward">
          <td class="px-4 text-[12px]">
            <span class="block truncate font-medium text-[var(--text-primary)]" title={describeTarget(saved)}>{describeTarget(saved)}</span>
          </td>
          <td class="w-[150px] px-4 text-[12px] text-[var(--text-secondary)]">{saved.namespace}</td>
          <td class="w-[190px] px-4 font-mono text-[12px] text-[var(--text-secondary)]">
            {saved.container_port} <span class="text-[var(--text-muted)]">→</span> <span class="text-[var(--accent)]">localhost:{saved.local_port}</span>
          </td>
          <td class="w-[240px] px-4 text-[11px]">
            <span class="inline-flex max-w-full items-center gap-1.5 truncate text-[var(--tone)]" style={toneStyle(st.tone)} title={st.label}>
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--tone)]"></span>
              <span class="truncate">{st.label}</span>
            </span>
          </td>
          <td class="w-[300px] px-4">
            <div class="flex items-center justify-end gap-1">
              <Button
                variant="ghost-tone"
                tone={saved.auto_start ? "accent" : "muted"}
                size="sm"
                onclick={() => portForwardStore.setAutoStart(saved.id, !saved.auto_start)}
                title={saved.auto_start ? "Auto-start on: opens when this context connects" : "Auto-start off"}
                data-testid="saved-port-forward-autostart"
              >
                {#if saved.auto_start}<Zap class="h-3 w-3" />{:else}<ZapOff class="h-3 w-3" />{/if}
                Auto
              </Button>
              {#if state.kind === "active"}
                <Button variant="ghost-tone" tone="accent" size="sm" onclick={() => onOpen(saved.local_port)}>
                  <ExternalLink class="h-3 w-3" /> Open
                </Button>
                <Button variant="ghost-tone" tone="error" size="sm" onclick={() => portForwardStore.stop(saved.id)}>
                  <Square class="h-3 w-3" /> Stop
                </Button>
              {:else if state.kind === "starting" || state.kind === "reconnecting"}
                <Button variant="ghost-tone" tone="error" size="sm" onclick={() => portForwardStore.stop(saved.id)}>
                  <Square class="h-3 w-3" /> Cancel
                </Button>
              {:else}
                <Button variant="ghost-tone" tone="accent" size="sm" onclick={() => portForwardStore.start(saved)} data-testid="saved-port-forward-start">
                  {#if state.kind === "error"}<RefreshCw class="h-3 w-3" /> Retry{:else}<Play class="h-3 w-3" /> Start{/if}
                </Button>
              {/if}
              <Button variant="ghost-tone" tone="muted" size="sm" onclick={() => portForwardStore.forget(saved.id)} title="Forget this saved forward">
                <Trash2 class="h-3 w-3" />
              </Button>
            </div>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</CardSection>
