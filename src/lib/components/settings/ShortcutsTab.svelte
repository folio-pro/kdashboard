<script lang="ts">
  import { Kbd } from "$lib/components/ui";
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
        <div class="flex items-center justify-between gap-3 rounded-sm px-2 py-1 hover:bg-[var(--bg-secondary)]">
          <span class="text-[11px] text-[var(--text-secondary)]">{shortcut.label}</span>
          <Kbd>{shortcut.keys}</Kbd>
        </div>
      {/each}
    </div>
  {/each}
</section>
