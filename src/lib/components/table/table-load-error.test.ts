import { describe, expect, test } from "bun:test";
import { classifyLoadError } from "./table-load-error";

describe("classifyLoadError", () => {
  test("a 404 means the kind is not served, not that the cluster is down", () => {
    const v = classifyLoadError("Failed to load resources: 404 Not Found: 404 page not found", "VPA");
    expect(v.kind).toBe("not-installed");
    expect(v.title).toContain("not available");
    expect(v.action).toBe("Refresh");
  });

  test("a 403 is an RBAC problem", () => {
    const v = classifyLoadError('pods is forbidden: User "x" cannot list resource "pods"', "Pods");
    expect(v.kind).toBe("forbidden");
    expect(v.action).toBe("Retry");
  });

  test("network errors are the only 'unable to reach cluster' case", () => {
    expect(classifyLoadError("fetch failed: connect ECONNREFUSED 127.0.0.1:6443", "Pods").kind).toBe("unreachable");
    expect(classifyLoadError("request to https://x timed out", "Pods").kind).toBe("unreachable");
    expect(classifyLoadError("", "Pods").kind).toBe("unreachable");
  });

  test("an HTTP 5xx came from a reachable server: not an outage, the server's message stands", () => {
    const v = classifyLoadError("Failed to load resources: 500 Internal Server Error: conversion webhook for foo.example.com failed", "Foos");
    expect(v.kind).toBe("unknown");
    expect(v.title).toBe("Could not load foos");
    expect(v.detail).toContain("conversion webhook");
    expect(classifyLoadError("HTTP-Code: 503 Service Unavailable", "Pods").kind).toBe("unknown");
  });

  test("anything else keeps the raw message and a plain retry", () => {
    const v = classifyLoadError("Failed to load resources: something odd", "Leases");
    expect(v.kind).toBe("unknown");
    expect(v.detail).toContain("something odd");
    expect(v.title).toBe("Could not load leases");
  });
});
