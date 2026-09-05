<script lang="ts">
  import { Badge, Button, Input, SearchField, SegmentedControl, Select } from "$lib/components/ui";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { KeyRound, ShieldAlert, Check, X as XIcon } from "lucide-svelte";
  import { rbacStore } from "$lib/stores/rbac.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { cn } from "$lib/utils";
  import type { RbacSubject, SubjectKind } from "$lib/types";
  import { VERBS, canI, filterRows, filterSubjects, parseResourceRef, rowAllows, scopesOf, subjectKey, subjectLabel } from "./rbac.logic";

  let subjectQuery = $state("");
  let kindFilter = $state<SubjectKind | null>(null);
  let picked = $state<RbacSubject | null>(null);
  let customKind = $state<SubjectKind>("User");
  let customName = $state("");
  let rowQuery = $state("");
  let scopeFilter = $state<string | null>(null);
  // Quick check
  let checkVerb = $state("get");
  let checkResource = $state("pods");
  let checkNamespace = $state("");

  let subjects = $derived(filterSubjects(rbacStore.subjects, subjectQuery, kindFilter));
  let perms = $derived(rbacStore.permissions);
  let scopes = $derived(perms ? scopesOf(perms) : []);
  let rows = $derived(perms ? filterRows(perms.rows, rowQuery, scopeFilter) : []);
  let check = $derived.by(() => {
    if (!perms || !checkResource.trim()) return null;
    const { apiGroup, resource } = parseResourceRef(checkResource);
    return canI(perms, checkVerb, resource, apiGroup, checkNamespace.trim() || null);
  });

  $effect(() => {
    if (rbacStore.subjects.length === 0 && !rbacStore.subjectsLoading && !rbacStore.subjectsError) {
      void rbacStore.loadSubjects(k8sStore.currentNamespace);
    }
  });

  function pick(s: RbacSubject) {
    picked = s;
    scopeFilter = null;
    if (!checkNamespace) checkNamespace = s.namespace ?? k8sStore.currentNamespace;
    void rbacStore.resolve(s.kind, s.name, s.namespace, k8sStore.currentNamespace);
  }
  function pickCustom() {
    const name = customName.trim();
    if (!name) return;
    const ns = customKind === "ServiceAccount" ? k8sStore.currentNamespace : null;
    pick({ kind: customKind, name, namespace: ns, bindings: 0 });
  }
</script>

