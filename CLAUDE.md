# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

kdashboard — an Electron + Svelte 5 desktop IDE for Kubernetes. Three processes:
the sandboxed renderer (`src/`), the preload bridge (`electron/preload.ts`), and
the Node main process (`electron/`) which talks to clusters via
`@kubernetes/client-node`. No in-cluster agent. The only HTTP listeners on the
host are the loopback MCP endpoints of the AI agent feature (`electron/agent/`):
a per-session one (random port, alive only while an Agent Session runs) and an
opt-in external one (fixed port, Settings → AI Agent) for other MCP clients.

## Commands

```bash
bun install                  # electron is in trustedDependencies — Bun would
                             # otherwise skip the postinstall that downloads the
                             # ~211 MB Electron binary and dev:electron dies

bun run dev:electron         # full app (main + preload + renderer, HMR + restart)
bun run dev                  # renderer only, in a browser — NO window.electronAPI,
                             # so every invoke() rejects. This is the e2e target.
bun run build:electron       # electron-vite build -> out/, electron-builder -> release/

bun run typecheck:electron   # tsc on electron/ (the only typecheck script)
bunx svelte-check            # renderer typecheck — no npm script, run it directly
```

### Tests

`bunfig.toml` pins the bun test root to `src`, so the two unit suites are
separate invocations:

```bash
bun run test                 # both unit suites (bun test && bun test ./electron)
bun test                     # frontend only (src/)
bun test ./electron          # Electron backend only
bun test src/lib/stores/ui.test.ts          # single file
bun test ./electron -t "drain"              # single test by name

bun run test:integration     # node:test via tsx against a real cluster
bun run test:e2e             # Playwright (starts `bun run dev` itself)
bunx playwright test e2e/resource-table.spec.ts -g "sorts"   # single e2e test
bun run benchmark            # frontend perf harness, prod build, 3 runs (scripts/bench/README.md)
```

Integration tests run under **Node, not Bun** — the apiserver TLS bridge uses
undici's global dispatcher, which Bun's `fetch` ignores. They skip entirely
unless `KDASH_TEST_CONTEXT` is set:

```bash
./scripts/dev-cluster.sh                    # seeded Kind cluster for manual testing
KDASH_TEST_CONTEXT=kind-kdash-dev bun run test:integration
node --import tsx --test electron/integration/k8s.itest.ts   # one integration file
```

`RENDERER_PORT` overrides the dev/e2e port (default 1420). Set it when several
worktrees of this repo are running — `strictPort` plus `reuseExistingServer`
otherwise lets a sibling checkout's dev server silently become the system under
test. `playwright.bench.config.ts` is the same suite pinned to 1421 with reuse
disabled.

## Architecture

### The IPC seam

Everything crosses on **one** channel. `src/lib/ipc/core.ts` `invoke(cmd, args)`
→ `window.electronAPI.invoke` (preload) → `ipcMain.handle('k8s:invoke')` →
`buildDispatcher` in `electron/dispatch.ts` → a handler from the map. Commands
are addressed by snake_case name (`list_resources`, `get_pod_metrics`,
`start_resource_watch`). Streams go the other way on five event channels:
`terminal-output`, `terminal-exit`, `log-lines`, `port-forward-closed`,
`resource-watch-event`, subscribed through `src/lib/ipc/event.ts` `listen()`.

The only synchronous call in the bridge is `bootSettings()` (`k8s:boot-settings`),
which exists so the persisted theme is applied before first paint. Keep it that
way.

**Adding a backend command:** add `handlers.set('snake_case_name', fn)` in the
relevant `electron/handlers/*.ts` `register()`, and — if the module is new —
import it into the module list in `electron/main.ts` and, when it should be
integration-tested, into `electron/integration/setup.ts`. Only `Error.message`
crosses the boundary, so throw messages a user could act on; `dispatch` runs
them through `describeInvokeError` (`electron/k8s/errors.ts`).

### Wire casing (the renderer stores depend on this — do not "normalize" it)

- `Resource`, `ResourceMetadata`, `ResourceList`, `EventItem`, `WatchEvent`:
  **snake_case** top-level keys (`api_version`, `resource_version`,
  `creation_timestamp`, `owner_references`, `event_type`, `type`).
- Everything *inside* `spec`/`status`/`involvedObject` stays **camelCase**, as
  the k8s API returns it.

Handler args are whatever the frontend sends, usually camelCase. `invoke()`
JSON round-trips args that contain objects, because Svelte 5 `$state` proxies
throw on structured clone.

### Kind registry

`electron/k8s/kinds.ts` is the single source of truth for built-in kinds — API
coordinates, scope, aliases, and the per-kind LIST field projection.
`resources.ts`, `watch.ts`, `resource-mapping.ts`, and diagnostics all read from
it, so **adding a built-in kind is one row**. The renderer's navigable list is
`src/lib/resource-catalog.ts`; its `type` values must exist in `RESOURCE_TYPES`
unless flagged `virtual` (app views like topology/security/port-forwards).

List paths use lean projections (`listProjectionFor`, `listMetaFrom` — which
strips `last-applied-configuration`); detail paths (`get_resource`,
`get_resource_yaml`) keep the full object. Watch events reuse the *list*
projection because they replace list rows wholesale.

