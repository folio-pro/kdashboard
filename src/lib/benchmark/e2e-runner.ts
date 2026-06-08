/**
 * End-to-end list benchmark runner.
 *
 * Activated only when the Rust `bench_config` command reports `enabled` (env
 * KDASH_BENCH=1). Drives the REAL backend + IPC + render path:
 *
 *   backendMs = time of invoke("list_resources")  (kube list + Rust serialize + IPC + JS parse)
 *   e2eMs     = backendMs + time to flush Svelte reactivity and paint the virtual table
 *
 * Results are printed to the console (sentinel line) and persisted to JSON via
 * `write_bench_results` so an automated harness can read them without a WebDriver.
 */
import { invoke } from "$lib/ipc/core";
import type { ResourceList } from "../types/index.js";
import { k8sStore } from "../stores/k8s.svelte.js";
import { uiStore } from "../stores/ui.svelte.js";

interface BenchConfig {
  enabled: boolean;
  iterations: number;
  warmup: number;
  context: string | null;
  namespace: string | null;
  out_path: string | null;
  resource_types: string | null;
}

interface Stat {
  median: number;
  min: number;
  max: number;
  mean: number;
  samples: number[];
}

interface TypeResult {
  resourceType: string;
  itemCount: number;
  backendMs: Stat;
  e2eMs: Stat;
}

const DEFAULT_TYPES = [
  "pods",
  "deployments",
  "replicasets",
  "services",
  "configmaps",
  "secrets",
  "namespaces",
  "nodes",
];

// Wait for the browser to flush layout + paint after a store update. Uses a
// double rAF, but races a timeout fallback: requestAnimationFrame is paused
// when the window is backgrounded/unfocused, which would otherwise hang the
// whole benchmark. 50ms comfortably exceeds two 60fps frames.
const nextPaint = () =>
  new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 50);
  });

function stat(samples: number[]): Stat {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    median: round(median),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(samples.reduce((a, b) => a + b, 0) / samples.length),
    samples: samples.map(round),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

async function measureType(
  resourceType: string,
  namespace: string | undefined,
  iterations: number,
  warmup: number,
): Promise<TypeResult> {
  const backend: number[] = [];
  const e2e: number[] = [];
  let itemCount = 0;

  // Make the virtual table the active view so assignments actually render.
  uiStore.activeView = "table";

  for (let i = 0; i < warmup + iterations; i++) {
    const t0 = performance.now();
    const result = await invoke<ResourceList>("list_resources", {
      resourceType,
      namespace,
    });
    const t1 = performance.now();

    // Feed the result through the store so the real table renders.
    k8sStore.selectedResourceType = resourceType;
    k8sStore.resources = { items: result.items, resource_type: resourceType };
    await nextPaint();
    const t2 = performance.now();

    if (i >= warmup) {
      backend.push(t1 - t0);
      e2e.push(t2 - t0);
    }
    itemCount = result.items.length;
  }

  return {
    resourceType,
    itemCount,
    backendMs: stat(backend),
    e2eMs: stat(e2e),
  };
}

/** Returns true if benchmark mode was active and handled init (caller should stop). */
export async function maybeRunBenchmark(): Promise<boolean> {
  let cfg: BenchConfig;
  try {
    cfg = await invoke<BenchConfig>("bench_config");
  } catch {
    return false;
  }
  if (!cfg.enabled) return false;

  console.log("[bench] starting end-to-end list benchmark", cfg);

  let originalContext: string | null = null;
  try {
    if (cfg.context) {
      try {
        originalContext = await invoke<string>("get_current_context");
      } catch {
        originalContext = null;
      }
      // Switch unconditionally and verify — never trust cached store state.
      await invoke("switch_context", { context: cfg.context });
      k8sStore.currentContext = cfg.context;

      const active = await invoke<string>("get_current_context").catch(() => "");
      if (active !== cfg.context) {
        throw new Error(`context switch failed: wanted ${cfg.context}, got ${active}`);
      }
      const ok = await invoke<boolean>("check_connection").catch((e) => {
        throw new Error(`check_connection failed on ${cfg.context}: ${e}`);
      });
      if (!ok) {
        throw new Error(`check_connection returned false on ${cfg.context}`);
      }
      console.log(`[bench] connected to ${active} (check_connection=${ok})`);
    }
    // namespace: null/empty => all namespaces (the stress case)
    const namespace = cfg.namespace || undefined;
    k8sStore.currentNamespace = namespace ?? "";
    k8sStore.connectionStatus = "connected";

    const parsedTypes =
      cfg.resource_types?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    const types = parsedTypes.length > 0 ? parsedTypes : DEFAULT_TYPES;

    const results: TypeResult[] = [];
    for (const t of types) {
      try {
        const r = await measureType(t, namespace, cfg.iterations, cfg.warmup);
        results.push(r);
        console.log(
          `[bench] ${t.padEnd(14)} n=${String(r.itemCount).padStart(5)}  backend=${r.backendMs.median}ms  e2e=${r.e2eMs.median}ms`,
        );
      } catch (err) {
        console.warn(`[bench] ${t} failed:`, err);
      }
    }

    const payload = {
      meta: {
        timestamp: new Date().toISOString(),
        context: cfg.context ?? k8sStore.currentContext,
        namespace: namespace ?? "(all)",
        iterations: cfg.iterations,
        warmup: cfg.warmup,
        appVersion: await invoke<{ app_version: string }>("get_app_metadata")
          .then((m) => m.app_version)
          .catch(() => "unknown"),
      },
      results,
    };

    const json = JSON.stringify(payload, null, 2);
    if (cfg.out_path) {
      try {
        await invoke("write_bench_results", { path: cfg.out_path, contents: json });
        console.log(`[bench] results written to ${cfg.out_path}`);
      } catch (err) {
        console.warn("[bench] failed to write results:", err);
      }
    }
    // Sentinel line so a harness can scrape stdout even without the file.
    console.log("__KDASH_BENCH_DONE__" + JSON.stringify(payload));
  } catch (err) {
    console.error("[bench] fatal:", err);
    console.log("__KDASH_BENCH_DONE__" + JSON.stringify({ error: String(err) }));
  }

  // Restore the user's original kubeconfig current-context (switch_context
  // mutates ~/.kube/config, so leave it as we found it).
  if (originalContext && originalContext !== cfg.context) {
    await invoke("switch_context", { context: originalContext }).catch(() => {});
  }

  // Exit so the orchestration script knows the run is complete.
  try {
    const { exit } = await import("$lib/ipc/process");
    await exit(0);
  } catch {
    // plugin-process unavailable — leave the window open.
  }
  return true;
}
