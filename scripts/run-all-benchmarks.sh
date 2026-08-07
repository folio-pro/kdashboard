#!/bin/bash
set -e

echo "=== Running Frontend Benchmarks ==="
npx tsx scripts/run-playwright-benchmarks.ts

echo ""

echo ""
echo "=== Benchmark Summary Complete ==="