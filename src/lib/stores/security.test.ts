import { describe, expect, test, beforeEach } from "bun:test";
import { SecurityStoreLogic } from "./security.logic";

describe("SecurityStore", () => {
  let store: SecurityStoreLogic;

  beforeEach(() => {
    store = new SecurityStoreLogic();
  });

  test("starts with null overview", () => {
    expect(store.overview).toBeNull();
    expect(store.data).toBeNull();
    expect(store.isLoading).toBe(false);
    expect(store.error).toBeNull();
  });

  test("overview getter aliases data", () => {
    const mockData = { total_pods: 10, scanned_pods: 5, pods: [] };
    store.data = mockData as any;
    expect(store.overview as unknown).toBe(mockData);
  });

  test("reset clears all state and increments loadId", () => {
    store.data = { total_pods: 10, scanned_pods: 5, pods: [] } as any;
    store.isLoading = true;
    store.error = "scan failed";

    const prevLoadId = (store as any)._loadId;
    store.reset();

    expect(store.overview).toBeNull();
    expect(store.data).toBeNull();
    expect(store.isLoading).toBe(false);
    expect(store.error).toBeNull();
    expect((store as any)._loadId).toBe(prevLoadId + 1);
  });

  test("reset increments loadId for stale request detection", () => {
    store.reset();
    store.reset();
    store.reset();
    expect((store as any)._loadId).toBe(3);
  });
});
