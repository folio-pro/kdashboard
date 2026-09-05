#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# End-to-end list benchmark driver.
#
# Launches the REAL Tauri app in benchmark mode (KDASH_BENCH=1). The in-app
# runner switches to the target context, measures invoke("list_resources") ->
# table-painted for each resource type, writes JSON results, and exits the app.
# This script waits for the results file, then prints a summary table.
#
# Usage:
#   ./scripts/bench/run.sh                          # default: kind-kdash-dev, all namespaces
#   KDASH_BENCH_CONTEXT=kind-kdash-dev ./scripts/bench/run.sh
#   ITERS=8 WARMUP=2 ./scripts/bench/run.sh
#   LABEL=baseline ./scripts/bench/run.sh           # tag the output filename
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

CONTEXT="${KDASH_BENCH_CONTEXT:-kind-kdash-dev}"
NS="${KDASH_BENCH_NS:-}"               # empty => all namespaces
ITERS="${ITERS:-5}"
WARMUP="${WARMUP:-1}"
TYPES="${KDASH_BENCH_TYPES:-}"
LABEL="${LABEL:-$(date +%Y%m%d-%H%M%S)}"
TIMEOUT="${TIMEOUT:-900}"              # seconds; generous for first Rust compile

OUT_DIR="$ROOT_DIR/benchmark-out"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/e2e-${LABEL}.json"
LOG_FILE="$OUT_DIR/electron-${LABEL}.log"
rm -f "$OUT_FILE"

echo "▸ context=$CONTEXT  ns=${NS:-(all)}  iters=$ITERS  warmup=$WARMUP"
echo "▸ results -> $OUT_FILE"
echo "▸ app log -> $LOG_FILE"

export KDASH_BENCH=1
export KDASH_BENCH_CONTEXT="$CONTEXT"
export KDASH_BENCH_NS="$NS"
export KDASH_BENCH_ITERS="$ITERS"
export KDASH_BENCH_WARMUP="$WARMUP"
export KDASH_BENCH_TYPES="$TYPES"
export KDASH_BENCH_OUT="$OUT_FILE"

cleanup() {
  pkill -f "target/debug/kdashboard" 2>/dev/null || true
  pkill -f "electron ." 2>/dev/null || true
  [[ -n "${TAURI_PID:-}" ]] && kill "$TAURI_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "▸ launching app (first run compiles Rust — be patient)..."
npm run dev:electron >"$LOG_FILE" 2>&1 &
TAURI_PID=$!

elapsed=0
while [[ ! -f "$OUT_FILE" ]]; do
  sleep 2
  elapsed=$((elapsed + 2))
  if ! kill -0 "$TAURI_PID" 2>/dev/null; then
    # app process gone; give the FS a moment then check once more
    sleep 1
    [[ -f "$OUT_FILE" ]] && break
    echo "✘ app exited before writing results. Last log lines:" >&2
    tail -30 "$LOG_FILE" >&2
    exit 1
  fi
  if (( elapsed >= TIMEOUT )); then
    echo "✘ timeout after ${TIMEOUT}s waiting for results." >&2
    tail -30 "$LOG_FILE" >&2
    exit 1
  fi
done

echo "✔ results captured in ${elapsed}s"
echo ""

# Pretty-print summary
if command -v jq >/dev/null 2>&1; then
  echo "  type            items   backend(ms)   e2e(ms)"
  echo "  ───────────────────────────────────────────────"
  jq -r '.results[] | "  \(.resourceType | (. + "              ")[0:14])  \(.itemCount | tostring | (("     " + .)[-5:]))   \(.backendMs.median | tostring | (("        " + .)[-7:]))   \(.e2eMs.median | tostring | (("        " + .)[-7:]))"' "$OUT_FILE"
  echo ""
  echo "  idle (pods table + watch, $(jq -r '.idle.window_ms // 0' "$OUT_FILE")ms window):"
  echo "    cpu%        $(jq -c '.idle.cpu_percent // {}' "$OUT_FILE")"
  echo "    working set $(jq -c '.idle.working_set_mb // {}' "$OUT_FILE") MB"
  echo "    renderer js heap $(jq -r '.idle.renderer_js_heap_mb // "n/a"' "$OUT_FILE") MB   main heap $(jq -r '.idle.main_heap_used_mb // "n/a"' "$OUT_FILE") MB"
  echo ""
  echo "  meta: $(jq -c '.meta' "$OUT_FILE")"
else
  cat "$OUT_FILE"
fi
