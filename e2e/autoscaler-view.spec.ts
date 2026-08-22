/**
 * The three autoscaler views (HPA, VPA, WPA). They share one set of columns and
 * one detail panel, fed by the normalizer in $lib/utils/autoscaler — these
 * tests guard that each flavour's own spec/status layout still reaches the
 * screen through it, and that the columns are populated at all (they shipped
 * declared-but-unimplemented, rendering "-" in every cell).
 */
import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const created = new Date(Date.now() - 86_400_000).toISOString();

function meta(name: string, uid: string) {
  return {
    name,
    namespace: "default",
    uid,
    creation_timestamp: created,
    labels: {},
    annotations: {},
    owner_references: [],
    resource_version: "1",
  };
}

const HPA = {
  kind: "HorizontalPodAutoscaler",
  api_version: "autoscaling/v2",
  metadata: meta("api-hpa", "hpa-uid-1"),
  spec: {
    scaleTargetRef: { kind: "Deployment", name: "api" },
    minReplicas: 2,
    maxReplicas: 10,
    metrics: [
      { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 80 } } },
      { type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: 70 } } },
    ],
  },
  status: {
    currentReplicas: 3,
    desiredReplicas: 5,
    currentMetrics: [
      { type: "Resource", resource: { name: "cpu", current: { averageUtilization: 60 } } },
    ],
    conditions: [{ type: "ScalingLimited", status: "True", reason: "TooManyReplicas" }],
  },
};

const WPA = {
  kind: "WatermarkPodAutoscaler",
  api_version: "datadoghq.com/v1alpha1",
  metadata: meta("api-wpa", "wpa-uid-1"),
  spec: {
    scaleTargetRef: { kind: "Deployment", name: "api" },
    minReplicas: 4,
    maxReplicas: 20,
    dryRun: true,
    algorithm: "absolute",
    tolerance: 0.01,
    scaleUpLimitFactor: 50,
    downscaleForbiddenWindowSeconds: 300,
    metrics: [
      {
        type: "External",
        external: { metricName: "nginx.net.request_per_s", highWatermark: "80", lowWatermark: "40" },
      },
    ],
  },
  status: {
    currentReplicas: 6,
    desiredReplicas: 6,
    currentMetrics: [
      { type: "External", external: { metricName: "nginx.net.request_per_s", currentValue: "60" } },
    ],
  },
};

const VPA = {
  kind: "VerticalPodAutoscaler",
  api_version: "autoscaling.k8s.io/v1",
  metadata: meta("api-vpa", "vpa-uid-1"),
  spec: {
    targetRef: { kind: "Deployment", name: "api" },
    updatePolicy: { updateMode: "Auto" },
  },
  status: {
    recommendation: {
      containerRecommendations: [
        {
          containerName: "app",
          target: { cpu: "250m", memory: "512Mi" },
          lowerBound: { cpu: "100m", memory: "256Mi" },
          upperBound: { cpu: "1", memory: "1Gi" },
        },
      ],
    },
  },
};

const MOCK = clusterBootMock(`(cmd, args) => {
  if (cmd === "list_resources") {
    const byType = {
      hpa: ${JSON.stringify([HPA])},
      wpa: ${JSON.stringify([WPA])},
      vpa: ${JSON.stringify([VPA])},
    };
    return { resource_type: args.resourceType, items: byType[args.resourceType] ?? [] };
  }
  if (cmd === "discover_crds") return [];
  // No Prometheus in the test cluster: the panel must say so rather than fail.
  if (cmd === "query_prometheus_range") return { configured: false, series: [] };
}`);

async function openView(page: import("@playwright/test").Page, label: string) {
  await page.getByRole("button", { name: new RegExp(`^${label} `) }).first().click();
  await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
}

test.beforeEach(async ({ page, mockInvoke }) => {
  await mockInvoke(MOCK);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pods", exact: true })).toBeVisible({ timeout: 10_000 });
});

test("the HPA table shows the target, both metrics and the replica gap", async ({ page }) => {
  await openView(page, "HPA");

  const row = page.locator("tbody tr").first();
  await expect(row).toContainText("api-hpa");
  await expect(row).toContainText("Deployment/api");
  // The metric with a reading and the one still waiting for one both show.
  await expect(row).toContainText("cpu: 60%/80%");
  await expect(row).toContainText("memory: <unknown>/70%");
  // 3 running, 5 wanted — the gap is the whole point of the column.
  await expect(row).toContainText("3 → 5");
  await expect(row).toContainText("2");
  await expect(row).toContainText("10");
});

test("the HPA detail panel explains the replica gap and the scaling limit", async ({ page }) => {
  await openView(page, "HPA");
  await page.locator("tbody tr").first().click();

  const panel = page.locator('[data-testid="detail-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("3 running → 5 wanted");
  await expect(panel).toContainText("min 2");
  await expect(panel).toContainText("max 10");
  await expect(panel).toContainText("TooManyReplicas");
  await expect(panel).toContainText("cpu");
  // The replica chart is offered but degrades to a hint without a Prometheus.
  await expect(panel).toContainText("Replica History");
  await expect(panel).toContainText("Set a Prometheus URL");
});

test("the WPA table shows the watermark band, not a single target", async ({ page }) => {
  await openView(page, "WPA");

  const row = page.locator("tbody tr").first();
  await expect(row).toContainText("api-wpa");
  await expect(row).toContainText("Deployment/api");
  await expect(row).toContainText("nginx.net.request_per_s: 60/40 – 80");
  await expect(row).toContainText("6");
});

test("the WPA detail panel renders the autoscaler panel, not the generic one", async ({ page }) => {
  await openView(page, "WPA");
  await page.locator("tbody tr").first().click();

  const panel = page.locator('[data-testid="detail-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Watermarks");
  await expect(panel).toContainText("Dry run");
  await expect(panel).toContainText("6 running");
  await expect(panel).toContainText("min 4");
  await expect(panel).toContainText("max 20");
  // WPA's own knobs are not HPA `behavior`, so they get their own section.
  await expect(panel).toContainText("Tuning");
  await expect(panel).toContainText("absolute");
  // Units come from the CRD's field names, so the panel must supply them.
  await expect(panel).toContainText("Downscale Window");
  await expect(panel).toContainText("300s");
  await expect(panel).toContainText("50%");
  // kube-state-metrics has no WPA replica series, so no chart is offered.
  await expect(panel).not.toContainText("Replica History");
});

test("the VPA table shows recommendations instead of replica bounds", async ({ page }) => {
  await openView(page, "VPA");

  const row = page.locator("tbody tr").first();
  await expect(row).toContainText("api-vpa");
  await expect(row).toContainText("Deployment/api");
  await expect(row).toContainText("Auto");
  await expect(row).toContainText("app/cpu: 250m/100m – 1");

  await page.locator("tbody tr").first().click();
  const panel = page.locator('[data-testid="detail-panel"]');
  await expect(panel).toContainText("Recommendations");
  await expect(panel).toContainText("app/memory");
  // A VPA never changes the replica count, so the scaling track stays away.
  await expect(panel).not.toContainText("Max Replicas");
});
