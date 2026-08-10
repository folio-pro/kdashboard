import { describe, expect, test } from "bun:test";
import {
  contextAtOffset,
  documentsOf,
  keyOfLine,
  rangeOfEntry,
  rangeOfPath,
  walkPaths,
  plainValue,
  _leadingWidth as leadingWidth,
  _isSequenceItem as isSequenceItem,
  _sequenceContentColumn as sequenceContentColumn,
  _keyColonIndex as keyColonIndex,
  _sequenceIndexOf as sequenceIndexOf,
  _documentStartLine as documentStartLine,
  _documentIndexOf as documentIndexOf,
  _rootField as rootField,
} from "./yaml-ast";

/** Place the cursor at the first occurrence of `marker`, which is removed. */
function at(text: string, marker = "|"): { doc: string; pos: number } {
  const pos = text.indexOf(marker);
  if (pos === -1) throw new Error(`marker ${marker} not found`);
  return { doc: text.slice(0, pos) + text.slice(pos + marker.length), pos };
}

// ---------------------------------------------------------------------------
// Line primitives
// ---------------------------------------------------------------------------
describe("leadingWidth", () => {
  test("counts spaces", () => {
    expect(leadingWidth("    foo")).toBe(4);
  });

  test("returns 0 for unindented", () => {
    expect(leadingWidth("foo")).toBe(0);
  });

  test("counts tabs as one column each", () => {
    expect(leadingWidth("\t\tfoo")).toBe(2);
  });

  test("returns length for whitespace-only line", () => {
    expect(leadingWidth("      ")).toBe(6);
  });
});

describe("isSequenceItem", () => {
  test("detects a dash entry", () => {
    expect(isSequenceItem("  - name: x")).toBe(true);
  });

  test("detects a bare dash", () => {
    expect(isSequenceItem("  -")).toBe(true);
  });

  test("rejects a plain key", () => {
    expect(isSequenceItem("  name: x")).toBe(false);
  });

  test("rejects a negative number value", () => {
    expect(isSequenceItem("  -1")).toBe(false);
  });
});

describe("sequenceContentColumn", () => {
  test("points past the dash and space", () => {
    expect(sequenceContentColumn("  - name: x")).toBe(4);
  });

  test("handles extra spacing after the dash", () => {
    expect(sequenceContentColumn("  -   name: x")).toBe(6);
  });

  test("assumes two columns for a bare dash", () => {
    expect(sequenceContentColumn("    -")).toBe(6);
  });
});

describe("keyColonIndex", () => {
  test("finds the key colon", () => {
    expect(keyColonIndex("name: value")).toBe(4);
  });

  test("ignores a colon inside an image tag", () => {
    // `image: repo:5000/app` — only the first colon terminates a key.
    expect(keyColonIndex("image: repo:5000/app")).toBe(5);
  });

  test("returns -1 when no colon is followed by whitespace", () => {
    expect(keyColonIndex("registry:5000")).toBe(-1);
  });

  test("ignores colons inside double quotes", () => {
    expect(keyColonIndex('"a: b"')).toBe(-1);
  });

  test("ignores colons inside single quotes", () => {
    expect(keyColonIndex("'a: b'")).toBe(-1);
  });

  test("stops at a comment", () => {
    expect(keyColonIndex("# note: this")).toBe(-1);
  });

  test("accepts a trailing colon at end of line", () => {
    expect(keyColonIndex("spec:")).toBe(4);
  });
});

