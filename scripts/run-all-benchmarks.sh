#!/bin/bash
set -e

echo "=== Running Frontend Benchmarks ==="
npx tsx scripts/run-playwright-benchmarks.ts

echo ""
echo "=== Running Rust Backend Benchmarks ==="
cd src-tauri
cargo bench -- --nocapture 2>/dev/null || cargo criterion --message-format=json 2>/dev/null || cargo bench 2>/dev/null || echo "Rust benchmarks require nightly or custom setup"

echo ""
echo "=== Benchmark Summary Complete ==="