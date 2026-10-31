// Resource types the quick-edit dialog supports.
//
// Kept in its own yaml-free module on purpose: actions/registry.ts (loaded
// eagerly at boot) only needs this list, but importing it from
// quick-edit.logic.ts dragged the whole `yaml` parser into the initial renderer
// chunk. QuickEditDialog still imports the logic (lazy).
export const QUICK_EDIT_TYPES = ["deployments", "statefulsets", "daemonsets", "cronjobs"];
