import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { summarizeManifests } from "./manifest-summary";
import {
  TEMPLATE_KINDS,
  appendDocument,
  applyButtonState,
  describeTargets,
  isClusterScoped,
  manifestTemplate,
  needsNamespacePicker,
  resolveTargets,
  serializeForApply,
} from "./create-resource.logic";

describe("manifestTemplate", () => {
  test("every template parses to a manifest of its own kind", () => {
    for (const kind of TEMPLATE_KINDS) {
      const yaml = manifestTemplate(kind, "shop");
      const obj = parse(yaml) as Record<string, unknown>;
      expect(obj.kind).toBe(kind);
      expect(typeof obj.apiVersion).toBe("string");
      expect((obj.metadata as Record<string, unknown>).name).toBeTruthy();
      expect(summarizeManifests(yaml).errors).toEqual([]);
    }
  });

  test("namespaced templates carry the current namespace", () => {
    const obj = parse(manifestTemplate("Deployment", "shop")) as { metadata: { namespace?: string } };
    expect(obj.metadata.namespace).toBe("shop");
  });

  test("templates omit the namespace line when the table shows all namespaces", () => {
    expect(manifestTemplate("Service", "")).not.toContain("namespace:");
    const obj = parse(manifestTemplate("Service", "")) as { metadata: { namespace?: string } };
    expect(obj.metadata.namespace).toBeUndefined();
  });

  test("the Namespace template never takes a namespace", () => {
    expect(manifestTemplate("Namespace", "shop")).not.toContain("namespace: shop");
  });
});

describe("appendDocument", () => {
  test("replaces an empty or whitespace-only buffer", () => {
    expect(appendDocument("", "kind: Job\n")).toBe("kind: Job\n");
    expect(appendDocument("  \n", "kind: Job\n")).toBe("kind: Job\n");
  });

  test("appends as a new document with a --- separator", () => {
    const out = appendDocument("kind: Service\n\n", "kind: Job\n");
    expect(out).toBe("kind: Service\n---\nkind: Job\n");
    expect(summarizeManifests(out).resources.map((r) => r.kind)).toEqual(["Service", "Job"]);
  });
});

describe("isClusterScoped", () => {
  test("knows the built-in cluster-scoped kinds", () => {
    expect(isClusterScoped("Namespace")).toBe(true);
    expect(isClusterScoped("ClusterRole")).toBe(true);
    expect(isClusterScoped("Deployment")).toBe(false);
  });

  test("treats an unknown kind as namespaced", () => {
    expect(isClusterScoped("Certificate")).toBe(false);
  });
});

const yamlOf = (text: string) => summarizeManifests(text).resources;

describe("resolveTargets", () => {
  test("a manifest's own namespace wins over the current one", () => {
    const [t] = resolveTargets(yamlOf("kind: ConfigMap\nmetadata:\n  name: a\n  namespace: other"), "shop", "");
    expect(t.namespace).toBe("other");
    expect(t.inferred).toBe(false);
    expect(t.needsNamespace).toBe(false);
  });

  test("falls back to the current namespace and flags it as inferred", () => {
    const [t] = resolveTargets(yamlOf("kind: ConfigMap\nmetadata:\n  name: a"), "shop", "");
    expect(t.namespace).toBe("shop");
    expect(t.inferred).toBe(true);
  });

  test("with all namespaces selected, uses the namespace picked in the dialog", () => {
    const [t] = resolveTargets(yamlOf("kind: ConfigMap\nmetadata:\n  name: a"), "", "picked");
    expect(t.namespace).toBe("picked");
    expect(t.inferred).toBe(true);
  });

  test("with nothing to fall back on, the manifest needs a namespace", () => {
    const [t] = resolveTargets(yamlOf("kind: ConfigMap\nmetadata:\n  name: a"), "", "");
    expect(t.namespace).toBeNull();
    expect(t.needsNamespace).toBe(true);
  });

  test("cluster-scoped kinds never get a namespace", () => {
    const [t] = resolveTargets(yamlOf("kind: Namespace\nmetadata:\n  name: a"), "shop", "");
    expect(t.namespace).toBeNull();
    expect(t.clusterScoped).toBe(true);
    expect(t.needsNamespace).toBe(false);
  });
});

