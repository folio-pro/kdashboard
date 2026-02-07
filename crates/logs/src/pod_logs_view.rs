use gpui::*;
use gpui::prelude::FluentBuilder;
use gpui_component::input::{Input, InputEvent, InputState};
use k8s_client::{get_client, get_pod_logs};
use std::sync::mpsc;
use ui::{
    theme, back_btn, secondary_btn, Button, ButtonVariant, ButtonVariants, DropdownMenu, Icon,
    IconName, PopupMenu, PopupMenuItem, Sizable,
};

/// Get or create the Tokio runtime for K8s operations
fn get_tokio_runtime() -> &'static tokio::runtime::Runtime {
    use std::sync::OnceLock;
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime")
    })
}

/// Log level filter for the UI
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum LogLevelFilter {
    #[default]
    All,
    Info,
    Warn,
    Error,
}

impl LogLevelFilter {
    pub fn as_str(&self) -> &'static str {
        match self {
            LogLevelFilter::All => "ALL",
            LogLevelFilter::Info => "INFO",
            LogLevelFilter::Warn => "WARN",
            LogLevelFilter::Error => "ERROR",
        }
    }
}

/// Time range for logs
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum LogSince {
    #[default]
    OneHour,
    ThreeHours,
    SixHours,
    TwelveHours,
    OneDay,
}

impl LogSince {
    pub fn as_str(&self) -> &'static str {
        match self {
            LogSince::OneHour => "1 hour ago",
            LogSince::ThreeHours => "3 hours ago",
            LogSince::SixHours => "6 hours ago",
            LogSince::TwelveHours => "12 hours ago",
            LogSince::OneDay => "1 day ago",
        }
    }

    pub fn as_seconds(&self) -> i64 {
        match self {
            LogSince::OneHour => 3600,
            LogSince::ThreeHours => 10800,
            LogSince::SixHours => 21600,
            LogSince::TwelveHours => 43200,
            LogSince::OneDay => 86400,
        }
    }

    fn all() -> &'static [LogSince] {
        &[
            LogSince::OneHour,
            LogSince::ThreeHours,
            LogSince::SixHours,
            LogSince::TwelveHours,
            LogSince::OneDay,
        ]
    }
}

/// Tail line options
const TAIL_OPTIONS: &[usize] = &[100, 250, 500, 1000, 2000];

/// Detected log level for a parsed entry
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DetectedLevel {
    Info,
    Warn,
    Error,
    Debug,
}

/// A single log entry for the pod logs view
#[derive(Clone, Debug)]
pub struct PodLogEntry {
    pub timestamp: String,
    pub level: DetectedLevel,
    pub message: String,
}

/// Actions that can be triggered from PodLogsView
#[derive(Clone, Debug)]
pub enum PodLogsAction {
    Close,
    Download,
    StartStream,
    StopStream,
    Clear,
}

pub struct PodLogsView {
    pod_name: String,
    namespace: String,
    containers: Vec<String>,
    selected_container: usize,

    // Logs data
    logs: Vec<PodLogEntry>,
    is_loading: bool,
    error: Option<String>,

    // Filter state
    level_filter: LogLevelFilter,
    log_since: LogSince,
    tail_lines: usize,
    search_query: String,
    show_timestamps: bool,
    previous_container: bool,
    regex_mode: bool,

    // Stream state
    is_streaming: bool,
    word_wrap: bool,

    // Search input
    search_input: Option<Entity<InputState>>,
    _search_subscription: Option<Subscription>,

    // Scroll
    scroll_handle: ScrollHandle,

