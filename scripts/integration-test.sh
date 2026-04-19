#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Integration test runner for kdashboard v2
#
# Spins up an ephemeral kind cluster, seeds test resources, runs Rust
# integration tests, and tears everything down.
#
# Usage:
#   ./scripts/integration-test.sh          # run all integration tests
#   ./scripts/integration-test.sh --keep   # keep cluster after tests (for debugging)
# ---------------------------------------------------------------------------
set -euo pipefail

CLUSTER_NAME="kdash-integration"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$ROOT_DIR/src-tauri/tests/fixtures"
KEEP_CLUSTER=false

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP_CLUSTER=true ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "\033[1;34m▸ %s\033[0m\n" "$*"; }
ok()    { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
fail()  { printf "\033[1;31m✘ %s\033[0m\n" "$*"; }

cleanup() {
  # Restore original kubeconfig context
  if [ -n "${ORIGINAL_CONTEXT:-}" ]; then
    kubectl config use-context "$ORIGINAL_CONTEXT" >/dev/null 2>&1 || true
  fi

  if [ "$KEEP_CLUSTER" = true ]; then
    info "Keeping cluster '$CLUSTER_NAME' (use 'kind delete cluster --name $CLUSTER_NAME' to remove)"
    return
  fi
  info "Tearing down cluster '$CLUSTER_NAME'..."
  kind delete cluster --name "$CLUSTER_NAME" 2>/dev/null || true
  ok "Cluster removed"
}

# Always clean up unless --keep
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Check prerequisites
# ---------------------------------------------------------------------------
for cmd in docker kind kubectl; do
  if ! command -v "$cmd" &>/dev/null; then
    fail "$cmd is not installed"
    exit 1
  fi
done

# Save current context to restore later
ORIGINAL_CONTEXT="$(kubectl config current-context 2>/dev/null || echo "")"

# ---------------------------------------------------------------------------
# 2. Create cluster (reuse if already exists)
# ---------------------------------------------------------------------------
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  info "Reusing existing cluster '$CLUSTER_NAME'"
else
  info "Creating kind cluster '$CLUSTER_NAME'..."
  kind create cluster --name "$CLUSTER_NAME" --wait 60s
  ok "Cluster created"
fi

# Kind merges into ~/.kube/config and sets the context automatically.
# Ensure we're using the right context.
kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null 2>&1

# ---------------------------------------------------------------------------
# 3. Seed test resources
# ---------------------------------------------------------------------------
info "Seeding test resources..."
kubectl apply -f "$FIXTURES_DIR/seed.yaml"

# Wait for deployment to be ready (max 90s)
info "Waiting for test-nginx deployment..."
kubectl rollout status deployment/test-nginx -n kdash-test --timeout=90s
ok "Test resources ready"

# ---------------------------------------------------------------------------
# 4. Run integration tests
# ---------------------------------------------------------------------------
info "Running Rust integration tests..."

# Set env var so tests know which context/namespace to use
export KDASH_TEST_CONTEXT="kind-${CLUSTER_NAME}"
export KDASH_TEST_NAMESPACE="kdash-test"

cd "$ROOT_DIR/src-tauri"

if cargo test --features integration -- --test-threads=1 integration 2>&1; then
  ok "All integration tests passed!"
else
  fail "Some integration tests failed"
  exit 1
fi
