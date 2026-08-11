import { describe, expect, test } from "bun:test";
import { summarizeManifests } from "./manifest-summary";

describe("summarizeManifests", () => {
  test("empty input yields no resources", () => {
    expect(summarizeManifests("").resources).toEqual([]);
    expect(summarizeManifests("   \n  ").resources).toEqual([]);
  });

  test("reads kind and metadata.name from a single document", () => {
    const yaml = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: default
data:
  key: value`;
    expect(summarizeManifests(yaml).resources).toEqual([
      { key: "0-ConfigMap-app-config", kind: "ConfigMap", name: "app-config" },
    ]);
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
    // The pod template's `kind` is indented; only the column-0 one counts.
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

  test("non-Kubernetes content degrades to no resources rather than throwing", () => {
    expect(summarizeManifests("just some text\nnot yaml at all: [[[").resources).toEqual([]);
    expect(summarizeManifests("{ not: yaml").resources).toEqual([]);
  });

  test("a document without a kind is skipped, later ones still parse", () => {
    const yaml = `foo: bar
---
kind: Job
metadata:
  name: nightly`;
    expect(summarizeManifests(yaml).resources).toHaveLength(1);
    expect(summarizeManifests(yaml).resources[0].kind).toBe("Job");
  });
});
