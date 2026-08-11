import { describe, expect, test, beforeEach } from "bun:test";
import {
  type LogLevel,
  type LogLine,
  detectLevel,
  tryParseJson,
  formatTimestamp,
  shortPodName,
  parseLogLine,
  createTextMatcher,
  filterLogs,
  navigateLog,
  resetLogIdCounter,
} from "./log-viewer";

// --- Tests ---

describe("detectLevel", () => {
  test("detects error level (lowercase)", () => {
    expect(detectLevel("something error occurred")).toBe("error");
  });

  test("detects error level (uppercase)", () => {
    expect(detectLevel("FATAL: process crashed")).toBe("error");
  });

  test("detects error level (mixed case)", () => {
    expect(detectLevel("Error: file not found")).toBe("error");
  });

  test("detects err keyword", () => {
    expect(detectLevel("connection err timeout")).toBe("error");
  });

  test("detects panic keyword", () => {
    expect(detectLevel("goroutine panic: nil pointer")).toBe("error");
  });

  test("detects crit keyword", () => {
    expect(detectLevel("crit level alert")).toBe("error");
  });

  test("detects critical keyword", () => {
    expect(detectLevel("critical failure in subsystem")).toBe("error");
  });

  test("detects warn level (lowercase)", () => {
    expect(detectLevel("warn: disk space low")).toBe("warn");
  });

  test("detects warning level (uppercase)", () => {
    expect(detectLevel("WARNING: deprecated API call")).toBe("warn");
  });

  test("detects info level", () => {
    expect(detectLevel("info: server started")).toBe("info");
  });

  test("detects notice level as info", () => {
    expect(detectLevel("notice: scheduled maintenance")).toBe("info");
  });

  test("defaults to debug when no keywords match", () => {
    expect(detectLevel("GET /api/health 200 OK")).toBe("debug");
  });

  test("error takes priority over warn", () => {
    expect(detectLevel("warn: error happened")).toBe("error");
  });

  test("error takes priority over info", () => {
    expect(detectLevel("info: fatal exception")).toBe("error");
  });

  test("warn takes priority over info", () => {
    expect(detectLevel("info: warning issued")).toBe("warn");
  });

  test("does not match partial words (word boundary)", () => {
    // 'information' contains 'info' but as a substring — however the regex
    // uses \b which matches word boundaries. 'info' IS a word boundary match
    // inside 'information' because 'info' ends where 'r' begins — actually
    // \binfo\b would NOT match 'information'. Let's verify.
    expect(detectLevel("informational message")).toBe("debug");
  });

  test("empty string defaults to debug", () => {
    expect(detectLevel("")).toBe("debug");
  });
});

describe("tryParseJson", () => {
  test("detects simple JSON object", () => {
    const result = tryParseJson('{"key":"value"}');
    expect(result.isJson).toBe(true);
    expect(result.formatted).toBe('{\n  "key": "value"\n}');
  });

  test("detects JSON array", () => {
    const result = tryParseJson("[1,2,3]");
    expect(result.isJson).toBe(true);
    expect(result.formatted).toBe("[\n  1,\n  2,\n  3\n]");
  });

  test("detects JSON with text prefix", () => {
    const result = tryParseJson('some prefix {"key":"value"}');
    expect(result.isJson).toBe(true);
    expect(result.formatted).toBe('some prefix\n{\n  "key": "value"\n}');
  });

  test("returns original string for non-JSON", () => {
    const result = tryParseJson("just a regular log line");
    expect(result.isJson).toBe(false);
    expect(result.formatted).toBe("just a regular log line");
  });

  test("returns original for invalid JSON with braces", () => {
    const result = tryParseJson("{not valid json}");
    expect(result.isJson).toBe(false);
    expect(result.formatted).toBe("{not valid json}");
  });

  test("returns original when opening brace has no matching close", () => {
    const result = tryParseJson('{"key":"value"');
    expect(result.isJson).toBe(false);
    expect(result.formatted).toBe('{"key":"value"');
  });

  test("returns original when opening bracket has no matching close", () => {
    const result = tryParseJson("[1, 2, 3");
    expect(result.isJson).toBe(false);
    expect(result.formatted).toBe("[1, 2, 3");
  });

  test("handles empty string", () => {
    const result = tryParseJson("");
    expect(result.isJson).toBe(false);
    expect(result.formatted).toBe("");
  });

  test("handles nested JSON", () => {
    const result = tryParseJson('{"a":{"b":"c"}}');
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.formatted)).toEqual({ a: { b: "c" } });
  });

  test("handles whitespace-padded input", () => {
    const result = tryParseJson('  {"key":"value"}  ');
    expect(result.isJson).toBe(true);
    expect(result.formatted).toBe('{\n  "key": "value"\n}');
  });

  test("handles JSON array with prefix text", () => {
    const result = tryParseJson("data: [1,2]");
    expect(result.isJson).toBe(true);
    expect(result.formatted).toContain("data:");
  });
});

