export function formatAge(timestamp: string): string {
  if (!timestamp) return "Unknown";

  const now = Date.now();
  const created = new Date(timestamp).getTime();
  const diffMs = now - created;

  if (diffMs < 0) return "< 1s";

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m${remainingSeconds}s` : `${minutes}m`;
  }
  if (seconds > 0) return `${seconds}s`;

  return "< 1s";
}

/** Relative time like "5s ago", "3m ago", "2h ago", or a short date for older entries. */
export function formatRelativeTime(timestamp: string): string {
  if (!timestamp) return "—";
  const d = new Date(timestamp);
  const diff = Date.now() - d.getTime();

  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatTimestamp(timestamp: string): string {
  if (!timestamp) return "Unknown";
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return timestamp;
  }
}
