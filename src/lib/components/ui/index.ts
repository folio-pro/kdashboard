/**
 * Design-system barrel. Import primitives from `$lib/components/ui` so a
 * single import line covers a whole file's chrome.
 *
 * See ./README.md for the scales (size, tone, radius, type) and for the rule
 * on when a new primitive is warranted.
 */
export {
  Button,
  buttonVariants,
  type ButtonVariant,
  type ButtonSize,
  type ButtonTone,
  type ButtonActiveStyle,
} from "./button/index.js";
export {
  Badge,
  badgeVariants,
  type BadgeTone,
  type BadgeAppearance,
  type BadgeSize,
} from "./badge/index.js";
export { Card } from "./card/index.js";
export { TONES, toneStyle, type Tone } from "./tones.js";
export { Input } from "./input/index.js";
export { Kbd } from "./kbd/index.js";
export { Menu, MenuItem, MenuSeparator } from "./menu/index.js";
export { SearchField } from "./search-field/index.js";
export { SelectMenu } from "./select-menu/index.js";
export { default as Spinner } from "./spinner/Spinner.svelte";
export { Checkbox } from "./checkbox/index.js";
export { Skeleton, CodeSkeleton } from "./skeleton/index.js";