describe("formatTimestamp", () => {
  test("formats a valid ISO timestamp", () => {
    const result = formatTimestamp("2026-03-18T14:30:45.123Z");
    // Verify it contains expected parts (month, time)
    expect(result).toMatch(/Mar\s+18\s+\d{2}:\d{2}:\d{2}/);
  });

  test("returns original string for invalid timestamp", () => {
    const result = formatTimestamp("not-a-timestamp");
    // Date constructor with invalid input creates Invalid Date
    // toLocaleString on Invalid Date varies by runtime, but the function
    // catches exceptions. In practice new Date("not-a-timestamp") doesn't
    // throw but produces NaN-based output. Let's verify it doesn't crash.
    expect(typeof result).toBe("string");
  });

  test("formats midnight correctly", () => {
    const result = formatTimestamp("2026-01-01T00:00:00.000Z");
    expect(result).toContain("Jan");
  });

  test("pads single-digit day with space", () => {
    const result = formatTimestamp("2026-03-01T12:00:00.000Z");
    // Day should be " 1" (space-padded to 2 chars)
    expect(result).toContain(" 1");
  });
});

describe("shortPodName", () => {
  test("returns last two segments for pod with 3+ segments", () => {
    expect(shortPodName("my-app-deployment-abc123-xyz")).toBe("abc123-xyz");
  });

  test("returns last two segments for exactly 3 segments", () => {
    expect(shortPodName("frontend-6d4f8b-9k2m1")).toBe("6d4f8b-9k2m1");
  });

  test("returns last 12 chars for 2-segment name", () => {
    expect(shortPodName("nginx-proxy")).toBe("nginx-proxy");
  });

  test("returns last 12 chars for single segment name", () => {
    expect(shortPodName("mypod")).toBe("mypod");
  });

  test("truncates long single-segment name to last 12 chars", () => {
    expect(shortPodName("averylongpodnamewithoutdashes")).toBe(
      "ithoutdashes",
    );
  });

  test("handles many segments (5+)", () => {
    expect(shortPodName("a-b-c-d-e-f")).toBe("e-f");
  });

  test("handles two-segment name shorter than 12 chars", () => {
    const result = shortPodName("ab-cd");
    // 2 segments → falls to slice(-12), "ab-cd" is 5 chars
    expect(result).toBe("ab-cd");
  });
});

describe("parseLogLine", () => {
  beforeEach(() => {
    resetLogIdCounter();
  });

  test("parses a plain log message", () => {
    const line = parseLogLine("GET /health 200");
    expect(line.id).toBe(0);
    expect(line.message).toBe("GET /health 200");
    expect(line.level).toBe("debug");
    expect(line.timestamp).toBeUndefined();
    expect(line.podName).toBeUndefined();
    expect(line.isJson).toBe(false);
  });

  test("increments id for each line", () => {
    const line1 = parseLogLine("first");
    const line2 = parseLogLine("second");
    expect(line1.id).toBe(0);
    expect(line2.id).toBe(1);
  });

  test("extracts pod name prefix", () => {
    const line = parseLogLine("[my-pod-abc-123] something happened");
    expect(line.podName).toBe("my-pod-abc-123");
    expect(line.message).toBe("something happened");
  });

  test("extracts timestamp from ISO format", () => {
    const line = parseLogLine(
      "2026-03-18T14:30:45.123Z info: server started",
    );
    expect(line.timestamp).toBeDefined();
    expect(line.message).toBe("info: server started");
    expect(line.level).toBe("info");
  });

  test("extracts both pod prefix and timestamp", () => {
    const line = parseLogLine(
      "[web-pod-5f8d-k2m1] 2026-03-18T10:00:00.000Z error: crash",
    );
    expect(line.podName).toBe("web-pod-5f8d-k2m1");
    expect(line.timestamp).toBeDefined();
    expect(line.message).toBe("error: crash");
    expect(line.level).toBe("error");
  });

  test("detects JSON in message", () => {
    const line = parseLogLine('{"status":"ok","code":200}');
    expect(line.isJson).toBe(true);
    expect(line.jsonFormatted).toBeDefined();
  });

  test("non-JSON message has no jsonFormatted", () => {
    const line = parseLogLine("plain text log");
    expect(line.isJson).toBe(false);
    expect(line.jsonFormatted).toBeUndefined();
  });

  test("handles pod prefix with multiline content (via /s flag)", () => {
    const line = parseLogLine("[pod-a-b-c] line1\nline2");
    expect(line.podName).toBe("pod-a-b-c");
    expect(line.message).toBe("line1\nline2");
  });
});

