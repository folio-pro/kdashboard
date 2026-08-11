<script lang="ts">
  import { SHORTCUTS, type ShortcutScope } from "$lib/shortcuts";

  const SCOPE_LABELS: Record<ShortcutScope, string> = {
    global: "Anywhere",
    table: "Resource list",
    details: "Resource detail",
  };

  const SCOPE_ORDER: ShortcutScope[] = ["global", "table", "details"];

  // Grouped from the registry rather than hand-listed, so a shortcut can no
  // longer exist without appearing here (or appear here without existing).
  const groups = SCOPE_ORDER.map((scope) => ({
    scope,
    label: SCOPE_LABELS[scope],
    items: SHORTCUTS.filter((s) => s.scope === scope),
  })).filter((g) => g.items.length > 0);
</script>

<!-- Keyboard Shortcuts -->
<section>
  <h2 class="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">Keyboard Shortcuts</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Quick reference for navigating kdashboard with your keyboard.
  </p>

  {#each groups as group (group.scope)}
    <h3 class="mt-5 mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
      {group.label}
    </h3>
    <div class="grid grid-cols-2 gap-x-8 gap-y-1">
      {#each group.items as shortcut (shortcut.id)}
        <div class="flex items-center justify-between gap-3 rounded px-2 py-1 hover:bg-[var(--bg-secondary)]">
          <span class="text-[11px] text-[var(--text-secondary)]">{shortcut.label}</span>
          <kbd class="shrink-0 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">{shortcut.keys}</kbd>
        </div>
      {/each}
    </div>
  {/each}
</section>
