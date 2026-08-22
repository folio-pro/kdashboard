import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { applyQuickEdit, describeChanges, quickEditFromYaml } from "./quick-edit.logic";

const YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
  labels:
    app: web
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: app
          image: acme/web:1.4.0
          env:
            - name: LOG_LEVEL
              value: info
            - name: DB_URL
              valueFrom:
                secretKeyRef:
                  name: db
                  key: url
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              memory: 1Gi
        - name: sidecar
          image: envoy:1.30
status:
  replicas: 2
`;

describe("quickEditFromYaml", () => {
  test("reads image, env (flagging valueFrom) and resources per container", () => {
    const e = quickEditFromYaml(YAML);
    expect(e.kind).toBe("Deployment");
    expect(e.namespace).toBe("shop");
    expect(e.containers.map((c) => c.name)).toEqual(["app", "sidecar"]);
    const app = e.containers[0];
    expect(app.image).toBe("acme/web:1.4.0");
    expect(app.env).toEqual([{ name: "LOG_LEVEL", value: "info", fromRef: false }, { name: "DB_URL", value: null, fromRef: true }]);
    expect(app.cpu_request).toBe("500m");
    expect(app.memory_limit).toBe("1Gi");
    expect(app.cpu_limit).toBe("");
    expect(e.containers[1].env).toEqual([]);
  });
});

describe("applyQuickEdit", () => {
  test("changes the image, rewrites env keeping valueFrom entries, and sets/clears quantities", () => {
    const e = quickEditFromYaml(YAML);
    e.containers[0].image = "acme/web:1.5.0";
    e.containers[0].env = [
      { name: "LOG_LEVEL", value: "debug", fromRef: false },
      { name: "DB_URL", value: null, fromRef: true },
      { name: "FEATURE_X", value: "on", fromRef: false },
    ];
    e.containers[0].cpu_request = "250m";
    e.containers[0].memory_limit = "";
    e.containers[0].cpu_limit = "1";
    const out = applyQuickEdit(YAML, e);
    const doc = parse(out);
    const app = doc.spec.template.spec.containers[0];
    expect(app.image).toBe("acme/web:1.5.0");
    expect(app.env).toEqual([
      { name: "LOG_LEVEL", value: "debug" },
      { name: "DB_URL", valueFrom: { secretKeyRef: { name: "db", key: "url" } } },
      { name: "FEATURE_X", value: "on" },
    ]);
    expect(app.resources).toEqual({ requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1" } });
    // Everything else is untouched.
    expect(doc.spec.replicas).toBe(2);
    expect(doc.metadata.labels).toEqual({ app: "web" });
    expect(doc.spec.template.spec.containers[1]).toEqual({ name: "sidecar", image: "envoy:1.30" });
    expect(doc.status).toEqual({ replicas: 2 });
  });

  test("clearing every env entry and every quantity drops the keys", () => {
    const e = quickEditFromYaml(YAML);
    e.containers[0].env = [];
    e.containers[0].cpu_request = "";
    e.containers[0].memory_request = "";
    e.containers[0].memory_limit = "";
    const app = parse(applyQuickEdit(YAML, e)).spec.template.spec.containers[0];
    expect(app.env).toBeUndefined();
    expect(app.resources).toBeUndefined();
  });

  test("CronJobs edit the job template's containers", () => {
    const cron = `apiVersion: batch/v1\nkind: CronJob\nmetadata: {name: c, namespace: n}\nspec:\n  schedule: "* * * * *"\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          containers:\n            - name: job\n              image: r/job:1\n`;
    const e = quickEditFromYaml(cron);
    expect(e.containers[0].image).toBe("r/job:1");
    e.containers[0].image = "r/job:2";
    expect(parse(applyQuickEdit(cron, e)).spec.jobTemplate.spec.template.spec.containers[0].image).toBe("r/job:2");
  });

  test("a kind without a template is refused", () => {
    expect(() => applyQuickEdit("apiVersion: v1\nkind: ConfigMap\nmetadata: {name: x}\ndata: {}\n", { kind: "ConfigMap", name: "x", namespace: "", containers: [] })).toThrow(/no pod template/);
  });
});

describe("describeChanges", () => {
  test("lists each change in plain words", () => {
    const before = quickEditFromYaml(YAML);
    const after = quickEditFromYaml(YAML);
    after.containers[0].image = "acme/web:1.5.0";
    after.containers[0].env = [{ name: "LOG_LEVEL", value: "debug", fromRef: false }, { name: "NEW", value: "1", fromRef: false }];
    after.containers[0].memory_limit = "2Gi";
    after.containers[1].cpu_request = "50m";
    expect(describeChanges(before, after)).toEqual([
      "app: image acme/web:1.4.0 → acme/web:1.5.0",
      "app: env LOG_LEVEL changed",
      "app: env NEW added",
      "app: env DB_URL dropped",
      "app: memory limit 1Gi → 2Gi",
      "sidecar: CPU request unset → 50m",
    ]);
    expect(describeChanges(before, before)).toEqual([]);
  });
});
