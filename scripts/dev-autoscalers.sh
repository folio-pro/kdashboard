#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Autoscaler fixtures for the Kind dev cluster.
#
# Layers HPA, VPA and WPA onto the cluster ./scripts/dev-cluster.sh creates, so
# the Scaling views have something to show. Run dev-cluster.sh first.
#
# What it installs:
#   * metrics-server (patched with --kubelet-insecure-tls, which Kind needs) so
#     the HPA controller has real readings instead of <unknown>
#   * the REAL upstream CRDs for VerticalPodAutoscaler and Datadog's
#     WatermarkPodAutoscaler — not hand-written ones, so the views are checked
#     against the schemas those projects actually ship
#   * four HPAs, two WPAs and two VPAs covering the shapes the views handle
#   * `load-demo`, a workload whose CPU oscillates on a ~2.5 minute cycle, so
#     the live-updating columns can be watched moving
#
# NOTE ON STATUS: the VPA recommender and the WPA controller are not installed
# (the latter needs a Datadog account), so nothing writes their `status`. This
# script patches those statuses by hand with realistic values. The HPA statuses
# are real — written by the in-tree controller from metrics-server.
#
# Usage:
#   ./scripts/dev-autoscalers.sh          # install
#   ./scripts/dev-autoscalers.sh --clean  # remove the fixtures (keeps the cluster)
# ---------------------------------------------------------------------------
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-kdash-dev}"
CTX="kind-${CLUSTER_NAME}"
NS="kdash-dev"

WPA_CRD_URL="https://raw.githubusercontent.com/DataDog/watermarkpodautoscaler/main/config/crd/bases/v1/datadoghq.com_watermarkpodautoscalers.yaml"
VPA_CRD_URL="https://raw.githubusercontent.com/kubernetes/autoscaler/master/vertical-pod-autoscaler/deploy/vpa-v1-crd-gen.yaml"
METRICS_SERVER_URL="https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml"

info() { printf "\033[1;34m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
fail() { printf "\033[1;31m✘ %s\033[0m\n" "$*"; }

for cmd in kubectl curl; do
  command -v "$cmd" &>/dev/null || { fail "$cmd is not installed"; exit 1; }
done

if ! kubectl --context "$CTX" cluster-info &>/dev/null; then
  fail "Cluster context '$CTX' is not reachable. Run ./scripts/dev-cluster.sh first."
  exit 1
fi

k() { kubectl --context "$CTX" "$@"; }

# ---------------------------------------------------------------------------
# --clean
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--clean" ]]; then
  info "Removing autoscaler fixtures..."
  k delete -n "$NS" hpa web-api worker redis-cache load-demo --ignore-not-found
  # --ignore-not-found covers a missing object, not a missing TYPE: with the
  # CRDs already gone kubectl exits non-zero and set -e would abandon the rest
  # of the cleanup.
  k delete -n "$NS" wpa web-api worker --ignore-not-found || true
  k delete -n "$NS" vpa web-api redis-cache --ignore-not-found || true
  k delete -n "$NS" deploy load-demo --ignore-not-found
  k delete crd watermarkpodautoscalers.datadoghq.com --ignore-not-found
  k delete crd verticalpodautoscalers.autoscaling.k8s.io \
                verticalpodautoscalercheckpoints.autoscaling.k8s.io --ignore-not-found
  ok "Fixtures removed (metrics-server left in place)"
  exit 0
fi

# ---------------------------------------------------------------------------
# metrics-server
# ---------------------------------------------------------------------------
if k -n kube-system get deploy metrics-server &>/dev/null; then
  info "metrics-server already installed"
else
  info "Installing metrics-server..."
  k apply -f "$METRICS_SERVER_URL" >/dev/null
  # Kind's kubelet serves a self-signed cert; without this metrics-server never
  # scrapes and every HPA sits at <unknown> forever.
  k -n kube-system patch deployment metrics-server --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null
  k -n kube-system rollout status deployment/metrics-server --timeout=180s
  ok "metrics-server ready"
fi

# ---------------------------------------------------------------------------
# CRDs (upstream, not hand-written)
# ---------------------------------------------------------------------------
info "Installing the WatermarkPodAutoscaler CRD (DataDog/watermarkpodautoscaler)..."
curl -sSL --max-time 60 "$WPA_CRD_URL" | k apply -f - >/dev/null
info "Installing the VerticalPodAutoscaler CRDs (kubernetes/autoscaler)..."
curl -sSL --max-time 60 "$VPA_CRD_URL" | k apply -f - >/dev/null
# apply returns before the apiserver serves the new types; without this the
# WPA/VPA objects below race it and fail with "no matches for kind".
k wait --for=condition=established --timeout=60s \
  crd/watermarkpodautoscalers.datadoghq.com \
  crd/verticalpodautoscalers.autoscaling.k8s.io >/dev/null
ok "CRDs installed"

# ---------------------------------------------------------------------------
# The autoscalers
# ---------------------------------------------------------------------------
info "Creating autoscalers in namespace '$NS'..."
k apply -f - <<'EOF' >/dev/null
# Two metrics, so the Targets column has to render more than one — and one of
# them usually has no reading, which is the <unknown> path.
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: web-api, namespace: kdash-dev }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: web-api }
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 50 } }
    - type: Resource
      resource: { name: memory, target: { type: Utilization, averageUtilization: 70 } }
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies: [{ type: Percent, value: 100, periodSeconds: 15 }]
    scaleDown:
      stabilizationWindowSeconds: 30
      policies: [{ type: Pods, value: 1, periodSeconds: 15 }]
