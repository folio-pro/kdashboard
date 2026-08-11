// Pure logic extracted from LogViewer.svelte — no Svelte imports, no $state/$derived.

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
