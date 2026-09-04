// Level classification: only an explicit token gives a line a level, and a
// line without one is `null` — visible under "all" and "info", hidden by
// "warn" and "error". See detectLevel / levelMatches in log-viewer.ts.

import { describe, expect, test } from "bun:test";
import {
  type LogLine,
  detectLevel,
  filterLogs,
  levelMatches,
  parseLogLine,
} from "./log-viewer";

describe("detectLevel: lines with no level token", () => {
  test("nginx access line gets no level", () => {
    expect(
      detectLevel(
        '10.244.0.1 - - [04/Sep/2026:12:52:02 +0000] "GET / HTTP/1.1" 200 615 "-" "kube-probe/1.36" "-"',
      ),
    ).toBeNull();
  });

  test("a level word inside a URL path is not a token", () => {
    expect(detectLevel('10.244.0.1 - - [04/Sep/2026:12:52:02 +0000] "GET /debug HTTP/1.1" 200 2')).toBeNull();
    expect(detectLevel('"GET /api/errors HTTP/1.1" 404 0')).toBeNull();
  });

  test("plain text gets no level", () => {
    expect(detectLevel("GET /api/health 200 OK")).toBeNull();
    expect(detectLevel("Listening on :8080")).toBeNull();
    expect(detectLevel("plain text line with no level whatsoever")).toBeNull();
  });

  test("identifiers containing a level word are not tokens", () => {
    expect(detectLevel("writing to stderr")).toBeNull();
    expect(detectLevel("error_count=3 ok")).toBeNull();
    expect(detectLevel("informational message")).toBeNull();
    expect(detectLevel("debugger attached")).toBeNull();
  });

  test("stream markers and empty lines get no level", () => {
    expect(detectLevel("[stream ended]")).toBeNull();
    expect(detectLevel("")).toBeNull();
  });
});

describe("detectLevel: explicit tokens", () => {
  test("uppercase level words at the start of the line", () => {
    expect(detectLevel("DEBUG loading config")).toBe("debug");
    expect(detectLevel("INFO  server started on port 8080")).toBe("info");
    expect(detectLevel("WARN disk usage above 80%")).toBe("warn");
    expect(detectLevel("WARNING: deprecated API call")).toBe("warn");
    expect(detectLevel("ERROR failed to connect to database: timeout")).toBe("error");
    expect(detectLevel("ERR connection reset")).toBe("error");
    expect(detectLevel("FATAL: process crashed")).toBe("error");
    expect(detectLevel("PANIC: runtime error")).toBe("error");
  });

  test("TRACE maps onto debug (the lowest display level)", () => {
    expect(detectLevel("TRACE entering handler")).toBe("debug");
  });

  test("tokens are matched regardless of case", () => {
    expect(detectLevel("Error: file not found")).toBe("error");
    expect(detectLevel("warn: disk space low")).toBe("warn");
    expect(detectLevel("info: server started")).toBe("info");
  });

  test("bracketed and logfmt tokens (nginx error log, zap, logrus)", () => {
    expect(detectLevel("2026/09/04 12:52:02 [error] 31#31: *1 open() failed")).toBe("error");
    expect(detectLevel("2026/09/04 12:52:02 [warn] 31#31: conflicting server name")).toBe("warn");
    expect(detectLevel('time="2026-09-04T12:52:02Z" level=info msg="started"')).toBe("info");
    expect(detectLevel("level=warning msg=slow")).toBe("warn");
    expect(detectLevel("(fatal) out of memory")).toBe("error");
  });

  test("syslog / python extras: NOTICE is info, CRITICAL is error", () => {
    expect(detectLevel("NOTICE: scheduled maintenance")).toBe("info");
    expect(detectLevel("CRITICAL failure in subsystem")).toBe("error");
  });

  test("a level word later in the line still counts when it stands alone", () => {
    expect(detectLevel("something error occurred")).toBe("error");
    expect(detectLevel("goroutine panic: nil pointer")).toBe("error");
  });

  test("the first token wins: the declared level beats words in the message", () => {
    expect(detectLevel("WARN request failed: error=timeout")).toBe("warn");
    expect(detectLevel("INFO handled error gracefully")).toBe("info");
    expect(detectLevel("ERROR after a warning")).toBe("error");
  });
});

describe("detectLevel: klog prefixes", () => {
  test("I / W / E / F map onto info / warn / error / error", () => {
    expect(detectLevel("I0904 12:52:02.123456       1 server.go:120] Listening on :8080")).toBe("info");
    expect(detectLevel("W0904 12:52:03.000000       1 cache.go:55] cache miss for key foo")).toBe("warn");
    expect(detectLevel("E0904 12:52:04.000000       1 client.go:99] connection refused")).toBe("error");
    expect(detectLevel("F0904 12:52:05.000000       1 main.go:10] cannot start")).toBe("error");
  });

  test("the prefix wins over words in the message", () => {
    expect(detectLevel("I0904 12:52:02.000000       1 x.go:1] error budget refilled")).toBe("info");
  });
});