---
# min == max: pinned, so ScalingLimited shows up somewhere predictable.
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: worker, namespace: kdash-dev }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: worker }
  minReplicas: 2
  maxReplicas: 2
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 80 } }
---
# AverageValue rather than Utilization: the quantity path, not the percent one.
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: redis-cache, namespace: kdash-dev }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: redis-cache }
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: AverageValue, averageValue: 20m } }
---
apiVersion: datadoghq.com/v1alpha1
kind: WatermarkPodAutoscaler
metadata: { name: web-api, namespace: kdash-dev }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: web-api }
  minReplicas: 4
  maxReplicas: 20
  algorithm: absolute
  tolerance: "0.01"
  scaleUpLimitFactor: "50"
  scaleDownLimitFactor: "20"
  upscaleForbiddenWindowSeconds: 30
  downscaleForbiddenWindowSeconds: 300
  readinessDelaySeconds: 30
  metrics:
    - type: External
      external:
        metricName: nginx.net.request_per_s
        metricSelector: { matchLabels: { kube_container_name: api } }
        highWatermark: "80"
        lowWatermark: "40"
---
# dryRun + a Resource metric, so the utilization-reading path is covered too.
apiVersion: datadoghq.com/v1alpha1
kind: WatermarkPodAutoscaler
metadata: { name: worker, namespace: kdash-dev }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: worker }
  minReplicas: 1
  maxReplicas: 8
  dryRun: true
  algorithm: average
  metrics:
    - type: Resource
      resource: { name: cpu, highWatermark: "80", lowWatermark: "30" }
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata: { name: web-api, namespace: kdash-dev }
spec:
  targetRef: { apiVersion: apps/v1, kind: Deployment, name: web-api }
  updatePolicy: { updateMode: "Auto" }
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata: { name: redis-cache, namespace: kdash-dev }
spec:
  targetRef: { apiVersion: apps/v1, kind: Deployment, name: redis-cache }
  updatePolicy: { updateMode: "Off" }
EOF
ok "Autoscalers created"

# ---------------------------------------------------------------------------
# Hand-written status for the two kinds with no controller here
# ---------------------------------------------------------------------------
info "Patching VPA/WPA status (no recommender or Datadog controller in this cluster)..."
SCALED_AT=$(date -u -d '-4 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-4M +%Y-%m-%dT%H:%M:%SZ)

k -n "$NS" patch wpa web-api --subresource=status --type=merge -p "{\"status\":{
  \"currentReplicas\":6,\"desiredReplicas\":8,\"scalingEventsCount\":3,
  \"lastScaleTime\":\"$SCALED_AT\",\"lastConditionType\":\"ScalingActive\",\"lastConditionState\":\"True\",
  \"currentMetrics\":[{\"type\":\"External\",\"external\":{\"metricName\":\"nginx.net.request_per_s\",\"currentValue\":\"62\"}}],
  \"conditions\":[
    {\"type\":\"ScalingActive\",\"status\":\"True\",\"reason\":\"ValidMetricFound\",\"message\":\"the WPA was able to successfully calculate a replica count\",\"lastTransitionTime\":\"$SCALED_AT\"},
    {\"type\":\"AbleToScale\",\"status\":\"True\",\"reason\":\"SucceededRescale\",\"message\":\"the WPA controller was able to update the target scale to 8\",\"lastTransitionTime\":\"$SCALED_AT\"},
    {\"type\":\"ScalingLimited\",\"status\":\"False\",\"reason\":\"DesiredWithinRange\",\"message\":\"the desired count is within the acceptable range\",\"lastTransitionTime\":\"$SCALED_AT\"}
  ]}}" >/dev/null

k -n "$NS" patch wpa worker --subresource=status --type=merge -p "{\"status\":{
  \"currentReplicas\":2,\"desiredReplicas\":2,\"scalingEventsCount\":0,
  \"lastConditionType\":\"DryRun\",\"lastConditionState\":\"True\",
  \"currentMetrics\":[{\"type\":\"Resource\",\"resource\":{\"name\":\"cpu\",\"currentAverageUtilization\":24,\"currentAverageValue\":\"2m\"}}],
  \"conditions\":[
    {\"type\":\"DryRun\",\"status\":\"True\",\"reason\":\"DryRun\",\"message\":\"scaling changes are not applied\",\"lastTransitionTime\":\"$SCALED_AT\"},
    {\"type\":\"ScalingActive\",\"status\":\"True\",\"reason\":\"ValidMetricFound\",\"message\":\"the WPA was able to successfully calculate a replica count\",\"lastTransitionTime\":\"$SCALED_AT\"}
  ]}}" >/dev/null

