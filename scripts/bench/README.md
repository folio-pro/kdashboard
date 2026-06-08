# List benchmark harness

End-to-end benchmark for the resource-list path: it drives the **real** Tauri
backend (kube list → Rust serialize → IPC → Svelte render) against a local
`kind` cluster, with no WebDriver.

## How it works

1. `kind-bench.yaml` + `seed.sh` create a high-capacity `kind` cluster and seed
   it with a configurable number of Deployments (pause pods), Services,
   ConfigMaps and Secrets across several namespaces — reproducible scale.
2. `run.sh` launches the app with `KDASH_BENCH=1`. The in-app runner
   (`src/lib/benchmark/e2e-runner.ts`) switches to the target context, measures
   `invoke("list_resources") → table painted` for each resource type, writes the
   results JSON, and exits the app.
3. `run.sh` waits for the results file and prints a summary table.

Two numbers per type:

- **backendMs** — time of `invoke("list_resources")` alone: kube list + Rust
  serialize + IPC + JS parse. This is the accurate, focus-independent metric.
- **e2eMs** — backendMs plus the time to flush Svelte reactivity and paint the
  virtual table. Note: `requestAnimationFrame` is throttled when the window is
  backgrounded, so e2eMs has a ~50ms floor when unfocused — compare backendMs.

## Usage

```bash
# 1. Seed (recreate cluster with high max-pods, then load it)
DEPLOYMENTS=50 REPLICAS=8 ./scripts/bench/seed.sh --recreate

# 2. Run the benchmark (baseline label, 6 iterations + 2 warmup)
LABEL=baseline ITERS=6 WARMUP=2 ./scripts/bench/run.sh

# Only specific types
KDASH_BENCH_TYPES=pods,deployments ./scripts/bench/run.sh

# Clean up bench namespaces (keep the cluster)
./scripts/bench/seed.sh --clean
```

Results land in `benchmark-out/e2e-<label>.json` and the app log in
`benchmark-out/electron-<label>.log`.

## Env knobs

| Var | Default | Meaning |
|-----|---------|---------|
| `KDASH_BENCH` | (off) | `1` enables benchmark mode (set by `run.sh`) |
| `KDASH_BENCH_CONTEXT` | `kind-kdash-dev` | kube context to measure |
| `KDASH_BENCH_NS` | (empty) | namespace; empty = all namespaces (stress case) |
| `KDASH_BENCH_ITERS` / `ITERS` | 5 | measured iterations per type |
| `KDASH_BENCH_WARMUP` / `WARMUP` | 1 | warmup iterations (discarded) |
| `KDASH_BENCH_TYPES` | a representative set | comma-separated resource types |
| `KDASH_BENCH_OUT` | `benchmark-out/e2e-*.json` | results path |

Seeder knobs: `DEPLOYMENTS`, `REPLICAS`, `CONFIGMAPS`, `SECRETS`, `SERVICES`,
`NAMESPACES`, `WAIT`.