    // Callbacks
    on_action: Option<Box<dyn Fn(PodLogsAction, &mut Context<'_, Self>) + 'static>>,
    on_close: Option<Box<dyn Fn(&mut Context<'_, Self>) + 'static>>,
}

impl PodLogsView {
    pub fn new(pod_name: String, namespace: String, containers: Vec<String>) -> Self {
        Self {
            pod_name,
            namespace,
            containers,
            selected_container: 0,
            logs: Vec::new(),
            is_loading: true,
            error: None,
            level_filter: LogLevelFilter::All,
            log_since: LogSince::OneHour,
            tail_lines: 1000,
            search_query: String::new(),
            show_timestamps: true,
            previous_container: false,
            regex_mode: false,
            is_streaming: true,
            word_wrap: false,
            search_input: None,
            _search_subscription: None,
            scroll_handle: ScrollHandle::new(),
            on_action: None,
            on_close: None,
        }
    }

    /// Initialize the search input (requires window access, call from render)
    fn ensure_search_input(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.search_input.is_some() {
            return;
        }
        let input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Filter logs...")
        });
        let sub = cx.subscribe(&input, |this, _input, ev: &InputEvent, cx| {
            match ev {
                InputEvent::Change => {
                    let text = this
                        .search_input
                        .as_ref()
                        .map(|i| i.read(cx).text().to_string())
                        .unwrap_or_default();
                    this.search_query = text;
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => {
                    // no-op, search is live
                }
                _ => {}
            }
        });
        self.search_input = Some(input);
        self._search_subscription = Some(sub);
    }

    /// Initialize and start fetching logs
    pub fn init(view: Entity<Self>, cx: &mut App) {
        let pod_name = view.read(cx).pod_name.clone();
        let namespace = view.read(cx).namespace.clone();
        let container = view.read(cx).containers.first().cloned();
        let tail_lines = view.read(cx).tail_lines as i64;
        let since_seconds = Some(view.read(cx).log_since.as_seconds());

        let (tx, rx) = mpsc::channel::<Result<String, String>>();

        std::thread::spawn(move || {
            let rt = get_tokio_runtime();
            rt.block_on(async {
                let client = match get_client().await {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(Err(format!("Failed to get K8s client: {}", e)));
                        return;
                    }
                };
                let result = get_pod_logs(
                    &client,
                    &pod_name,
                    container.as_deref(),
                    &namespace,
                    Some(tail_lines),
                    since_seconds,
                )
                .await;
                match result {
                    Ok(logs_text) => {
                        let _ = tx.send(Ok(logs_text));
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string()));
                    }
                }
            });
        });

        let view = view.downgrade();
        cx.spawn(async move |cx| {
            for _ in 0..200 {
                if let Ok(result) = rx.try_recv() {
                    let _ = cx.update(|cx: &mut App| {
                        let _ = view.update(cx, |this, cx| {
                            this.is_loading = false;
                            match result {
                                Ok(logs_text) => {
                                    this.logs = Self::parse_logs(&logs_text);
                                    this.error = None;
                                }
                                Err(e) => {
                                    this.error = Some(e);
                                }
                            }
                            cx.notify();
                        });
                    });
                    return;
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(50))
                    .await;
            }
            let _ = cx.update(|cx: &mut App| {
                let _ = view.update(cx, |this, cx| {
                    this.is_loading = false;
                    this.error = Some("Timeout waiting for logs".to_string());
                    cx.notify();
                });
            });
        })
        .detach();
    }

    fn parse_logs(logs_text: &str) -> Vec<PodLogEntry> {
        logs_text
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| {
                let (timestamp, message) =
                    if line.len() > 30 && line.chars().nth(4) == Some('-') {
                        let space_idx = line.find(' ').unwrap_or(0);
                        if space_idx > 20 {
                            (
                                line[..space_idx].to_string(),
                                line[space_idx + 1..].to_string(),
                            )
                        } else {
                            (String::new(), line.to_string())
                        }
                    } else {
                        (String::new(), line.to_string())
                    };

                let level = Self::detect_log_level(&message);
                PodLogEntry {
                    timestamp,
                    level,
                    message,
                }
            })
            .collect()
    }

    fn detect_log_level(message: &str) -> DetectedLevel {
        let msg_lower = message.to_lowercase();
        if msg_lower.contains("error")
            || msg_lower.contains("failed")
            || msg_lower.contains("err]")
        {
            DetectedLevel::Error
        } else if msg_lower.contains("warn") || msg_lower.contains("warning") {
            DetectedLevel::Warn
        } else if msg_lower.contains("info")
            || msg_lower.contains("get ")
            || msg_lower.contains("post ")
            || msg_lower.contains("http/")
            || msg_lower.contains("listening")
            || msg_lower.contains("started")
        {
            DetectedLevel::Info
        } else {
            DetectedLevel::Debug
        }
    }

    pub fn refresh(&mut self, cx: &mut Context<'_, Self>) {
        self.is_loading = true;
        self.error = None;
        cx.notify();

        let pod_name = self.pod_name.clone();
        let namespace = self.namespace.clone();
        let container = self.containers.get(self.selected_container).cloned();
        let tail_lines = self.tail_lines as i64;
        let since_seconds = Some(self.log_since.as_seconds());

        let (tx, rx) = mpsc::channel::<Result<String, String>>();

        std::thread::spawn(move || {
            let rt = get_tokio_runtime();
            rt.block_on(async {
                let client = match get_client().await {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(Err(format!("Failed to get K8s client: {}", e)));
                        return;
                    }
                };
                let result = get_pod_logs(
                    &client,
                    &pod_name,
                    container.as_deref(),
                    &namespace,
                    Some(tail_lines),
                    since_seconds,
                )
                .await;
                match result {
                    Ok(logs_text) => {
                        let _ = tx.send(Ok(logs_text));
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string()));
                    }
                }
            });
        });

        cx.spawn(async move |view, cx| {
            for _ in 0..200 {
                if let Ok(result) = rx.try_recv() {
                    let _ = cx.update(|cx: &mut App| {
                        let _ = view.update(cx, |this, cx| {
                            this.is_loading = false;
                            match result {
                                Ok(logs_text) => {
                                    this.logs = Self::parse_logs(&logs_text);
                                    this.error = None;
                                }
                                Err(e) => {
                                    this.error = Some(e);
                                }
                            }
                            cx.notify();
                        });
                    });
                    return;
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(50))
                    .await;
            }
            let _ = cx.update(|cx: &mut App| {
                let _ = view.update(cx, |this, cx| {
                    this.is_loading = false;
                    this.error = Some("Timeout waiting for logs".to_string());
                    cx.notify();
                });
            });
        })
        .detach();
    }

    pub fn on_action(
        mut self,
        handler: impl Fn(PodLogsAction, &mut Context<'_, Self>) + 'static,
    ) -> Self {
        self.on_action = Some(Box::new(handler));
        self
    }

    pub fn on_close(mut self, handler: impl Fn(&mut Context<'_, Self>) + 'static) -> Self {
        self.on_close = Some(Box::new(handler));
        self
    }

    pub fn set_logs(&mut self, logs: Vec<PodLogEntry>) {
        self.logs = logs;
    }

    pub fn append_log(&mut self, entry: PodLogEntry) {
        self.logs.push(entry);
    }

    pub fn clear_logs(&mut self) {
        self.logs.clear();
    }

    fn filtered_logs(&self) -> Vec<&PodLogEntry> {
        // Pre-compile regex if in regex mode
        let compiled_regex = if self.regex_mode && !self.search_query.is_empty() {
            regex::Regex::new(&self.search_query).ok()
        } else {
            None
        };

        self.logs
            .iter()
            .filter(|log| {
                // Level filter
                let level_match = match self.level_filter {
                    LogLevelFilter::All => true,
                    LogLevelFilter::Info => log.level == DetectedLevel::Info,
                    LogLevelFilter::Warn => log.level == DetectedLevel::Warn,
                    LogLevelFilter::Error => log.level == DetectedLevel::Error,
                };

                // Search filter
                let search_match = if self.search_query.is_empty() {
                    true
                } else if let Some(ref re) = compiled_regex {
                    re.is_match(&log.message)
                } else {
                    log.message
                        .to_lowercase()
                        .contains(&self.search_query.to_lowercase())
                };

                level_match && search_match
            })
            .collect()
    }

    /// Export logs to a file
    fn download_logs(&self) {
        let filtered = self.filtered_logs();
        let mut content = String::new();
        for log in &filtered {
            if !log.timestamp.is_empty() {
                content.push_str(&log.timestamp);
                content.push(' ');
            }
            content.push_str(match log.level {
                DetectedLevel::Info => "INFO  ",
                DetectedLevel::Warn => "WARN  ",
                DetectedLevel::Error => "ERROR ",
                DetectedLevel::Debug => "DEBUG ",
            });
            content.push_str(&log.message);
            content.push('\n');
        }

        // Write to ~/Downloads/<pod_name>-logs.txt
        if let Some(downloads) = dirs::download_dir() {
            let filename = format!("{}-logs.txt", self.pod_name);
            let path = downloads.join(filename);
            let _ = std::fs::write(&path, content);
            tracing::info!("Logs saved to {}", path.display());
        }
    }
}

// ── Render ──────────────────────────────────────────────────────────────────

impl Render for PodLogsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.ensure_search_input(window, cx);

        let theme = theme(cx);
        let colors = &theme.colors;

        // Root: fixed to window size, nothing escapes
        div()
            .id("pod-logs-root")
            .w_full()
            .h_full()
            .min_w(px(0.0))
            .min_h(px(0.0))
            .overflow_hidden()
            .flex()
            .flex_col()
            .bg(colors.background)
            .child(self.render_top_bar(cx))
            .child(self.render_filter_toolbar(cx))
            .child(self.render_logs_content(cx))
    }
}

