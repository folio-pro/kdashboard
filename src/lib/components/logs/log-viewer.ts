// Pure logic extracted from LogViewer.svelte — no Svelte imports, no $state/$derived.

import type { Resource } from "$lib/types";

// --- Types ---

export type LogLevel = "all" | "info" | "warn" | "error";

export interface LogLine {
  id: number;
  podName?: string;
  timestamp?: string;
  message: string;
  level: "error" | "warn" | "info" | "debug";
  isJson: boolean;
  jsonFormatted?: string;
  _jsonHighlightedCache?: string;
}

// --- Regex patterns ---

export const ERROR_PATTERNS = /\b(error|err|fatal|panic|crit|critical)\b/i;
export const WARN_PATTERNS = /\b(warn|warning)\b/i;
export const INFO_PATTERNS = /\b(info|notice)\b/i;
export const TS_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)/;
export const POD_PREFIX_REGEX = /^\[([^\]]+)\]\s+(.*)/s;

// --- Pure functions ---

export function detectLevel(message: string): LogLine["level"] {
  if (ERROR_PATTERNS.test(message)) return "error";
  if (WARN_PATTERNS.test(message)) return "warn";
  if (INFO_PATTERNS.test(message)) return "info";
  return "debug";
}

export function tryParseJson(str: string): { isJson: boolean; formatted: string } {
  const trimmed = str.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonArrayStart = trimmed.indexOf("[");
  const start =
    jsonStart === -1
      ? jsonArrayStart
      : jsonArrayStart === -1
        ? jsonStart
        : Math.min(jsonStart, jsonArrayStart);
  if (start === -1) return { isJson: false, formatted: str };
  // Fast pre-check: last char must match opening bracket
  const lastChar = trimmed[trimmed.length - 1];
  if (
    (trimmed[start] === "{" && lastChar !== "}") ||
    (trimmed[start] === "[" && lastChar !== "]")
  ) {
    return { isJson: false, formatted: str };
  }
  try {
    const candidate = trimmed.slice(start);
    const parsed = JSON.parse(candidate);
    const prefix = trimmed.slice(0, start).trim();
    const formatted = JSON.stringify(parsed, null, 2);
    return { isJson: true, formatted: prefix ? `${prefix}\n${formatted}` : formatted };
  } catch {
    return { isJson: false, formatted: str };
  }
}

export function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    const month = d.toLocaleString("en", { month: "short" });
    const day = d.getDate().toString().padStart(2, " ");
    const time = d.toTimeString().slice(0, 8);
    return `${month} ${day} ${time}`;
  } catch {
    return ts;
  }
}

export function shortPodName(name: string): string {
  const parts = name.split("-");
  if (parts.length >= 3) return parts.slice(-2).join("-");
  return name.slice(-12);
}

// --- Log ID counter ---

let logIdCounter = 0;

export function resetLogIdCounter(): void {
  logIdCounter = 0;
}

export function nextLogId(): number {
  return logIdCounter++;
}

export function parseLogLine(raw: string): LogLine {
  const id = logIdCounter++;
  let remaining = raw;
  let linePodName: string | undefined;
  const podMatch = remaining.match(POD_PREFIX_REGEX);
  if (podMatch) {
    linePodName = podMatch[1];
    remaining = podMatch[2];
  }
  const tsMatch = remaining.match(TS_REGEX);
  const message = tsMatch ? tsMatch[2] : remaining;
  const timestamp = tsMatch ? formatTimestamp(tsMatch[1]) : undefined;
  const jsonResult = tryParseJson(message);
  return {
    id,
    podName: linePodName,
    timestamp,
    message,
    level: detectLevel(message),
    isJson: jsonResult.isJson,
    jsonFormatted: jsonResult.isJson ? jsonResult.formatted : undefined,
  };
}

export function createTextMatcher(
  filterText: string,
  useRegex: boolean,
): ((msg: string) => boolean) | null {
  if (filterText.length === 0) return null;
  if (useRegex) {
    try {
      const regex = new RegExp(filterText, "i");
      return (msg) => regex.test(msg);
    } catch {
      return null;
    }
  }
  const lower = filterText.toLowerCase();
  return (msg) => msg.toLowerCase().includes(lower);
}

export function filterLogs(
  logs: LogLine[],
  opts: {
    podFilter: string | null;
    levelFilter: LogLevel;
    filterText: string;
    useRegex: boolean;
  },
): LogLine[] {
  const hasPodFilter = opts.podFilter !== null;
  const hasLevelFilter = opts.levelFilter !== "all";
  const hasTextFilter = opts.filterText.length > 0;

  if (!hasPodFilter && !hasLevelFilter && !hasTextFilter) return logs;

  const textMatcher = hasTextFilter
    ? createTextMatcher(opts.filterText, opts.useRegex)
    : null;

  return logs.filter(
    (l) =>
      (!hasPodFilter || l.podName === opts.podFilter) &&
      (!hasLevelFilter || l.level === opts.levelFilter) &&
      (!textMatcher || textMatcher(l.message)),
  );
}

