<script lang="ts">
  import { Check, X, Minus } from "lucide-svelte";
  import { cn } from "$lib/utils";

  /**
   * Conditions as a checklist: a tick for True, a cross for False, a dash
   * for Unknown, with the reason (or message) trailing in muted text. `wrap`
   * lays them out inline for the four pod conditions; `list` one per line
   * with the reason right-aligned.
   */
  export interface ConditionItem {
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }

  interface Props {
    conditions: ConditionItem[];
    layout?: "wrap" | "list";
    /** Conditions whose healthy state is False (e.g. a Node's MemoryPressure). */
    invert?: ReadonlySet<string>;
  }

  let { conditions, layout = "list", invert }: Props = $props();

  type Verdict = "ok" | "bad" | "unknown";
  function verdict(c: ConditionItem): Verdict {
    const wantTrue = !invert?.has(c.type);
    if (c.status === "True") return wantTrue ? "ok" : "bad";
    if (c.status === "False") return wantTrue ? "bad" : "ok";
    return "unknown";
  }
  const COLOR: Record<Verdict, string> = {
    ok: "var(--status-running)",
    bad: "var(--status-failed)",
    unknown: "var(--text-muted)",
  };
</script>

<div class={cn(layout === "wrap" ? "flex flex-wrap gap-x-5 gap-y-2" : "flex flex-col gap-2")}>
  {#each conditions as c (c.type)}
    {@const v = verdict(c)}
    {@const note = c.reason || c.message}
    <div class={cn("flex min-w-0 items-baseline gap-2", layout === "list" && "justify-between")} title={c.message ?? c.reason ?? ""}>
      <span class="inline-flex shrink-0 items-center gap-1.5 text-[12px]" style:color={v === "bad" ? COLOR.bad : "var(--text-secondary)"}>
        <span class="inline-flex" style:color={COLOR[v]}>
          {#if v === "ok"}<Check class="h-3 w-3" strokeWidth={2.5} />{:else if v === "bad"}<X class="h-3 w-3" strokeWidth={2.5} />{:else}<Minus class="h-3 w-3" strokeWidth={2.5} />{/if}
        </span>
        {c.type}
      </span>
      {#if note}
        <span class="min-w-0 truncate text-[11px] text-[var(--text-muted)]">{note}</span>
      {/if}
    </div>
  {/each}
</div>
