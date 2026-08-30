#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Reproducible FRONTEND benchmark — no cluster required.
#
# Runs e2e/perf-bench.spec.ts RUNS times against a PRODUCTION build of the
# renderer (vite build + vite preview, bench store hook opted in with
# VITE_KDASH_BENCH=1) and writes one JSON per run plus a median summary:
#
#   benchmark-out/frontend-<label>-run<N>.json
#   benchmark-out/frontend-<label>.json          (median across runs)
#
# Usage:
#   LABEL=baseline ./scripts/bench/frontend.sh
#   LABEL=after RUNS=5 ./scripts/bench/frontend.sh
#   DEV=1 LABEL=x ./scripts/bench/frontend.sh     # dev server instead of prod build
#   bun scripts/bench/compare.ts benchmark-out/frontend-baseline.json benchmark-out/frontend-after.json
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

LABEL="${LABEL:-$(date +%Y%m%d-%H%M%S)}"
RUNS="${RUNS:-3}"
PORT="${RENDERER_PORT:-1421}"
OUT_DIR="$ROOT_DIR/benchmark-out"
mkdir -p "$OUT_DIR"

if [[ "${DEV:-0}" == "1" ]]; then PROD=0; else PROD=1; fi
echo "▸ label=$LABEL runs=$RUNS port=$PORT mode=$([[ $PROD == 1 ]] && echo prod || echo dev)"

for i in $(seq 1 "$RUNS"); do
  out="$OUT_DIR/frontend-${LABEL}-run${i}.json"
  rm -f "$out"
  echo "▸ run $i/$RUNS -> $out"
  BENCH_OUT="$out" BENCH_PROD="$PROD" RENDERER_PORT="$PORT" \
    npx playwright test -c playwright.bench.config.ts e2e/perf-bench.spec.ts \
      --project=chromium --reporter=line --workers=1 >"$OUT_DIR/frontend-${LABEL}-run${i}.log" 2>&1 \
    || { echo "✗ run $i failed — see $OUT_DIR/frontend-${LABEL}-run${i}.log"; exit 1; }
done

bun scripts/bench/summarize.ts "$OUT_DIR/frontend-${LABEL}.json" "$OUT_DIR"/frontend-"${LABEL}"-run*.json
echo "✔ median of $RUNS runs -> $OUT_DIR/frontend-${LABEL}.json"
