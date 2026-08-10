import { describe, expect, test } from "bun:test";

import { _staticProvider as staticProvider, EMPTY_PROVIDER } from "./schema-provider";
import {
  completionsFor,
  type CompletionDeps,
  _tokenStart as tokenStart,
  _valueStart as valueStart,
  _summarize as summarize,
  _siblingKeys as siblingKeys,
  _RESOURCE_SNIPPETS as RESOURCE_SNIPPETS,
  _BLOCK_SNIPPETS as BLOCK_SNIPPETS,
} from "./yaml-complete";

/** Place the cursor at `|`, which is removed from the text. */
function at(text: string): { doc: string; pos: number } {
  const pos = text.indexOf("|");
  if (pos === -1) throw new Error("no cursor marker");
  return { doc: text.slice(0, pos) + text.slice(pos + 1), pos };
}

function deps(overrides: Partial<CompletionDeps> = {}): CompletionDeps {
  return {
    provider: async (kind) => (kind ? staticProvider(kind) : EMPTY_PROVIDER),
    clusterValues: async () => ({ values: [], detail: "" }),
    namespace: "default",
    ...overrides,
  };
}

async function labelsAt(text: string, explicit = true, d = deps()): Promise<string[]> {
  const { doc, pos } = at(text);
  const result = await completionsFor(doc, pos, explicit, d);
  return result?.options.map((o) => o.label) ?? [];
}

// ---------------------------------------------------------------------------
// Prefix extraction
// ---------------------------------------------------------------------------
describe("tokenStart", () => {
  test("starts at the beginning of a partial key", () => {
    const text = "spec:\n  repl";
    expect(tokenStart(text, text.length)).toBe(text.length - 4);
  });

  test("equals the cursor when nothing is typed", () => {
    const text = "spec:\n  ";
    expect(tokenStart(text, text.length)).toBe(text.length);
  });

  test("includes dots and slashes", () => {
    const text = "  app.kubernetes.io/na";
    expect(text.slice(tokenStart(text, text.length))).toBe("app.kubernetes.io/na");
  });
});

describe("valueStart", () => {
  test("starts after the colon and space", () => {
    const text = "type: Clus";
    expect(text.slice(valueStart(text, text.length))).toBe("Clus");
  });

  test("equals the cursor right after the space", () => {
    const text = "type: ";
    expect(valueStart(text, text.length)).toBe(text.length);
  });
});

describe("summarize", () => {
  test("keeps only the first sentence", () => {
    expect(summarize("First one. Second one is long.")).toBe("First one.");
  });

  test("returns a single sentence unchanged", () => {
    expect(summarize("Just this")).toBe("Just this");
  });

  test("returns undefined for no description", () => {
    expect(summarize(undefined)).toBeUndefined();
  });

  test("truncates a very long first sentence", () => {
    const long = `${"a".repeat(500)}. next`;
    expect(summarize(long)!.length).toBeLessThanOrEqual(400);
  });
});

