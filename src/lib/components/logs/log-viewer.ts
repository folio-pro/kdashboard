// Pure logic extracted from LogViewer.svelte — no Svelte imports, no $state/$derived.

import type { Resource } from "$lib/types";

// --- Types ---

/** The level FILTER the toolbar offers. `all` is not a line level. */
export type LogLevel = "all" | "info" | "warn" | "error";

/** A level a line can carry. Lines without a recognisable level carry `null`. */
export type LineLevel = "error" | "warn" | "info" | "debug";

export interface LogLine {
  id: number;
  podName?: string;
  timestamp?: string;
  message: string;
  /**
   * `null` when the line has no level token at all (nginx access lines, plain
   * prints, `[stream ended]`). It used to default to `debug`, which invented a
   * level the log never had and let the `info` filter hide a pod's entire
   * output.
   */
  level: LineLevel | null;
  isJson: boolean;
  jsonFormatted?: string;
  _jsonHighlightedCache?: string;
}

// --- Regex patterns ---

/**
 * A level token that stands on its own: at the start of the line or after
 * whitespace / `[` / `=` / `(` / `<` / a quote, and followed by the end or a
 * separator. Plain `\b` matched inside URL paths (`GET /debug`) and identifiers
 * (`stderr` no, but `error_count=` yes); these boundaries only accept the
 * places a log framework actually prints its level: `INFO`, `[warn]`,
 * `level=error`, `"ERR"`, `(fatal)`, `Error:`.
 *
 * The FIRST token in the line wins. Structured loggers print the level before
 * the message, so `WARN request failed: error=timeout` is a warning, not an
 * error — the old "error beats warn" priority read the message body instead.
 */
const LEVEL_TOKEN =
  /(?<=^|[\s[=(<"'])(trace|debug|info|notice|warn|warning|err|error|fatal|panic|critical)(?=$|[\s\]:=)>,;."'])/i;

/**
 * klog / glog prefix: `I0904 12:52:02.123456       1 server.go:120] …`. The
 * severity is the single leading letter (Info, Warning, Error, Fatal).
 */
const KLOG_PREFIX = /^([IWEF])\d{4} \d{2}:\d{2}:\d{2}/;

/**
 * `"level"` / `"severity"` fields of a JSON line, string or numeric (pino
 * prints numbers: 10 trace … 60 fatal). Matched textually rather than parsed
 * so a line that is JSON-shaped but not valid JSON still classifies.
 */
const JSON_LEVEL_FIELD = /"(?:level|severity)"\s*:\s*(?:"([A-Za-z]+)"|(\d+))/;

export const TS_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)/;
export const POD_PREFIX_REGEX = /^\[([^\]]+)\]\s+(.*)/s;

// --- Pure functions ---

/** Map a level word (any case) onto the four display levels. */
function levelFromWord(word: string): LineLevel | null {
  switch (word.toLowerCase()) {
    case "trace":
    case "debug":
      return "debug";
    case "info":
    case "notice":
      return "info";
    case "warn":
    case "warning":
      return "warn";
    case "err":
    case "error":
    case "fatal":
    case "panic":
    case "critical":
      return "error";
    default:
      return null;
  }
}

/** pino / bunyan numeric levels. */
function levelFromNumber(n: number): LineLevel | null {
  if (n >= 50) return "error";
  if (n >= 40) return "warn";
  if (n >= 30) return "info";
  if (n >= 10) return "debug";
  return null;
}

/**
 * The level a line explicitly declares, or `null` when it declares none.
 *
 * Only explicit tokens count: a klog prefix, a JSON `level`/`severity` field,
 * or a standalone level word (see LEVEL_TOKEN). Anything else — an nginx
 * access line, a stack trace frame, a bare `println` — has no level, and the
 * viewer must not invent one: a guessed `DEBUG` badge is wrong on its face,
 * and a guessed level lets a filter hide lines the user never classified.
 */
export function detectLevel(message: string): LineLevel | null {
  const klog = KLOG_PREFIX.exec(message);
  if (klog) {
    switch (klog[1]) {
      case "I":
        return "info";
      case "W":
        return "warn";
      default:
        return "error";
    }
  }

  // A JSON line's own level field is authoritative, even when its value is one
  // we do not recognise: falling through to the word scan would classify the
  // line by whatever its message happens to say.
  const json = JSON_LEVEL_FIELD.exec(message);
  if (json) {
    return json[1] !== undefined ? levelFromWord(json[1]) : levelFromNumber(Number(json[2]));
  }

  const token = LEVEL_TOKEN.exec(message);
  return token ? levelFromWord(token[1]) : null;
}

/**
 * Whether a line's level passes the toolbar's level filter.
 *
 * Unlevelled lines (`null`) are deliberately shown by `all` AND by `info`:
 * plain output is the informational stream of a pod — an nginx access log, a
 * shell script's prints — and an `info` filter that dropped it would blank the
 * viewer for most pods. `warn` and `error` are requests for lines that flagged
 * themselves as trouble, so they hide unlevelled lines along with `debug`.
 */
export function levelMatches(level: LineLevel | null, filter: LogLevel): boolean {
  if (filter === "all") return true;
  if (level === null) return filter === "info";
  return level === filter;
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
      (!hasLevelFilter || levelMatches(l.level, opts.levelFilter)) &&
      (!textMatcher || textMatcher(l.message)),
  );
}

// --- Export ---

/**
 * The displayed lines as a plain-text document: exactly the columns the row
 * shows (source prefix, timestamp when shown, message), one line each, so a
 * download or a paste matches what the user was looking at. JSON lines go out
 * as their single-line original rather than the pretty-printed view — a log
 * file with one JSON object per line stays greppable and re-parseable.
 */
export function formatLogsForExport(lines: LogLine[], opts: { timestamps: boolean }): string {
  const out: string[] = [];
  for (const line of lines) {
    let text = line.message;
    if (opts.timestamps && line.timestamp) text = `${line.timestamp} ${text}`;
    if (line.podName) text = "[" + line.podName + "] " + text;
    out.push(text);
  }
  return out.join("\n");
}

/**
 * `<pod>[-<container>]-<yyyymmdd>-<hhmmss>.log`. Only the characters a file
 * system is guaranteed to accept — resource names are DNS labels already, but
 * the sentinel container value and a missing name must not reach the dialog.
 */
export function exportFileName(
  resourceName: string | undefined,
  container: string,
  now: Date = new Date(),
): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const parts = [safe(resourceName ?? "logs") || "logs"];
  if (container && container !== ALL_CONTAINERS) parts.push(safe(container));
  return `${parts.join("-")}-${stamp}.log`;
}

