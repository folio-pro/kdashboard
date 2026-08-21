// Screen preferences for resource tables: which columns each type shows, how
// wide the detail aside is. localStorage (like the tab session) rather than
// settings: not cluster state, cheap to lose, one object under one key.

const STORAGE_KEY = "kdashboard-table-prefs-v1";

export const ASIDE_MIN_WIDTH = 320;
export const ASIDE_DEFAULT_WIDTH = 440;

interface Prefs {
  /** Hidden column keys, per resource type. */
  hidden: Record<string, string[]>;
  /** Width of the docked detail aside, in px. */
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
    const asideWidth =
      typeof raw.asideWidth === "number" && raw.asideWidth >= ASIDE_MIN_WIDTH ? raw.asideWidth : ASIDE_DEFAULT_WIDTH;
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

  isHidden(resourceType: string, key: string): boolean {
    return this.prefs.hidden[resourceType]?.includes(key) ?? false;
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
