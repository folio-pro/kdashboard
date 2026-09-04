import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import { podSecretRefs } from "./pod-secret-refs";

function pod(spec: Record<string, unknown>): Resource {
  return {
    kind: "Pod",
    api_version: "v1",
    metadata: {
      name: "web",
      namespace: "shop",
      uid: "u",
      creation_timestamp: "2026-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec,
    status: {},
  };
}

describe("podSecretRefs", () => {
  test("collects every way a pod can name a Secret, deduplicated, in first-seen order", () => {
    const refs = podSecretRefs(
      pod({
        imagePullSecrets: [{ name: "regcred" }],
        volumes: [
          { name: "tls", secret: { secretName: "web-tls" } },
          { name: "cfg", configMap: { name: "web-config" } },
          { name: "proj", projected: { sources: [{ secret: { name: "sa-token" } }, { configMap: { name: "ca" } }] } },
        ],
        initContainers: [{ name: "init", env: [{ name: "PW", valueFrom: { secretKeyRef: { name: "db-creds", key: "password" } } }] }],
        containers: [
          {
            name: "app",
            envFrom: [{ secretRef: { name: "app-env" } }, { configMapRef: { name: "app-config" } }],
            env: [
              { name: "PLAIN", value: "x" },
              { name: "TOKEN", valueFrom: { secretKeyRef: { name: "db-creds", key: "token" } } },
              { name: "FROM_CM", valueFrom: { configMapKeyRef: { name: "app-config", key: "k" } } },
            ],
          },
        ],
        ephemeralContainers: [{ name: "debug", envFrom: [{ secretRef: { name: "debug-env" } }] }],
      }),
    );
    expect(refs).toEqual(["regcred", "web-tls", "sa-token", "db-creds", "app-env", "debug-env"]);
  });

  test("a pod with no secrets yields nothing, and malformed entries are skipped", () => {
    expect(podSecretRefs(pod({}))).toEqual([]);
    expect(
      podSecretRefs(pod({ imagePullSecrets: [{}], volumes: [{ secret: {} }], containers: [{ env: [{ valueFrom: {} }], envFrom: [{}] }] })),
    ).toEqual([]);
  });
});
