<script lang="ts">
  // A single-series line chart over a Prometheus range query. Inline SVG — no
  // chart library — because one series over ~60 points needs nothing more.

  import type { PrometheusSample } from "$lib/types";

  let {
    samples,
    format,
    color = "var(--accent)",
    height = 56,
  }: {
    samples: PrometheusSample[];
    /** Renders a value for the axis labels and the hover tooltip. */
    format: (v: number) => string;
    color?: string;
    height?: number;
  } = $props();

  const WIDTH = 320;

  let bounds = $derived.by(() => {
    if (samples.length === 0) return { min: 0, max: 1, t0: 0, t1: 1 };
    const values = samples.map((s) => s.v);
    const max = Math.max(...values);
    return {
      // Anchor at zero so the eye compares heights, not a magnified wiggle.
      min: 0,
      max: max === 0 ? 1 : max * 1.1,
      t0: samples[0]!.t,
      t1: samples[samples.length - 1]!.t,
    };
  });

  function x(t: number): number {
    const span = bounds.t1 - bounds.t0;
    return span === 0 ? 0 : ((t - bounds.t0) / span) * WIDTH;
  }

  function y(v: number): number {
    const span = bounds.max - bounds.min;
    return height - ((v - bounds.min) / span) * height;
  }

  let path = $derived(
    samples.map((s, i) => `${i === 0 ? "M" : "L"}${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`).join(" "),
  );

  let area = $derived(
    samples.length === 0
      ? ""
      : `${path} L${x(bounds.t1).toFixed(1)},${height} L${x(bounds.t0).toFixed(1)},${height} Z`,
  );

  let peak = $derived(samples.length === 0 ? 0 : Math.max(...samples.map((s) => s.v)));
  let latest = $derived(samples.length === 0 ? 0 : samples[samples.length - 1]!.v);
</script>

{#if samples.length === 0}
  <p class="py-3 text-[11px] text-[var(--text-dimmed)]">No data in this window.</p>
{:else}
  <div class="flex flex-col gap-1">
    <!-- Height is a prop, so it goes in the style attribute: an interpolated
         Tailwind class (h-[{height}px]) never reaches the JIT scanner. -->
    <svg
      viewBox="0 0 {WIDTH} {height}"
      class="w-full"
      style="height: {height}px"
      preserveAspectRatio="none"
      role="img"
      aria-label="Usage over time"
    >
      <path d={area} fill={color} opacity="0.12" />
      <path d={path} fill="none" stroke={color} stroke-width="1.5" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="flex justify-between font-mono text-[10px] text-[var(--text-dimmed)]">
      <span>now {format(latest)}</span>
      <span>peak {format(peak)}</span>
    </div>
  </div>
{/if}
