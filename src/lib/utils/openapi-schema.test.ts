import { describe, expect, test } from "bun:test";

import {
  deref,
  fieldAtPath,
  fieldsAtPath,
  nodeAtPath,
  type OpenApiSchema,
  type OpenApiSchemaResult,
} from "./openapi-schema";

const ref = (name: string): OpenApiSchema => ({ $ref: `#/components/schemas/${name}` });

/** A trimmed stand-in for the apps/v1 group document. */
const SCHEMAS: Record<string, OpenApiSchema> = {
  Deployment: {
    type: "object",
    required: ["spec"],
    properties: {
      apiVersion: { type: "string", description: "APIVersion defines the versioned schema." },
      kind: { type: "string" },
      metadata: ref("ObjectMeta"),
      spec: ref("DeploymentSpec"),
    },
  },
  DeploymentSpec: {
    type: "object",
    required: ["selector", "template"],
    properties: {
      replicas: { type: "integer", format: "int32", description: "Number of desired pods." },
      paused: { type: "boolean" },
      template: ref("PodTemplateSpec"),
      strategy: {
        // The apiserver emits this shape for an annotated reference.
        allOf: [ref("DeploymentStrategy")],
        description: "The deployment strategy to use.",
      },
    },
  },
  DeploymentStrategy: {
    type: "object",
    properties: { type: { type: "string", enum: ["Recreate", "RollingUpdate"] } },
  },
  PodTemplateSpec: {
    type: "object",
    properties: { spec: ref("PodSpec") },
  },
  PodSpec: {
    type: "object",
    required: ["containers"],
    properties: {
      containers: { type: "array", items: ref("Container") },
      restartPolicy: { type: "string", enum: ["Always", "OnFailure", "Never"] },
    },
  },
  Container: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      image: { type: "string", description: "Container image name. More info: somewhere." },
      ports: { type: "array", items: ref("ContainerPort") },
    },
  },
  ContainerPort: {
    type: "object",
    properties: {
      containerPort: { type: "integer" },
      protocol: { type: "string", enum: ["TCP", "UDP", "SCTP"] },
    },
  },
  ObjectMeta: {
    type: "object",
    properties: {
      name: { type: "string" },
      labels: { type: "object", additionalProperties: { type: "string" } },
    },
  },
};

const RESULT: OpenApiSchemaResult = {
  available: true,
  root: "Deployment",
  schemas: SCHEMAS,
  reason: null,
};

const UNAVAILABLE: OpenApiSchemaResult = {
  available: false,
  root: null,
  schemas: {},
  reason: "mocked",
};

