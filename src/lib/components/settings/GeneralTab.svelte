<script lang="ts">
  import { cn } from "$lib/utils";
  import { Check } from "lucide-svelte";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { THEME_COLORS, DARK_THEMES, LIGHT_THEMES, type ThemeOption } from "./settings-constants";
  import type { TableDensity } from "$lib/types";

  function selectTheme(themeId: string) {
    settingsStore.updateTheme(themeId);
  }

  function handleDensityChange(density: TableDensity) {
    settingsStore.updateDensity(density);
  }
</script>

<!-- Appearance -->
<section>
  <h2 class="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">Appearance</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Choose a color theme for the interface. The theme applies to the entire application including the sidebar, tables, and detail panels.
  </p>

  {#snippet themeGrid(themes: ThemeOption[])}
    <div class="grid grid-cols-3 gap-2">
      {#each themes as theme}
        {@const colors = THEME_COLORS[theme.id]}
        {@const isActive = settingsStore.settings.theme_mode === theme.id}
        <button
          class={cn(
            "relative flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-[12px] transition-all",
            isActive
              ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]"
              : "border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]"
          )}
          onclick={() => selectTheme(theme.id)}
        >
          {#if colors}
            <div class="flex shrink-0 gap-0.5 overflow-hidden rounded-sm">
              <span class="h-5 w-3.5" style:background-color={colors.bg}></span>
              <span class="h-5 w-3.5" style:background-color={colors.secondary}></span>
              <span class="h-5 w-3.5" style:background-color={colors.accent}></span>
            </div>
          {/if}
          <span class="flex-1">{theme.name}</span>
          {#if isActive}
            <Check class="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
          {/if}
        </button>
      {/each}
    </div>
  {/snippet}

  <!-- Dark Themes -->
  <div class="mt-5">
    <span class="mb-2 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Dark themes</span>
    {@render themeGrid(DARK_THEMES)}
  </div>

  <!-- Light Themes -->
  <div class="mt-4">
    <span class="mb-2 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Light themes</span>
    {@render themeGrid(LIGHT_THEMES)}
  </div>
</section>

<!-- Table Display -->
<section>
  <h2 class="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">Table Display</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Control how resource tables are displayed. Compact fits more rows on screen; Terminal is denser still, in the mono face.
  </p>
  <div class="mt-4 flex gap-2">
    {#each [
      { id: "comfortable" as const, label: "Comfortable", desc: "Room for a status pill on every row", rowCount: 3 },
      { id: "compact" as const, label: "Compact", desc: "Tighter spacing to show more resources at once", rowCount: 5 },
      { id: "terminal" as const, label: "Terminal", desc: "Mono, 26px rows — like a k9s pane", rowCount: 7 },
    ] as option}
      {@const isActive = settingsStore.settings.table_density === option.id}
      <button
        class={cn(
          "flex flex-1 flex-col rounded-lg border px-4 py-3 text-left transition-all",
          isActive
            ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]"
            : "border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--border-hover)]"
        )}
        onclick={() => handleDensityChange(option.id)}
      >
        <div class="flex items-center gap-2">
          <span class="text-[12px] font-medium">{option.label}</span>
          {#if isActive}
            <Check class="h-3.5 w-3.5 text-[var(--accent)]" />
          {/if}
        </div>
        <span class="mt-0.5 text-[10px] text-[var(--text-muted)]">{option.desc}</span>
        <!-- Mini density preview -->
        <div class="mt-2.5 flex flex-col rounded-sm border border-[var(--border-color)]/50 overflow-hidden">
          {#each { length: option.rowCount } as _}
            <div
              class={cn(
                "border-b border-[var(--border-color)]/30 last:border-b-0",
                option.id === "comfortable" ? "py-1.5" : option.id === "compact" ? "py-0.5" : "py-px"
              )}
            >
              <div class="mx-2 flex gap-2">
                <div class="h-1 w-8 rounded-full bg-[var(--text-muted)]/20"></div>
                <div class="h-1 w-12 rounded-full bg-[var(--text-muted)]/15"></div>
                <div class="h-1 w-6 rounded-full bg-[var(--text-muted)]/10"></div>
              </div>
            </div>
          {/each}
        </div>
      </button>
    {/each}
  </div>
</section>

<!-- AI Agent -->
<section>
  <h2 class="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">AI Agent</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    The embedded agent can request a small set of cluster changes (scale, restart, delete pod, update resources) through its tools.
  </p>

  <label class="mt-4 flex cursor-pointer items-start gap-2.5">
    <Checkbox
      checked={settingsStore.settings.agent_require_approval !== false}
      onCheckedChange={(checked) => {
        settingsStore.settings.agent_require_approval = checked === true;
        settingsStore.saveSettings();
      }}
      class="mt-0.5"
    />
    <span class="flex flex-col">
      <span class="text-[12px] font-medium text-[var(--text-primary)]">Require approval for agent mutations</span>
      <span class="text-[11px] leading-relaxed text-[var(--text-muted)]">
        Every change the agent requests shows an Approve / Deny dialog before touching the cluster.
        Turning this off lets the agent modify your cluster without asking — only do this on clusters where that is acceptable.
      </span>
    </span>
  </label>
</section>
