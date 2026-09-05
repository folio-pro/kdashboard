/**
 * Pure helpers for the ConfigMap and Secret detail views: base64 decoding
 * with binary detection, well-known Secret type summaries, and value shape
 * summaries for the collapsible ConfigMap blocks. No Svelte, no IPC.
 */

export interface DecodedValue {
  /** UTF-8 text when `binary` is false; a placeholder description otherwise. */
  text: string;
  /** Decoded length in bytes (0 when the input was not valid base64). */
  bytes: number;
  /** True when the bytes are not valid UTF-8 (or contain NUL) — not for display. */
  binary: boolean;
}

/** Byte length of a base64 payload without decoding it. */
export function base64ByteLength(b64: string): number {
  const clean = b64.replace(/\s+/g, "");
  if (clean.length === 0) return 0;
  let padding = 0;
  if (clean.endsWith("==")) padding = 2;
  else if (clean.endsWith("=")) padding = 1;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/**
 * Decode a base64 Secret value. Bytes that are not valid UTF-8, or that
 * contain a NUL byte, are flagged binary rather than rendered as mojibake.
 * Invalid base64 is returned verbatim (a `stringData`-only Secret arrives
 * un-encoded from the projection).
 */
export function decodeSecretValue(b64: string): DecodedValue {
  let raw: string;
  try {
    raw = atob(b64.replace(/\s+/g, ""));
  } catch {
    return { text: b64, bytes: b64.length, binary: false };
  }
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (bytes.includes(0)) {
    return { text: "", bytes: bytes.length, binary: true };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, bytes: bytes.length, binary: false };
  } catch {
    return { text: "", bytes: bytes.length, binary: true };
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------------
// Secret type summaries
// ---------------------------------------------------------------------------

export const SECRET_TYPE_LABELS: Record<string, string> = {
  Opaque: "Opaque",
  "kubernetes.io/tls": "TLS certificate",
  "kubernetes.io/dockerconfigjson": "Docker registry credentials",
  "kubernetes.io/dockercfg": "Docker registry credentials (legacy)",
  "kubernetes.io/basic-auth": "Basic auth",
  "kubernetes.io/ssh-auth": "SSH key",
  "kubernetes.io/service-account-token": "Service account token",
  "bootstrap.kubernetes.io/token": "Bootstrap token",
  "helm.sh/release.v1": "Helm release",
};

export function secretTypeLabel(type: string | undefined): string {
  const t = type ?? "Opaque";
  return SECRET_TYPE_LABELS[t] ?? t;
}

export interface TlsSummary {
  hasCert: boolean;
  hasKey: boolean;
  hasCa: boolean;
}

/** Which of the TLS Secret's conventional keys are present. */
export function tlsSummary(data: Record<string, unknown> | undefined): TlsSummary {
  const d = data ?? {};
  return {
    hasCert: typeof d["tls.crt"] === "string" && (d["tls.crt"] as string).length > 0,
    hasKey: typeof d["tls.key"] === "string" && (d["tls.key"] as string).length > 0,
    hasCa: typeof d["ca.crt"] === "string" && (d["ca.crt"] as string).length > 0,
  };
}

export interface RegistryAuth {
  registry: string;
  username?: string;
}

/**
 * Registries (and usernames, never passwords) from a
 * `kubernetes.io/dockerconfigjson` or legacy `kubernetes.io/dockercfg` Secret.
 * Both are base64 JSON: the former wraps entries in `auths`, the latter is
 * the map itself. Anything unparseable yields an empty list.
 */
export function dockerRegistries(type: string | undefined, data: Record<string, unknown> | undefined): RegistryAuth[] {
  const key = type === "kubernetes.io/dockercfg" ? ".dockercfg" : ".dockerconfigjson";
  const raw = data?.[key];
  if (typeof raw !== "string") return [];
  const decoded = decodeSecretValue(raw);
  if (decoded.binary) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const map =
    key === ".dockerconfigjson"
      ? (parsed as { auths?: unknown }).auths
      : parsed;
  if (!map || typeof map !== "object") return [];
  const out: RegistryAuth[] = [];
  for (const [registry, entry] of Object.entries(map as Record<string, unknown>)) {
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    let username = typeof e.username === "string" ? e.username : undefined;
    if (!username && typeof e.auth === "string") {
      // `auth` is base64("user:password"); surface the user only.
      const auth = decodeSecretValue(e.auth);
      const idx = auth.binary ? -1 : auth.text.indexOf(":");
      if (idx > 0) username = auth.text.slice(0, idx);
    }
    out.push(username ? { registry, username } : { registry });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ConfigMap value shapes
// ---------------------------------------------------------------------------

export interface ValueSummary {
  lines: number;
  chars: number;
  /** Multi-line or wide enough to deserve a mono block instead of an inline value. */
  block: boolean;
  /** Long enough that the block starts collapsed. */
  long: boolean;
}

export const LONG_VALUE_LINES = 12;
export const LONG_VALUE_CHARS = 1200;

export function summarizeValue(value: string): ValueSummary {
  const lines = value.length === 0 ? 0 : value.split("\n").length;
  const chars = value.length;
  return {
    lines,
    chars,
    block: lines > 1 || chars > 80,
    long: lines > LONG_VALUE_LINES || chars > LONG_VALUE_CHARS,
  };
}
