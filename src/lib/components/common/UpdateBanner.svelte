<script lang="ts">
  import { check } from "$lib/ipc/updater";
  import { relaunch } from "$lib/ipc/process";
  import { listen } from "$lib/ipc/event";
  import { onMount } from "svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { ArrowDownToLine, Copy, X } from "lucide-svelte";
  import { Button } from "$lib/components/ui";
  import { fly } from "svelte/transition";
  import type { UpdateInfo } from "$lib/types";
  import { isVisible as _isVisible, computeProgress, BREW_UPGRADE_COMMAND } from "./update-banner";

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

  async function copyBrewCommand() {
    try {
      await navigator.clipboard.writeText(BREW_UPGRADE_COMMAND);
      toastStore.success("Copied", "Run it in a terminal to update");
    } catch (err) {
      toastStore.error("Copy failed", String(err));
    }
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

      <div class="flex items-center gap-2 text-[12px]">
        <span class="font-medium text-[var(--text-primary)]">
          kdashboard v{updateInfo?.version} available
        </span>
      </div>

      {#if installing}
        <div class="flex items-center gap-2">
          <div class="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
            <div
              class="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
              style="width: {progress}%"
            ></div>
          </div>
          <span class="text-[11px] tabular-nums text-[var(--text-muted)]">{progress}%</span>
        </div>
      {:else if updateInfo?.manualInstall}
        <!-- Unsigned macOS builds can't self-install; Homebrew is the update channel. -->
        <code
          class="rounded-sm bg-[var(--bg-tertiary)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
        >
          {BREW_UPGRADE_COMMAND}
        </code>

        <Button variant="accent" size="xs" onclick={copyBrewCommand}>
          <Copy class="h-3 w-3" />
          Copy
        </Button>

        <Button variant="muted" size="icon-xs" onclick={dismiss} aria-label="Dismiss update">
          <X class="h-3.5 w-3.5" />
        </Button>
      {:else}
        <Button variant="accent" size="xs" onclick={handleUpdate}>
          Update now
        </Button>

        <Button variant="muted" size="icon-xs" onclick={dismiss} aria-label="Dismiss update">
          <X class="h-3.5 w-3.5" />
        </Button>
      {/if}
    </div>
  </div>
{/if}
