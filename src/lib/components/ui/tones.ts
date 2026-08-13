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
 * The `--tone` declaration, as an inline `style` value.
 *
 * It is NOT a Tailwind class. It used to be one — an arbitrary property built
 * per tone, `[--tone:${value}]` — and that shipped a UI with no colour: the
 * Tailwind scanner matches class names as literal text in the source, so a
 * name assembled at runtime is a name it never sees. Nothing errored. The
 * eight rules were simply absent from the stylesheet, `var(--tone)` resolved
 * to nothing, and every control coloured through it — the Stream and Connect
 * buttons, the log level filters, every Badge — painted transparent on a
 * transparent background.
 *
 * A custom property carrying a value, set per element, is what the `style`
 * attribute is for; four Badge call sites were already spelling it that way by
 * hand. Declaring it here keeps it out of the scanner's reach for good, and it
 * still inherits to the element's children.
 */
export function toneStyle(tone: Tone): string {
  return `--tone: ${TONES[tone]};`;
}
