// Classifies a list-load failure so the empty state can say what actually
// happened. "Unable to reach cluster · Retry connection" was shown for every
// error, including a 404 from a kind whose CRD is not installed (VPA, WPA) —
// the cluster was fine and retrying could never help.

export type LoadErrorKind = "not-installed" | "forbidden" | "unreachable" | "unknown";

export interface LoadErrorView {
  kind: LoadErrorKind;
  title: string;
  /** Explanation under the title; the raw error is kept for the tooltip. */
  detail: string;
  /** Label of the primary button ("" hides it). */
  action: string;
}

const NOT_FOUND = /\b404\b|not found|could not find the requested resource|the server doesn't have a resource type/i;
const FORBIDDEN = /\b403\b|forbidden|cannot list resource|is forbidden/i;
// Transport failures only. An HTTP 5xx is an answer from a reachable server
// (a CRD's broken conversion webhook, an aggregated API down) and falls
// through to "unknown" with the server's own message — same rule as the
// store's isNetworkErrorMessage.
const UNREACHABLE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|fetch failed|socket hang up|network|unable to connect|connection refused|timed out|dial tcp|no such host|TLS|certificate/i;

export function classifyLoadError(message: string | null | undefined, resourceTypeLabel: string): LoadErrorView {
  const raw = (message ?? "").trim();
  const label = resourceTypeLabel.toLowerCase();
  if (NOT_FOUND.test(raw)) {
    return {
      kind: "not-installed",
      title: `${resourceTypeLabel} not available in this cluster`,
      detail: `The API for ${label} is not served here (the server answered 404). Install the CRD or enable the API group, then refresh.`,
      action: "Refresh",
    };
  }
  if (FORBIDDEN.test(raw)) {
    return {
      kind: "forbidden",
      title: `You cannot list ${label} here`,
      detail: "The cluster refused the request (403). Your kubeconfig user lacks the RBAC permission for this kind in this scope — try another namespace or context.",
      action: "Retry",
    };
  }
  if (UNREACHABLE.test(raw) || raw === "") {
    return {
      kind: "unreachable",
      title: "Unable to reach cluster",
      detail: raw || "The API server did not answer.",
      action: "Retry connection",
    };
  }
  return {
    kind: "unknown",
    title: `Could not load ${label}`,
    detail: raw,
    action: "Retry",
  };
}