describe("siblingKeys", () => {
  test("collects keys at the same indentation", () => {
    const text = "spec:\n  replicas: 1\n  paused: true\n  ";
    const found = siblingKeys(text, text.length, 2);
    expect([...found].sort()).toEqual(["paused", "replicas"]);
  });

  test("ignores deeper and shallower keys", () => {
    const text = "spec:\n  template:\n    metadata: {}\n  ";
    const found = siblingKeys(text, text.length, 2);
    expect(found.has("metadata")).toBe(false);
    expect(found.has("template")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------
describe("resource snippets", () => {
  test("an empty document offers whole-resource skeletons", async () => {
    const found = await labelsAt("|");
    expect(found).toContain("Deployment");
    expect(found).toContain("Service");
  });

  test("skeletons carry a snippet template", () => {
    for (const snippet of RESOURCE_SNIPPETS) {
      expect(snippet.snippet).toBeTruthy();
    }
  });

  test("every skeleton declares apiVersion and kind", () => {
    for (const snippet of RESOURCE_SNIPPETS) {
      expect(snippet.snippet).toContain("apiVersion:");
      expect(snippet.snippet).toContain("kind:");
    }
  });

  test("skeletons disappear once a kind is written", async () => {
    const found = await labelsAt("apiVersion: v1\nkind: Pod\n|");
    expect(found).not.toContain("Deployment");
  });

  test("block snippets open with the field they complete", () => {
    for (const [name, body] of Object.entries(BLOCK_SNIPPETS)) {
      expect(body.startsWith(`${name}:`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Key completions
// ---------------------------------------------------------------------------
describe("key completions", () => {
  const DEPLOY = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: main
          image: nginx:1
          |`;

  test("suggests container fields inside a sequence entry", async () => {
    // The old walker resolved this path to spec.template.spec.containers and
    // offered the wrong field set.
    const found = await labelsAt(DEPLOY);
    expect(found).toContain("imagePullPolicy");
    expect(found).toContain("volumeMounts");
  });

  test("does not offer pod-level fields inside a container", async () => {
    const found = await labelsAt(DEPLOY);
    expect(found).not.toContain("restartPolicy");
  });

  test("suggests spec fields at the spec level", async () => {
    const found = await labelsAt(
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: w\nspec:\n  |",
    );
    expect(found).toContain("replicas");
    expect(found).toContain("selector");
  });

  test("required fields are boosted above optional ones", async () => {
    const { doc, pos } = at(
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: w\nspec:\n  |",
    );
    const result = await completionsFor(doc, pos, true, deps());
    const selector = result!.options.find((o) => o.label === "selector");
    const paused = result!.options.find((o) => o.label === "paused");
    expect(selector!.boost!).toBeGreaterThan(paused!.boost!);
  });

  test("fields already written sink to the bottom", async () => {
    const { doc, pos } = at(
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: w\nspec:\n  replicas: 2\n  |",
    );
    const result = await completionsFor(doc, pos, true, deps());
    const replicas = result!.options.find((o) => o.label === "replicas");
    const paused = result!.options.find((o) => o.label === "paused");
    expect(replicas!.boost!).toBeLessThan(paused!.boost!);
  });

  test("a field with a block snippet advertises it", async () => {
    const { doc, pos } = at("apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  |");
    const result = await completionsFor(doc, pos, true, deps());
    const containers = result!.options.find((o) => o.label === "containers");
    expect(containers?.snippet).toBeTruthy();
    expect(containers?.detail).toContain("block");
  });

  test("suggests conventional label keys under metadata.labels", async () => {
    const found = await labelsAt(
      "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n  labels:\n    |",
    );
    expect(found).toContain("app.kubernetes.io/name");
  });

  test("suggests conventional annotation keys under metadata.annotations", async () => {
    const found = await labelsAt(
      "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n  annotations:\n    |",
    );
    expect(found).toContain("prometheus.io/scrape");
  });

  test("stays silent while typing nothing without an explicit request", async () => {
    const { doc, pos } = at("apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  |");
    expect(await completionsFor(doc, pos, false, deps())).toBeNull();
  });

  test("responds while a prefix is being typed", async () => {
    const found = await labelsAt(
      "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  cont|",
      false,
    );
    expect(found).toContain("containers");
  });
});

describe("fallback behaviour", () => {
  test("does not offer root keys at a nested path", async () => {
    // `apiVersion` and `kind` are valid only at the document root; a schema
    // that describes nothing deeper must not resurrect them here.
    const noFields = deps({ provider: async () => EMPTY_PROVIDER });
    const found = await labelsAt(
      "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  template:\n    spec:\n      |",
      true,
      noFields,
    );
    expect(found).not.toContain("apiVersion");
    expect(found).not.toContain("kind");
  });

  test("still offers root keys at the document root", async () => {
    const noFields = deps({ provider: async () => EMPTY_PROVIDER });
    const found = await labelsAt("apiVersion: v1\nkind: Pod\n|", true, noFields);
    expect(found).toContain("metadata");
  });

  test("a rejecting provider yields no suggestions instead of throwing", async () => {
    const broken = deps({
      provider: async () => {
        throw new Error("IPC down");
      },
    });
    const { doc, pos } = at("apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  cont|");
    expect(await completionsFor(doc, pos, true, broken)).toBeNull();
  });

  test("a rejecting cluster lookup yields no suggestions instead of throwing", async () => {
    const broken = deps({
      clusterValues: async () => {
        throw new Error("list_resources failed");
      },
    });
    const { doc, pos } = at(
      "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  serviceAccountName: |",
    );
    expect(await completionsFor(doc, pos, true, broken)).toBeNull();
  });
});

describe("flush sequence style", () => {
  test("suggests container fields when the dash is at its key's column", async () => {
    const found = await labelsAt(`apiVersion: v1
kind: Pod
metadata:
  name: p
spec:
  containers:
  - name: main
    image: nginx:1
    |`);
    expect(found).toContain("imagePullPolicy");
    expect(found).not.toContain("restartPolicy");
  });

  test("suggests enum values inside a flush sequence entry", async () => {
    const found = await labelsAt(`apiVersion: v1
kind: Service
metadata:
  name: s
spec:
  ports:
  - port: 80
    protocol: |`);
    expect(found).toEqual(["TCP", "UDP", "SCTP"]);
  });
});

// ---------------------------------------------------------------------------
// Value completions
// ---------------------------------------------------------------------------
describe("value completions", () => {
  test("suggests kinds after 'kind:'", async () => {
    const found = await labelsAt("kind: |");
    expect(found).toContain("Deployment");
    expect(found).toContain("ConfigMap");
  });

  test("suggests apiVersions filtered by the declared kind", async () => {
    const found = await labelsAt("kind: Deployment\napiVersion: |");
    expect(found).toEqual(["apps/v1"]);
  });

  test("falls back to common apiVersions with no kind", async () => {
    const found = await labelsAt("apiVersion: |");
    expect(found).toContain("v1");
    expect(found).toContain("apps/v1");
  });

  test("suggests enum values for a schema enum", async () => {
    const found = await labelsAt(
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: s\nspec:\n  type: |",
    );
    expect(found).toEqual(["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"]);
  });

  test("suggests enum values inside a sequence entry", async () => {
    const found = await labelsAt(
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: s\nspec:\n  ports:\n    - port: 80\n      protocol: |",
    );
    expect(found).toEqual(["TCP", "UDP", "SCTP"]);
  });

  test("suggests true/false for a boolean field", async () => {
    const found = await labelsAt(
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\nimmutable: |",
    );
    expect(found).toEqual(["true", "false"]);
  });

  test("offers cluster names for a reference field", async () => {
    const withCluster = deps({
      clusterValues: async () => ({ values: ["app-sa", "builder-sa"], detail: "ServiceAccount" }),
    });
    const found = await labelsAt(
      "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  serviceAccountName: |",
      true,
      withCluster,
    );
    expect(found).toEqual(["app-sa", "builder-sa"]);
  });

  test("labels cluster suggestions with the referenced kind", async () => {
    const withCluster = deps({
      clusterValues: async () => ({ values: ["app-sa"], detail: "ServiceAccount" }),
    });
    const { doc, pos } = at(
      "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  serviceAccountName: |",
    );
    const result = await completionsFor(doc, pos, true, withCluster);
    expect(result!.options[0].detail).toBe("ServiceAccount");
  });

  test("returns nothing when neither schema nor cluster can help", async () => {
    const { doc, pos } = at("apiVersion: v1\nkind: Pod\nmetadata:\n  name: |");
    expect(await completionsFor(doc, pos, true, deps())).toBeNull();
  });

  test("replaces only the partially typed value", async () => {
    const { doc, pos } = at(
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: s\nspec:\n  type: Clus|",
    );
    const result = await completionsFor(doc, pos, false, deps());
    expect(doc.slice(result!.from, pos)).toBe("Clus");
  });
});

// ---------------------------------------------------------------------------
// Multi-document
// ---------------------------------------------------------------------------
describe("multi-document files", () => {
  test("uses the kind of the document under the cursor", async () => {
    const found = await labelsAt(`apiVersion: v1
kind: Pod
metadata:
  name: p
---
apiVersion: v1
kind: Service
metadata:
  name: s
spec:
  type: |`);
    expect(found).toContain("LoadBalancer");
  });
});
