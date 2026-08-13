<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { Loader2 } from "lucide-svelte";

  /**
   * Busy indicator. `.animate-spin` is exempted from the reduced-motion
   * clamp in app.css (a frozen spinner reads as a hung app), so all spinning
   * goes through this one component rather than eight ad-hoc icons.
   */
  interface Props {
    size?: "xs" | "sm" | "md";
    class?: string;
    label?: string;
  }

  let { size = "sm", class: className, label = "Loading" }: Props = $props();

  const sizeClass = {
    xs: "h-3 w-3",
    sm: "h-3.5 w-3.5",
    md: "h-4 w-4",
  } as const;
</script>

<Loader2
  class={cn("animate-spin text-[var(--text-muted)]", sizeClass[size], className)}
  aria-label={label}
  role="status"
/>
