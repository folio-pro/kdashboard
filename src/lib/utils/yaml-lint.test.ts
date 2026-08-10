import { describe, expect, test } from "bun:test";

import type { SchemaField } from "./k8s-schema-fields";
import { _staticProvider as staticProvider, type SchemaProvider } from "./schema-provider";
import {
  lintYaml,
  _typeMismatch as typeMismatch,
  _isQuantityPath as isQuantityPath,
  _isServerOwned as isServerOwned,
  _QUANTITY as QUANTITY,
  _DNS_1123_SUBDOMAIN as DNS_1123,
} from "./yaml-lint";
import type { PathSegment } from "./yaml-ast";

const NOTHING: SchemaProvider = {
  kind: null,
  source: "none",
  authoritative: false,
  fieldsAt: () => null,
  fieldAt: () => null,
};

/** Always answer from the static table, whatever kind is asked for. */
const useStatic = (kind: string | null) => (kind ? staticProvider(kind) : NOTHING);

/**
 * A complete (authoritative) schema built from a nested literal, standing in for
 * a cluster OpenAPI document.
 */
function authoritative(kind: string, tree: Record<string, SchemaField>): SchemaProvider {
  function walk(path: PathSegment[]): Record<string, SchemaField> | null {
    let current: Record<string, SchemaField> | undefined = tree;
    for (const segment of path) {
      if (typeof segment === "number") continue;
      const field: SchemaField | undefined = current?.[segment];
      if (!field) return null;
      current = field.children ?? field.items?.children;
      if (!current) return null;
    }
    return current ?? null;
  }

  return {
    kind,
    source: "openapi",
    authoritative: true,
    fieldsAt: walk,
    fieldAt(path) {
      if (path.length === 0) return null;
      const key = path[path.length - 1];
      if (typeof key !== "string") return null;
      return walk(path.slice(0, -1))?.[key] ?? null;
    },
  };
}

const messages = (text: string, lookup = useStatic) => lintYaml(text, lookup).map((d) => d.message);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("typeMismatch", () => {
  test("accepts a matching boolean", () => {
    expect(typeMismatch({ type: "boolean" }, true)).toBeNull();
  });

  test("rejects a string where a boolean is expected", () => {
    expect(typeMismatch({ type: "boolean" }, "true")).toContain("boolean");
  });

  test("flags a quoted number with actionable wording", () => {
    expect(typeMismatch({ type: "number" }, "3")).toContain("remove the quotes");
  });

  test("accepts a real number", () => {
    expect(typeMismatch({ type: "number" }, 3)).toBeNull();
  });

  test("rejects a non-numeric string for a number", () => {
    expect(typeMismatch({ type: "number" }, "many")).toContain("Expected a number");
  });

  test("never flags an IntOrString field", () => {
    // `targetPort` and `maxSurge` accept both 8080 and "http".
    expect(typeMismatch({ type: "any" }, "http")).toBeNull();
    expect(typeMismatch({ type: "any" }, 8080)).toBeNull();
  });

  test("ignores null values", () => {
    expect(typeMismatch({ type: "number" }, null)).toBeNull();
  });

  test("rejects a mapping where a list is expected", () => {
    expect(typeMismatch({ type: "array" }, { a: 1 })).toContain("Expected a list");
  });

  test("rejects a list where a mapping is expected", () => {
    expect(typeMismatch({ type: "object" }, [1])).toContain("Expected a mapping");
  });
});

describe("QUANTITY", () => {
  // Binary suffixes use a capital K (`Ki`) while decimal ones use a lowercase k.
  // Testing only Mi and Gi hid a regex that rejected every `Ki`.
  test.each([
    "100m",
    "1",
    "0.5",
    "512Ki",
    "512Mi",
    "2Gi",
    "4Ti",
    "1Pi",
    "1Ei",
    "1500M",
    "3k",
    "1e3",
    "250n",
    "10u",
  ])("accepts %s", (v: string) => {
    expect(QUANTITY.test(v)).toBe(true);
  });

  test.each(["1 Gi", "abc", "10Gib", "", "Mi", "1ki", "5KI", "2gi", "1K"])(
    "rejects %s",
    (v: string) => {
      expect(QUANTITY.test(v)).toBe(false);
    },
  );
});

describe("DNS_1123_SUBDOMAIN", () => {
  test.each(["web", "web-1", "my.app", "a", "a1"])("accepts %s", (v: string) => {
    expect(DNS_1123.test(v)).toBe(true);
  });

  test.each(["Web", "-web", "web-", "web_1", "we b"])("rejects %s", (v: string) => {
    expect(DNS_1123.test(v)).toBe(false);
  });
});

describe("isQuantityPath", () => {
  test("matches a limits entry", () => {
    expect(isQuantityPath(["spec", "resources", "limits", "cpu"])).toBe(true);
  });

  test("matches a requests entry", () => {
    expect(isQuantityPath(["resources", "requests", "memory"])).toBe(true);
  });

  test("does not match an unrelated limits key", () => {
    expect(isQuantityPath(["spec", "other", "limits", "cpu"])).toBe(false);
  });
});

