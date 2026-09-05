// Export (copy / download), the line-wrap preference, and the "all
// containers" stream request.

import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import {
  ALL_CONTAINERS,
  type LogLine,
  type WrapStorage,
  buildStreamRequest,
  exportFileName,
  formatLogsForExport,
  readWrapPreference,
  writeWrapPreference,
  WRAP_STORAGE_KEY,
} from "./log-viewer";

describe("formatLogsForExport", () => {
  const lines: LogLine[] = [
    { id: 0, timestamp: "Sep  4 14:52:02", message: "INFO started", level: "info", isJson: false },
    {
      id: 1,
      podName: "web-6d4f8b-9k2m1",
      timestamp: "Sep  4 14:52:03",
      message: '{"level":"warn","msg":"x"}',
      level: "warn",
      isJson: true,
      jsonFormatted: '{\n  "level": "warn",\n  "msg": "x"\n}',
    },
    { id: 2, message: "no timestamp, no pod", level: null, isJson: false },
  ];

  test("one line per entry with the columns the row shows", () => {
    expect(formatLogsForExport(lines, { timestamps: true })).toBe(
      [
        "Sep  4 14:52:02 INFO started",
        '[web-6d4f8b-9k2m1] Sep  4 14:52:03 {"level":"warn","msg":"x"}',
        "no timestamp, no pod",
      ].join("\n"),
    );
  });

  test("omits timestamps when they are hidden", () => {
    expect(formatLogsForExport(lines, { timestamps: false })).toBe(
      ["INFO started", '[web-6d4f8b-9k2m1] {"level":"warn","msg":"x"}', "no timestamp, no pod"].join("\n"),
    );
  });

  test("JSON goes out single-line, not pretty-printed", () => {
    const out = formatLogsForExport([lines[1]], { timestamps: false });
    expect(out.split("\n")).toHaveLength(1);
  });

  test("empty input is an empty document", () => {
    expect(formatLogsForExport([], { timestamps: true })).toBe("");
  });
});

describe("exportFileName", () => {
  const at = new Date(2026, 8, 4, 12, 5, 9);

  test("pod, container and a sortable timestamp", () => {
    expect(exportFileName("web-6d4f8b-9k2m1", "nginx", at)).toBe("web-6d4f8b-9k2m1-nginx-20260904-120509.log");
  });

  test("the all-containers sentinel is not a file name part", () => {
    expect(exportFileName("web", ALL_CONTAINERS, at)).toBe("web-20260904-120509.log");
  });

  test("falls back when there is no resource name", () => {
    expect(exportFileName(undefined, "", at)).toBe("logs-20260904-120509.log");
  });

  test("strips characters a file system may reject", () => {
    expect(exportFileName("a/b:c", "x y", at)).toBe("a-b-c-x-y-20260904-120509.log");
  });
});

describe("wrap preference", () => {
  function memoryStorage(initial: Record<string, string> = {}): WrapStorage & { data: Record<string, string> } {
    const data = { ...initial };
    return {
      data,
      getItem: (k) => (k in data ? data[k] : null),
      setItem: (k, v) => {
        data[k] = v;
      },
    };
  }

  test("defaults to wrapping", () => {
    expect(readWrapPreference(memoryStorage())).toBe(true);
    expect(readWrapPreference(undefined)).toBe(true);
  });

  test("round-trips through storage", () => {
    const storage = memoryStorage();
    writeWrapPreference(storage, false);
    expect(storage.data[WRAP_STORAGE_KEY]).toBe("0");
    expect(readWrapPreference(storage)).toBe(false);
    writeWrapPreference(storage, true);
    expect(readWrapPreference(storage)).toBe(true);
  });

  test("survives a throwing or corrupt storage", () => {
    const broken: WrapStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readWrapPreference(broken)).toBe(true);
    expect(() => writeWrapPreference(broken, false)).not.toThrow();
    expect(readWrapPreference(memoryStorage({ [WRAP_STORAGE_KEY]: "garbage" }))).toBe(false);
  });
});

describe("buildStreamRequest with ALL_CONTAINERS", () => {
  const pod = {
    kind: "Pod",
    api_version: "v1",
    metadata: { name: "web", namespace: "default", uid: "u1" },
  } as unknown as Resource;

  const base = {
    resource: pod,
    isDeployment: false,
    deploymentPodNames: [] as string[],
    tailLines: 100,
    sinceSeconds: null,
    timestamps: true,
    previous: false,
  };

  test("several containers: the pod stream carries them all", () => {
    const req = buildStreamRequest({ ...base, container: ALL_CONTAINERS, containers: ["nginx", "sidecar"] });
    expect(req.kind).toBe("stream");
    if (req.kind !== "stream") return;
    expect(req.command).toBe("stream_pod_logs");
    expect(req.args.containers).toEqual(["nginx", "sidecar"]);
    expect(req.args.container).toBe("nginx");
  });

  test("a single container streams the plain way", () => {
    const req = buildStreamRequest({ ...base, container: ALL_CONTAINERS, containers: ["main"] });
    if (req.kind !== "stream") throw new Error("expected a stream");
    expect(req.args.container).toBe("main");
    expect("containers" in req.args).toBe(false);
  });

  test("a named container never sends the containers list", () => {
    const req = buildStreamRequest({ ...base, container: "sidecar", containers: ["nginx", "sidecar"] });
    if (req.kind !== "stream") throw new Error("expected a stream");
    expect(req.args.container).toBe("sidecar");
    expect("containers" in req.args).toBe(false);
  });

  test("no containers known: unavailable with a reason", () => {
    const req = buildStreamRequest({ ...base, container: ALL_CONTAINERS, containers: [] });
    expect(req).toEqual({ kind: "unavailable", reason: "This pod reports no containers to stream." });
  });

  test("a deployment stream takes the first container", () => {
    const req = buildStreamRequest({
      ...base,
      isDeployment: true,
      deploymentPodNames: ["web-1", "web-2"],
      container: ALL_CONTAINERS,
      containers: ["nginx", "sidecar"],
    });
    if (req.kind !== "stream") throw new Error("expected a stream");
    expect(req.command).toBe("stream_multi_pod_logs");
    expect(req.args.container).toBe("nginx");
    expect("containers" in req.args).toBe(false);
  });
});
