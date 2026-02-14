use gpui::*;
use ui::theme;

pub struct LogEntry {
    pub timestamp: Option<String>,
    pub message: String,
    pub level: LogLevel,
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum LogLevel {
    #[default]
    Info,
    Warning,
    Error,
    Debug,
}

pub struct LogsView {
    logs: Vec<LogEntry>,
    pod_name: String,
    _namespace: String,
    _container: Option<String>,
    filter: String,
    auto_scroll: bool,
}

impl LogsView {
    pub fn new(pod_name: String, namespace: String, container: Option<String>) -> Self {
        Self {
            logs: Vec::new(),
            pod_name,
            _namespace: namespace,
            _container: container,
            filter: String::new(),
            auto_scroll: true,
        }
    }

    pub fn set_logs(&mut self, logs: Vec<LogEntry>) {
        self.logs = logs;
    }

    pub fn append_log(&mut self, entry: LogEntry) {
        self.logs.push(entry);
    }

    pub fn set_filter(&mut self, filter: String) {
        self.filter = filter;
    }

    pub fn toggle_auto_scroll(&mut self) {
        self.auto_scroll = !self.auto_scroll;
    }

    pub fn clear(&mut self) {
        self.logs.clear();
    }

    fn filtered_logs(&self) -> Vec<&LogEntry> {
        if self.filter.is_empty() {
            return self.logs.iter().collect();
        }

        let filter_lower = self.filter.to_lowercase();
        self.logs
            .iter()
            .filter(|log| log.message.to_lowercase().contains(&filter_lower))
            .collect()
    }
}

impl Render for LogsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let logs = self.filtered_logs();
        let log_count = logs.len();

        div()
            .size_full()
            .flex()
            .flex_col()
            // Header
            .child(
                div()
                    .h(px(40.0))
                    .w_full()
                    .px(px(12.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(colors.border)
                    .child(
                        div()
                            .text_size(theme.font_size_small)
                            .text_color(colors.text_muted)
                            .child(format!("Logs: {} ({} lines)", self.pod_name, log_count)),
                    )
                    .child(
                        div().flex().items_center().gap(px(8.0)).child(
                            div()
                                .px(px(8.0))
                                .py(px(4.0))
                                .rounded(theme.border_radius)
                                .bg(if self.auto_scroll {
                                    colors.primary.opacity(0.2)
                                } else {
                                    colors.secondary
                                })
                                .text_size(theme.font_size_small)
                                .text_color(colors.text)
                                .cursor_pointer()
                                .child("Auto-scroll"),
                        ),
                    ),
            )
            // Logs content
            .child(
                div()
                    .id("logs-content-scroll")
                    .flex_1()
                    .min_h(px(0.0))
                    .overflow_y_scroll()
                    .bg(colors.surface)
                    .children(logs.into_iter().map(|log| self.render_log_entry(cx, log))),
            )
    }
}

impl LogsView {
    fn render_log_entry(&self, cx: &Context<'_, Self>, entry: &LogEntry) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let level_color = match entry.level {
            LogLevel::Info => colors.text,
            LogLevel::Warning => colors.warning,
            LogLevel::Error => colors.error,
            LogLevel::Debug => colors.text_muted,
        };

        let mut row = div()
            .w_full()
            .px(px(12.0))
            .py(px(2.0))
            .flex()
            .items_start()
            .gap(px(8.0))
            .hover(|style| style.bg(colors.selection_hover));

        // Timestamp
        if let Some(ts) = &entry.timestamp {
            row = row.child(
                div()
                    .w(px(180.0))
                    .flex_shrink_0()
                    .text_size(theme.font_size_small)
                    .text_color(colors.text_muted)
                    .font_family("JetBrains Mono")
                    .child(ts.clone()),
            );
        }

        // Message
        row = row.child(
            div()
                .flex_1()
                .text_size(theme.font_size_small)
                .text_color(level_color)
                .font_family("JetBrains Mono")
                .child(entry.message.clone()),
        );

        row
    }
}