// ---------------------------------------------------------------------------
// deref
// ---------------------------------------------------------------------------
describe("deref", () => {
  test("follows a $ref", () => {
    expect(deref(ref("PodSpec"), SCHEMAS)?.required).toEqual(["containers"]);
  });

  test("returns a concrete node unchanged", () => {
    const node: OpenApiSchema = { type: "string" };
    expect(deref(node, SCHEMAS)).toBe(node);
  });

  test("resolves the single-ref allOf form", () => {
    const resolved = deref(SCHEMAS.DeploymentSpec.properties!.strategy, SCHEMAS);
    expect(resolved?.type).toBe("object");
    expect(resolved?.properties?.type.enum).toEqual(["Recreate", "RollingUpdate"]);
  });

  test("keeps the sibling description when merging allOf", () => {
    const resolved = deref(SCHEMAS.DeploymentSpec.properties!.strategy, SCHEMAS);
    expect(resolved?.description).toBe("The deployment strategy to use.");
  });

  test("returns undefined for a dangling ref", () => {
    expect(deref(ref("Missing"), SCHEMAS)).toBeUndefined();
  });

  test("terminates on a self-referential ref chain", () => {
    const cyclic: Record<string, OpenApiSchema> = { A: ref("A") };
    expect(() => deref(ref("A"), cyclic)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// nodeAtPath
// ---------------------------------------------------------------------------
describe("nodeAtPath", () => {
  test("resolves the root", () => {
    expect(nodeAtPath(RESULT, [])?.required).toEqual(["spec"]);
  });

  test("descends through refs", () => {
    expect(nodeAtPath(RESULT, ["spec", "replicas"])?.type).toBe("integer");
  });

  test("descends through an array index into the item schema", () => {
    const node = nodeAtPath(RESULT, ["spec", "template", "spec", "containers", 0]);
    expect(node?.required).toEqual(["name"]);
  });

  test("descends into a field of an array item", () => {
    const node = nodeAtPath(RESULT, ["spec", "template", "spec", "containers", 0, "image"]);
    expect(node?.type).toBe("string");
  });

  test("treats a key on an array as a key on its items", () => {
    // The cursor may sit on a fresh `- ` with no index yet.
    const node = nodeAtPath(RESULT, ["spec", "template", "spec", "containers", "image"]);
    expect(node?.type).toBe("string");
  });

  test("resolves an open map through additionalProperties", () => {
    expect(nodeAtPath(RESULT, ["metadata", "labels", "anything"])?.type).toBe("string");
  });

  test("returns undefined for an unknown path", () => {
    expect(nodeAtPath(RESULT, ["spec", "nope"])).toBeUndefined();
  });

  test("returns undefined when the schema is unavailable", () => {
    expect(nodeAtPath(UNAVAILABLE, ["spec"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fieldsAtPath
// ---------------------------------------------------------------------------
describe("fieldsAtPath", () => {
  test("lists the root fields", () => {
    const fields = fieldsAtPath(RESULT, [])!;
    expect(Object.keys(fields).sort()).toEqual(["apiVersion", "kind", "metadata", "spec"]);
  });

  test("marks required fields", () => {
    expect(fieldsAtPath(RESULT, [])!.spec.required).toBe(true);
  });

  test("leaves optional fields unmarked", () => {
    expect(fieldsAtPath(RESULT, [])!.kind.required).toBeUndefined();
  });

  test("maps integer onto the number type", () => {
    expect(fieldsAtPath(RESULT, ["spec"])!.replicas.type).toBe("number");
  });

  test("carries the description across", () => {
    expect(fieldsAtPath(RESULT, ["spec"])!.replicas.desc).toContain("desired pods");
  });

  test("lists the fields of an array item", () => {
    const fields = fieldsAtPath(RESULT, ["spec", "template", "spec", "containers", 0])!;
    expect(Object.keys(fields).sort()).toEqual(["image", "name", "ports"]);
  });

  test("lists item fields for a bare array path", () => {
    const fields = fieldsAtPath(RESULT, ["spec", "template", "spec", "containers"])!;
    expect(fields.image).toBeDefined();
  });

  test("marks an array item's required field", () => {
    const fields = fieldsAtPath(RESULT, ["spec", "template", "spec", "containers", 0])!;
    expect(fields.name.required).toBe(true);
  });

  test("returns null for an unknown path", () => {
    expect(fieldsAtPath(RESULT, ["spec", "nope"])).toBeNull();
  });

  test("returns null for a leaf with no properties", () => {
    expect(fieldsAtPath(RESULT, ["spec", "replicas"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fieldAtPath
// ---------------------------------------------------------------------------
describe("fieldAtPath", () => {
  test("resolves an enum on a nested field", () => {
    const field = fieldAtPath(RESULT, ["spec", "template", "spec", "restartPolicy"]);
    expect(field?.enum).toEqual(["Always", "OnFailure", "Never"]);
  });

  test("resolves an enum inside an array item", () => {
    const path = ["spec", "template", "spec", "containers", 0, "ports", 1, "protocol"];
    expect(fieldAtPath(RESULT, path)?.enum).toEqual(["TCP", "UDP", "SCTP"]);
  });

  test("reports a boolean type", () => {
    expect(fieldAtPath(RESULT, ["spec", "paused"])?.type).toBe("boolean");
  });

  test("reports required from the parent's required list", () => {
    expect(fieldAtPath(RESULT, ["spec", "template"])?.required).toBe(true);
  });

  test("returns null for the empty path", () => {
    expect(fieldAtPath(RESULT, [])).toBeNull();
  });

  test("returns null for an unknown field", () => {
    expect(fieldAtPath(RESULT, ["spec", "nope"])).toBeNull();
  });
});
