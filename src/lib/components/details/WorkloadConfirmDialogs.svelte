<script lang="ts">
  /**
   * The Restart and Rollback confirmations. Mounted once (App.svelte) beside
   * the Delete dialog so the detail header, the row context menu and the
   * bulk action all confirm through the same two dialogs.
   */
  import ConfirmDialog from "$lib/components/common/ConfirmDialog.svelte";
  import { dialogStore } from "$lib/stores/dialogs.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { invoke } from "$lib/ipc/core";
  import { restartWorkloads, rollbackDeployment } from "$lib/actions/registry";
  import type { RevisionInfo } from "./revision-history-card.logic";
  import { previousRevision, restartMessage, restartTitle, rollbackMessage } from "./workload-confirm.logic";

  // --- Restart ---------------------------------------------------------------
  let restartInFlight = $state(false);

  async function confirmRestart() {
    const targets = dialogStore.restartResources;
    if (targets.length === 0 || restartInFlight) return;
    restartInFlight = true;
    try {
      await restartWorkloads(targets);
    } finally {
      restartInFlight = false;
      dialogStore.closeRestart();
    }
  }

  // --- Rollback --------------------------------------------------------------
  // The dialog names the revision it will roll back to, so it resolves the
  // target up front and then rolls back to THAT revision explicitly — never
  // to "whatever the backend picks" once the user has read the prompt.
  let rollbackTarget = $state<RevisionInfo | null>(null);
  let rollbackInFlight = $state(false);

  $effect(() => {
    const resource = dialogStore.rollbackOpen ? dialogStore.rollbackResource : null;
    rollbackTarget = null;
    if (!resource) return;
    const name = resource.metadata.name;
    let cancelled = false;
    invoke<RevisionInfo[]>("list_deployment_revisions", {
      name,
      namespace: resource.metadata.namespace ?? "",
    })
      .then((revisions) => {
        if (cancelled) return;
        const target = previousRevision(revisions ?? []);
        if (!target) {
          toastStore.error("Nothing to roll back to", `${name} has no previous revision.`);
          dialogStore.closeRollback();
          return;
        }
        rollbackTarget = target;
      })
      .catch((err) => {
        if (cancelled) return;
        toastStore.error("Rollback failed", String(err));
        dialogStore.closeRollback();
      });
    return () => { cancelled = true; };
  });

  async function confirmRollback() {
    const resource = dialogStore.rollbackResource;
    const target = rollbackTarget;
    // Still resolving the target: the button reads "Looking up…" and waits.
    if (!resource || !target || rollbackInFlight) return;
    rollbackInFlight = true;
    try {
      await rollbackDeployment(resource, target.revision);
    } catch (err) {
      toastStore.error("Rollback failed", String(err));
    } finally {
      rollbackInFlight = false;
      dialogStore.closeRollback();
    }
  }
</script>

{#if dialogStore.restartOpen && dialogStore.restartResources.length > 0}
  <ConfirmDialog
    open={dialogStore.restartOpen}
    title={restartTitle(dialogStore.restartResources)}
    description={restartMessage(dialogStore.restartResources)}
    confirmLabel={restartInFlight ? "Restarting…" : "Restart"}
    variant="default"
    onconfirm={confirmRestart}
    oncancel={() => dialogStore.closeRestart()}
  />
{/if}

{#if dialogStore.rollbackOpen && dialogStore.rollbackResource}
  {@const name = dialogStore.rollbackResource.metadata.name}
  <ConfirmDialog
    open={dialogStore.rollbackOpen}
    title="Roll back {name}"
    description={rollbackTarget ? rollbackMessage(name, rollbackTarget) : `Looking up the previous revision of ${name}…`}
    confirmLabel={rollbackInFlight ? "Rolling back…" : rollbackTarget ? `Roll back to #${rollbackTarget.revision}` : "Looking up…"}
    variant="destructive"
    onconfirm={confirmRollback}
    oncancel={() => dialogStore.closeRollback()}
  />
{/if}
