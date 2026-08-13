# Design system

Three layers. Break any one of them and the UI drifts, because the layer below
stops being reachable.

1. **Tokens** — CSS custom properties in `src/app.css`, redefined per theme
   preset. Never write a literal colour in a component.
2. **Scales** — the fixed lists below. One spelling per step.
3. **Primitives** — the components in this directory. Import from
   `$lib/components/ui`.

## Why this file exists

The tokens were already disciplined; the component layer was not. Before this
document there were 124 hand-rolled `<button>` elements against 10 files that
imported `Button`, ~43 copies of the same pill, 5 spellings of `<kbd>`, and one
view styled with raw Tailwind palette colours that invert on the light themes.

The cause was a primitive layer that did not fit the product: `Button` shipped
the shadcn heights (h-9 default, h-8 "small") while this is a dense Kubernetes
console whose real control height is h-7. Every call site overrode the size, so
most stopped calling. **A primitive nobody can use at the right size is not a
design system.** If you find yourself passing `class="h-7"`, the scale is wrong
— fix the scale, do not fix the call site.

## Scales

### Control height

Shared by `Button` and `Input`, so a control and its neighbour line up.

| size | height | use |
| --- | --- | --- |
| `xs` | 24px | inline chips, row-level affordances |
| `sm` | 28px | toolbars, filter bars, view headers — the dominant height |
| `md` | 32px | default; forms, detail-panel actions |
| `lg` | 36px | dialog footers, settings pages |

`Button` mirrors each as a square: `icon-xs` … `icon-lg`, and adds
`inline` / `inline-sm` / `inline-xs` for controls with no box at all — a
breadcrumb, a "reveal" toggle, a toast's action — which take the line-height
of the text they sit in.

### Type

`10 · 11 · 12 · 13 · 15 · 18 · 26` px, spelled `text-[Npx]`. Never `text-xs` and
`text-[12px]` for the same 12px. See the header comment in `app.css`.

### Radius

`rounded-sm · rounded-md · rounded-lg · rounded-xl · rounded-full`. Bare
`rounded` is not a step in the scale — it is the Tailwind default that crept in.

### Tone

Semantic, never a colour name. `neutral · muted · accent · success · warning ·
error · info · terminating`, each mapping to a theme variable
(`--status-running`, `--status-failed`, …). `Badge` resolves the tone into a
single `--tone` custom property, so an appearance is one rule rather than one
rule per tone.

## Primitives

| Component | Replaces |
| --- | --- |
| `Button` | raw `<button>` with a hand-written class string |
| `Badge` | status pills, chips, counts, severity tags |
| `Card` | `rounded-lg border … bg-[var(--bg-secondary)] p-3` surfaces |
| `Input` | raw `<input type="text">` |
| `SearchField` | the icon + input + hint box, six copies of it |
| `Menu`, `MenuItem`, `MenuSeparator` | the app's own dropdown and context menus |
| `Kbd` | keyboard hints |
| `Spinner` | ad-hoc `Loader2 class="animate-spin"` |
| `Checkbox`, `Skeleton`, `CodeSkeleton` | — |

Composite, domain-aware components live one directory up and are built *from*
these: `common/StatusBadge` (k8s phase → dot + label),
`details/AnnotationValue`, `table/*`, `details/*`.

### Button variants

`accent` (the default) · `outline` · `ghost` · `destructive` · `link` — the
ordinary set, plus these:

| variant | where it belongs |
| --- | --- |
| `toolbar` | bordered control on a secondary surface: log bars, table toolbars, view headers |
| `toolbar-tone` | the same, labelled in the button's own `tone` (the log level filters) |
| `solid-tone` | filled in its `tone` — a bar's primary action (Connect, Stream, Stop) |
| `soft-tone` | tinted in its `tone` — clickable counts and problem chips |
| `ghost-tone` | label-only in its `tone`, tinting on hover — inline row actions |
| `muted` | label-only, grows a background on hover — icon buttons in dense chrome |
| `segment` / `tab` | a tab in a recessed strip / an underlined strip |

Selection is `active={…}` plus an `activeStyle`: `solid` (fill with the tone),
`soft` (tint it), `raised` (lift onto the page background), `underline` (mark
the bottom border). The component sets `aria-pressed` from `active`.

## When a raw `<button>` is still right

`Button` is for things shaped like buttons. A trigger whose shape is the layout
— a full-width table row, a list item, a card-shaped picker, a tab strip with
its own sliver indicator — stays a raw `<button>`, and takes its colours and
type from the tokens and scales above. Forcing those through `Button` means
undoing its padding, height and radius at every call site, which is the same
drift in the other direction.

## Rules

- **No literal colours.** No `text-red-400`, no `#0C0C0C`. Tone variants or
  `var(--…)` only. The five light presets are the test: a raw palette colour
  that looks fine on the default dark theme is unreadable on `github-light`.
- **Variants, not `class`.** `class` is for layout at the call site (margin,
  flex, width). The moment it carries height, colour or font size, add or use a
  variant or a size. A call site writing `class="h-auto p-0 text-[11px]"` is
  the scale being overridden rather than used — that is what `inline` is for.
- **`active` over a ternary.** Segmented and filter controls take
  `active={…}`; the compound variant supplies the selected look and sets
  `aria-pressed`.
- **New primitive only on the third copy.** Two similar blocks are a
  coincidence; three are a component.

The first two rules are enforced by `design-system.test.ts`, which fails the
suite on a raw palette class or a bare `rounded` anywhere under `src/`. Both
checks scan tokens rather than `class="…"` attributes, because much of this
codebase composes its classes through `cn(…)`.
