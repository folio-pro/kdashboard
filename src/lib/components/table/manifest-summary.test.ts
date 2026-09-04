import { describe, expect, test } from "bun:test";
import { summarizeManifests } from "./manifest-summary";

describe("summarizeManifests", () => {
  test("empty input yields no resources and no errors", () => {
    expect(summarizeManifests("")).toEqual({ resources: [], errors: [] });
    expect(summarizeManifests("   \n  ")).toEqual({ resources: [], errors: [] });
  });

  test("reads kind, metadata.name and metadata.namespace from a single document", () => {
    const yaml = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: default
data:
  key: value`;
    const { resources, errors } = summarizeManifests(yaml);
    expect(errors).toEqual([]);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      key: "0-ConfigMap-app-config",
      index: 0,
      kind: "ConfigMap",
      name: "app-config",
      namespace: "default",
    });
  });

  test("namespace is null when the manifest omits it", () => {
    expect(summarizeManifests("kind: Job\nmetadata:\n  name: a").resources[0].namespace).toBeNull();
  });

  test("splits multi-document YAML on ---", () => {
    const yaml = `kind: Service
metadata:
  name: web
---
kind: Deployment
metadata:
  name: web`;
    const { resources } = summarizeManifests(yaml);
    expect(resources.map((r) => `${r.kind}/${r.name}`)).toEqual([
      "Service/web",
      "Deployment/web",
    ]);
  });

  test("keys stay unique when the same kind/name repeats", () => {
    const yaml = `kind: Service
metadata:
  name: web
---
kind: Service
metadata:
  name: web`;
    const keys = summarizeManifests(yaml).resources.map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });

  test("ignores a nested kind under spec.template", () => {
    const yaml = `kind: Deployment
metadata:
  name: api
spec:
  template:
    kind: Pod
    metadata:
      name: api-pod`;
    const { resources } = summarizeManifests(yaml);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ kind: "Deployment", name: "api" });
  });

  test("falls back to (unnamed) when metadata.name is absent", () => {
    expect(summarizeManifests("kind: Namespace\nmetadata:\n  labels:\n    a: b").resources[0]).toMatchObject({
      kind: "Namespace",
      name: "(unnamed)",
    });
  });

  test("strips quotes around kind and name", () => {
    const { resources } = summarizeManifests(`kind: "Secret"\nmetadata:\n  name: 'db-creds'`);
    expect(resources[0]).toMatchObject({ kind: "Secret", name: "db-creds" });
  });

  test("non-Kubernetes content degrades to errors rather than throwing", () => {
    const plain = summarizeManifests("just some text");
    expect(plain.resources).toEqual([]);
    expect(plain.errors).toHaveLength(1);
    expect(plain.errors[0].message).toMatch(/kind/);

    const broken = summarizeManifests("{ not: yaml");
    expect(broken.resources).toEqual([]);
    expect(broken.errors).toHaveLength(1);
    expect(broken.errors[0].index).toBe(0);
  });

  test("a document without a kind is reported, later ones still parse", () => {
    const yaml = `foo: bar
---
kind: Job
metadata:
  name: nightly`;
    const { resources, errors } = summarizeManifests(yaml);
    expect(resources).toHaveLength(1);
    expect(resources[0].kind).toBe("Job");
    expect(errors).toEqual([{ index: 0, message: expect.stringMatching(/kind/) }]);
  });

  test("a syntax error is attributed to its document", () => {
    const yaml = `kind: Job
metadata:
  name: ok
---
kind: Job
metadata:
  name: [broken`;
    const { resources, errors } = summarizeManifests(yaml);
    expect(resources.map((r) => r.index)).toEqual([0]);
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(1);
  });

  test("blank and comment-only documents are ignored", () => {
    const yaml = `kind: Job
metadata:
  name: a
---
# nothing here
---
`;
    const { resources, errors } = summarizeManifests(yaml);
    expect(resources).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});