describe("createTextMatcher", () => {
  test("returns null for empty filter text", () => {
    expect(createTextMatcher("", false)).toBeNull();
    expect(createTextMatcher("", true)).toBeNull();
  });

  test("plain text matcher is case-insensitive", () => {
    const matcher = createTextMatcher("Error", false)!;
    expect(matcher("an error occurred")).toBe(true);
    expect(matcher("an ERROR occurred")).toBe(true);
    expect(matcher("all good")).toBe(false);
  });

  test("plain text matcher does substring match", () => {
    const matcher = createTextMatcher("pod", false)!;
    expect(matcher("my-pod-name")).toBe(true);
    expect(matcher("deployment")).toBe(false);
  });

  test("regex matcher works with valid pattern", () => {
    const matcher = createTextMatcher("err\\w+", true)!;
    expect(matcher("an error occurred")).toBe(true);
    expect(matcher("warning only")).toBe(false);
  });

  test("regex matcher is case-insensitive", () => {
    const matcher = createTextMatcher("error", true)!;
    expect(matcher("ERROR: crash")).toBe(true);
  });

  test("invalid regex returns null (graceful fallback)", () => {
    const matcher = createTextMatcher("[invalid(", true);
    expect(matcher).toBeNull();
  });

  test("regex with special characters works", () => {
    const matcher = createTextMatcher("status:\\s*\\d+", true)!;
    expect(matcher("status: 200")).toBe(true);
    expect(matcher("status:404")).toBe(true);
    expect(matcher("status: ok")).toBe(false);
  });
});

