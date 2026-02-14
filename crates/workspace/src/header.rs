use crate::app_state::AppState;
use gpui::prelude::FluentBuilder;
use gpui::*;
use ui::gpui_component::input::{Input, InputEvent, InputState};
use ui::{Icon, IconName, Sizable, theme};

pub struct Header {
    search_input: Option<Entity<InputState>>,
    _search_subscription: Option<Subscription>,
}

impl Header {
    pub fn new() -> Self {
        Self {
            search_input: None,
            _search_subscription: None,
        }
    }

    fn ensure_search_input(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.search_input.is_some() {
            return;
        }
        let input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search pods, deployments..."));
        let sub = cx.subscribe(&input, |this, _input, ev: &InputEvent, cx| {
            if let InputEvent::Change = ev {
                let text = this
                    .search_input
                    .as_ref()
                    .map(|i| i.read(cx).text().to_string())
                    .unwrap_or_default();
                cx.update_global::<crate::app_state::AppState, _>(|state, _| {
                    state.set_filter(text);
                });
                cx.notify();
            }
        });
        self.search_input = Some(input);
        self._search_subscription = Some(sub);
    }
}

impl Default for Header {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for Header {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.ensure_search_input(window, cx);

        let theme = theme(cx);
        let colors = &theme.colors;

        // Build search input
        let search_input = self.search_input.as_ref().map(|input| {
            Input::new(input)
                .appearance(false)
                .cleanable(true)
                .with_size(ui::Size::Small)
        });

        div()
            .w_full()
            .px(px(24.0))
            .py(px(12.0))
            .bg(colors.background)
            .border_b_1()
            .border_color(colors.border)
            .font_family(theme.font_family_ui.clone())
            .flex()
            .items_center()
            .justify_between()
            // Left: search box + selectors
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    // Search box
                    .child(
                        div()
                            .w(px(300.0))
                            .px(px(12.0))
                            .py(px(6.0))
                            .rounded(theme.border_radius_md)
                            .bg(colors.surface)
                            .border_1()
                            .border_color(colors.border)
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                Icon::new(IconName::Search)
                                    .size(px(14.0))
                                    .color(colors.text_muted),
                            )
                            .when_some(search_input, |el, input| el.child(input)),
                    ),
            )
            // Right: settings entry (replaces static user info)
            .child(
                div().flex().items_center().gap(px(16.0)).child(
                    div()
                        .id("header-settings-link")
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .cursor_pointer()
                        .hover(|style| style.opacity(0.85))
                        .child(
                            div()
                                .w(px(32.0))
                                .h(px(32.0))
                                .rounded_full()
                                .bg(colors.surface)
                                .border_1()
                                .border_color(colors.border)
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(
                                    Icon::new(IconName::Settings)
                                        .size(px(14.0))
                                        .color(colors.text_muted),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(13.0))
                                .text_color(colors.text)
                                .child("Settings"),
                        )
                        .on_click(cx.listener(|_this, _event, _window, cx| {
                            cx.update_global::<AppState, _>(|state, _| {
                                state.open_settings();
                            });
                            cx.notify();
                        })),
                ),
            )
    }
}