describe("isServerOwned", () => {
  test("skips the status subtree", () => {
    expect(isServerOwned(["status", "phase"])).toBe(true);
  });

  test("skips metadata.uid", () => {
    expect(isServerOwned(["metadata", "uid"])).toBe(true);
  });

  test("does not skip metadata.name", () => {
    expect(isServerOwned(["metadata", "name"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Syntax
// ---------------------------------------------------------------------------
describe("syntax diagnostics", () => {
  test("empty document produces nothing", () => {
    expect(lintYaml("")).toEqual([]);
  });

  test("whitespace-only document produces nothing", () => {
    expect(lintYaml("   \n  \n")).toEqual([]);
  });

  test("reports a tab used as indentation", () => {
    const found = lintYaml("kind: Pod\nspec:\n\tx: 1\n", useStatic);
    expect(found.some((d) => d.severity === "error" && /[Tt]ab/.test(d.message))).toBe(true);
  });

  test("anchors a syntax error inside the second document", () => {
    const text = "kind: Pod\n---\nspec:\n\tx: 1\n";
    const error = lintYaml(text, useStatic).find((d) => d.severity === "error");
    expect(error).toBeDefined();
    // Absolute offsets: the tab lives past the `---` separator.
    expect(error!.from).toBeGreaterThan(text.indexOf("---"));
  });

  test("skips schema checks for a document that failed to parse", () => {
    const found = lintYaml("kind: Pod\nspec:\n\tx: 1\n", useStatic);
    expect(found.every((d) => d.source !== "k8s" || d.severity === "error")).toBe(true);
  });

  test("ranges never exceed the document", () => {
    const text = "kind: Pod\nspec:\n\tx: 1\n";
    for (const d of lintYaml(text, useStatic)) {
      expect(d.from).toBeGreaterThanOrEqual(0);
      expect(d.to).toBeLessThanOrEqual(text.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Anchoring — the regression this rewrite exists for
// ---------------------------------------------------------------------------
describe("diagnostic anchoring", () => {
  const SERVICE = `apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  ports:
    - name: http
      protocol: TCP
    - name: https
      protocol: BOGUS
`;

  test("underlines the offending occurrence, not the first one", () => {
    const found = lintYaml(SERVICE, useStatic).filter((d) => d.message.includes("BOGUS"));
    expect(found).toHaveLength(1);
    expect(SERVICE.slice(found[0].from, found[0].to)).toBe("BOGUS");
  });

  test("does not flag the valid sibling", () => {
    expect(messages(SERVICE).some((m) => m.includes("'TCP'"))).toBe(false);
  });

  test("names the expected values", () => {
    const message = messages(SERVICE).find((m) => m.includes("BOGUS"));
    expect(message).toContain("TCP");
    expect(message).toContain("SCTP");
  });
});

// ---------------------------------------------------------------------------
// Schema checks
// ---------------------------------------------------------------------------
describe("document-level checks", () => {
  test("reports a missing kind", () => {
    expect(messages("apiVersion: v1\nmetadata:\n  name: x\n")).toContain("Missing 'kind' field");
  });

  test("reports a missing apiVersion", () => {
    expect(messages("kind: Pod\nmetadata:\n  name: x\n")).toContain("Missing 'apiVersion' field");
  });

  test("reports an apiVersion that does not match the kind", () => {
    const found = messages("apiVersion: v1\nkind: Deployment\nmetadata:\n  name: x\n");
    expect(found.some((m) => m.includes("Unexpected apiVersion"))).toBe(true);
  });

  test("accepts the correct apiVersion", () => {
    const found = messages("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n");
    expect(found.some((m) => m.includes("Unexpected apiVersion"))).toBe(false);
  });

  test("reports a missing required field", () => {
    const found = messages("apiVersion: v1\nkind: Pod\nmetadata:\n  name: x\n");
    expect(found.some((m) => m.includes("Missing required field: 'spec'"))).toBe(true);
  });

  test("says nothing about an unknown kind", () => {
    expect(messages("apiVersion: v1\nkind: TotallyMadeUp\nmetadata:\n  name: x\n")).toEqual([]);
  });
});

describe("metadata.name validation", () => {
  const withName = (name: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n`;

  test("accepts a valid name", () => {
    expect(messages(withName("web-1")).some((m) => m.includes("not a valid name"))).toBe(false);
  });

  test("rejects uppercase", () => {
    expect(messages(withName("Web")).some((m) => m.includes("not a valid name"))).toBe(true);
  });

  test("rejects an underscore", () => {
    expect(messages(withName("my_app")).some((m) => m.includes("not a valid name"))).toBe(true);
  });

  test("underlines the name itself", () => {
    const text = withName("Web");
    const found = lintYaml(text, useStatic).find((d) => d.message.includes("not a valid name"));
    expect(text.slice(found!.from, found!.to)).toBe("Web");
  });

  test("rejects an over-long name", () => {
    const long = "a".repeat(254);
    expect(messages(withName(long)).some((m) => m.includes("exceeds 253"))).toBe(true);
  });
});

describe("container checks", () => {
  const pod = (image: string, cpu = "100m") => `apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  containers:
    - name: main
      image: ${image}
      resources:
        limits:
          cpu: ${cpu}
`;

  test("flags an untagged image", () => {
    expect(messages(pod("nginx")).some((m) => m.includes("no tag"))).toBe(true);
  });

  test("accepts a tagged image", () => {
    expect(messages(pod("nginx:1.27")).some((m) => m.includes("no tag"))).toBe(false);
  });

  test("accepts a digest-pinned image", () => {
    expect(messages(pod("nginx@sha256:abc")).some((m) => m.includes("no tag"))).toBe(false);
  });

  test("accepts a registry with a port and a tag", () => {
    expect(messages(pod("registry:5000/app:1.0")).some((m) => m.includes("no tag"))).toBe(false);
  });

  test("flags a malformed quantity", () => {
    expect(
      messages(pod("nginx:1", "'100 m'")).some((m) => m.includes("not a valid quantity")),
    ).toBe(true);
  });

  test("accepts a well-formed quantity", () => {
    expect(messages(pod("nginx:1", "250m")).some((m) => m.includes("not a valid quantity"))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Unknown fields — authoritative sources only
// ---------------------------------------------------------------------------
describe("unknown fields", () => {
  const TREE: Record<string, SchemaField> = {
    apiVersion: { type: "string" },
    kind: { type: "string" },
    metadata: {
      type: "object",
      children: {
        name: { type: "string" },
        uid: { type: "string" },
        resourceVersion: { type: "string" },
      },
    },
    spec: { type: "object", children: { replicas: { type: "number" } } },
    status: { type: "object", children: { phase: { type: "string" } } },
  };

  const DOC = `apiVersion: v1
kind: Widget
metadata:
  name: demo
spec:
  replicas: 2
  bogusField: true
`;

  test("an authoritative schema reports the unknown field", () => {
    const found = messages(DOC, () => authoritative("Widget", TREE));
    expect(found.some((m) => m.includes("Unknown field 'bogusField'"))).toBe(true);
  });

  test("the static table stays silent about unknown fields", () => {
    const found = messages(DOC, () => ({ ...authoritative("Widget", TREE), authoritative: false }));
    expect(found.some((m) => m.includes("Unknown field"))).toBe(false);
  });

  test("known fields are not reported", () => {
    const found = messages(DOC, () => authoritative("Widget", TREE));
    expect(found.some((m) => m.includes("'replicas'"))).toBe(false);
  });

  test("the unknown key is underlined, not its value", () => {
    const found = lintYaml(DOC, () => authoritative("Widget", TREE)).find((d) =>
      d.message.includes("Unknown field"),
    );
    expect(DOC.slice(found!.from, found!.to)).toBe("bogusField");
  });

  test("server-owned status fields are never reported", () => {
    const withStatus = `${DOC}status:\n  phase: Running\n`;
    const found = messages(withStatus, () => authoritative("Widget", TREE));
    expect(found.some((m) => m.includes("Unknown field"))).toBe(true); // bogusField only
    expect(found.filter((m) => m.includes("Unknown field"))).toHaveLength(1);
  });

  test("server-owned metadata fields are never reported", () => {
    const withUid = `apiVersion: v1
kind: Widget
metadata:
  name: demo
  uid: 11111111-2222-3333-4444-555555555555
  resourceVersion: "12345"
spec:
  replicas: 1
`;
    const found = messages(withUid, () => authoritative("Widget", TREE));
    expect(found.some((m) => m.includes("Unknown field"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ordering and multi-document
// ---------------------------------------------------------------------------
describe("output shape", () => {
  test("diagnostics come back in document order", () => {
    const text = `apiVersion: v1
kind: Service
metadata:
  name: BAD_NAME
spec:
  ports:
    - protocol: NOPE
`;
    const found = lintYaml(text, useStatic);
    const offsets = found.map((d) => d.from);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  test("validates every document in a multi-document file", () => {
    const text = `apiVersion: v1
kind: ConfigMap
metadata:
  name: Bad1
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: Bad2
`;
    const found = messages(text).filter((m) => m.includes("not a valid name"));
    expect(found).toHaveLength(2);
  });

  test("the second document's diagnostic points past the separator", () => {
    const text = `apiVersion: v1
kind: ConfigMap
metadata:
  name: ok
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: Bad2
`;
    const found = lintYaml(text, useStatic).find((d) => d.message.includes("not a valid name"));
    expect(text.slice(found!.from, found!.to)).toBe("Bad2");
  });
});
