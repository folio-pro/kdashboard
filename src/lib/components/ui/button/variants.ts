import { tv, type VariantProps } from "tailwind-variants";
import type { Tone } from "../tones.js";

/**
 * "Filled in the button's own tone" and "tinted in it" are each written once
 * here, because they are reachable two ways: as a resting variant
 * (`solid-tone` — a Connect button is always filled) and as the selected state
 * of a segmented control (`activeStyle`). Those are different meanings, so
 * both spellings stay; the classes behind them must not drift apart.
 */
const TONE_SOLID =
  "border-transparent bg-[var(--tone)] text-[var(--bg-primary)] hover:bg-[var(--tone)] hover:text-[var(--bg-primary)]";
const TONE_SOFT =
  "border-transparent bg-[color-mix(in_srgb,var(--tone)_20%,transparent)] text-[var(--tone)] hover:bg-[color-mix(in_srgb,var(--tone)_28%,transparent)] hover:text-[var(--tone)]";

/**
 * Button scale.
 *
 * The sizes are named after the control heights this UI actually uses, which
 * are denser than the shadcn defaults this file started from. The old scale
 * topped out at `sm` = h-8 with `default` = h-9, so every dense toolbar in the
 * app hand-rolled its own `<button class="flex h-7 items-center …">` instead —
 * 124 raw buttons against 10 files importing this component. Naming the real
 * heights is what makes the component reachable:
 *
 *   xs  h-6   inline chips, row-level affordances
 *   sm  h-7   toolbars, filter bars, headers (the dominant control height)
 *   md  h-8   default; forms and detail-panel actions
 *   lg  h-9   dialog footers, settings pages
 *
 * `icon-*` mirrors each height as a square. Anything outside this list is a
 * mistake, not a decision — pass `class` for one-off spacing, not one-off size.
 */
export const buttonVariants = tv({
  base: "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)] disabled:pointer-events-none disabled:opacity-50",
  variants: {
    variant: {
      /** Solid accent with theme-aware foreground — the primary action. */
      accent: "bg-[var(--accent)] text-[var(--bg-primary)] hover:bg-[var(--accent-hover)]",
      destructive:
        "border border-[var(--status-failed)]/50 bg-transparent text-[var(--status-failed)] hover:bg-[var(--status-failed)]/10",
      outline:
        "border border-[var(--border-color)] bg-transparent text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]",
      ghost: "text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]",
      /**
       * The recessed control that fills log bars, table toolbars and view
       * headers: bordered, secondary surface, muted label that lifts on hover.
       */
      toolbar:
        "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
      /** Label-only control that only grows a background on hover. */
      muted: "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
      /**
       * `toolbar`, but the label takes the button's own `tone` — the log
       * level filters, where each control is coloured by what it filters.
       */
      "toolbar-tone":
        "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--tone)] hover:bg-[var(--bg-tertiary)]",
      /**
       * Filled in the button's own `tone` — the primary action of a header bar
       * (Connect, Start streaming, and their destructive counterparts).
       */
      "solid-tone": TONE_SOLID,
      /** Label-only in its own `tone`, tinting on hover — inline row actions. */
      "ghost-tone": "text-[var(--tone)] hover:bg-[color-mix(in_srgb,var(--tone)_10%,transparent)]",
      /** Tinted in its own `tone` — clickable counts, inline problem chips. */
      "soft-tone": TONE_SOFT,
      /**
       * A tab inside a recessed strip: flat at rest, raised onto the page
       * background when selected. Pair with `activeStyle="raised"`.
       */
      segment: "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
      /**
       * A tab in an underlined strip (settings, Helm release detail). Pair
       * with `activeStyle="underline"`.
       */
      tab: "rounded-none border-b-2 border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
      link: "text-[var(--accent)] underline-offset-4 hover:underline",
    },
    size: {
      xs: "h-6 gap-1 px-2 text-[11px]",
      sm: "h-7 gap-1.5 px-2.5 text-[12px]",
      md: "h-8 gap-1.5 px-3 text-[12px]",
      lg: "h-9 gap-2 px-4 text-[13px]",
      "icon-xs": "h-6 w-6",
      "icon-sm": "h-7 w-7",
      "icon-md": "h-8 w-8",
      "icon-lg": "h-9 w-9",
      /**
       * No box at all: a control that sits inside a run of text and must share
       * its line-height — breadcrumbs, "reveal"/"copy all", a toast's action.
       * Without this the call sites all wrote `class="h-auto p-0 text-[11px]"`,
       * which is the size scale being overridden rather than used.
       */
      inline: "h-auto gap-1 p-0 text-[11px]",
      "inline-sm": "h-auto gap-1 p-0 text-[12px]",
      "inline-xs": "h-auto gap-1 p-0 text-[10px]",
    },
    /** Toolbars and log controls label their controls in the mono face. */
    mono: {
      true: "font-mono",
      false: "",
    },
    /**
     * Selected state for segmented/filter controls. Pairs with any variant:
     * the variant supplies the resting look, `active` the selected one.
     */
    active: {
      true: "",
      false: "",
    },
    /** How the selected state reads: filled, a tint of the tone, or raised. */
    activeStyle: {
      solid: "",
      soft: "",
      raised: "",
      underline: "",
    },
  },
  compoundVariants: [
    {
      active: true,
      activeStyle: "solid",
      class: TONE_SOLID,
    },
    {
      active: true,
      activeStyle: "soft",
      class: TONE_SOFT,
    },
    {
      active: true,
      activeStyle: "underline",
      class: "border-[var(--accent)] text-[var(--text-primary)] hover:text-[var(--text-primary)]",
    },
    {
      active: true,
      activeStyle: "raised",
      class: "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm hover:text-[var(--text-primary)]",
    },
  ],
  defaultVariants: {
    variant: "accent",
    size: "md",
    mono: false,
    active: false,
    activeStyle: "solid",
  },
});

export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
export type ButtonSize = VariantProps<typeof buttonVariants>["size"];
/**
 * The colour a `*-tone` variant and a selected control take. It reaches the
 * element as an inline `--tone` declaration, not a class — see `toneStyle`.
 */
export type ButtonTone = Tone;
export type ButtonActiveStyle = VariantProps<typeof buttonVariants>["activeStyle"];