// --- Line wrap preference ---

export const WRAP_STORAGE_KEY = "kdash:logs:wrap";

/** The subset of the Storage interface the preference helpers touch. */
export interface WrapStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Whether long lines wrap. Defaults to wrapping — the behaviour the viewer
 * always had — and survives corrupt or unavailable storage.
 */
export function readWrapPreference(storage: WrapStorage | undefined): boolean {
  if (!storage) return true;
  try {
    const raw = storage.getItem(WRAP_STORAGE_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

export function writeWrapPreference(storage: WrapStorage | undefined, wrap: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(WRAP_STORAGE_KEY, wrap ? "1" : "0");
  } catch {
    // Quota exceeded or storage disabled — the preference is best-effort.
  }
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

/**
 * Container-picker value meaning "every container of the pod". Not a legal
 * container name (DNS label), so it can never collide with a real one.
 */
export const ALL_CONTAINERS = "*";

export interface StreamRequestOptions {
  resource: Resource | null;
  isDeployment: boolean;
  deploymentPodNames: string[];
  /** A container name, or ALL_CONTAINERS. */
  container: string;
  /** Every container of the pod — what ALL_CONTAINERS expands to. */
  containers?: string[];
  tailLines: number;
  sinceSeconds: number | null;
  timestamps: boolean;
  previous: boolean;
}

/** Decide which stream command serves the current selection, if any. */
export function buildStreamRequest(opts: StreamRequestOptions): StreamRequest {
  const all = opts.container === ALL_CONTAINERS;
  const containers = all ? (opts.containers ?? []) : [];
  const common = {
    // The multi-pod stream takes one container; "all" there means the first.
    container: all ? (containers[0] ?? "") : opts.container,
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
  if (all && containers.length === 0) {
    return { kind: "unavailable", reason: "This pod reports no containers to stream." };
  }
  return {
    kind: "stream",
    command: "stream_pod_logs",
    args: {
      name: resource.metadata.name,
      namespace: resource.metadata.namespace ?? "",
      ...common,
      // Two or more: the backend opens one reader per container and prefixes
      // every line with `[container] `, which POD_PREFIX_REGEX then peels off
      // into the row's source chip. A single container streams the plain way.
      ...(containers.length > 1 ? { containers } : {}),
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
