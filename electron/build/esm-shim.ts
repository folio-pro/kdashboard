// Relocate electron-vite's CommonJS shim in an ESM main bundle.
//
// electron-vite inserts `__dirname` / `__filename` / `require` shims right
// after what its regex takes for the last static import — but that regex is
// not line-anchored, so `import x from 'y'` text inside a bundled dependency's
// JSDoc or string literal (the MCP SDK and zod both have some) drags the shim
// deep into the file. Two failure modes seen: the shim inside a block comment
// ("ReferenceError: __dirname is not defined" at boot), and the shim after
// undici's `typeof __filename` probe ("Cannot access '__filename' before
// initialization", a TDZ error). This moves the shim block right after the
// real last top-level import. Pure; used by electron.vite.config.ts.

const ESM_SHIM_RE = /\n\/\/ -- CommonJS Shims --\n[\s\S]*?const require = __cjs_mod__\.createRequire\(import\.meta\.url\);\n/;
// Line-anchored, so import-like text in comments/strings does not count.
// Quotes are still single at this stage (vite's esbuild pass normalises later).
const TOP_LEVEL_IMPORT_RE = /^import\b[^;]*?\bfrom\s*["'][^"']+["'];|^import\s*["'][^"']+["'];/gm;

/** Returns `code` unchanged when it carries no shim. */
export function relocateEsmShimCode(code: string): string {
  const match = ESM_SHIM_RE.exec(code);
  if (!match) return code;
  const shim = match[0];
  const stripped = code.slice(0, match.index) + code.slice(match.index + shim.length);
  const imports = [...stripped.matchAll(TOP_LEVEL_IMPORT_RE)];
  const last = imports.at(-1);
  const at = last ? last.index + last[0].length : 0;
  return stripped.slice(0, at) + shim + stripped.slice(at);
}
