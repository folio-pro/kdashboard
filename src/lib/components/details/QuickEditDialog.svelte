<script lang="ts">
  import { invoke } from "$lib/ipc/core";
  import { Dialog, DialogContent } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Plus, X, Lock } from "lucide-svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import type { Resource } from "$lib/types";
  import { applyQuickEdit, describeChanges, quickEditFromYaml, type QuickEdit } from "./quick-edit.logic";

  let { open = $bindable(false), resource }: { open: boolean; resource: Resource | null } = $props();

  let original = $state<string>("");
  let baseline = $state<QuickEdit | null>(null);
  let edit = $state<QuickEdit | null>(null);
  let loading = $state(false);
  let applying = $state(false);
  let error = $state("");
  let step = $state<"edit" | "review">("edit");
  let activeContainer = $state(0);

  let changes = $derived(baseline && edit ? describeChanges(baseline, edit) : []);
  let preview = $derived.by(() => {
    if (!edit || !original) return "";
    try {
      return applyQuickEdit(original, edit);
    } catch (err) {
      return `# ${String(err)}`;
    }
  });

  $effect(() => {
    if (open && resource) void load(resource);
    if (!open) {
      edit = null;
      baseline = null;
      original = "";
      step = "edit";
      error = "";
    }
  });

  async function load(r: Resource) {
    loading = true;
    error = "";
    try {
      const yaml = await invoke<string>("get_resource_yaml", { kind: r.kind, name: r.metadata.name, namespace: r.metadata.namespace ?? "" });
      original = yaml;
      baseline = quickEditFromYaml(yaml);
      edit = quickEditFromYaml(yaml);
      activeContainer = 0;
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  function addEnv() {
    if (!edit) return;
    edit.containers[activeContainer].env.push({ name: "", value: "", fromRef: false });
  }
  function dropEnv(i: number) {
    if (!edit) return;
    edit.containers[activeContainer].env.splice(i, 1);
  }

  async function apply() {
    if (!edit || !original) return;
    applying = true;
    error = "";
    try {
      const yaml = applyQuickEdit(original, edit);
      await invoke("apply_yaml", { yaml });
      toastStore.success("Applied", `${edit.kind} ${edit.name}: ${changes.length} change${changes.length === 1 ? "" : "s"}`);
      open = false;
      await k8sStore.refreshResources();
    } catch (err) {
      error = String(err);
    } finally {
      applying = false;
    }
  }
</script>

<Dialog bind:open>
  <DialogContent class="flex max-h-[85vh] flex-col sm:max-w-[720px]" aria-labelledby="quick-edit-title">
    <div class="flex min-h-0 flex-col gap-3 p-1" data-testid="quick-edit">
      <div>
        <h3 id="quick-edit-title" class="text-[13px] font-semibold text-[var(--text-primary)]">Quick edit {resource?.kind}</h3>
        <p class="mt-1 text-[11px] text-[var(--text-muted)]">{resource?.metadata.namespace}/{resource?.metadata.name} · image, environment and resources per container. Applied with server-side apply; the controller rolls the pods.</p>
      </div>

      {#if loading}
        <p class="text-[12px] text-[var(--text-muted)]">Loading…</p>
      {:else if error && !edit}
        <p class="text-[12px] text-[var(--status-failed)]">{error}</p>
      {:else if edit && step === "edit"}
        {#if edit.containers.length > 1}
          <div class="flex gap-0.5 rounded-md bg-[var(--bg-tertiary)] p-0.5 text-[11px]">
            {#each edit.containers as c, i (c.name)}
              <button type="button" class={`rounded-sm px-2 py-0.5 ${activeContainer === i ? "bg-[var(--bg-secondary)] text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`} onclick={() => (activeContainer = i)}>{c.name}</button>
            {/each}
          </div>
        {/if}
        {#if edit.containers[activeContainer]}
          {@const c = edit.containers[activeContainer]}
          <div class="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
            <label class="flex flex-col gap-1 text-[11px] text-[var(--text-muted)]">
              Image
              <Input size="md" mono value={c.image} oninput={(e) => { c.image = (e.target as HTMLInputElement).value; }} aria-label="Image" />
            </label>
            <div class="flex flex-col gap-1">
              <div class="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                <span>Environment</span>
                <Button variant="ghost" size="xs" onclick={addEnv} data-testid="quick-edit-add-env"><Plus class="h-3 w-3" /> Add variable</Button>
              </div>
              {#if c.env.length === 0}
                <p class="text-[11px] text-[var(--text-muted)]">No environment variables.</p>
              {/if}
              {#each c.env as ev, i (i)}
                <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_28px] items-center gap-1.5">
                  <Input size="sm" mono value={ev.name} oninput={(e) => { ev.name = (e.target as HTMLInputElement).value; }} placeholder="NAME" aria-label={`Env name ${i + 1}`} />
                  {#if ev.fromRef}
                    <span class="flex h-7 items-center gap-1.5 truncate rounded-sm border border-dashed border-[var(--border-color)] px-2 font-mono text-[11px] text-[var(--text-muted)]" title="Takes its value from a ConfigMap/Secret/field reference — edit in YAML"><Lock class="h-3 w-3" /> valueFrom</span>
                  {:else}
                    <Input size="sm" mono value={ev.value ?? ""} oninput={(e) => { ev.value = (e.target as HTMLInputElement).value; }} placeholder="value" aria-label={`Env value ${i + 1}`} />
                  {/if}
                  <Button variant="ghost" size="icon-xs" onclick={() => dropEnv(i)} aria-label="Drop variable"><X class="h-3 w-3" /></Button>
                </div>
              {/each}
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="flex flex-col gap-1.5 rounded-md border border-[var(--border-color)] p-2">
                <span class="text-[11px] text-[var(--text-muted)]">Requests</span>
                <label class="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">CPU <Input size="sm" mono value={c.cpu_request} oninput={(e) => { c.cpu_request = (e.target as HTMLInputElement).value; }} placeholder="e.g. 250m" aria-label="CPU request" class="flex-1" /></label>
                <label class="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">Memory <Input size="sm" mono value={c.memory_request} oninput={(e) => { c.memory_request = (e.target as HTMLInputElement).value; }} placeholder="e.g. 512Mi" aria-label="Memory request" class="flex-1" /></label>
              </div>
              <div class="flex flex-col gap-1.5 rounded-md border border-[var(--border-color)] p-2">
                <span class="text-[11px] text-[var(--text-muted)]">Limits</span>
                <label class="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">CPU <Input size="sm" mono value={c.cpu_limit} oninput={(e) => { c.cpu_limit = (e.target as HTMLInputElement).value; }} placeholder="unset" aria-label="CPU limit" class="flex-1" /></label>
                <label class="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">Memory <Input size="sm" mono value={c.memory_limit} oninput={(e) => { c.memory_limit = (e.target as HTMLInputElement).value; }} placeholder="unset" aria-label="Memory limit" class="flex-1" /></label>
              </div>
            </div>
          </div>
        {/if}
      {:else if edit && step === "review"}
        <div class="flex min-h-0 flex-col gap-2">
          <ul class="flex flex-col gap-0.5 text-[12px]" data-testid="quick-edit-changes">
            {#each changes as ch (ch)}<li class="text-[var(--text-primary)]">· {ch}</li>{/each}
          </ul>
          <pre class="max-h-[300px] overflow-auto rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]" data-testid="quick-edit-preview">{preview}</pre>
        </div>
      {/if}

      {#if error && edit}
        <p class="text-[12px] text-[var(--status-failed)]">{error}</p>
      {/if}

      <div class="flex items-center justify-end gap-2">
        <span class="mr-auto text-[11px] text-[var(--text-muted)]">{changes.length} change{changes.length === 1 ? "" : "s"}</span>
        {#if step === "review"}
          <Button variant="outline" size="md" onclick={() => (step = "edit")} disabled={applying}>Back</Button>
          <Button variant="accent" size="md" onclick={apply} disabled={applying || changes.length === 0} data-testid="quick-edit-apply">{applying ? "Applying…" : "Apply"}</Button>
        {:else}
          <Button variant="outline" size="md" onclick={() => (open = false)}>Cancel</Button>
          <Button size="md" onclick={() => (step = "review")} disabled={!edit || changes.length === 0} data-testid="quick-edit-review">Review changes</Button>
        {/if}
      </div>
    </div>
  </DialogContent>
</Dialog>
