<script lang="ts">
</script>

<!-- Keyboard Shortcuts -->
<section>
  <h2 class="text-xs font-semibold uppercase tracking-wider text-[var(--text-primary)]">Keyboard Shortcuts</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Quick reference for navigating kdashboard with your keyboard.
  </p>
  <div class="mt-4 grid grid-cols-2 gap-x-8 gap-y-2.5">
    {#each [
      { keys: "\u2318 K", desc: "Open command palette" },
      { keys: "\u2318 ,", desc: "Open settings" },
      { keys: "\u2318 B", desc: "Toggle sidebar" },
      { keys: "Esc", desc: "Go back / close overlay" },
      { keys: "\u2191 / \u2193", desc: "Navigate table rows" },
      { keys: "\u21B5", desc: "Open resource details" },
    ] as shortcut}
      <div class="flex items-center justify-between gap-3 rounded px-2 py-1 hover:bg-[var(--bg-secondary)]">
        <span class="text-[11px] text-[var(--text-secondary)]">{shortcut.desc}</span>
        <kbd class="shrink-0 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">{shortcut.keys}</kbd>
      </div>
    {/each}
  </div>
</section>
