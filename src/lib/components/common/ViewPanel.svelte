<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { ArrowLeft, RefreshCw, AlertTriangle } from "lucide-svelte";
  import type { Snippet } from "svelte";
  import type { IconComponent } from "$lib/actions/types";

  interface Props {
    title: string;
    icon: IconComponent;
    namespace: string;
    isLoading: boolean;
    error: string | null;
    hasData: boolean;
    onBack: () => void;
    onRefresh: () => void;
    loadingMessage?: string;
    errorMessage?: string;
    emptyMessage?: string;
    emptyHelper?: string;
    badge?: Snippet;
    headerActions?: Snippet;
    loadingSkeleton?: Snippet;
    children: Snippet;
    empty?: Snippet;
  }

  let {
    title,
    icon: Icon,
    namespace,
    isLoading,
    error,
    hasData,
    onBack,
    onRefresh,
    loadingMessage = "Loading...",
    errorMessage = "Failed to load data",
    emptyMessage = "No data available",
    emptyHelper,
    badge,
    headerActions,
    loadingSkeleton,
    children,
    empty,
  }: Props = $props();
</script>

<div class="flex h-full flex-col bg-[var(--bg-primary)]">
  <!-- Header -->
  <div class="flex h-[52px] items-center justify-between border-b border-[var(--border-color)] px-4">
    <div class="flex items-center gap-3">
      <Button variant="outline" size="icon" onclick={onBack} title="Back" aria-label="Go back">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <div class="flex items-center gap-2">
        <Icon class="h-4 w-4 text-[var(--accent)]" />
        <span class="text-sm font-semibold text-[var(--text-primary)]">{title}</span>
        <span class="text-xs text-[var(--text-muted)]">{namespace}</span>
      </div>
      {#if badge}
        {@render badge()}
      {/if}
    </div>

    <div class="flex items-center gap-2">
      {#if headerActions}
        {@render headerActions()}
      {/if}
      <Button variant="outline" size="icon" onclick={onRefresh} disabled={isLoading} title="Refresh" aria-label="Refresh">
        <RefreshCw class="h-3.5 w-3.5 {isLoading ? 'animate-spin' : ''}" />
      </Button>
    </div>
  </div>

  <!-- Content -->
  <div class="min-h-0 flex-1">
    {#if isLoading && !hasData}
      <div class="flex h-full items-center justify-center">
        <div class="flex flex-col items-center gap-3">
          {#if loadingSkeleton}
            {@render loadingSkeleton()}
          {:else}
            <Skeleton class="h-20 w-60 rounded-lg" />
          {/if}
          <span class="text-sm text-[var(--text-muted)]">{loadingMessage}</span>
        </div>
      </div>
    {:else if error}
      <div class="flex h-full items-center justify-center">
        <div class="flex flex-col items-center gap-2 text-center">
          <AlertTriangle class="h-8 w-8 text-[var(--status-failed)]" />
          <span class="text-sm font-medium text-[var(--text-primary)]">{errorMessage}</span>
          <span class="max-w-md text-xs text-[var(--text-muted)]">{error}</span>
          <Button variant="outline" size="sm" onclick={onRefresh} class="mt-2">Try again</Button>
        </div>
      </div>
    {:else if hasData}
      {@render children()}
    {:else}
      {#if empty}
        {@render empty()}
      {:else}
        <div class="flex h-full items-center justify-center">
          <div class="flex flex-col items-center gap-2 text-center">
            <Icon class="h-8 w-8 text-[var(--text-muted)]" />
            <span class="text-sm text-[var(--text-muted)]">{emptyMessage}</span>
            {#if emptyHelper}
              <span class="text-xs text-[var(--text-muted)]">{emptyHelper}</span>
            {/if}
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>