impl PodLogsView {
    // ── Top Bar ─────────────────────────────────────────────────────────

    fn render_top_bar(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let container_dropdown = self.render_container_dropdown(cx);

        let search_input = self.search_input.as_ref().map(|input| {
            Input::new(input)
                .appearance(false)
                .cleanable(true)
                .with_size(ui::Size::Small)
        });

        div()
            .w_full()
            .flex_shrink_0()
            .overflow_hidden()
            .flex()
            .items_center()
            .justify_between()
            .px(px(24.0))
            .py(px(12.0))
            .border_b_1()
            .border_color(colors.border)
            // Left: back + title + pod name
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(16.0))
                    .child(
                        back_btn("logs-back-btn", colors)
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                if let Some(on_close) = &this.on_close {
                                    on_close(cx);
                                }
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.0))
                            .child(
                                div()
                                    .text_size(px(16.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .font_family(theme.font_family_ui.clone())
                                    .text_color(colors.text)
                                    .child("Logs"),
                            )
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .font_family(theme.font_family.clone())
                                    .text_color(colors.text_muted)
                                    .child(self.pod_name.clone()),
                            ),
                    ),
            )
            // Right: container selector + search + wrap + download + stream
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(container_dropdown)
                    .child(
                        div()
                            .w(px(250.0))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .px(px(12.0))
                            .py(px(4.0))
                            .rounded(theme.border_radius_md)
                            .bg(colors.surface)
                            .border_1()
                            .border_color(colors.border)
                            .child(
                                Icon::new(IconName::Search)
                                    .size(px(14.0))
                                    .color(colors.text_muted),
                            )
                            .when_some(search_input, |el, input| el.child(input)),
                    )
                    // Wrap button
                    .child(
                        div()
                            .id("wrap-btn")
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .px(px(12.0))
                            .py(px(6.0))
                            .rounded(theme.border_radius_md)
                            .border_1()
                            .when(self.word_wrap, |el| {
                                el.bg(colors.primary)
                                    .border_color(colors.primary)
                            })
                            .when(!self.word_wrap, |el| {
                                el.bg(colors.surface)
                                    .border_color(colors.border)
                            })
                            .cursor_pointer()
                            .hover(|s| s.bg(colors.secondary_hover))
                            .child(
                                Icon::new(IconName::WrapText)
                                    .size(px(14.0))
                                    .color(if self.word_wrap {
                                        colors.background
                                    } else {
                                        colors.text_secondary
                                    }),
                            )
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .font_family(theme.font_family_ui.clone())
                                    .text_color(if self.word_wrap {
                                        colors.background
                                    } else {
                                        colors.text_secondary
                                    })
                                    .child("Wrap"),
                            )
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.word_wrap = !this.word_wrap;
                                cx.notify();
                            })),
                    )
                    // Download button
                    .child(
                        secondary_btn("download-btn", IconName::Download, "Download", colors)
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.download_logs();
                                if let Some(on_action) = &this.on_action {
                                    on_action(PodLogsAction::Download, cx);
                                }
                            })),
                    )
                    // Stream button
                    .child(
                        div()
                            .id("stream-btn")
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .px(px(12.0))
                            .py(px(6.0))
                            .rounded(theme.border_radius_md)
                            .border_1()
                            .when(self.is_streaming, |el| {
                                el.bg(colors.primary)
                                    .border_color(colors.primary)
                            })
                            .when(!self.is_streaming, |el| {
                                el.bg(colors.surface)
                                    .border_color(colors.border)
                            })
                            .cursor_pointer()
                            .hover(|s| s.bg(colors.primary_hover))
                            .child(
                                Icon::new(IconName::Play)
                                    .size(px(14.0))
                                    .color(if self.is_streaming {
                                        colors.background
                                    } else {
                                        colors.text_secondary
                                    }),
                            )
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .font_family(theme.font_family.clone())
                                    .text_color(if self.is_streaming {
                                        colors.background
                                    } else {
                                        colors.text
                                    })
                                    .child("Stream"),
                            )
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.is_streaming = !this.is_streaming;
                                if let Some(on_action) = &this.on_action {
                                    if this.is_streaming {
                                        on_action(PodLogsAction::StartStream, cx);
                                    } else {
                                        on_action(PodLogsAction::StopStream, cx);
                                    }
                                }
                                cx.notify();
                            })),
                    ),
            )
    }

    // ── Container Dropdown ──────────────────────────────────────────────

    fn render_container_dropdown(&self, cx: &Context<'_, Self>) -> Div {
        let containers = self.containers.clone();
        let selected = self.selected_container;
        let current_label: SharedString = containers
            .get(selected)
            .cloned()
            .unwrap_or_else(|| "default".to_string())
            .into();

        if containers.len() <= 1 {
            return div().child(
                Button::new("container-selector")
                    .icon(IconName::Box)
                    .label(current_label)
                    .compact()
                    .with_variant(ButtonVariant::Ghost),
            );
        }

        let view = cx.entity().downgrade();
        div().child(
            Button::new("container-selector")
                .icon(IconName::Box)
                .label(current_label)
                .compact()
                .with_variant(ButtonVariant::Ghost)
                .dropdown_caret(true)
                .dropdown_menu(move |menu: PopupMenu, _window, _cx| {
                    let mut m = menu.scrollable(true);
                    for (i, c) in containers.iter().enumerate() {
                        let is_selected = i == selected;
                        let idx = i;
                        let view = view.clone();
                        m = m.item(
                            PopupMenuItem::new(c.clone())
                                .checked(is_selected)
                                .on_click(move |_, _window, cx| {
                                    let _ = view.update(cx, |this, cx| {
                                        if this.selected_container != idx {
                                            this.selected_container = idx;
                                            this.refresh(cx);
                                        }
                                    });
                                }),
                        );
                    }
                    m
                }),
        )
    }

    // ── Filter Toolbar ──────────────────────────────────────────────────

    fn render_filter_toolbar(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let filtered_count = self.filtered_logs().len();

        let time_dropdown = self.render_time_dropdown(cx);
        let tail_dropdown = self.render_tail_dropdown(cx);

        div()
            .w_full()
            .flex_shrink_0()
            .overflow_hidden()
            .flex()
            .items_center()
            .gap(px(12.0))
            .bg(colors.surface)
            .px(px(24.0))
            .py(px(10.0))
            .border_b_1()
            .border_color(colors.border)
            .child(
                div()
                    .text_size(px(12.0))
                    .font_weight(FontWeight::MEDIUM)
                    .font_family(theme.font_family_ui.clone())
                    .text_color(colors.text_secondary)
                    .child("Level:"),
            )
            .child(self.render_level_selector(cx))
            .child(self.render_separator(colors))
            .child(
                div()
                    .text_size(px(12.0))
                    .font_weight(FontWeight::MEDIUM)
                    .font_family(theme.font_family_ui.clone())
                    .text_color(colors.text_secondary)
                    .child("Since:"),
            )
            .child(time_dropdown)
            .child(self.render_separator(colors))
            .child(
                div()
                    .text_size(px(12.0))
                    .font_weight(FontWeight::MEDIUM)
                    .font_family(theme.font_family_ui.clone())
                    .text_color(colors.text_secondary)
                    .child("Tail:"),
            )
            .child(tail_dropdown)
            .child(self.render_separator(colors))
            // Timestamps toggle
            .child(
                div()
                    .id("timestamps-toggle")
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .px(px(10.0))
                    .py(px(6.0))
                    .rounded(theme.border_radius_md)
                    .when(self.show_timestamps, |el| el.bg(colors.primary))
                    .when(!self.show_timestamps, |el| {
                        el.border_1().border_color(colors.border)
                    })
                    .cursor_pointer()
                    .hover(|s| s.bg(colors.primary_hover))
                    .when(self.show_timestamps, |el| {
                        el.child(
                            Icon::new(IconName::Check)
                                .size(px(14.0))
                                .color(colors.background),
                        )
                    })
                    .child(
                        div()
                            .text_size(px(11.0))
                            .font_weight(if self.show_timestamps {
                                FontWeight::SEMIBOLD
                            } else {
                                FontWeight::MEDIUM
                            })
                            .font_family(theme.font_family_ui.clone())
                            .text_color(if self.show_timestamps {
                                colors.background
                            } else {
                                colors.text_secondary
                            })
                            .child("Timestamps"),
                    )
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.show_timestamps = !this.show_timestamps;
                        cx.notify();
                    })),
            )
            // Previous toggle
            .child(
                div()
                    .id("previous-toggle")
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .px(px(10.0))
                    .py(px(6.0))
                    .rounded(theme.border_radius_md)
                    .when(self.previous_container, |el| el.bg(colors.primary))
                    .when(!self.previous_container, |el| {
                        el.border_1().border_color(colors.border)
                    })
                    .cursor_pointer()
                    .hover(|s| s.bg(colors.secondary_hover))
                    .when(self.previous_container, |el| {
                        el.child(
                            Icon::new(IconName::Check)
                                .size(px(14.0))
                                .color(colors.background),
                        )
                    })
                    .child(
                        div()
                            .text_size(px(11.0))
                            .font_weight(FontWeight::MEDIUM)
                            .font_family(theme.font_family_ui.clone())
                            .text_color(if self.previous_container {
                                colors.background
                            } else {
                                colors.text_secondary
                            })
                            .child("Previous"),
                    )
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.previous_container = !this.previous_container;
                        this.refresh(cx);
                    })),
            )
            .child(self.render_separator(colors))
            // Regex toggle
            .child(
                div()
                    .id("regex-toggle")
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .px(px(10.0))
                    .py(px(6.0))
                    .rounded(theme.border_radius_md)
                    .when(self.regex_mode, |el| el.bg(colors.primary))
                    .when(!self.regex_mode, |el| {
                        el.border_1().border_color(colors.border)
                    })
                    .cursor_pointer()
                    .hover(|s| s.bg(colors.secondary_hover))
                    .child(
                        Icon::new(IconName::Search)
                            .size(px(14.0))
                            .color(if self.regex_mode {
                                colors.background
                            } else {
                                colors.text_secondary
                            }),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .font_weight(FontWeight::MEDIUM)
                            .font_family(theme.font_family_ui.clone())
                            .text_color(if self.regex_mode {
                                colors.background
                            } else {
                                colors.text_secondary
                            })
                            .child("Regex"),
                    )
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.regex_mode = !this.regex_mode;
                        cx.notify();
                    })),
            )
            // Spacer
            .child(div().flex_1())
            // Line count
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        Icon::new(IconName::FileText)
                            .size(px(14.0))
                            .color(colors.text_muted),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .font_weight(FontWeight::MEDIUM)
                            .font_family(theme.font_family.clone())
                            .text_color(colors.text_muted)
                            .child(format!(
                                "{} lines",
                                Self::format_number(filtered_count)
                            )),
                    ),
            )
            .child(self.render_separator(colors))
            // Clear button
            .child(
                div()
                    .id("clear-btn")
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .px(px(10.0))
                    .py(px(6.0))
                    .rounded(theme.border_radius_md)
                    .border_1()
                    .border_color(colors.border)
                    .cursor_pointer()
                    .hover(|s| s.bg(colors.secondary_hover))
                    .child(
                        Icon::new(IconName::Trash)
                            .size(px(14.0))
                            .color(colors.text_secondary),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .font_weight(FontWeight::MEDIUM)
                            .font_family(theme.font_family_ui.clone())
                            .text_color(colors.text_secondary)
                            .child("Clear"),
                    )
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.logs.clear();
                        if let Some(on_action) = &this.on_action {
                            on_action(PodLogsAction::Clear, cx);
                        }
                        cx.notify();
                    })),
            )
    }

    // ── Time Dropdown ───────────────────────────────────────────────────

    fn render_time_dropdown(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let current = self.log_since;
        let current_label: SharedString = current.as_str().into();
        let view = cx.entity().downgrade();

        Button::new("time-selector")
            .label(current_label)
            .compact()
            .with_variant(ButtonVariant::Ghost)
            .dropdown_caret(true)
            .dropdown_menu(move |menu: PopupMenu, _window, _cx| {
                let mut m = menu;
                for &since in LogSince::all() {
                    let is_selected = since == current;
                    let view = view.clone();
                    m = m.item(
                        PopupMenuItem::new(since.as_str())
                            .checked(is_selected)
                            .on_click(move |_, _window, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    this.log_since = since;
                                    this.refresh(cx);
                                });
                            }),
                    );
                }
                m
            })
    }

    // ── Tail Dropdown ───────────────────────────────────────────────────

    fn render_tail_dropdown(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let current = self.tail_lines;
        let current_label: SharedString = current.to_string().into();
        let view = cx.entity().downgrade();

        Button::new("tail-selector")
            .label(current_label)
            .compact()
            .with_variant(ButtonVariant::Ghost)
            .dropdown_caret(true)
            .dropdown_menu(move |menu: PopupMenu, _window, _cx| {
                let mut m = menu;
                for &tail in TAIL_OPTIONS {
                    let is_selected = tail == current;
                    let view = view.clone();
                    m = m.item(
                        PopupMenuItem::new(tail.to_string())
                            .checked(is_selected)
                            .on_click(move |_, _window, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    this.tail_lines = tail;
                                    this.refresh(cx);
                                });
                            }),
                    );
                }
                m
            })
    }

    // ── Level Selector (segmented control) ──────────────────────────────

    fn render_level_selector(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div()
            .flex()
            .rounded(theme.border_radius_md)
            .border_1()
            .border_color(colors.border)
            .overflow_hidden()
            .child(self.render_level_segment(cx, LogLevelFilter::All, "ALL", colors.primary, true))
            .child(self.render_level_segment(
                cx,
                LogLevelFilter::Info,
                "INFO",
                colors.text_secondary,
                false,
            ))
            .child(self.render_level_segment(
                cx,
                LogLevelFilter::Warn,
                "WARN",
                colors.warning,
                false,
            ))
            .child(self.render_level_segment(
                cx,
                LogLevelFilter::Error,
                "ERROR",
                colors.error,
                false,
            ))
    }

    fn render_level_segment(
        &self,
        cx: &Context<'_, Self>,
        level: LogLevelFilter,
        label: &'static str,
        color: Hsla,
        is_first: bool,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let is_active = self.level_filter == level;
        let label_owned = label.to_string();

        div()
            .id(ElementId::Name(label.into()))
            .px(px(10.0))
            .py(px(6.0))
            .cursor_pointer()
            .when(is_active, |el| el.bg(colors.primary))
            .when(!is_active, |el| el.bg(colors.surface))
            .when(!is_first, |el| {
                el.border_l_1().border_color(colors.border)
            })
            .hover(|s| {
                if is_active {
                    s
                } else {
                    s.bg(colors.secondary_hover)
                }
            })
            .child(
                div()
                    .text_size(px(11.0))
                    .font_weight(if is_active {
                        FontWeight::SEMIBOLD
                    } else {
                        FontWeight::MEDIUM
                    })
                    .font_family(theme.font_family_ui.clone())
                    .text_color(if is_active { colors.background } else { color })
                    .child(label_owned.clone()),
            )
            .on_click(cx.listener(move |this, _event, _window, cx| {
                this.level_filter = level;
                cx.notify();
            }))
    }

    // ── Logs Content Area ───────────────────────────────────────────────

    fn render_logs_content(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let logs = self.filtered_logs();
        let is_loading = self.is_loading;
        let error = self.error.clone();

        // Outer: fills remaining vertical space, clips everything
        div()
            .flex_1()
            .min_h(px(0.0))
            .min_w(px(0.0))
            .overflow_hidden()
            .p(px(24.0))
            .child(
                // Card container: fills the padded area
                div()
                    .w_full()
                    .h_full()
                    .min_w(px(0.0))
                    .flex()
                    .flex_col()
                    .rounded(theme.border_radius_md)
                    .bg(colors.surface_elevated)
                    .border_1()
                    .border_color(colors.border)
                    .overflow_hidden()
                    .child(self.render_terminal_header(cx))
                    // Scroll boundary: hard clip wrapper so scroll never leaks
                    .child(
                        div()
                            .flex_1()
                            .min_h(px(0.0))
                            .min_w(px(0.0))
                            .overflow_hidden()
                            .child(
                                // Actual scrollable area
                                div()
                                    .id("logs-scroll")
                                    .w_full()
                                    .h_full()
                                    .when(self.word_wrap, |el| el.overflow_y_scroll())
                                    .when(!self.word_wrap, |el| el.overflow_scroll())
                                    .track_scroll(&self.scroll_handle)
                                    .bg(colors.surface_elevated)
                                    .p(px(16.0))
                                    .flex()
                                    .flex_col()
                                    .when(!self.word_wrap, |el| el.items_start())
                                    .gap(px(2.0))
                                    .when(is_loading, |el| {
                                        el.child(
                                            div()
                                                .text_size(px(12.0))
                                                .text_color(colors.text_muted)
                                                .font_family(theme.font_family.clone())
                                                .child("Loading logs..."),
                                        )
                                    })
                                    .when(error.is_some(), |el| {
                                        el.child(
                                            div()
                                                .text_size(px(12.0))
                                                .text_color(colors.error)
                                                .font_family(theme.font_family.clone())
                                                .child(format!(
                                                    "Error: {}",
                                                    error.unwrap_or_default()
                                                )),
                                        )
                                    })
                                    .when(!is_loading && self.error.is_none(), |el| {
                                        el.children(
                                            logs.iter()
                                                .map(|log| self.render_log_line(cx, log)),
                                        )
                                    }),
                            ),
                    ),
            )
    }

    // ── Terminal Header ─────────────────────────────────────────────────

    fn render_terminal_header(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div()
            .w_full()
            .flex_shrink_0()
            .overflow_hidden()
            .flex()
            .items_center()
            .justify_between()
            .px(px(16.0))
            .py(px(12.0))
            .bg(colors.surface)
            .border_b_1()
            .border_color(colors.border)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        Icon::new(IconName::Terminal)
                            .size(px(16.0))
                            .color(colors.text_muted),
                    )
                    .child(
                        div()
                            .text_size(px(12.0))
                            .font_family(theme.font_family.clone())
                            .text_color(colors.text_secondary)
                            .child(self.pod_name.clone()),
                    ),
            )
            .when(self.is_streaming, |el| {
                el.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            div()
                                .size(px(8.0))
                                .rounded_full()
                                .bg(colors.success),
                        )
                        .child(
                            div()
                                .text_size(px(10.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .font_family(theme.font_family.clone())
                                .text_color(colors.success)
                                .child("LIVE"),
                        ),
                )
            })
    }

    // ── Log Line ────────────────────────────────────────────────────────

    fn render_log_line(&self, cx: &Context<'_, Self>, log: &PodLogEntry) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let (level_color, level_label, msg_color) = match log.level {
            DetectedLevel::Info => (colors.primary, "INFO", colors.text_secondary),
            DetectedLevel::Warn => (colors.warning, "WARN", colors.warning),
            DetectedLevel::Error => (colors.error, "ERROR", colors.error),
            DetectedLevel::Debug => (colors.text_muted, "DEBUG", colors.text_secondary),
        };

        let word_wrap = self.word_wrap;

        div()
            .w_full()
            .when(!word_wrap, |el| el.flex_shrink_0())
            .min_w(px(0.0))
            .flex()
            .items_start()
            .gap(px(12.0))
            .hover(|s| s.bg(colors.selection_hover))
            // Timestamp
            .when(self.show_timestamps && !log.timestamp.is_empty(), |el| {
                el.child(
                    div()
                        .w(px(200.0))
                        .flex_shrink_0()
                        .text_size(px(12.0))
                        .font_family(theme.font_family.clone())
                        .text_color(colors.text_muted)
                        .child(log.timestamp.clone()),
                )
            })
            // Level
            .child(
                div()
                    .w(px(50.0))
                    .flex_shrink_0()
                    .text_size(px(12.0))
                    .font_family(theme.font_family.clone())
                    .text_color(level_color)
                    .child(level_label),
            )
            // Message
            .child(
                div()
                    .when(word_wrap, |el| el.flex_1().min_w(px(0.0)))
                    .when(!word_wrap, |el| el.whitespace_nowrap().flex_shrink_0())
                    .text_size(px(12.0))
                    .font_family(theme.font_family.clone())
                    .text_color(msg_color)
                    .child(log.message.clone()),
            )
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    fn render_separator(&self, colors: &ui::ThemeColors) -> impl IntoElement {
        div().w(px(1.0)).h(px(20.0)).bg(colors.border)
    }

    fn format_number(n: usize) -> String {
        if n >= 1000 {
            format!("{},{:03}", n / 1000, n % 1000)
        } else {
            n.to_string()
        }
    }
}