export function navigateLog(
  filteredLogs: LogLine[],
  selectedLog: LogLine | null,
  direction: -1 | 1,
): LogLine | null {
  if (filteredLogs.length === 0) return selectedLog;
  const current = selectedLog ? filteredLogs.indexOf(selectedLog) : -1;
  const next = Math.max(0, Math.min(filteredLogs.length - 1, current + direction));
  return filteredLogs[next];
}
// --- Stream lifecycle ---

/**
 * How far along the log stream is, from the renderer's point of view.
 *
 * `connecting` covers ONLY the window between asking the backend to start and
 * the backend confirming the request is established. `live` means the stream is
 * attached — it may simply not have produced output yet.
 *
 * Collapsing those two into one `isStreaming` boolean is what used to pin the
 * viewer on "Connecting to log stream..." forever: the message was shown for
 * any stream with zero lines, so a perfectly healthy but quiet pod looked
 * permanently stuck (while the header showed a LIVE badge at the same time).
 */
export type StreamPhase = "idle" | "connecting" | "live" | "ended" | "error";

/** Payload of the backend's `log-stream-status` event. */
export interface StreamStatus {
  state: "ended" | "error";
  message?: string;
  pod?: string;
}

/** The backend commands that can serve a log stream. */
export type StreamCommand = "stream_pod_logs" | "stream_multi_pod_logs";

/**
 * What to ask the backend for — or why there is nothing to ask for.
 *
 * Modelled as a union rather than a nullable so the "nothing streamable" case
 * carries its own explanation. The viewer used to discover this halfway through
 * starting a stream and `return` early, leaving the streaming flag set: that is
 * what pinned the empty state on "Connecting to log stream..." forever.
 */
export type StreamRequest =
  | { kind: "stream"; command: StreamCommand; args: Record<string, unknown> }
  | { kind: "unavailable"; reason: string };

export interface StreamRequestOptions {
  resource: Resource | null;
  isDeployment: boolean;
  deploymentPodNames: string[];
  container: string;
  tailLines: number;
  sinceSeconds: number | null;
  timestamps: boolean;
  previous: boolean;
}

/** Decide which stream command serves the current selection, if any. */
export function buildStreamRequest(opts: StreamRequestOptions): StreamRequest {
  const common = {
    container: opts.container,
    tailLines: opts.tailLines,
    sinceSeconds: opts.sinceSeconds,
    timestamps: opts.timestamps,
    previous: opts.previous || null,
  };

  if (opts.isDeployment) {
    if (opts.deploymentPodNames.length === 0) {
      return { kind: "unavailable", reason: "This deployment has no running pods to stream." };
    }
    return {
      kind: "stream",
      command: "stream_multi_pod_logs",
      args: {
        pods: opts.deploymentPodNames,
        namespace: opts.resource?.metadata?.namespace ?? "",
        ...common,
      },
    };
  }

  const resource = opts.resource;
  if (!resource || resource.kind.toLowerCase() !== "pod") {
    // The selection can vanish mid-start — a watch event dropping the pod nulls
    // it out from under us.
    return { kind: "unavailable", reason: "No pod selected to stream logs from." };
  }
  return {
    kind: "stream",
    command: "stream_pod_logs",
    args: {
      name: resource.metadata.name,
      namespace: resource.metadata.namespace ?? "",
      ...common,
    },
  };
}

export interface EmptyStateOptions {
  phase: StreamPhase;
  /** Whether any line arrived at all, before filtering. */
  hasLogs: boolean;
  levelFilter: LogLevel;
  filterText: string;
  isDeployment: boolean;
  podsLoading: boolean;
  deploymentPodCount: number;
  /** Duration window phrased for "nothing in the last {…}" — e.g. "1 day". */
  sinceWindowLabel: string;
  errorMessage?: string;
}

/**
 * The message shown in place of the log list when nothing is visible.
 *
 * Only called when the filtered list is empty, so `hasLogs` alone distinguishes
 * "filters hid everything" from "nothing arrived".
 */
export function streamEmptyStateMessage(opts: EmptyStateOptions): string {
  const hasLevelFilter = opts.levelFilter !== "all";
  const hasSearchFilter = opts.filterText.trim().length > 0;

  // Lines did arrive but the active filters hide all of them — the filters are
  // the story, not the stream phase.
  if (opts.hasLogs) {
    if (hasLevelFilter && hasSearchFilter) {
      return `No ${opts.levelFilter.toUpperCase()} logs match the current search.`;
    }
    if (hasLevelFilter) {
      return `No logs found for level ${opts.levelFilter.toUpperCase()}.`;
    }
    if (hasSearchFilter) {
      return "No logs match the current search.";
    }
  }

  switch (opts.phase) {
    case "connecting":
      return "Connecting to log stream...";
    case "live":
      return `Connected — waiting for output. Nothing logged in the last ${opts.sinceWindowLabel}.`;
    case "ended":
      return "Log stream ended.";
    case "error":
      return opts.errorMessage ?? "The log stream stopped unexpectedly.";
    case "idle":
      break;
  }

  if (opts.isDeployment && opts.podsLoading) return "Loading pods...";
  if (opts.isDeployment && opts.deploymentPodCount === 0) {
    return "No pods found for this deployment";
  }
  return "Select a container and press Stream to start";
}
