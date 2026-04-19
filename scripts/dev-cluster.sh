#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Dev cluster for manual testing of kdashboard v2
#
# Creates a Kind cluster with realistic test resources so you can test
# the full app (AI chat, safety tiers, audit log, etc.) locally.
#
# Usage:
#   ./scripts/dev-cluster.sh          # create cluster + seed resources
#   ./scripts/dev-cluster.sh --reset  # delete and recreate from scratch
#   ./scripts/dev-cluster.sh --stop   # delete the cluster
#   ./scripts/dev-cluster.sh --status # show cluster status
# ---------------------------------------------------------------------------
set -euo pipefail

CLUSTER_NAME="kdash-dev"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "\033[1;34m▸ %s\033[0m\n" "$*"; }
ok()    { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
fail()  { printf "\033[1;31m✘ %s\033[0m\n" "$*"; }
dim()   { printf "\033[0;90m  %s\033[0m\n" "$*"; }

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
ACTION="start"
for arg in "$@"; do
  case "$arg" in
    --reset)  ACTION="reset" ;;
    --stop)   ACTION="stop" ;;
    --status) ACTION="status" ;;
  esac
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
for cmd in docker kind kubectl; do
  if ! command -v "$cmd" &>/dev/null; then
    fail "$cmd is not installed"
    echo ""
    echo "Install with:"
    case "$cmd" in
      docker) echo "  brew install --cask docker" ;;
      kind)   echo "  brew install kind" ;;
      kubectl) echo "  brew install kubectl" ;;
    esac
    exit 1
  fi
done

# Check Docker is running
if ! docker info &>/dev/null; then
  fail "Docker is not running. Start Docker Desktop first."
  exit 1
fi

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

cluster_exists() {
  kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"
}

do_stop() {
  if cluster_exists; then
    info "Deleting cluster '$CLUSTER_NAME'..."
    kind delete cluster --name "$CLUSTER_NAME"
    ok "Cluster deleted"
  else
    dim "Cluster '$CLUSTER_NAME' doesn't exist"
  fi
}

do_status() {
  if cluster_exists; then
    ok "Cluster '$CLUSTER_NAME' is running"
    echo ""
    kubectl --context "kind-${CLUSTER_NAME}" get namespaces 2>/dev/null || true
    echo ""
    info "Resources in dev namespace:"
    kubectl --context "kind-${CLUSTER_NAME}" get all -n kdash-dev 2>/dev/null || true
    echo ""
    info "Resources in staging namespace:"
    kubectl --context "kind-${CLUSTER_NAME}" get all -n kdash-staging 2>/dev/null || true
  else
    dim "Cluster '$CLUSTER_NAME' is not running"
    dim "Run: ./scripts/dev-cluster.sh"
  fi
}

