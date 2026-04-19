<script lang="ts">
  import { fetchMonochromeIcon } from "$lib/utils/context-icons";

  interface Props {
    id: string;
    class?: string;
  }

  let { id, class: className = "h-4 w-4" }: Props = $props();
  let svgContent = $state<string | null>(null);

  $effect(() => {
    svgContent = null;
    fetchMonochromeIcon(id).then((svg) => {
      svgContent = svg;
    });
  });
</script>

{#if svgContent}
  <span class={`inline-flex items-center justify-center ${className}`}>
    {@html svgContent}
  </span>
{:else}
  <!-- Placeholder while loading -->
  <span class={`inline-block rounded bg-current/10 ${className}`}></span>
{/if}

<style>
  span :global(svg) {
    width: 100%;
    height: 100%;
  }
</style>
