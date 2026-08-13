/**
 * The tone vocabulary, in one place.
 *
 * Badge and Button each grew their own list, and they disagreed: Badge said
 * `warning` and `terminating`, Button said `warn` and had neither
 * `terminating` nor `muted`. tailwind-variants silently falls back to the
 * default when handed a name it does not know, so `<Badge tone="warn">` in
 * TopologyView rendered neutral grey and nothing complained — a design system
 * with two spellings for one concept is the drift it exists to prevent.
 *
 * Every tone resolves to a theme variable, never a literal, and is applied as
 * a `--tone` custom property so an appearance is one rule rather than one rule
 * per tone.
 */
export const TONES = {
  neutral: "var(--text-secondary)",
  muted: "var(--text-muted)",
  accent: "var(--accent)",
  success: "var(--status-running)",
  warning: "var(--status-pending)",
  error: "var(--status-failed)",
  info: "var(--status-succeeded)",
  terminating: "var(--status-terminating)",
} as const;

export type Tone = keyof typeof TONES;

/**
 * The `--tone` declarations as a tailwind-variants `variants.tone` map.
 * Spelled as an arbitrary property (`[--tone:…]`) so the value travels with
 * the class list and inherits to the element's own children.
 */
export const toneVariants = Object.fromEntries(
  Object.entries(TONES).map(([name, value]) => [name, `[--tone:${value}]`])
) as Record<Tone, string>;
