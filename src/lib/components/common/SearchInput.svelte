<script lang="ts">
  import { cn } from "$lib/utils";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import { Search, X } from "lucide-svelte";

  interface Props {
    id?: string;
    value: string;
    placeholder?: string;
    onchange: (value: string) => void;
  }

  let { id, value, placeholder = "Filter resources...", onchange }: Props = $props();

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      onchange(target.value);
    }, 150);
  }

  function clear() {
    onchange("");
  }
</script>

<div class="relative flex items-center">
  <Search class="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[var(--text-muted)]" />

  <Input
    {id}
    type="text"
    {placeholder}
    {value}
    oninput={handleInput}
    class="h-7 w-full pl-8 pr-7 text-xs"
  />

  {#if value}
    <Button
      variant="ghost"
      size="icon"
      class="absolute right-1 h-5 w-5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      onclick={clear}
      aria-label="Clear search"
    >
      <X class="h-3 w-3" />
    </Button>
  {/if}
</div>
