<script lang="ts">
  import { Ellipsis } from "lucide-svelte";
  import { Button } from "$lib/components/ui";
  import type { Resource } from "$lib/types";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { resourceActions } from "$lib/actions/registry";
  import type { ActionDef } from "$lib/actions/types";

  /**
   * Hover actions: the two or three things you do to a row every day, without
   * the right-click. Everything else stays behind "…", which opens the same
   * menu the right-click does. Painted over the tail of the row's last cell —
   * a solid strip with a soft left edge, so it covers whatever is under it
   * (usually a node name) instead of colliding with it.
   */
  interface Props {
    resource: Resource;
    resourceType: string;
    /** Open the row's action menu at a screen position. */
    onmore: (x: number, y: number) => void;
  }

  let { resource, resourceType, onmore }: Props = $props();

  const QUICK_ACTION_IDS = ["view-logs", "open-terminal", "edit-yaml"];
  let quickActions = $derived(
    resourceActions.filter((a) => QUICK_ACTION_IDS.includes(a.id) && a.appliesTo(resourceType, resource)),
  );

  function run(e: MouseEvent, action: ActionDef) {
    e.stopPropagation();
    // The navigate actions read the store's selected resource, as they do
    // from the context menu (see ResourceTable.openRowMenu).
    k8sStore.selectResource(resource);
    action.execute(resource);
  }

  function more(e: MouseEvent) {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onmore(rect.left, rect.bottom + 2);
  }
</script>

<div
  class="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 pl-7 pr-1.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 [&:has(:focus-visible)]:pointer-events-auto [&:has(:focus-visible)]:opacity-100"
  style="background: linear-gradient(90deg, transparent, var(--table-row-hover) 24px);"
>
  {#each quickActions as action (action.id)}
    <Button variant="muted" size="icon-xs" title={action.label} aria-label={action.label} onclick={(e) => run(e, action)}>
      <action.icon class="h-3.5 w-3.5" />
    </Button>
  {/each}
  <Button variant="muted" size="icon-xs" title="More actions" aria-label="More actions" onclick={more}>
    <Ellipsis class="h-3.5 w-3.5" />
  </Button>
</div>
