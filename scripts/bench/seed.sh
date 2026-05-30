#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Scalable benchmark seeder for the kdash-dev kind cluster.
#
# Generates a configurable number of Deployments (pause image -> tiny but real
# Running pods), ConfigMaps, Secrets and Services spread across several
# namespaces, so the list/serialization path can be benchmarked at scale.
#
# Usage:
#   ./scripts/bench/seed.sh                 # seed with defaults onto existing cluster
#   ./scripts/bench/seed.sh --recreate      # recreate kind cluster (high max-pods) then seed
#   ./scripts/bench/seed.sh --clean         # delete all bench-* namespaces
#   DEPLOYMENTS=80 REPLICAS=10 ./scripts/bench/seed.sh
#
# Env knobs (defaults in parens):
#   DEPLOYMENTS (50)  REPLICAS (8)  CONFIGMAPS (150)  SECRETS (80)  SERVICES (80)
#   NAMESPACES  (4)   WAIT (1 = wait for pods Ready)
# ---------------------------------------------------------------------------
set -euo pipefail

CLUSTER_NAME="kdash-dev"
CTX="kind-${CLUSTER_NAME}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DEPLOYMENTS="${DEPLOYMENTS:-50}"
REPLICAS="${REPLICAS:-8}"
CONFIGMAPS="${CONFIGMAPS:-150}"
SECRETS="${SECRETS:-80}"
SERVICES="${SERVICES:-80}"
NAMESPACES="${NAMESPACES:-4}"
WAIT="${WAIT:-1}"
PAUSE_IMAGE="registry.k8s.io/pause:3.9"

info()  { printf "\033[1;34m▸ %s\033[0m\n" "$*"; }
ok()    { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
dim()   { printf "\033[0;90m  %s\033[0m\n" "$*"; }

ACTION="seed"
for arg in "$@"; do
  case "$arg" in
    --recreate) ACTION="recreate" ;;
    --clean)    ACTION="clean" ;;
  esac
done

ns_name() { echo "bench-$(( $1 % NAMESPACES ))"; }

do_recreate() {
  if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    info "Deleting existing cluster '$CLUSTER_NAME'..."
    kind delete cluster --name "$CLUSTER_NAME"
  fi
  info "Creating high-capacity kind cluster (max-pods=600 x 3 workers)..."
  kind create cluster --name "$CLUSTER_NAME" --config "$SCRIPT_DIR/kind-bench.yaml" --wait 90s
  ok "Cluster created"
}

do_clean() {
  info "Deleting bench-* namespaces..."
  kubectl --context "$CTX" get ns -o name 2>/dev/null \
    | grep -E 'namespace/bench-' \
    | xargs -r kubectl --context "$CTX" delete --wait=false 2>/dev/null || true
  ok "Clean requested (namespaces terminating in background)"
}

build_yaml() {
  local out="$1"
  : > "$out"

  # Namespaces
  for ((n=0; n<NAMESPACES; n++)); do
    cat >> "$out" <<EOF
---
apiVersion: v1
kind: Namespace
metadata:
  name: bench-${n}
  labels: { env: bench, scale: load }
EOF
  done

  # Deployments (pause pods) — each gets resources/labels/env to mimic real spec size
  for ((i=0; i<DEPLOYMENTS; i++)); do
    local ns; ns="$(ns_name "$i")"
    cat >> "$out" <<EOF
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bench-app-${i}
  namespace: ${ns}
  labels: { app: bench-app-${i}, tier: backend, team: platform, env: bench }
spec:
  replicas: ${REPLICAS}
  selector:
    matchLabels: { app: bench-app-${i} }
  template:
    metadata:
      labels: { app: bench-app-${i}, tier: backend, team: platform, env: bench }
      annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: pause
          image: ${PAUSE_IMAGE}
          ports: [ { containerPort: 8080 }, { containerPort: 9090 } ]
          env:
            - { name: APP_INDEX, value: "${i}" }
            - { name: LOG_LEVEL, value: "info" }
            - { name: REGION, value: "eu-west" }
          resources:
            requests: { cpu: 1m, memory: 4Mi }
            limits:   { cpu: 10m, memory: 16Mi }
EOF
  done

  # Services
  for ((i=0; i<SERVICES; i++)); do
    local ns; ns="$(ns_name "$i")"
    cat >> "$out" <<EOF
---
apiVersion: v1
kind: Service
metadata:
  name: bench-svc-${i}
  namespace: ${ns}
  labels: { app: bench-app-$((i % DEPLOYMENTS)) }
spec:
  selector: { app: bench-app-$((i % DEPLOYMENTS)) }
  ports: [ { port: 80, targetPort: 8080 } ]
  type: ClusterIP
EOF
  done

  # ConfigMaps
  for ((i=0; i<CONFIGMAPS; i++)); do
    local ns; ns="$(ns_name "$i")"
    cat >> "$out" <<EOF
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: bench-cm-${i}
  namespace: ${ns}
  labels: { app: bench-app-$((i % DEPLOYMENTS)) }
data:
  DATABASE_URL: "postgres://db-${i}:5432/app"
  FEATURE_FLAGS: "a,b,c,d,e,f"
  CONFIG_INDEX: "${i}"
EOF
  done

  # Secrets
  for ((i=0; i<SECRETS; i++)); do
    local ns; ns="$(ns_name "$i")"
    cat >> "$out" <<EOF
---
apiVersion: v1
kind: Secret
metadata:
  name: bench-secret-${i}
  namespace: ${ns}
  labels: { app: bench-app-$((i % DEPLOYMENTS)) }
type: Opaque
stringData:
  PASSWORD: "s3cr3t-${i}"
  TOKEN: "tok-${i}-abcdef"
EOF
  done
}

case "$ACTION" in
  clean)    do_clean; exit 0 ;;
  recreate) do_recreate ;;
esac

if ! kubectl --context "$CTX" get ns >/dev/null 2>&1; then
  echo "Cluster '$CTX' unreachable. Run with --recreate or ./scripts/dev-cluster.sh first." >&2
  exit 1
fi

TMP_YAML="$(mktemp -t bench-seed.XXXXXX.yaml)"
trap 'rm -f "$TMP_YAML"' EXIT

info "Generating manifests: ${DEPLOYMENTS} deploys x ${REPLICAS} replicas, ${SERVICES} svc, ${CONFIGMAPS} cm, ${SECRETS} secrets across ${NAMESPACES} ns"
build_yaml "$TMP_YAML"

info "Applying ($(grep -c '^kind:' "$TMP_YAML") objects)..."
kubectl --context "$CTX" apply -f "$TMP_YAML" >/dev/null
ok "Applied"

if [[ "$WAIT" == "1" ]]; then
  info "Waiting for pods to schedule (up to 180s)..."
  for ((n=0; n<NAMESPACES; n++)); do
    ns="bench-$n"
    kubectl --context "$CTX" wait --for=condition=Available deploy --all -n "$ns" --timeout=180s 2>/dev/null || true
  done
fi

echo ""
ok "Bench seed complete. Pod count by namespace:"
for ((n=0; n<NAMESPACES; n++)); do
  ns="bench-$n"
  printf '  %-10s %s pods\n' "$ns" "$(kubectl --context "$CTX" get pods -n "$ns" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
done
echo ""
dim "Total pods (all ns): $(kubectl --context "$CTX" get pods -A --no-headers 2>/dev/null | wc -l | tr -d ' ')"
dim "Point the app at context '${CTX}' and run the benchmark."