describe("keyOfLine", () => {
  test("reads a plain key", () => {
    expect(keyOfLine("  replicas: 3")).toBe("replicas");
  });

  test("reads a key behind a sequence dash", () => {
    expect(keyOfLine("  - name: main")).toBe("name");
  });

  test("reads a quoted key", () => {
    expect(keyOfLine('  "app.kubernetes.io/name": web')).toBe("app.kubernetes.io/name");
  });

  test("reads a dotted unquoted key", () => {
    expect(keyOfLine("  prometheus.io/scrape: 'true'")).toBe("prometheus.io/scrape");
  });

  test("returns null for a bare scalar", () => {
    expect(keyOfLine("  - nginx")).toBeNull();
  });

  test("returns null for a comment", () => {
    expect(keyOfLine("# spec: x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Document splitting
// ---------------------------------------------------------------------------
describe("documentStartLine / documentIndexOf", () => {
  const lines = ["apiVersion: v1", "kind: Pod", "---", "apiVersion: v1", "kind: Service"];

  test("first document starts at line 0", () => {
    expect(documentStartLine(lines, 1)).toBe(0);
  });

  test("second document starts after the separator", () => {
    expect(documentStartLine(lines, 4)).toBe(3);
  });

  test("indexes the first document as 0", () => {
    expect(documentIndexOf(lines, 1)).toBe(0);
  });

  test("indexes the second document as 1", () => {
    expect(documentIndexOf(lines, 4)).toBe(1);
  });

  test("a leading separator still opens document 0", () => {
    const withLead = ["---", "kind: Pod"];
    expect(documentIndexOf(withLead, 1)).toBe(0);
  });
});

describe("rootField", () => {
  const lines = ["apiVersion: apps/v1", "kind: Deployment", "spec:", "  kind: NotThis"];

  test("reads kind at root", () => {
    expect(rootField(lines, 0, "kind")).toBe("Deployment");
  });

  test("reads apiVersion at root", () => {
    expect(rootField(lines, 0, "apiVersion")).toBe("apps/v1");
  });

  test("ignores an indented same-named key", () => {
    // `spec.kind` must not shadow the root kind.
    expect(rootField(lines, 0, "kind")).not.toBe("NotThis");
  });

  test("strips quotes", () => {
    expect(rootField(['kind: "Pod"'], 0, "kind")).toBe("Pod");
  });

  test("returns null when absent", () => {
    expect(rootField(["metadata:"], 0, "kind")).toBeNull();
  });

  test("stops at the next document separator", () => {
    const multi = ["kind: Pod", "---", "kind: Service"];
    expect(rootField(multi, 0, "kind")).toBe("Pod");
  });
});

describe("sequenceIndexOf", () => {
  const lines = [
    "spec:", // 0
    "  containers:", // 1
    "    - name: a", // 2
    "      image: x", // 3
    "    - name: b", // 4
    "      image: y", // 5
  ];

  test("first entry is index 0", () => {
    expect(sequenceIndexOf(lines, 2, 4)).toBe(0);
  });

  test("second entry is index 1", () => {
    expect(sequenceIndexOf(lines, 4, 4)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cursor context — the array-path regression this module exists to fix
// ---------------------------------------------------------------------------
describe("contextAtOffset paths", () => {
  const DEPLOY = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: main
          image: nginx
          ports:
            - containerPort: 80
`;

  test("root level yields an empty path", () => {
    const { doc, pos } = at(`kind: Pod\n|`);
    expect(contextAtOffset(doc, pos).path).toEqual([]);
  });

  test("nested mapping yields its key chain", () => {
    const { doc, pos } = at(DEPLOY.replace("  replicas: 2", "  |replicas: 2"));
    expect(contextAtOffset(doc, pos).path).toEqual(["spec"]);
  });

  test("keys beside a sequence entry resolve through the entry index", () => {
    // Cursor on `image:` inside containers[0] — the old walker returned
    // ["spec","template","spec","containers"] and lost the entry entirely.
    const { doc, pos } = at(DEPLOY.replace("          image: nginx", "          |image: nginx"));
    expect(contextAtOffset(doc, pos).path).toEqual(["spec", "template", "spec", "containers", 0]);
  });

  test("a new line inside a sequence entry keeps the entry index", () => {
    const withBlank = DEPLOY.replace(
      "          image: nginx",
      "          image: nginx\n          |",
    );
    const { doc, pos } = at(withBlank);
    expect(contextAtOffset(doc, pos).path).toEqual(["spec", "template", "spec", "containers", 0]);
  });

  test("nested sequence inside a sequence entry", () => {
    const { doc, pos } = at(
      DEPLOY.replace("            - containerPort: 80", "            - |containerPort: 80"),
    );
    expect(contextAtOffset(doc, pos).path).toEqual([
      "spec",
      "template",
      "spec",
      "containers",
      0,
      "ports",
    ]);
  });

  test("a fresh dash resolves to the owning sequence key", () => {
    const withDash = DEPLOY.replace("        - name: main", "        - name: main\n        - |");
    const { doc, pos } = at(withDash);
    expect(contextAtOffset(doc, pos).path).toEqual(["spec", "template", "spec", "containers"]);
  });

  test("second container gets index 1", () => {
    const twoContainers = DEPLOY.replace(
      "          image: nginx",
      "          image: nginx\n        - name: side\n          |image: redis",
    );
    const { doc, pos } = at(twoContainers);
    expect(contextAtOffset(doc, pos).path).toEqual(["spec", "template", "spec", "containers", 1]);
  });

  test("blank lines do not break the walk", () => {
    const { doc, pos } = at("spec:\n  template:\n\n    |");
    expect(contextAtOffset(doc, pos).path).toEqual(["spec", "template"]);
  });

  test("comments do not break the walk", () => {
    const { doc, pos } = at("spec:\n  # a note\n  |");
    expect(contextAtOffset(doc, pos).path).toEqual(["spec"]);
  });
});

/**
 * YAML allows a sequence dash at its declaring key's own column, which is the
 * style most published manifests use. Every fixture in the block above indents
 * the dash one level deeper, so this style went untested — and `buildPath`
 * returned ["spec", 0], dropping the `containers` key entirely.
 */
describe("contextAtOffset with a flush sequence dash", () => {
  const FLUSH = `apiVersion: v1
kind: Pod
spec:
  containers:
  - name: main
    image: nginx
    ports:
    - containerPort: 80
  restartPolicy: Always
`;

  test("keys beside the entry keep the sequence key and index", () => {
    const { doc, pos } = at(FLUSH.replace("    image: nginx", "    |image: nginx"));
    expect(contextAtOffset(doc, pos).path).toEqual(["spec", "containers", 0]);
  });

  test("a nested flush sequence resolves through both levels", () => {
    const { doc, pos } = at(FLUSH.replace("    - containerPort: 80", "    - |containerPort: 80"));
    expect(contextAtOffset(doc, pos).path).toEqual(["spec", "containers", 0, "ports"]);
  });

  test("a fresh flush dash resolves to the owning sequence key", () => {
    const { doc, pos } = at(FLUSH.replace("  - name: main", "  - name: main\n  - |"));
    expect(contextAtOffset(doc, pos).path).toEqual(["spec", "containers"]);
  });

  test("the second flush entry gets index 1", () => {
    const withSecond = FLUSH.replace(
      "    image: nginx",
      "    image: nginx\n  - name: side\n    |image: redis",
    );
    const { doc, pos } = at(withSecond);
    expect(contextAtOffset(doc, pos).path).toEqual(["spec", "containers", 1]);
  });

  test("a sibling after the sequence returns to the parent mapping", () => {
    const { doc, pos } = at(FLUSH.replace("  restartPolicy", "  |restartPolicy"));
    expect(contextAtOffset(doc, pos).path).toEqual(["spec"]);
  });

  test("a new line at the entry's indent stays inside the entry", () => {
    const { doc, pos } = at(FLUSH.replace("    image: nginx", "    image: nginx\n    |"));
    expect(contextAtOffset(doc, pos).path).toEqual(["spec", "containers", 0]);
  });
});

describe("contextAtOffset key/value position", () => {
  test("before any colon the cursor is on the key side", () => {
    const { doc, pos } = at("spec:\n  repl|");
    expect(contextAtOffset(doc, pos).isKey).toBe(true);
  });

  test("after the colon the cursor is on the value side", () => {
    const { doc, pos } = at("spec:\n  replicas: |");
    const ctx = contextAtOffset(doc, pos);
    expect(ctx.isKey).toBe(false);
    expect(ctx.currentKey).toBe("replicas");
  });

  test("a colon inside a value does not flip the position back to key", () => {
    const { doc, pos } = at("spec:\n  image: nginx:1.2|");
    const ctx = contextAtOffset(doc, pos);
    expect(ctx.isKey).toBe(false);
    expect(ctx.currentKey).toBe("image");
  });

  test("value side inside a sequence entry reports its key", () => {
    const { doc, pos } = at("ports:\n  - protocol: |");
    expect(contextAtOffset(doc, pos).currentKey).toBe("protocol");
  });
});

describe("contextAtOffset document awareness", () => {
  const MULTI = `apiVersion: v1
kind: Pod
metadata:
  name: a
---
apiVersion: v1
kind: Service
spec:
  type: |
`;

  test("reads the kind of the document under the cursor", () => {
    const { doc, pos } = at(MULTI);
    const ctx = contextAtOffset(doc, pos);
    expect(ctx.kind).toBe("Service");
  });

  test("reports the document index", () => {
    const { doc, pos } = at(MULTI);
    expect(contextAtOffset(doc, pos).docIndex).toBe(1);
  });

  test("the path does not leak across the separator", () => {
    const { doc, pos } = at(MULTI);
    expect(contextAtOffset(doc, pos).path).toEqual(["spec"]);
  });

  test("reads apiVersion of the containing document", () => {
    const { doc, pos } = at(MULTI);
    expect(contextAtOffset(doc, pos).apiVersion).toBe("v1");
  });
});

describe("contextAtOffset robustness", () => {
  test("empty document", () => {
    const ctx = contextAtOffset("", 0);
    expect(ctx.path).toEqual([]);
    expect(ctx.kind).toBeNull();
  });

  test("position past the end is clamped", () => {
    expect(() => contextAtOffset("kind: Pod", 9999)).not.toThrow();
  });

  test("negative position is clamped", () => {
    expect(() => contextAtOffset("kind: Pod", -5)).not.toThrow();
  });

  test("half-typed key does not throw", () => {
    const { doc, pos } = at("spec:\n  containers:\n    - na|");
    expect(() => contextAtOffset(doc, pos)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Source ranges
// ---------------------------------------------------------------------------
describe("rangeOfPath", () => {
  const DOC = `kind: Service
spec:
  ports:
    - name: http
      protocol: TCP
    - name: https
      protocol: BOGUS
`;

  test("anchors the second occurrence, not the first regex match", () => {
    // The regression this replaces: `protocol` appears twice and the old
    // regex-based locator always underlined the first one.
    const doc = documentsOf(DOC)[0];
    const range = rangeOfPath(doc, ["spec", "ports", 1, "protocol"]);
    expect(range).not.toBeNull();
    expect(DOC.slice(range!.from, range!.to)).toBe("BOGUS");
  });

  test("resolves the first entry independently", () => {
    const doc = documentsOf(DOC)[0];
    const range = rangeOfPath(doc, ["spec", "ports", 0, "protocol"]);
    expect(DOC.slice(range!.from, range!.to)).toBe("TCP");
  });

  test("target 'key' underlines the field name", () => {
    const doc = documentsOf(DOC)[0];
    const range = rangeOfPath(doc, ["spec", "ports", 1, "protocol"], "key");
    expect(DOC.slice(range!.from, range!.to)).toBe("protocol");
  });

  test("resolves a top-level scalar", () => {
    const doc = documentsOf(DOC)[0];
    const range = rangeOfPath(doc, ["kind"]);
    expect(DOC.slice(range!.from, range!.to)).toBe("Service");
  });

  test("returns null for a missing path", () => {
    const doc = documentsOf(DOC)[0];
    expect(rangeOfPath(doc, ["spec", "nope"])).toBeNull();
  });

  test("returns null for an out-of-range index", () => {
    const doc = documentsOf(DOC)[0];
    expect(rangeOfPath(doc, ["spec", "ports", 9, "protocol"])).toBeNull();
  });

  test("a key with no value falls back to the key range", () => {
    const empty = "metadata:\n";
    const doc = documentsOf(empty)[0];
    const range = rangeOfPath(doc, ["metadata"]);
    expect(range).not.toBeNull();
  });
});

describe("rangeOfEntry", () => {
  const DOC = "spec:\n  replicas: 3\n";

  test("spans key and value", () => {
    const doc = documentsOf(DOC)[0];
    const range = rangeOfEntry(doc, ["spec", "replicas"]);
    expect(DOC.slice(range!.from, range!.to)).toBe("replicas: 3");
  });
});

describe("walkPaths", () => {
  test("visits nested mapping and sequence paths", () => {
    const DOC = "spec:\n  ports:\n    - port: 80\n    - port: 443\n";
    const doc = documentsOf(DOC)[0];
    const seen: string[] = [];
    walkPaths(doc.contents, (path) => seen.push(path.join(".")));
    expect(seen).toContain("spec");
    expect(seen).toContain("spec.ports");
    expect(seen).toContain("spec.ports.0");
    expect(seen).toContain("spec.ports.1.port");
  });

  test("yields the plain value of each leaf", () => {
    const doc = documentsOf("replicas: 3\n")[0];
    const values: unknown[] = [];
    walkPaths(doc.contents, (_p, v) => values.push(plainValue(v)));
    expect(values).toContain(3);
  });
});

describe("documentsOf", () => {
  test("splits a multi-document file", () => {
    expect(documentsOf("kind: Pod\n---\nkind: Service\n")).toHaveLength(2);
  });

  test("preserves syntax errors on the document", () => {
    const docs = documentsOf("spec:\n\tbad: 1\n");
    expect(docs[0].errors.length).toBeGreaterThan(0);
  });
});