describe("needsNamespacePicker", () => {
  const resources = yamlOf("kind: ConfigMap\nmetadata:\n  name: a\n---\nkind: Namespace\nmetadata:\n  name: n");

  test("only when the table shows all namespaces and a namespaced manifest omits one", () => {
    expect(needsNamespacePicker(resolveTargets(resources, "", ""), "")).toBe(true);
    expect(needsNamespacePicker(resolveTargets(resources, "shop", ""), "shop")).toBe(false);
  });

  test("stays visible after a namespace was picked, so it can be changed", () => {
    expect(needsNamespacePicker(resolveTargets(resources, "", "picked"), "")).toBe(true);
  });

  test("not needed when every namespaced manifest names its namespace", () => {
    const explicit = yamlOf("kind: ConfigMap\nmetadata:\n  name: a\n  namespace: x");
    expect(needsNamespacePicker(resolveTargets(explicit, "", ""), "")).toBe(false);
  });
});

describe("applyButtonState", () => {
  function stateFor(text: string, currentNamespace = "shop", chosen = "") {
    const summary = summarizeManifests(text);
    return applyButtonState(summary, resolveTargets(summary.resources, currentNamespace, chosen));
  }

  test("disabled while the editor is empty", () => {
    const s = stateFor("");
    expect(s.enabled).toBe(false);
    expect(s.label).toBe("Apply to cluster");
    expect(s.reason).toBeTruthy();
  });

  test("disabled when a document has no kind", () => {
    expect(stateFor("foo: bar").enabled).toBe(false);
  });

  test("disabled on a YAML syntax error, even if another document is fine", () => {
    const s = stateFor("kind: Job\nmetadata:\n  name: ok\n---\n{ not: yaml");
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/error/);
  });

  test("disabled until a namespace is chosen for a namespaced manifest under all namespaces", () => {
    const text = "kind: ConfigMap\nmetadata:\n  name: a";
    expect(stateFor(text, "", "").enabled).toBe(false);
    expect(stateFor(text, "", "").reason).toMatch(/namespace/);
    expect(stateFor(text, "", "picked").enabled).toBe(true);
  });

  test("enabled with one valid manifest, labelled Apply to cluster", () => {
    const s = stateFor("kind: ConfigMap\nmetadata:\n  name: a");
    expect(s).toEqual({ enabled: true, label: "Apply to cluster", reason: null });
  });

  test("counts documents in the label", () => {
    const s = stateFor("kind: Service\nmetadata:\n  name: a\n---\nkind: Deployment\nmetadata:\n  name: a");
    expect(s).toEqual({ enabled: true, label: "Apply 2 resources", reason: null });
  });
});

describe("serializeForApply", () => {
  test("writes the resolved namespace into a manifest that had none", () => {
    const [t] = resolveTargets(yamlOf("# keep me\nkind: ConfigMap\nmetadata:\n  name: a\ndata:\n  k: v\n"), "shop", "");
    const out = serializeForApply(t);
    expect(parse(out)).toEqual({ kind: "ConfigMap", metadata: { name: "a", namespace: "shop" }, data: { k: "v" } });
    expect(out).toContain("# keep me");
  });

  test("leaves an explicit namespace alone", () => {
    const [t] = resolveTargets(yamlOf("kind: ConfigMap\nmetadata:\n  name: a\n  namespace: other"), "shop", "");
    expect((parse(serializeForApply(t)) as { metadata: { namespace: string } }).metadata.namespace).toBe("other");
  });

  test("does not add a namespace to cluster-scoped kinds", () => {
    const [t] = resolveTargets(yamlOf("kind: Namespace\nmetadata:\n  name: a"), "shop", "");
    expect(serializeForApply(t)).not.toContain("namespace:");
  });

  test("emits one manifest per target from a multi-document draft", () => {
    const targets = resolveTargets(yamlOf("kind: Service\nmetadata:\n  name: a\n---\nkind: Deployment\nmetadata:\n  name: b"), "shop", "");
    const docs = targets.map(serializeForApply);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => (parse(d) as { kind: string }).kind)).toEqual(["Service", "Deployment"]);
    expect(describeTargets(targets)).toBe("Service a, Deployment b");
  });
});
