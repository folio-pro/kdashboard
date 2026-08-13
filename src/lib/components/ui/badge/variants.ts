import { tv, type VariantProps } from "tailwind-variants";
import { toneVariants } from "../tones.js";

/**
 * Badge / pill / chip.
 *
 * Before this existed the same pill was retyped ~43 times with slightly
 * different spellings — px-1/px-1.5/px-2, rounded/rounded-full, /10 vs /15 vs
 * /20 tints — and one view (SecurityView) reached for raw Tailwind palette
 * colours (`bg-yellow-500/20 text-yellow-400`), which ignore the theme and
 * break outright on the five light presets.
 *
 * Colour comes from a single `--tone` custom property so each appearance is
 * one rule instead of one rule per tone × appearance. Tones are theme
 * variables, never literal colours.
 */
export const badgeVariants = tv({
  base: "inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-medium",
  variants: {
    tone: toneVariants,
    appearance: {
      /** Tinted background, tone-coloured label. The default chip. */
      soft: "bg-[color-mix(in_srgb,var(--tone)_15%,transparent)] text-[var(--tone)]",
      /** Hairline border, no fill — for counts and metadata. */
      outline: "border border-[var(--border-color)] text-[var(--tone)]",
      /** Filled, reversed out against the page background. */
      solid: "bg-[var(--tone)] text-[var(--bg-primary)]",
      /** Flat surface chip, tone only tints the label. */
      surface: "bg-[var(--bg-tertiary)] text-[var(--tone)]",
    },
    size: {
      xs: "rounded-sm px-1.5 py-0.5 text-[10px]",
      sm: "rounded-sm px-2 py-0.5 text-[11px]",
    },
    pill: {
      true: "rounded-full",
      false: "",
    },
    /** A hairline outline on top of any appearance (metadata chips). */
    bordered: {
      true: "border border-[var(--border-color)]",
      false: "",
    },
    mono: {
      true: "font-mono",
      false: "",
    },
  },
  defaultVariants: {
    tone: "neutral",
    appearance: "soft",
    size: "xs",
    pill: false,
    bordered: false,
    mono: false,
  },
});

export type BadgeTone = VariantProps<typeof badgeVariants>["tone"];
export type BadgeAppearance = VariantProps<typeof badgeVariants>["appearance"];
export type BadgeSize = VariantProps<typeof badgeVariants>["size"];
