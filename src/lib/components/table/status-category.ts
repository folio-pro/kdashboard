// Status text → visual category, shared by the table row and the detail
// panels' StatusBadge. One map so "ImagePullBackOff" is red everywhere.

export type StatusCategory = "success" | "warning" | "error" | "info" | "orange" | "muted";

const STATUS_CATEGORY: Record<string, StatusCategory> = {
  running: "success",
  active: "success",
  ready: "success",
  available: "success",
  bound: "success",
  "true": "success",
  succeeded: "info",
  completed: "info",
  complete: "info",
  pending: "warning",
  containercreating: "warning",
  waiting: "warning",
  failed: "error",
  error: "error",
  crashloopbackoff: "error",
  imagepullbackoff: "error",
  errimagepull: "error",
  evicted: "error",
  oomkilled: "error",
  "false": "error",
  terminating: "orange",
  unknown: "muted",
  // core/v1 Event types (global Events view)
  normal: "muted",
  warning: "warning",
};

const CATEGORY_COLOR: Record<StatusCategory, string> = {
  success: "var(--status-running)",
  warning: "var(--status-pending)",
  error: "var(--status-failed)",
  info: "var(--status-succeeded)",
  orange: "var(--status-terminating)",
  muted: "var(--text-muted)",
};

export function statusCategory(status: string): StatusCategory {
  return STATUS_CATEGORY[status.toLowerCase()] ?? "muted";
}

export function statusColor(category: StatusCategory): string {
  return CATEGORY_COLOR[category];
}

/**
 * Whether the table paints this status without colour. A healthy or finished
 * row is the normal case and should not compete with the rows that need
 * attention — so success, info and unknown render as plain muted text, and
 * only warning / error / terminating get a tinted pill. The detail panels
 * keep their coloured badges for every category (see StatusBadge).
 */
export function isQuietStatus(category: StatusCategory): boolean {
  return category === "success" || category === "info" || category === "muted";
}

/**
 * Severity shown in the row's left gutter: a 2px bar for problems only, so a
 * scroll through a long list lands the eye on the rows that matter.
 */
export function rowSeverity(category: StatusCategory): "error" | "warning" | null {
  if (category === "error") return "error";
  if (category === "warning" || category === "orange") return "warning";
  return null;
}
