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

// ---------------------------------------------------------------------------
// Scanned vs not scanned
// ---------------------------------------------------------------------------

import { podScanLabel, podScanState, podScanSummary } from "./security.logic";
import type { ImageScanResult, PodSecurityInfo } from "$lib/types";

const zero = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };

function pod(images: ImageScanResult[], unscanned: string[] = [], vulns: Partial<typeof zero> = {}): PodSecurityInfo {
  return { name: "p", namespace: "ns", images, unscanned_images: unscanned, total_vulns: { ...zero, ...vulns }, compliant: true };
}

function img(image: string, status?: "scanned" | "failed"): ImageScanResult {
  return { image, vulns: { ...zero }, scanned_at: "t", status };
}

describe("podScanSummary", () => {
  test("no scanner: every image is missing and the row says Not scanned", () => {
    const s = podScanSummary(pod([], ["nginx", "sidecar"]));
    expect(s).toEqual({ scanned: 0, missing: 2, failed: false, vulns: 0 });
    expect(podScanState(s)).toBe("unscanned");
    expect(podScanLabel(s)).toEqual({ text: "Not scanned", tone: "muted" });
  });

  test("every scan failed reads Scan failed, not clean", () => {
    const s = podScanSummary(pod([img("nginx", "failed")]));
    expect(podScanState(s)).toBe("failed");
    expect(podScanLabel(s)?.text).toBe("Scan failed");
  });

  test("scanned clean is the only green outcome", () => {
    const s = podScanSummary(pod([img("nginx", "scanned")]));
    expect(podScanState(s)).toBe("clean");
    expect(podScanLabel(s)).toEqual({ text: "No vulnerabilities", tone: "success" });
  });

  test("a partly scanned pod says how much was skipped", () => {
    const s = podScanSummary(pod([img("nginx", "scanned"), img("sidecar", "failed")], ["init"]));
    expect(s).toEqual({ scanned: 1, missing: 2, failed: true, vulns: 0 });
    expect(podScanState(s)).toBe("partial");
    expect(podScanLabel(s)?.text).toBe("No vulnerabilities · 2 not scanned");
  });

  test("findings take over the row; the label steps aside", () => {
    const s = podScanSummary(pod([img("nginx", "scanned")], [], { high: 3 }));
    expect(podScanState(s)).toBe("vulnerable");
    expect(podScanLabel(s)).toBeNull();
  });

  test("an older payload without status fields counts every listed image as scanned", () => {
    const legacy = { name: "p", namespace: "ns", images: [img("nginx")], total_vulns: { ...zero }, compliant: true } as PodSecurityInfo;
    expect(podScanState(podScanSummary(legacy))).toBe("clean");
  });
});