k -n "$NS" patch vpa web-api --subresource=status --type=merge -p "{\"status\":{
  \"recommendation\":{\"containerRecommendations\":[
    {\"containerName\":\"api\",\"target\":{\"cpu\":\"237m\",\"memory\":\"262144k\"},\"lowerBound\":{\"cpu\":\"120m\",\"memory\":\"131072k\"},\"upperBound\":{\"cpu\":\"1\",\"memory\":\"1Gi\"},\"uncappedTarget\":{\"cpu\":\"237m\",\"memory\":\"262144k\"}}
  ]},
  \"conditions\":[{\"type\":\"RecommendationProvided\",\"status\":\"True\",\"lastTransitionTime\":\"$SCALED_AT\"}]}}" >/dev/null

k -n "$NS" patch vpa redis-cache --subresource=status --type=merge -p "{\"status\":{
  \"recommendation\":{\"containerRecommendations\":[
    {\"containerName\":\"redis\",\"target\":{\"cpu\":\"41m\",\"memory\":\"56Mi\"},\"lowerBound\":{\"cpu\":\"25m\",\"memory\":\"32Mi\"},\"upperBound\":{\"cpu\":\"180m\",\"memory\":\"256Mi\"}}
  ]},
  \"conditions\":[{\"type\":\"RecommendationProvided\",\"status\":\"True\",\"lastTransitionTime\":\"$SCALED_AT\"}]}}" >/dev/null
ok "Status patched"

# ---------------------------------------------------------------------------
# Oscillating load, so the live columns actually move
# ---------------------------------------------------------------------------
info "Deploying the oscillating load generator..."
k apply -f - <<'EOF' >/dev/null
# ~60s busy, ~90s idle. Its HPA then climbs and falls on a ~2.5 minute cycle,
# which is what makes the live Targets/Replicas columns reviewable without
# waiting for real traffic. Capped at 100m x 5 pods = half a core of the host.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: load-demo
  namespace: kdash-dev
  labels: { app: load-demo, tier: demo }
spec:
  replicas: 1
  selector: { matchLabels: { app: load-demo } }
  template:
    metadata:
      labels: { app: load-demo, tier: demo }
    spec:
      containers:
        - name: burner
          image: busybox:1.36
          command: ["/bin/sh", "-c"]
          args:
            - |
              while true; do
                end=$(( $(date +%s) + 60 ))
                while [ "$(date +%s)" -lt "$end" ]; do :; done
                sleep 90
              done
          resources:
            requests: { cpu: 50m, memory: 16Mi }
            limits:   { cpu: 100m, memory: 32Mi }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: load-demo, namespace: kdash-dev }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: load-demo }
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 60 } }
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies: [{ type: Percent, value: 100, periodSeconds: 15 }]
    scaleDown:
      stabilizationWindowSeconds: 30
      policies: [{ type: Pods, value: 1, periodSeconds: 15 }]
EOF
k -n "$NS" rollout status deploy/load-demo --timeout=180s
ok "Load generator running"

echo ""
ok "Done. Give metrics-server ~60s, then:"
echo ""
kubectl --context "$CTX" get hpa,wpa,vpa -n "$NS" 2>/dev/null || true
echo ""
printf "  \033[0;90mbun run dev:electron    → Scaling ▸ HPA / VPA / WPA\033[0m\n"
printf "  \033[0;90m./scripts/dev-autoscalers.sh --clean    to remove\033[0m\n"
