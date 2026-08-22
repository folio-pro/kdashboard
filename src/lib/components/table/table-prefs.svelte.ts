// Screen preferences for resource tables: which columns each type shows, how
// wide the detail aside is. localStorage (like the tab session) rather than
// settings: not cluster state, cheap to lose, one object under one key.

const STORAGE_KEY = "kdashboard-table-prefs-v1";

export const ASIDE_MIN_WIDTH = 320;
export const ASIDE_DEFAULT_WIDTH = 440;

interface Prefs {
  /**
   * Column keys the user toggled away from their default, per resource type.
   * For a column shown by default that means hidden; for one the type ships
   * hidden (`Column.defaultHidden`) it means shown.
   */
  hidden: Record<string, string[]>;
  /** Preferred width of the docked detail aside, in px; the aside caps it to the room it has. */
  asideWidth: number;
}

const DEFAULTS: Prefs = { hidden: {}, asideWidth: ASIDE_DEFAULT_WIDTH };

function load(): Prefs {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Prefs> | null;
    if (!raw || typeof raw !== "object") return DEFAULTS;
    const hidden: Prefs["hidden"] = {};
    for (const [type, keys] of Object.entries(raw.hidden ?? {})) {
      if (Array.isArray(keys)) hidden[type] = keys.filter((k): k is string => typeof k === "string");
    }
    // Only the floor is known here; the ceiling depends on the window, so the
    // aside clamps the rendered width to what the row can spare.
    const asideWidth =
      typeof raw.asideWidth === "number" && Number.isFinite(raw.asideWidth) && raw.asideWidth >= ASIDE_MIN_WIDTH
        ? raw.asideWidth
        : ASIDE_DEFAULT_WIDTH;
    return { hidden, asideWidth };
  } catch {
    return DEFAULTS;
  }
}

class TablePrefs {
  private prefs = $state<Prefs>(load());

  get asideWidth(): number {
    return this.prefs.asideWidth;
  }

  isHidden(resourceType: string, key: string, defaultHidden = false): boolean {
    const toggled = this.prefs.hidden[resourceType]?.includes(key) ?? false;
    return toggled !== defaultHidden;
  }

  hiddenCount(resourceType: string): number {
    return this.prefs.hidden[resourceType]?.length ?? 0;
  }

  toggleColumn(resourceType: string, key: string): void {
    const current = this.prefs.hidden[resourceType] ?? [];
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    this.update({ hidden: { ...this.prefs.hidden, [resourceType]: next } });
  }

  resetColumns(resourceType: string): void {
    const { [resourceType]: _, ...rest } = this.prefs.hidden;
    this.update({ hidden: rest });
  }

  setAsideWidth(width: number): void {
    if (!Number.isFinite(width)) return;
    this.update({ asideWidth: Math.max(ASIDE_MIN_WIDTH, Math.round(width)) });
  }

  private update(patch: Partial<Prefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
    } catch {
      // Quota or disabled storage: the choice stays session-local.
    }
  }
}

export const tablePrefs = new TablePrefs();
