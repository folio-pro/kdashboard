import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import { fetchConfigObjects } from "./pod-utils";

function obj(kind: string, name: string, data: Record<string, string>): Resource {
  return { api_version: "v1", kind, metadata: { name, namespace: "prod" } as Resource["metadata"], spec: {}, status: {}, data };
}

describe("fetchConfigObjects", () => {
  test("gets each referenced object by name (list rows carry no values)", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const invoke = async <T,>(cmd: string, args: Record<string, unknown>): Promise<T> => {
      calls.push([cmd, args]);
      return obj(String(args.kind), String(args.name), { k: "v" }) as T;
    };
    const out = await fetchConfigObjects(invoke, "Secret", ["a", "b"], "prod");
    expect(calls).toEqual([
      ["get_resource", { kind: "Secret", name: "a", namespace: "prod" }],
      ["get_resource", { kind: "Secret", name: "b", namespace: "prod" }],
    ]);
    expect(out.map((r) => r.metadata.name)).toEqual(["a", "b"]);
    expect(out[0].data).toEqual({ k: "v" });
  });

  test("drops objects that fail to load (missing, RBAC) and keeps the rest", async () => {
    const invoke = async <T,>(_cmd: string, args: Record<string, unknown>): Promise<T> => {
      if (args.name === "gone") throw new Error("not found");
      return obj("ConfigMap", String(args.name), {}) as T;
    };
    const out = await fetchConfigObjects(invoke, "ConfigMap", ["gone", "cfg"], "prod");
    expect(out.map((r) => r.metadata.name)).toEqual(["cfg"]);
  });

  test("dedupes names and skips the call entirely when there are none", async () => {
    let n = 0;
    const invoke = async <T,>(_cmd: string, args: Record<string, unknown>): Promise<T> => {
      n++;
      return obj("ConfigMap", String(args.name), {}) as T;
    };
    expect(await fetchConfigObjects(invoke, "ConfigMap", [], "prod")).toEqual([]);
    expect(n).toBe(0);
    await fetchConfigObjects(invoke, "ConfigMap", ["x", "x"], "prod");
    expect(n).toBe(1);
  });
});
