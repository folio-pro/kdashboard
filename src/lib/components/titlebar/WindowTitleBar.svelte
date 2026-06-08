<script lang="ts">
  // Persistent, full-width window title bar (VSCode-style). Always rendered at
  // the very top of the window above the sidebar. It is the draggable window
  // chrome (move + double-click-zoom on macOS) and hosts the macOS traffic
  // lights, so it must stay a -webkit-app-region: drag surface (via
  // data-tauri-drag-region — see app.css). Themed via --bg-primary so it tracks
  // the active theme.
  import { k8sStore } from "$lib/stores/k8s.svelte";
</script>

<div
  class="window-titlebar flex h-9 shrink-0 items-center justify-center border-b border-[var(--border-color)] bg-[var(--bg-primary)]"
  data-tauri-drag-region
>
  <span
    class="pointer-events-none select-none text-xs font-medium tracking-tight text-[var(--text-secondary)]"
    data-tauri-drag-region
  >
    kdashboard{#if k8sStore.currentContext}&nbsp;&mdash;&nbsp;{k8sStore.currentContext}{/if}
  </span>
</div>
