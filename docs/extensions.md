# Writing a kdashboard extension

kdashboard loads user extensions at start-up from the `extensions` directory
under its user-data folder (Settings → Extensions → **Open folder**). Each
extension is one directory:

```
extensions/
  audit-log/
    manifest.json
    index.js
```

`manifest.json`:

```json
{
  "id": "audit-log",
  "name": "Audit log",
  "version": "1.0.0",
  "description": "Writes every restart and delete to a file",
  "main": "index.js",
  "api": 1
}
```

`index.js` is an ES module whose default export has an `activate(ctx)` function.
It runs **before the app mounts**; registrations after that throw.

```js
export default {
  activate(ctx) {
    ctx.registerCommand({
      id: "audit-log.open",
      label: "Open audit log",
      category: "Audit",
      action: () => ctx.toast.info("Audit log", `Context ${ctx.cluster.context}`),
    });

    ctx.registerAction({
      id: "audit-log.note",
      label: "Add note…",
      tier: "green",
      group: "operations",
      priority: 90,
      appliesTo: (resourceType) => resourceType === "deployments",
      execute: (resource) => ctx.storage.set(`note:${resource.metadata.name}`, Date.now()),
    });

    ctx.on("context-changed", ({ contextName }) => ctx.log.info("switched to", contextName));

    ctx.onStartup(async () => {
      const pods = await ctx.invoke("list_resources", { resourceType: "pods", namespace: ctx.cluster.namespace });
      ctx.log.info(`${pods.items.length} pods at start-up`);
    });
  },
};
```

## The context

| Member | What it does |
| --- | --- |
| `registerAction(def)` | Row / detail-panel action (`ActionDef`: id, label, tier, group, priority, appliesTo, execute). |
| `registerCommand(item)` | Command-palette entry (`id`, `label`, `category`, `action`). |
| `registerSettingsTab(tab)` | A tab in Settings rendering your Svelte component. |
| `registerMount(mount)` | Mount a component into a named UI slot: `app-overlay`, `app-top-banner`, `sidebar-header`, `sidebar-footer`, `cluster-rail-top`, `cluster-rail-bottom`, `status-bar-start`, `status-bar-end`, `table-header-trailing`, `table-row-leading`, `table-row-trailing`, `detail-panel-actions`, `detail-panel-tabs`. |
| `registerKbdHint(hint)` | A key hint in the status bar. |
| `onStartup(hook)` | Runs after mount. |
| `on(type, handler)` | App events: `context-changed`, `namespace-changed`, `resource-selected`. |
| `invoke(command, args)` | The same IPC the app uses against the cluster (`list_resources`, `get_resource`, `get_resource_yaml`, `apply_yaml`, …). |
| `cluster` | `context`, `namespace`, `selectedResource` (read-only, live). |
| `toast` | `success` / `error` / `warning` / `info`. |
| `openResource(type, name, ns?)` | Opens the detail tab. |
| `openExternal(url)` | System browser. |
| `storage` | `get` / `set` per-extension key/value, persisted in settings. |
| `log` | `info` / `warn` / `error`, prefixed with the extension id. |

The TypeScript types live in `src/lib/extensions/api.ts` (`ExtensionContext`,
`ExtensionModule`, `defineExtension`). `api` in the manifest must equal the
app's `API_VERSION`; a mismatch shows as *invalid* in Settings → Extensions and
the module is not evaluated.

## Rules of the road

- Extensions run in the renderer with the app's privileges. Only install what
  you trust.
- A thrown `activate()` marks the extension *failed* and the app continues.
- Components registered for slots/tabs must be compiled Svelte 5 components;
  plain ES modules can still register commands, actions, hooks and events.
- Reloading an extension means reloading the app (Settings → Extensions →
  **Reload app**).