<div class="grid h-full min-h-0 grid-cols-[320px_minmax(0,1fr)]" data-testid="rbac">
  <!-- Subjects -->
  <div class="flex min-h-0 flex-col border-r border-[var(--border-color)]">
    <div class="flex flex-col gap-2 border-b border-[var(--border-color)] p-3">
      <SearchField value={subjectQuery} ariaLabel="Filter subjects" placeholder="Filter subjects…" oninput={(e: Event) => { subjectQuery = (e.target as HTMLInputElement).value; }} />
      <SegmentedControl
        ariaLabel="Subject kind"
        value={kindFilter ?? "all"}
        onchange={(v) => (kindFilter = v === "all" ? null : (v as SubjectKind))}
        items={[{ value: "all", label: "All" }, { value: "ServiceAccount", label: "SAs" }, { value: "User", label: "Users" }, { value: "Group", label: "Groups" }]}
        class="[&>button]:flex-1"
      />
    </div>
    <ScrollArea class="min-h-0 flex-1">
      {#if rbacStore.subjectsLoading}
        <p class="p-3 text-[12px] text-[var(--text-muted)]">Reading bindings…</p>
      {:else if rbacStore.subjectsError}
        <p class="p-3 text-[12px] text-[var(--status-failed)]">{rbacStore.subjectsError}</p>
      {:else if subjects.length === 0}
        <p class="p-3 text-[12px] text-[var(--text-muted)]">No subject matches.</p>
      {/if}
      {#each subjects as s (subjectKey(s))}
        <button
          type="button"
          class={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--table-row-hover)]", picked && subjectKey(picked) === subjectKey(s) && "bg-[var(--sidebar-active)]")}
          onclick={() => pick(s)}
          data-testid="rbac-subject"
        >
          <Badge appearance="surface" mono size="xs" class="w-8 justify-center">{s.kind === "ServiceAccount" ? "sa" : s.kind === "User" ? "usr" : "grp"}</Badge>
          <span class="min-w-0 flex-1 truncate font-mono text-[var(--text-primary)]">{s.namespace ? `${s.namespace}/` : ""}{s.name}</span>
          <span class="font-mono text-[10px] text-[var(--text-muted)]">{s.bindings}</span>
        </button>
      {/each}
    </ScrollArea>
    <div class="flex flex-col gap-1.5 border-t border-[var(--border-color)] p-3">
      <span class="text-[11px] text-[var(--text-muted)]">Not in any binding? Ask about a name anyway (groups from your IdP count via membership only if listed above).</span>
      <div class="flex gap-1.5">
        <Select size="sm" bind:value={customKind} aria-label="Subject kind">
          <option value="User">User</option><option value="Group">Group</option><option value="ServiceAccount">ServiceAccount</option>
        </Select>
        <Input size="sm" mono class="min-w-0 flex-1" placeholder="name" value={customName} oninput={(e) => { customName = (e.target as HTMLInputElement).value; }} aria-label="Subject name" onkeydown={(e) => { if (e.key === "Enter") pickCustom(); }} />
        <Button size="sm" variant="outline" onclick={pickCustom} disabled={!customName.trim()}>Resolve</Button>
      </div>
    </div>
  </div>

  <!-- Permissions -->
  <div class="flex min-h-0 flex-col">
    {#if !picked}
      <div class="flex h-full flex-col items-center justify-center gap-2 text-center text-[12px] text-[var(--text-muted)]">
        <KeyRound class="h-6 w-6" />
        <span>Pick a subject to see what it can do — every Role and ClusterRole it reaches, directly or through a group.</span>
      </div>
    {:else if rbacStore.permissionsLoading && !perms}
      <div class="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">Resolving…</div>
    {:else if rbacStore.permissionsError}
      <div class="flex h-full items-center justify-center text-[12px] text-[var(--status-failed)]">{rbacStore.permissionsError}</div>
    {:else if perms}
      <div class="flex flex-col gap-3 border-b border-[var(--border-color)] p-4" data-testid="rbac-summary">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono text-[13px] font-medium text-[var(--text-primary)]">{subjectLabel(perms.subject)}</span>
          {#if perms.cluster_admin}<Badge tone="error">cluster-admin</Badge>{/if}
          <span class="text-[11px] text-[var(--text-muted)]">{perms.grants.length} grant{perms.grants.length === 1 ? "" : "s"} · {perms.rows.length} resource{perms.rows.length === 1 ? "" : "s"}{perms.groups.length ? ` · member of ${perms.groups.join(", ")}` : ""}</span>
          {#if perms.missing_roles.length > 0}
            <Badge tone="warning" title={perms.missing_roles.join(", ")}>{perms.missing_roles.length} missing role{perms.missing_roles.length === 1 ? "" : "s"}</Badge>
          {/if}
        </div>
        <!-- Quick check -->
        <div class="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[12px]" data-testid="rbac-check">
          <span class="text-[var(--text-muted)]">can it</span>
          <Select size="sm" mono bind:value={checkVerb} aria-label="Verb">
            {#each VERBS as v (v)}<option value={v}>{v}</option>{/each}
          </Select>
          <Input size="sm" mono class="w-[180px]" value={checkResource} oninput={(e) => { checkResource = (e.target as HTMLInputElement).value; }} placeholder="deployments.apps" aria-label="Resource" />
          <span class="text-[var(--text-muted)]">in</span>
          <Input size="sm" mono class="w-[140px]" value={checkNamespace} oninput={(e) => { checkNamespace = (e.target as HTMLInputElement).value; }} placeholder="(cluster scope)" aria-label="Namespace" />
          <span class="text-[var(--text-muted)]">?</span>
          {#if check}
            <span class={cn("ml-auto flex items-center gap-1.5 font-medium", check.length > 0 ? "text-[var(--status-running)]" : "text-[var(--status-failed)]")} data-testid="rbac-check-result">
              {#if check.length > 0}<Check class="h-3.5 w-3.5" /> yes — via {check.map((g) => `${g.role_kind}/${g.role}`).join(", ")}{:else}<XIcon class="h-3.5 w-3.5" /> no{/if}
            </span>
          {/if}
        </div>
        <div class="flex items-center gap-2">
          <SearchField value={rowQuery} ariaLabel="Filter resources" placeholder="Filter resources…" oninput={(e: Event) => { rowQuery = (e.target as HTMLInputElement).value; }} class="w-[220px]" />
          <div class="flex flex-wrap gap-1">
            {#each scopes as sc (sc)}
              <Button variant="outline" size="xs" mono active={scopeFilter === sc} activeStyle="underline" onclick={() => (scopeFilter = scopeFilter === sc ? null : sc)}>{sc}</Button>
            {/each}
          </div>
        </div>
      </div>
      <ScrollArea class="min-h-0 flex-1">
        {#if perms.rows.length === 0}
          <div class="flex items-center gap-2 p-4 text-[12px] text-[var(--text-muted)]"><ShieldAlert class="h-4 w-4" /> No resource rules reach this subject.</div>
        {:else}
          <table class="w-full text-[11px]" data-testid="rbac-matrix">
            <thead class="sticky top-0 bg-[var(--table-header-bg)] text-[var(--text-muted)]">
              <tr>
                <th class="px-3 py-1.5 text-left font-medium">Resource</th>
                {#each VERBS as v (v)}<th class="px-1 py-1.5 text-center font-medium">{v === "deletecollection" ? "delcol" : v}</th>{/each}
                <th class="px-3 py-1.5 text-left font-medium">Where</th>
              </tr>
            </thead>
            <tbody>
              {#each rows as r (r.api_group + "/" + r.resource)}
                <tr class="border-t border-[var(--border-color)]/60 hover:bg-[var(--table-row-hover)]" data-testid="rbac-row">
                  <td class="px-3 py-1 font-mono text-[var(--text-primary)]">{r.resource}{r.api_group ? `.${r.api_group}` : ""}{#if r.resource_names}<span class="ml-1 text-[var(--text-muted)]" title={r.resource_names.join(", ")}>({r.resource_names.length} named)</span>{/if}</td>
                  {#each VERBS as v (v)}
                    <td class="px-1 py-1 text-center">{#if rowAllows(r, v)}<span class="inline-block h-2 w-2 rounded-full bg-[var(--status-running)]" title={v}></span>{:else}<span class="text-[var(--border-color)]">·</span>{/if}</td>
                  {/each}
                  <td class="px-3 py-1 font-mono text-[var(--text-muted)]">{r.scopes.join(", ")}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
        {#if perms.grants.length > 0}
          <div class="border-t border-[var(--border-color)] p-4">
            <div class="mb-2 text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">Grants</div>
            <ul class="flex flex-col gap-1 text-[11px]">
              {#each perms.grants as g (g.scope + g.binding + g.role)}
                <li class="flex flex-wrap items-center gap-2 font-mono">
                  <span class="rounded-sm bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[var(--text-muted)]">{g.scope}</span>
                  <span class="text-[var(--text-primary)]">{g.role_kind}/{g.role}</span>
                  <span class="text-[var(--text-muted)]">via {g.binding_kind}/{g.binding}{g.via.kind === "Group" ? ` (group ${g.via.name})` : ""}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </ScrollArea>
    {/if}
  </div>
</div>
