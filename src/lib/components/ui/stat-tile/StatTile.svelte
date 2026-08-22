<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  import { Card } from "../card/index.js";
  import { toneStyle, type Tone } from "../tones.js";
  import type { IconComponent } from "$lib/actions/types";

  /**
   * A headline number with a label and an optional note: the tiles at the top
   * of Overview, Cost, Rightsizing, Port Forwards and Security. `tone` colours
   * the value (and the note's dot) through `--tone`; `children` can add a bar
   * or any extra row under the note.
   */
  interface Props extends HTMLAttributes<HTMLDivElement> {
    label: string;
    value: string | number;
    note?: string;
    tone?: Tone;
    icon?: IconComponent;
    /** md = 18px value (dense rows of tiles), lg = 26px (a hero row). */
    size?: "md" | "lg";
    mono?: boolean;
    /** Show a tone-coloured dot before the note. */
    dot?: boolean;
    children?: Snippet;
    class?: string;
  }

  let { label, value, note, tone = "neutral", icon: Icon, size = "md", mono = true, dot = false, children, class: className, ...rest }: Props = $props();
</script>

<Card class={cn("flex flex-col gap-1.5", className)} style={toneStyle(tone)} {...rest}>
  <div class="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
    {#if Icon}<Icon class="h-3.5 w-3.5" />{/if}
    {label}
  </div>
  <div
    class={cn("font-semibold leading-none text-[var(--text-primary)]", mono && "font-mono tabular-nums", size === "lg" ? "text-[26px] font-medium" : "text-[18px]")}
    style={tone !== "neutral" ? "color: var(--tone);" : ""}
  >
    {value}
  </div>
  {#if note}
    <div class="flex items-center gap-1.5 truncate text-[11px] text-[var(--text-secondary)]" title={note}>
      {#if dot}<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--tone)]"></span>{/if}
      <span class="truncate">{note}</span>
    </div>
  {/if}
  {#if children}{@render children()}{/if}
</Card>
