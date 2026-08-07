/**
 * Idle-time preloading of heavy lazy-loaded views.
 *
 * App.svelte renders DetailPanel / LogViewer / TerminalView / YamlEditor via
 * LazyView (dynamic import) to keep the initial bundle small. The trade-off is
 * that the FIRST time a user opens one of these, the browser has to fetch +
 * evaluate a large vendor chunk (CodeMirror ~493 kB, xterm ~337 kB, the yaml
 * parser ~97 kB), which shows up as a visible stutter — the opposite of "feels
 * native".
 *
 * We warm those chunks during idle time after boot. Vite dedupes dynamic
 * imports by specifier, so importing the same module string here populates the
 * module cache; LazyView's later import() resolves instantly from cache. The
 * specifiers MUST match App.svelte's exactly or a second chunk is produced.
 *
 * Ordered by likelihood of being opened next: detail view is by far the most
 * common follow-up to browsing a list.
 */

type Loader = () => Promise<unknown>;

const PRELOADERS: Loader[] = [
  () => import("$lib/components/details/DetailPanel.svelte"),
  () => import("$lib/components/details/YamlEditor.svelte"),
  () => import("$lib/components/logs/LogViewer.svelte"),
  () => import("$lib/components/terminal/TerminalView.svelte"),
];

function onIdle(cb: () => void, timeout = 2000): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  if (ric) ric(cb, { timeout });
  else setTimeout(cb, timeout);
}

/**
 * Warm the heavy view chunks one at a time during idle periods. Sequential +
 * idle-gated so prefetching never competes with first-paint or user input.
 */
export function preloadHeavyViews(): void {
  let i = 0;
  const next = () => {
    if (i >= PRELOADERS.length) return;
    const load = PRELOADERS[i++];
    load()
      .catch(() => {
        /* prefetch is best-effort; a failed warm just means a normal lazy load later */
      })
      .finally(() => onIdle(next));
  };
  onIdle(next);
}