do_create() {
  if cluster_exists; then
    info "Cluster '$CLUSTER_NAME' already exists, reusing it"
  else
    info "Creating Kind cluster '$CLUSTER_NAME'..."
    kind create cluster --name "$CLUSTER_NAME" --wait 60s
    ok "Cluster created"
  fi

  kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null 2>&1

  info "Seeding dev resources..."
  kubectl apply -f - <<'EOF'
---
apiVersion: v1
kind: Namespace
metadata:
  name: kdash-dev
  labels:
    env: development
---
apiVersion: v1
kind: Namespace
metadata:
  name: kdash-staging
  labels:
    env: staging
---
# === kdash-dev namespace ===
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: kdash-dev
  labels:
    app: web-api
data:
  DATABASE_URL: "postgres://db:5432/myapp"
  LOG_LEVEL: "debug"
  CACHE_TTL: "300"
---
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
  namespace: kdash-dev
  labels:
    app: web-api
type: Opaque
stringData:
  DB_PASSWORD: "dev-password-123"
  API_KEY: "sk-dev-key-abc"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
  namespace: kdash-dev
  labels:
    app: web-api
    tier: backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web-api
  template:
    metadata:
      labels:
        app: web-api
        tier: backend
    spec:
      containers:
        - name: api
          image: nginx:1.27-alpine
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
          env:
            - name: PORT
              value: "8080"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: kdash-dev
  labels:
    app: worker
    tier: backend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: worker
  template:
    metadata:
      labels:
        app: worker
        tier: backend
    spec:
      containers:
        - name: worker
          image: busybox:1.37
          command: ["sh", "-c", "while true; do echo working; sleep 30; done"]
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              cpu: 100m
              memory: 64Mi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-cache
  namespace: kdash-dev
  labels:
    app: redis
    tier: cache
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
        tier: cache
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          resources:
            requests:
              cpu: 25m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 128Mi
---
apiVersion: v1
kind: Service
metadata:
  name: web-api-svc
  namespace: kdash-dev
  labels:
    app: web-api
spec:
  selector:
    app: web-api
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP
---
apiVersion: v1
kind: Service
metadata:
  name: redis-svc
  namespace: kdash-dev
  labels:
    app: redis
spec:
  selector:
    app: redis
  ports:
    - port: 6379
      targetPort: 6379
  type: ClusterIP
---
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  namespace: kdash-dev
  labels:
    app: web-api
    job-type: migration
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: busybox:1.37
          command: ["sh", "-c", "echo 'Running migrations...' && sleep 2 && echo 'Done'"]
          resources:
            requests:
              cpu: 10m
              memory: 8Mi
      restartPolicy: Never
  backoffLimit: 2
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cleanup-job
  namespace: kdash-dev
  labels:
    app: web-api
    job-type: cleanup
spec:
  schedule: "0 */6 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: cleanup
              image: busybox:1.37
              command: ["sh", "-c", "echo cleanup"]
              resources:
                requests:
                  cpu: 10m
                  memory: 8Mi
          restartPolicy: Never
---
# === kdash-staging namespace ===
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
  namespace: kdash-staging
  labels:
    app: web-api
    tier: backend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web-api
  template:
    metadata:
      labels:
        app: web-api
        tier: backend
    spec:
      containers:
        - name: api
          image: nginx:1.27-alpine
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
---
apiVersion: v1
kind: Service
metadata:
  name: web-api-svc
  namespace: kdash-staging
  labels:
    app: web-api
spec:
  selector:
    app: web-api
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: kdash-staging
  labels:
    app: web-api
data:
  DATABASE_URL: "postgres://db:5432/myapp_staging"
  LOG_LEVEL: "info"
EOF

  # Wait for deployments
  info "Waiting for deployments to be ready..."
  kubectl rollout status deployment/web-api -n kdash-dev --timeout=90s
  kubectl rollout status deployment/worker -n kdash-dev --timeout=90s
  kubectl rollout status deployment/redis-cache -n kdash-dev --timeout=90s
  kubectl rollout status deployment/web-api -n kdash-staging --timeout=90s

  echo ""
  ok "Dev cluster ready!"
  echo ""
  echo "  Context:    kind-${CLUSTER_NAME}"
  echo "  Namespaces: kdash-dev, kdash-staging"
  echo ""
  echo "  Resources in kdash-dev:"
  dim "Deployments: web-api (3), worker (2), redis-cache (1)"
  dim "Services:    web-api-svc, redis-svc"
  dim "ConfigMaps:  app-config"
  dim "Secrets:     app-secrets"
  dim "Jobs:        db-migrate"
  dim "CronJobs:    cleanup-job"
  echo ""
  echo "  Now run the app:"
  dim "npm run tauri dev"
  echo ""
  echo "  Test actions to try in AI chat:"
  dim "\"Scale web-api to 5 replicas\"           → YELLOW (confirm dialog)"
  dim "\"Restart the worker deployment\"          → YELLOW (confirm dialog)"
  dim "\"Delete pod web-api-xxx in kdash-dev\"    → RED (type name to confirm)"
  dim "\"Delete namespace kdash-dev\"             → BLACKED (rejected)"
  dim "\"Show me the logs for web-api\"           → GREEN (auto-execute)"
  dim "\"List all pods in kdash-dev\"             → GREEN (auto-execute)"
  echo ""
  echo "  To stop:"
  dim "./scripts/dev-cluster.sh --stop"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
case "$ACTION" in
  start)  do_create ;;
  reset)  do_stop; do_create ;;
  stop)   do_stop ;;
  status) do_status ;;
esac
