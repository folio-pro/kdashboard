use gpui::*;

use crate::{Icon, IconName, ThemeColors};

/// Shared button sizing constants
const BTN_PX: f32 = 12.0;
const BTN_PY: f32 = 7.0;
const BTN_RADIUS: f32 = 6.0;
const BTN_GAP: f32 = 6.0;
const BTN_ICON_SIZE: f32 = 14.0;
const BTN_TEXT_SIZE: f32 = 13.0;
const BACK_BTN_SIZE: f32 = 32.0;
const BACK_BTN_ICON: f32 = 15.0;

/// Base button layout (shared across all variants).
fn btn_base(id: impl Into<ElementId>) -> Stateful<Div> {
    div()
        .id(id)
        .px(px(BTN_PX))
        .py(px(BTN_PY))
        .rounded(px(BTN_RADIUS))
        .cursor_pointer()
        .flex()
        .items_center()
        .gap(px(BTN_GAP))
}

/// Button label element.
fn btn_label(text: impl Into<SharedString>, color: Hsla) -> Div {
    div()
        .text_size(px(BTN_TEXT_SIZE))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(color)
        .child(text.into())
}

// ── Public button builders ──────────────────────────────────────────

/// Secondary (outlined) action button — e.g. "Edit YAML", "Refresh", "Logs", "Validate".
pub fn secondary_btn(
    id: impl Into<ElementId>,
    icon: IconName,
    label: impl Into<SharedString>,
    colors: &ThemeColors,
) -> Stateful<Div> {
    btn_base(id)
        .bg(colors.surface)
        .border_1()
        .border_color(colors.border)
        .hover(|s| s.bg(colors.selection_hover))
        .child(
            Icon::new(icon)
                .size(px(BTN_ICON_SIZE))
                .color(colors.text_secondary),
        )
        .child(btn_label(label, colors.text))
}

/// Primary (filled) action button — e.g. "Apply", "Create".
pub fn primary_btn(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    bg: Hsla,
    text_color: Hsla,
) -> Stateful<Div> {
    let hover_bg = Hsla {
        l: (bg.l - 0.06).max(0.0),
        ..bg
    };
    btn_base(id)
        .bg(bg)
        .hover(|s| s.bg(hover_bg))
        .child(btn_label(label, text_color))
}

/// Primary button with an icon — e.g. "Create Pod".
pub fn primary_icon_btn(
    id: impl Into<ElementId>,
    icon: IconName,
    label: impl Into<SharedString>,
    bg: Hsla,
    text_color: Hsla,
) -> Stateful<Div> {
    let hover_bg = Hsla {
        l: (bg.l - 0.06).max(0.0),
        ..bg
    };
    btn_base(id)
        .bg(bg)
        .hover(|s| s.bg(hover_bg))
        .child(Icon::new(icon).size(px(BTN_ICON_SIZE)).color(text_color))
        .child(btn_label(label, text_color))
}

/// Danger (destructive) button — e.g. "Delete".
pub fn danger_btn(
    id: impl Into<ElementId>,
    icon: IconName,
    label: impl Into<SharedString>,
    colors: &ThemeColors,
) -> Stateful<Div> {
    let hover_bg = Hsla {
        l: (colors.error.l - 0.06).max(0.0),
        ..colors.error
    };
    btn_base(id)
        .bg(colors.error)
        .hover(|s| s.bg(hover_bg))
        .child(Icon::new(icon).size(px(BTN_ICON_SIZE)).color(colors.text))
        .child(btn_label(label, colors.text))
}

/// Square icon-only back button (e.g. back arrows in headers).
pub fn back_btn(id: impl Into<ElementId>, colors: &ThemeColors) -> Stateful<Div> {
    div()
        .id(id)
        .flex_shrink_0()
        .size(px(BACK_BTN_SIZE))
        .rounded(px(BTN_RADIUS))
        .bg(colors.surface)
        .border_1()
        .border_color(colors.border)
        .cursor_pointer()
        .hover(|s| s.bg(colors.selection_hover))
        .flex()
        .items_center()
        .justify_center()
        .child(
            Icon::new(IconName::ArrowLeft)
                .size(px(BACK_BTN_ICON))
                .color(colors.text_secondary),
        )
}

/// Editor tab item (Editor / Diff / History). Returns a stateful div ready for `.on_click()`.
/// When `active`, shows a bottom accent border and bold text; otherwise, faded text with hover.
pub fn editor_tab(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    active: bool,
    accent: Hsla,
    text_active: Hsla,
    text_inactive: Hsla,
) -> Stateful<Div> {
    let label = label.into();
    let mut el = div()
        .id(id)
        .px(px(BTN_PX))
        .py(px(BTN_PY))
        .cursor_pointer()
        .flex()
        .items_center()
        .gap(px(BTN_GAP));

    if active {
        el = el.border_b_2().border_color(accent);
        el.child(
            div()
                .text_size(px(BTN_TEXT_SIZE))
                .text_color(text_active)
                .font_weight(FontWeight::SEMIBOLD)
                .child(label),
        )
    } else {
        el.hover(|s| s.text_color(text_active)).child(
            div()
                .text_size(px(BTN_TEXT_SIZE))
                .text_color(text_inactive)
                .font_weight(FontWeight::MEDIUM)
                .child(label),
        )
    }
}
