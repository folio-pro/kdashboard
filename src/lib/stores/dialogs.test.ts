import { describe, expect, test, beforeEach } from "bun:test";
import type { Resource } from "../types/index.js";
import { DialogStoreLogic } from "./dialogs.logic";

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    kind: overrides.kind ?? "Deployment",
    api_version: "apps/v1",
    metadata: {
      name: overrides.metadata?.name ?? "my-app",
      namespace: overrides.metadata?.namespace ?? "default",
      uid: "uid-1",
      creation_timestamp: "2024-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: overrides.spec ?? { replicas: 3 },
    status: overrides.status ?? {},
  };
}

describe("DialogStore", () => {
  let store: DialogStoreLogic;

  beforeEach(() => {
    store = new DialogStoreLogic();
  });

  // --- Initial state ---

  test("starts with all dialogs closed", () => {
    expect(store.scaleOpen).toBe(false);
    expect(store.scaleResource).toBeNull();
    expect(store.deleteOpen).toBe(false);
    expect(store.deleteResource).toBeNull();
    expect(store.upsellOpen).toBe(false);
  });

  // --- Scale dialog ---

  test("openScale sets scaleOpen and extracts resource data", () => {
    const resource = makeResource({ spec: { replicas: 5 } });
    store.openScale(resource);

    expect(store.scaleOpen).toBe(true);
    expect(store.scaleResource).toEqual({
      kind: "Deployment",
      name: "my-app",
      namespace: "default",
      currentReplicas: 5,
    });
  });

  test("openScale defaults replicas to 0 when missing", () => {
    const resource = makeResource({ spec: {} });
    store.openScale(resource);

    expect(store.scaleResource?.currentReplicas).toBe(0);
  });

  test("openScale handles missing namespace", () => {
    const resource = makeResource();
    resource.metadata.namespace = undefined as unknown as string;
    store.openScale(resource);

    expect(store.scaleResource?.namespace).toBe("");
  });

  test("closeScale resets all scale state", () => {
    store.openScale(makeResource());
    store.closeScale();

    expect(store.scaleOpen).toBe(false);
    expect(store.scaleResource).toBeNull();
  });

  // --- Delete dialog ---

  test("openDelete sets deleteOpen and stores resource", () => {
    const resource = makeResource();
    store.openDelete(resource);

    expect(store.deleteOpen).toBe(true);
    expect(store.deleteResource).toBe(resource);
  });

  test("closeDelete resets all delete state", () => {
    store.openDelete(makeResource());
    store.closeDelete();

    expect(store.deleteOpen).toBe(false);
    expect(store.deleteResource).toBeNull();
  });

  // --- Upsell dialog ---

  test("openUpsell sets upsellOpen", () => {
    store.openUpsell();
    expect(store.upsellOpen).toBe(true);
  });

  test("closeUpsell resets upsellOpen", () => {
    store.openUpsell();
    store.closeUpsell();
    expect(store.upsellOpen).toBe(false);
  });

  // --- Independence ---

  test("dialogs are independent", () => {
    store.openScale(makeResource());
    store.openDelete(makeResource());
    store.openUpsell();

    expect(store.scaleOpen).toBe(true);
    expect(store.deleteOpen).toBe(true);
    expect(store.upsellOpen).toBe(true);

    store.closeScale();
    expect(store.deleteOpen).toBe(true);
    expect(store.upsellOpen).toBe(true);
  });

  // --- Reopening ---

  test("opening scale twice overwrites previous resource", () => {
    store.openScale(makeResource({ metadata: { name: "app-1" } as Resource["metadata"] }));
    const second = makeResource({ metadata: { name: "app-2" } as Resource["metadata"] });
    store.openScale(second);

    expect(store.scaleResource?.name).toBe("app-2");
  });
});