describe("detectLevel: JSON lines", () => {
  test("string level field", () => {
    expect(detectLevel('{"level":"info","ts":"2026-09-04T12:52:05Z","msg":"started worker"}')).toBe("info");
    expect(detectLevel('{"level":"debug","msg":"cache hit"}')).toBe("debug");
    expect(detectLevel('{"level":"warn","msg":"retrying"}')).toBe("warn");
    expect(detectLevel('{"level":"error","msg":"boom"}')).toBe("error");
    expect(detectLevel('{"level":"fatal","msg":"boom"}')).toBe("error");
  });

  test("severity field, any case", () => {
    expect(detectLevel('{"severity":"WARNING","msg":"slow query","duration_ms":1200}')).toBe("warn");
    expect(detectLevel('{"severity": "Error", "msg": "x"}')).toBe("error");
    expect(detectLevel('{"severity":"INFO","message":"ok"}')).toBe("info");
  });

  test("numeric pino levels", () => {
    expect(detectLevel('{"level":30,"msg":"hello"}')).toBe("info");
    expect(detectLevel('{"level":40,"msg":"hmm"}')).toBe("warn");
    expect(detectLevel('{"level":50,"msg":"bad"}')).toBe("error");
    expect(detectLevel('{"level":60,"msg":"dead"}')).toBe("error");
    expect(detectLevel('{"level":20,"msg":"dbg"}')).toBe("debug");
  });

  test("the JSON level field is authoritative over words in the message", () => {
    expect(detectLevel('{"level":"info","msg":"error budget refilled"}')).toBe("info");
    expect(detectLevel('{"level":"verbose","msg":"an error occurred"}')).toBeNull();
  });

  test("JSON without a level field falls back to standalone tokens", () => {
    expect(detectLevel('{"msg":"ERROR nothing works"}')).toBe("error");
    expect(detectLevel('{"status":"ok","code":200}')).toBeNull();
  });

  test("a JSON payload behind a text prefix still classifies", () => {
    expect(detectLevel('app: {"level":"warn","msg":"x"}')).toBe("warn");
  });
});

describe("parseLogLine carries the null level through", () => {
  test("nginx access line with pod prefix and timestamp", () => {
    const line = parseLogLine(
      '[web-6d4f8b-9k2m1] 2026-09-04T12:52:02.000000000Z 10.244.0.1 - - [04/Sep/2026:12:52:02 +0000] "GET / HTTP/1.1" 200 615 "-" "kube-probe/1.36" "-"',
    );
    expect(line.podName).toBe("web-6d4f8b-9k2m1");
    expect(line.timestamp).toBeDefined();
    expect(line.level).toBeNull();
  });
});

describe("levelMatches", () => {
  test("all shows everything", () => {
    for (const level of ["error", "warn", "info", "debug", null] as const) {
      expect(levelMatches(level, "all")).toBe(true);
    }
  });

  test("info shows info AND unlevelled lines, not debug", () => {
    expect(levelMatches("info", "info")).toBe(true);
    expect(levelMatches(null, "info")).toBe(true);
    expect(levelMatches("debug", "info")).toBe(false);
    expect(levelMatches("warn", "info")).toBe(false);
    expect(levelMatches("error", "info")).toBe(false);
  });

  test("warn and error hide unlevelled lines", () => {
    expect(levelMatches(null, "warn")).toBe(false);
    expect(levelMatches(null, "error")).toBe(false);
    expect(levelMatches("warn", "warn")).toBe(true);
    expect(levelMatches("error", "error")).toBe(true);
    expect(levelMatches("error", "warn")).toBe(false);
  });
});

describe("filterLogs with unlevelled lines", () => {
  const lines: LogLine[] = [
    { id: 0, message: "INFO started", level: "info", isJson: false },
    { id: 1, message: '"GET / HTTP/1.1" 200', level: null, isJson: false },
    { id: 2, message: "WARN slow", level: "warn", isJson: false },
    { id: 3, message: "ERROR down", level: "error", isJson: false },
    { id: 4, message: "DEBUG trace", level: "debug", isJson: false },
  ];
  const run = (levelFilter: "all" | "info" | "warn" | "error") =>
    filterLogs(lines, { podFilter: null, levelFilter, filterText: "", useRegex: false }).map((l) => l.id);

  test("all keeps the unlevelled line", () => {
    expect(run("all")).toEqual([0, 1, 2, 3, 4]);
  });

  test("info keeps the unlevelled line alongside info", () => {
    expect(run("info")).toEqual([0, 1]);
  });

  test("warn and error drop it", () => {
    expect(run("warn")).toEqual([2]);
    expect(run("error")).toEqual([3]);
  });
});