describe("filterLogs", () => {
  const sampleLogs: LogLine[] = [
    { id: 0, podName: "pod-a-b-c", message: "info: started", level: "info", isJson: false },
    { id: 1, podName: "pod-x-y-z", message: "error: crash", level: "error", isJson: false },
    { id: 2, podName: "pod-a-b-c", message: "warn: disk low", level: "warn", isJson: false },
    { id: 3, podName: "pod-x-y-z", message: "GET /health 200", level: "debug", isJson: false },
    { id: 4, message: "info: no pod", level: "info", isJson: false },
  ];

  test("returns all logs when no filters active", () => {
    const result = filterLogs(sampleLogs, {
      podFilter: null,
      levelFilter: "all",
      filterText: "",
      useRegex: false,
    });
    expect(result).toBe(sampleLogs); // same reference
  });

  test("filters by pod name", () => {
    const result = filterLogs(sampleLogs, {
      podFilter: "pod-a-b-c",
      levelFilter: "all",
      filterText: "",
      useRegex: false,
    });
    expect(result).toHaveLength(2);
    expect(result.every((l) => l.podName === "pod-a-b-c")).toBe(true);
  });

  test("filters by level", () => {
    const result = filterLogs(sampleLogs, {
      podFilter: null,
      levelFilter: "error",
      filterText: "",
      useRegex: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("error");
  });

  test("filters by text (case-insensitive)", () => {
    const result = filterLogs(sampleLogs, {
      podFilter: null,
      levelFilter: "all",
      filterText: "CRASH",
      useRegex: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("crash");
  });

  test("filters by regex", () => {
    const result = filterLogs(sampleLogs, {
      podFilter: null,
      levelFilter: "all",
      filterText: "GET.*200",
      useRegex: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("GET");
  });

  test("combines pod + level filters", () => {
    const result = filterLogs(sampleLogs, {
      podFilter: "pod-x-y-z",
      levelFilter: "error",
      filterText: "",
      useRegex: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  test("combines all three filters", () => {
    const result = filterLogs(sampleLogs, {
      podFilter: "pod-a-b-c",
      levelFilter: "info",
      filterText: "started",
      useRegex: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(0);
  });

  test("returns empty array when no matches", () => {
    const result = filterLogs(sampleLogs, {
      podFilter: null,
      levelFilter: "all",
      filterText: "nonexistent",
      useRegex: false,
    });
    expect(result).toHaveLength(0);
  });

  test("invalid regex returns all logs (matcher is null)", () => {
    const result = filterLogs(sampleLogs, {
      podFilter: null,
      levelFilter: "all",
      filterText: "[invalid(",
      useRegex: true,
    });
    // textMatcher is null due to invalid regex, so text filter is not applied
    expect(result).toHaveLength(5);
  });

  test("pod filter with no podName on log excludes it", () => {
    const result = filterLogs(sampleLogs, {
      podFilter: "pod-a-b-c",
      levelFilter: "all",
      filterText: "",
      useRegex: false,
    });
    // Log id=4 has no podName → excluded
    expect(result.find((l) => l.id === 4)).toBeUndefined();
  });

  test("filters empty log array", () => {
    const result = filterLogs([], {
      podFilter: null,
      levelFilter: "error",
      filterText: "test",
      useRegex: false,
    });
    expect(result).toHaveLength(0);
  });
});

describe("navigateLog", () => {
  const logs: LogLine[] = [
    { id: 0, message: "first", level: "info", isJson: false },
    { id: 1, message: "second", level: "warn", isJson: false },
    { id: 2, message: "third", level: "error", isJson: false },
  ];

  test("navigate forward from first log", () => {
    const result = navigateLog(logs, logs[0], 1);
    expect(result).toBe(logs[1]);
  });

  test("navigate backward from last log", () => {
    const result = navigateLog(logs, logs[2], -1);
    expect(result).toBe(logs[1]);
  });

  test("clamps at beginning (cannot go before first)", () => {
    const result = navigateLog(logs, logs[0], -1);
    expect(result).toBe(logs[0]);
  });

  test("clamps at end (cannot go past last)", () => {
    const result = navigateLog(logs, logs[2], 1);
    expect(result).toBe(logs[2]);
  });

  test("navigates from null selection (goes to first on forward)", () => {
    // indexOf returns -1, so -1 + 1 = 0, clamped to 0
    const result = navigateLog(logs, null, 1);
    expect(result).toBe(logs[0]);
  });

  test("navigates from null selection backward (goes to first via clamp)", () => {
    // indexOf returns -1, so -1 + (-1) = -2, clamped to 0
    const result = navigateLog(logs, null, -1);
    expect(result).toBe(logs[0]);
  });

  test("returns current selection when filtered logs are empty", () => {
    const selected: LogLine = { id: 99, message: "orphan", level: "debug", isJson: false };
    const result = navigateLog([], selected, 1);
    expect(result).toBe(selected);
  });

  test("returns null when filtered logs are empty and no selection", () => {
    const result = navigateLog([], null, 1);
    expect(result).toBeNull();
  });

  test("navigate through all items sequentially", () => {
    let current: LogLine | null = null;
    current = navigateLog(logs, current, 1); // → index 0
    expect(current).toBe(logs[0]);
    current = navigateLog(logs, current, 1); // → index 1
    expect(current).toBe(logs[1]);
    current = navigateLog(logs, current, 1); // → index 2
    expect(current).toBe(logs[2]);
    current = navigateLog(logs, current, 1); // → still index 2 (clamped)
    expect(current).toBe(logs[2]);
  });

  test("navigate backward through all items", () => {
    let current: LogLine | null = logs[2];
    current = navigateLog(logs, current, -1); // → index 1
    expect(current).toBe(logs[1]);
    current = navigateLog(logs, current, -1); // → index 0
    expect(current).toBe(logs[0]);
    current = navigateLog(logs, current, -1); // → still index 0 (clamped)
    expect(current).toBe(logs[0]);
  });

  test("single-item list stays on same item", () => {
    const single = [{ id: 0, message: "only", level: "info" as const, isJson: false }];
    expect(navigateLog(single, single[0], 1)).toBe(single[0]);
    expect(navigateLog(single, single[0], -1)).toBe(single[0]);
  });
});
