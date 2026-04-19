/**
 * Shared color utilities for Kubernetes context badges.
 * Used by both ClusterRail (sidebar) and SettingsView (context customization preview).
 */

export const CONTEXT_COLORS = [
  "--accent",
  "--status-succeeded",
  "--status-running",
  "--status-pending",
  "--status-terminating",
] as const;

export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function getContextColor(name: string): string {
  return CONTEXT_COLORS[hashString(name) % CONTEXT_COLORS.length];
}
