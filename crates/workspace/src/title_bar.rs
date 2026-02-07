use gpui::*;
use ui::theme;

pub struct TitleBar;

impl TitleBar {
    pub fn new() -> Self {
        Self
    }
}

impl Default for TitleBar {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for TitleBar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        #[cfg(target_os = "macos")]
        {
            // macOS: transparent title bar with traffic lights
            div()
                .h(px(28.0))
                .w_full()
                .bg(colors.surface)
                // Leave space for traffic lights on the left
                .pl(px(70.0))
        }

        #[cfg(not(target_os = "macos"))]
        {
            // Windows/Linux: custom title bar
            div()
                .h(px(32.0))
                .w_full()
                .bg(colors.surface)
                .flex()
                .items_center()
                .justify_between()
                .px(px(8.0))
                .child(
                    div()
                        .text_size(theme.font_size_small)
                        .text_color(colors.text_muted)
                        .child("Kubernetes Dashboard"),
                )
                .child(self.render_window_controls(cx))
        }
    }
}

impl TitleBar {
    #[cfg(not(target_os = "macos"))]
    fn render_window_controls(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div()
            .flex()
            .items_center()
            .gap(px(4.0))
            // Minimize button
            .child(
                div()
                    .id("window-minimize")
                    .size(px(12.0))
                    .rounded_full()
                    .bg(colors.warning)
                    .cursor_pointer()
                    .on_click(|_event, window, _cx| {
                        // TODO: GPUI does not expose window.minimize() yet
                        tracing::info!("Minimize clicked (not implemented in GPUI)");
                    }),
            )
            // Maximize button
            .child(
                div()
                    .id("window-maximize")
                    .size(px(12.0))
                    .rounded_full()
                    .bg(colors.success)
                    .cursor_pointer()
                    .on_click(|_event, window, _cx| {
                        // TODO: GPUI does not expose window.toggle_fullscreen() yet
                        tracing::info!("Maximize clicked (not implemented in GPUI)");
                    }),
            )
            // Close button
            .child(
                div()
                    .id("window-close")
                    .size(px(12.0))
                    .rounded_full()
                    .bg(colors.error)
                    .cursor_pointer()
                    .on_click(|_event, _window, cx| {
                        // TODO: GPUI does not expose cx.quit() yet
                        tracing::info!("Close clicked (not implemented in GPUI)");
                    }),
            )
    }
}