All k8s access goes through the factories in `electron/k8s/client.ts` — never
construct a `KubeConfig` in a handler. Register `onConfigChange` to drop
per-cluster caches on context switch.

### Renderer stores: the `.logic.ts` / `.svelte.ts` split

Every store in `src/lib/stores/` is a pair:

- `x.logic.ts` — a plain class holding all state fields and logic. Unit-testable
  under `bun test` with no Svelte runtime. This is where behavior belongs.
- `x.svelte.ts` — a subclass that `override`s each field with `$state(...)` and
  exports the singleton.

Because `useDefineForClassFields` is on, base-class field declarations create
own data properties that shadow the compiled `$state` accessors. Every
`.svelte.ts` subclass constructor **must** call `unshadowState(this)`
(`stores/_unshadow.ts`) — in the leaf constructor, after `super()`, before any
hydration. Omitting it produces a store that looks fine and is silently
non-reactive.

Use `$state.raw` for backend payloads (resource lists, CRD rows, topology/cost/
security overviews). They are immutable snapshots replaced wholesale; deep
proxying allocates a Proxy per object across thousands of items. The
consequence: writers must **reassign** rather than mutate.

### Tabs and views

`ui.logic.ts` owns the tab system. Global state (sidebar, palette, tabs,
activeTabId) lives on the store; per-tab state (filter, sort, selection, cached
items/resource, namespace) lives on the `Tab` and is reached through getters
that read `activeTab`. Tab switching restores cache synchronously via
`utils/tabLifecycle.ts` to avoid an empty-state flash. Cached lists are boxed in
the `CachedItems` class specifically to escape Svelte's proxying.

### Performance invariants

These are deliberate and easy to regress: virtualized tables (TanStack Virtual),
lean list projections, batched watch deltas (20 events / 50 ms in `watch.ts`),
`scheduleFlush` in `utils/frame-scheduler.ts` (rAF raced against a timeout so a
backgrounded window still drains), `LazyView` for CodeMirror/terminal/detail
panels, and the `vendorChunks` split in `vite.shared.ts`.

### UI

Read `src/lib/components/ui/README.md` before touching components. Tokens in
`src/app.css` (never a literal color), fixed height/type/radius/tone scales, and
primitives imported from `$lib/components/ui`. If you're writing
`class="h-7"` on a `Button`, fix the scale, not the call site. Themes are listed
in `THEME_CHROME` in `electron/main.ts` and must stay in sync with the
`[data-theme=…]` palettes in `app.css`.

`src/lib/extensions/` is an optional-capability registry (named UI slots,
actions, palette commands, settings tabs, startup hooks). Core must render
correctly with nothing registered.

## Build config gotchas

- The preload bundles to **CJS** (`out/preload/index.cjs`). The renderer runs
  sandboxed, and Electron's sandboxed-preload loader only understands CommonJS.
- Main/preload bundle every dep except `electron`, Node built-ins, and
  `electron-updater`. electron-vite 5 externalizes everything under
  `dependencies` by default, so that split is enforced through package.json:
  `dependencies` holds **only** `electron-updater` (`handlers/updater.ts`
  require()s it at runtime, so it must exist as files in the asar) and every
  other package lives in `devDependencies`. Moving a package back into
  `dependencies` un-bundles it from main/preload and makes electron-builder copy
  it into `app.asar` — that regression is invisible in a dev run and in a
  packaged app launched from inside the repo, because Node resolves the missing
  module from the checkout's own `node_modules`. Test packaged builds from
  outside the repo tree.
- `codemirrorDedupe` in `vite.shared.ts` prevents "Unrecognized extension value"
  from duplicated CodeMirror copies.
- electron-vite does **not** minify by default; all three bundles set
  `minify: "esbuild"` explicitly (main is ~10 MB unminified, ~3.4 MB minified,
  because `@kubernetes/client-node` ships three generated layers per API).
- The main entry is `electron/bootstrap.ts`, not `main.ts`: it enables Node's
  on-disk compile cache and then `await import('./main')`s, so the real bundle
  is a separate chunk the cache covers. Keep the `await` (Electron holds
  `ready` until the entry has evaluated; main.ts's module scope must run
  first) and keep `chunkFileNames` flat (`__dirname`-relative preload and
  renderer paths break if the chunk lands under `chunks/`).
- `fixPathEnv` (login-shell PATH probe) is async and cached in
  `<userData>/login-shell.path`; `dispatch` waits on `pathReady`, so nothing
  that spawns a tool can run against the bare GUI PATH. Don't add spawn
  paths that bypass the dispatcher.
- Two Vite configs on purpose: `electron.vite.config.ts` (app) and
  `vite.config.ts` (renderer-only, used by `dev` and the Playwright webServer).
  Shared renderer settings live in `vite.shared.ts`.

## Conventions

Conventional Commits, imperative subject under 72 chars, scoped where useful
(`fix(topology): …`). Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`,
`perf`, `ci`. Behavior changes need tests — the codebase's `.logic.ts` split
exists to make that cheap.
