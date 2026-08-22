import { SvelteMap } from "svelte/reactivity";
import { invoke } from "$lib/ipc/core";
import type { ClusterOverview, DiagnosticResult, Problem } from "$lib/types";
import { AsyncLoadStore } from "./async-load.svelte";

export type Diagnosis = DiagnosticResult | { error: string } | "loading";

/**
 * One payload feeds two views (Overview, Problems). Loaded cluster-wide; the
 * backend narrows to the given namespace only where the cluster-wide list is
 * refused, and says so in `scope` / `partial`. Diagnoses are fetched lazily
 * per problem and kept until the next load.
 */
class OverviewStore extends AsyncLoadStore<ClusterOverview> {
  readonly diagnoses = new SvelteMap<string, Diagnosis>();

  get overview() { return this.data; }

  async loadOverview(namespace: string | null): Promise<void> {
    this.diagnoses.clear();
    await this._load("get_cluster_overview", namespace);
  }

  /** Run diagnose_resource for a problem once; reads are reactive through `diagnoses`. */
  diagnose(p: Problem): void {
    if (this.diagnoses.has(p.id)) return;
    this.diagnoses.set(p.id, "loading");
    invoke<DiagnosticResult>("diagnose_resource", { kind: p.kind, name: p.name, namespace: p.namespace ?? "" })
      .then((r) => this.diagnoses.set(p.id, r))
      .catch((err) => this.diagnoses.set(p.id, { error: String(err) }));
  }

  override reset(): void {
    super.reset();
    this.diagnoses.clear();
  }
}

export const overviewStore = new OverviewStore();
