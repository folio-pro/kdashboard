// Pure constants extracted from LogViewer.svelte — no Svelte imports, no $state/$derived.

import type { LogLine } from "./log-viewer";

// --- Types ---

export type TailLines = 100 | 500 | 1000 | 5000;
export type SinceDuration = "5m" | "15m" | "1h" | "6h" | "1d" | "3d" | "7d";

// --- Since options ---

export const SINCE_OPTIONS: { label: string; value: SinceDuration; seconds: number }[] = [
  { label: "5 min ago", value: "5m", seconds: 300 },
  { label: "15 min ago", value: "15m", seconds: 900 },
  { label: "1 hour ago", value: "1h", seconds: 3600 },
  { label: "6 hours ago", value: "6h", seconds: 21600 },
  { label: "1 day ago", value: "1d", seconds: 86400 },
  { label: "3 days ago", value: "3d", seconds: 259200 },
  { label: "7 days ago", value: "7d", seconds: 604800 },
];

export const SINCE_LABELS = new Map(SINCE_OPTIONS.map((o) => [o.value, o.label]));
export const SINCE_SECONDS = new Map(SINCE_OPTIONS.map((o) => [o.value, o.seconds]));

/**
 * The same durations phrased as a window ("1 day") instead of a point in time
 * ("1 day ago"), so they read correctly inside "nothing in the last {…}".
 */
export const SINCE_WINDOW_LABELS = new Map(
  SINCE_OPTIONS.map((o) => [o.value, o.label.replace(/ ago$/, "")]),
);

// --- Tail options ---

export const TAIL_OPTIONS: TailLines[] = [100, 500, 1000, 5000];

// --- Level display constants ---

export const LEVEL_BADGE_COLORS: Record<LogLine["level"], string> = {
  error: "text-[var(--log-error)]",
  warn: "text-[var(--log-warn)]",
  info: "text-[var(--log-info)]",
  debug: "text-[var(--log-debug)]",
};

export const LEVEL_LABELS: Record<LogLine["level"], string> = {
  error: "ERROR",
  warn: "WARN",
  info: "INFO",
  debug: "DEBUG",
};

export const MESSAGE_COLORS: Record<LogLine["level"], string> = {
  error: "text-[var(--log-error)]",
  warn: "text-[var(--log-warn)]",
  info: "text-[var(--text-secondary)]",
  debug: "text-[var(--text-secondary)]",
};

export const LEVEL_PILL_COLORS: Record<LogLine["level"], string> = {
  error: "bg-[var(--log-error)]/15 text-[var(--log-error)]",
  warn: "bg-[var(--log-warn)]/15 text-[var(--log-warn)]",
  info: "bg-[var(--log-info)]/15 text-[var(--log-info)]",
  debug: "bg-[var(--log-debug)]/15 text-[var(--log-debug)]",
};
