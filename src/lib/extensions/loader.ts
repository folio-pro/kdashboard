// Loading user extensions: discovered by the main process
// (`list_extensions`), evaluated here as ES modules from blob URLs, then
// activated against an ExtensionContext. Failures are recorded per extension
// and never stop the app; the Settings → Extensions tab shows them.

import type { ExtensionContext, ExtensionModule } from "./api";
import { API_VERSION } from "./api";

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  main: string;
  api: number;
}

/** One discovered extension directory, as the main process reports it. */
export type ExtensionSource =
  | { ok: true; dir: string; manifest: ExtensionManifest; source: string }
  | { ok: false; dir: string; manifest: ExtensionManifest | null; error: string };

export interface ExtensionStatus {
  id: string;
  name: string;
  version: string;
  description?: string;
  dir: string;
  state: "active" | "failed" | "invalid";
  error: string | null;
  /** What it registered, for the Settings tab. */
  registered: string[];
}

/** Import an ES module from source text. Overridable for tests. */
export type ModuleImporter = (source: string, id: string) => Promise<unknown>;

export const blobImporter: ModuleImporter = async (source, id) => {
  const blob = new Blob([`${source}\n//# sourceURL=kdashboard-extension:${id}`], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** Pick the ExtensionModule out of whatever the module exported. */
export function moduleOf(exported: unknown): ExtensionModule | null {
  if (!exported || typeof exported !== "object") return null;
  const e = exported as { default?: unknown; activate?: unknown };
  const candidate = (e.default && typeof e.default === "object" ? e.default : typeof e.activate === "function" ? e : null) as ExtensionModule | null;
  if (!candidate || typeof candidate.activate !== "function") return null;
  return candidate;
}

export interface LoadDeps {
  importer: ModuleImporter;
  /** Build the context for one extension; `registered` collects what it registers. */
  makeContext: (id: string, registered: string[]) => ExtensionContext;
}

/**
 * Activate every discovered extension in order. Returns a status per
 * extension; never throws. Pure with respect to the app: the caller injects
 * the importer and the context factory.
 */
export async function loadExtensions(sources: readonly ExtensionSource[], deps: LoadDeps): Promise<ExtensionStatus[]> {
  const out: ExtensionStatus[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    const id = src.manifest?.id ?? src.dir.split(/[\\/]/).pop() ?? "unknown";
    const base = { id, name: src.manifest?.name ?? id, version: src.manifest?.version ?? "?", description: src.manifest?.description, dir: src.dir };
    if (!src.ok) {
      out.push({ ...base, state: "invalid", error: src.error, registered: [] });
      continue;
    }
    if (seen.has(id)) {
      out.push({ ...base, state: "invalid", error: `duplicate extension id "${id}"`, registered: [] });
      continue;
    }
    seen.add(id);
    if (src.manifest.api !== API_VERSION) {
      out.push({ ...base, state: "invalid", error: `written for API ${src.manifest.api}, this build provides ${API_VERSION}`, registered: [] });
      continue;
    }
    const registered: string[] = [];
    try {
      const mod = moduleOf(await deps.importer(src.source, id));
      if (!mod) throw new Error("entry module has no default export with an activate() function");
      await mod.activate(deps.makeContext(id, registered));
      out.push({ ...base, state: "active", error: null, registered });
    } catch (err) {
      out.push({ ...base, state: "failed", error: err instanceof Error ? err.message : String(err), registered });
    }
  }
  return out;
}
