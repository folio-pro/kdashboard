<script lang="ts">
  import { check } from "@tauri-apps/plugin-updater";
  import { relaunch } from "@tauri-apps/plugin-process";
  import { listen } from "@tauri-apps/api/event";
  import { onMount } from "svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { ArrowDownToLine, X } from "lucide-svelte";
  import { fly } from "svelte/transition";
  import type { UpdateInfo } from "$lib/types";
  import { isVisible as _isVisible, computeProgress } from "./update-banner";

  let updateInfo: UpdateInfo | null = $state(null);
  let dismissed = $state(false);
  let installing = $state(false);
  let progress = $state(0);

  let visible = $derived(_isVisible({ updateInfo, dismissed, installing, progress }));

  onMount(() => {
    const unlistenPromise = listen<UpdateInfo>("update-available", (event) => {
      updateInfo = event.payload;
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  });

  async function handleUpdate() {
    if (installing) return;
    installing = true;
    progress = 0;

    try {
      const update = await check();
      if (!update) {
        toastStore.info("No update", "No update available at this time");
        installing = false;
        return;
      }

      let downloaded = 0;
      let totalLength = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            totalLength = event.data.contentLength ?? 0;
            progress = 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (totalLength > 0) {
              const pct = computeProgress(downloaded, totalLength);
              if (pct !== progress) progress = pct;
            }
            break;
          case "Finished":
            progress = 100;
            break;
        }
      });

      try {
        await relaunch();
      } catch (err) {
        if (import.meta.env.DEV) console.error("Relaunch failed:", err);
        toastStore.success(
          "Update installed",
          "Please restart kdashboard manually to complete the update"
        );
        installing = false;
      }
    } catch (err) {
      toastStore.error("Update failed", String(err));
      installing = false;
    }
  }

  function dismiss() {
    dismissed = true;
  }
</script>

{#if visible}
  <div
    class="fixed top-3 left-1/2 z-50 -translate-x-1/2"
    transition:fly={{ y: -40, duration: 200 }}
  >
    <div
      class="flex items-center gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2.5 shadow-lg"
    >
      <ArrowDownToLine class="h-4 w-4 shrink-0 text-[var(--accent)]" />

      <div class="flex items-center gap-2 text-xs">
        <span class="font-medium text-[var(--text-primary)]">
          kdashboard v{updateInfo?.version} available
        </span>
      </div>

      {#if installing}
        <div class="flex items-center gap-2">
          <div class="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
            <div
              class="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
              style="width: {progress}%"
            ></div>
          </div>
          <span class="text-[11px] tabular-nums text-[var(--text-muted)]">{progress}%</span>
        </div>
      {:else}
        <button
          class="rounded px-2.5 py-1 text-[11px] font-medium text-white bg-[var(--accent)] hover:opacity-90 transition-opacity"
          onclick={handleUpdate}
        >
          Update now
        </button>

        <button
          class="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          onclick={dismiss}
        >
          <X class="h-3.5 w-3.5" />
        </button>
      {/if}
    </div>
  </div>
{/if}
