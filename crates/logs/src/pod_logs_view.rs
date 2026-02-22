mod formatting;

use gpui::prelude::FluentBuilder;
use gpui::*;
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::scroll::ScrollableElement;
use gpui_component::{VirtualListScrollHandle, v_virtual_list};
use k8s_client::{get_client, get_pod_logs, stream_pod_logs};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use ui::{
    Button, ButtonVariant, ButtonVariants, DropdownMenu, Icon, IconName, PopupMenu, PopupMenuItem,
    Sizable, back_btn, secondary_btn, theme,
};

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
    AllTime,
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
            LogSince::AllTime => "All time",
            LogSince::OneHour => "1 hour ago",
            LogSince::ThreeHours => "3 hours ago",
            LogSince::SixHours => "6 hours ago",
            LogSince::TwelveHours => "12 hours ago",
            LogSince::OneDay => "1 day ago",
        }
    }

    pub fn as_seconds(&self) -> Option<i64> {
        match self {
            LogSince::AllTime => None,
            LogSince::OneHour => Some(3600),
            LogSince::ThreeHours => Some(10800),
            LogSince::SixHours => Some(21600),
            LogSince::TwelveHours => Some(43200),
            LogSince::OneDay => Some(86400),
        }
    }

    pub fn all() -> &'static [LogSince] {
        &[
            LogSince::AllTime,
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
    StartStream,
    StopStream,
    Clear,
}

#[derive(Clone, Debug)]
struct LogModalState {
    timestamp: String,
    level: DetectedLevel,
    format_label: String,
    content: String,
}

#[derive(Clone, Debug)]
pub struct ColorSpan {
    pub text: String,
    pub color: Hsla,
}

pub const MODAL_WRAP_CHUNK_CHARS: usize = 80;

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
    stream_cancel: Option<Arc<AtomicBool>>,
    stream_generation: u64,
    word_wrap: bool,
    log_modal: Option<LogModalState>,
    selected_log_index: Option<usize>,

    // Search input
    search_input: Option<Entity<InputState>>,
    _search_subscription: Option<Subscription>,

    // Scroll
    logs_scroll_handle: VirtualListScrollHandle,

    // Filter cache
    filtered_indices: Vec<usize>,
    filter_dirty: bool,

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
            stream_cancel: None,
            stream_generation: 0,
            word_wrap: false,
            log_modal: None,
            selected_log_index: None,
            search_input: None,
            _search_subscription: None,
            logs_scroll_handle: VirtualListScrollHandle::new(),
            filtered_indices: Vec::new(),
            filter_dirty: true,
            on_action: None,
            on_close: None,
        }
    }

    /// Initialize the search input (requires window access, call from render)
    fn ensure_search_input(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.search_input.is_some() {
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Filter logs..."));
        let sub = cx.subscribe(&input, |this, _input, ev: &InputEvent, cx| {
            match ev {
                InputEvent::Change => {
                    let text = this
                        .search_input
                        .as_ref()
                        .map(|i| i.read(cx).text().to_string())
                        .unwrap_or_default();
                    this.search_query = text;
                    this.filter_dirty = true;
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

    /// Initialize logs view.
    pub fn init(view: Entity<Self>, cx: &mut App) {
        let _ = view.update(cx, |this, cx| {
            this.refresh(cx);
        });
    }

    fn parse_log_line(line: &str) -> Option<PodLogEntry> {
        if line.trim().is_empty() {
            return None;
        }

        let (timestamp, message) = if line.len() > 30 && line.chars().nth(4) == Some('-') {
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
        Some(PodLogEntry {
            timestamp,
            level,
            message,
        })
    }

    fn parse_logs(logs_text: &str) -> Vec<PodLogEntry> {
        logs_text.lines().filter_map(Self::parse_log_line).collect()
    }

    fn detect_log_level(message: &str) -> DetectedLevel {
        let msg_lower = message.to_lowercase();
        if msg_lower.contains("error") || msg_lower.contains("failed") || msg_lower.contains("err]")
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

    fn stop_stream(&mut self) {
        if let Some(cancel) = self.stream_cancel.take() {
            cancel.store(true, Ordering::SeqCst);
        }
    }

    fn start_stream(&mut self, cx: &mut Context<'_, Self>) {
        self.stop_stream();
        self.stream_generation = self.stream_generation.wrapping_add(1);
        let stream_generation = self.stream_generation;

        self.is_loading = true;
        self.error = None;
        cx.notify();

        let pod_name = self.pod_name.clone();
        let namespace = self.namespace.clone();
        let container = self.containers.get(self.selected_container).cloned();
        let tail_lines = self.tail_lines as i64;
        let since_seconds = self.log_since.as_seconds();
        let previous = self.previous_container;

        let cancelled = Arc::new(AtomicBool::new(false));
        self.stream_cancel = Some(cancelled.clone());

        let (tx, rx) = mpsc::channel::<Result<String, String>>();

        std::thread::spawn(move || {
            let rt = k8s_client::tokio_runtime();
            rt.block_on(async {
                let client = match get_client().await {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(Err(format!("Failed to get K8s client: {}", e)));
                        return;
                    }
                };
                let result = stream_pod_logs(
                    &client,
                    &pod_name,
                    container.as_deref(),
                    &namespace,
                    Some(tail_lines),
                    since_seconds,
                    previous,
                    tx.clone(),
                    cancelled.clone(),
                )
                .await;

                if let Err(e) = result {
                    let _ = tx.send(Err(e.to_string()));
                }
            });
        });

        cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(30))
                    .await;

                let mut should_break = false;
                loop {
                    match rx.try_recv() {
                        Ok(msg) => {
                            let _ = cx.update(|cx: &mut App| {
                                let _ = view.update(cx, |this, cx| {
                                    if this.stream_generation != stream_generation {
                                        return;
                                    }

                                    this.is_loading = false;
                                    match msg {
                                        Ok(line) => {
                                            if let Some(entry) = Self::parse_log_line(&line) {
                                                this.append_log(entry);
                                            }
                                        }
                                        Err(e) => {
                                            this.error = Some(e);
                                            should_break = true;
                                        }
                                    }
                                    cx.notify();
                                });
                            });
                        }
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => {
                            let _ = cx.update(|cx: &mut App| {
                                let _ = view.update(cx, |this, cx| {
                                    if this.stream_generation == stream_generation {
                                        this.is_loading = false;
                                        cx.notify();
                                    }
                                });
                            });
                            should_break = true;
                            break;
                        }
                    }
                }

                if should_break {
                    break;
                }
            }
        })
        .detach();
    }

    fn refresh_once(&mut self, cx: &mut Context<'_, Self>) {
        self.stop_stream();
        self.is_loading = true;
        self.error = None;
        cx.notify();

        let pod_name = self.pod_name.clone();
        let namespace = self.namespace.clone();
        let container = self.containers.get(self.selected_container).cloned();
        let tail_lines = self.tail_lines as i64;
        let since_seconds = self.log_since.as_seconds();

        let (tx, rx) = mpsc::channel::<Result<String, String>>();

        std::thread::spawn(move || {
            let rt = k8s_client::tokio_runtime();
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
                                    this.filter_dirty = true;
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

    pub fn refresh(&mut self, cx: &mut Context<'_, Self>) {
        self.clear_logs();
        if self.is_streaming {
            self.start_stream(cx);
        } else {
            self.refresh_once(cx);
        }
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
        self.filter_dirty = true;
        self.selected_log_index = None;
        self.log_modal = None;
    }

    pub fn append_log(&mut self, entry: PodLogEntry) {
        self.logs.push(entry);
        self.filter_dirty = true;
    }

    pub fn clear_logs(&mut self) {
        self.logs.clear();
        self.filtered_indices.clear();
        self.filter_dirty = false;
        self.selected_log_index = None;
        self.log_modal = None;
    }

    fn update_filtered_indices(&mut self) {
        if !self.filter_dirty {
            return;
        }

        // Pre-compile regex if in regex mode
        let compiled_regex = if self.regex_mode && !self.search_query.is_empty() {
            regex::Regex::new(&self.search_query).ok()
        } else {
            None
        };

        let search_lower = if self.search_query.is_empty() {
            None
        } else {
            Some(self.search_query.to_lowercase())
        };

        self.filtered_indices.clear();
        self.filtered_indices.reserve(self.logs.len());

        for (idx, log) in self.logs.iter().enumerate() {
            // Level filter
            let level_match = match self.level_filter {
                LogLevelFilter::All => true,
                LogLevelFilter::Info => log.level == DetectedLevel::Info,
                LogLevelFilter::Warn => log.level == DetectedLevel::Warn,
                LogLevelFilter::Error => log.level == DetectedLevel::Error,
            };

            // Search filter
            let search_match = if search_lower.is_none() {
                true
            } else if let Some(ref re) = compiled_regex {
                re.is_match(&log.message)
            } else {
                let message_lower = log.message.to_lowercase();
                message_lower.contains(search_lower.as_ref().unwrap())
            };

            if level_match && search_match {
                self.filtered_indices.push(idx);
            }
        }

        self.filter_dirty = false;
    }
}

impl Drop for PodLogsView {
    fn drop(&mut self) {
        self.stop_stream();
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
            .relative()
            .flex()
            .flex_col()
            .bg(colors.background)
            .child(self.render_top_bar(cx))
            .child(self.render_filter_toolbar(cx))
            .child(self.render_logs_content(cx))
            .when_some(self.log_modal.clone(), |el, modal| {
                el.child(self.render_log_sidebar(cx, modal))
            })
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
            .items_start()
            .flex_wrap()
            .gap(px(8.0))
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
                    .min_w(px(0.0))
                    .flex_1()
                    .child(back_btn("logs-back-btn", colors).on_click(cx.listener(
                        |this, _event, _window, cx| {
                            if let Some(on_close) = &this.on_close {
                                on_close(cx);
                            }
                            cx.notify();
                        },
                    )))
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
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .child(self.pod_name.clone()),
                            ),
                    ),
            )
            // Right: container selector + search + download + stream
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_end()
                    .flex_wrap()
                    .gap(px(8.0))
                    .min_w(px(0.0))
                    .flex_1()
                    .child(container_dropdown)
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(150.0))
                            .max_w(px(250.0))
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
                                el.bg(colors.primary).border_color(colors.primary)
                            })
                            .when(!self.is_streaming, |el| {
                                el.bg(colors.surface).border_color(colors.border)
                            })
                            .cursor_pointer()
                            .hover(|s| s.bg(colors.primary_hover))
                            .child(Icon::new(IconName::Play).size(px(14.0)).color(
                                if self.is_streaming {
                                    colors.background
                                } else {
                                    colors.text_secondary
                                },
                            ))
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
                                let next_streaming = !this.is_streaming;
                                this.is_streaming = next_streaming;
                                if next_streaming {
                                    this.refresh(cx);
                                } else {
                                    this.stop_stream();
                                    this.is_loading = false;
                                }
                                if let Some(on_action) = &this.on_action {
                                    if next_streaming {
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
                        m = m.item(PopupMenuItem::new(c.clone()).checked(is_selected).on_click(
                            move |_, _window, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    if this.selected_container != idx {
                                        this.selected_container = idx;
                                        this.refresh(cx);
                                    }
                                });
                            },
                        ));
                    }
                    m
                }),
        )
    }

    // ── Filter Toolbar ──────────────────────────────────────────────────

    fn render_filter_toolbar(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let time_dropdown = self.render_time_dropdown(cx);
        let tail_dropdown = self.render_tail_dropdown(cx);

        div()
            .w_full()
            .flex_shrink_0()
            .overflow_hidden()
            .flex()
            .items_center()
            .flex_wrap()
            .gap(px(12.0))
            .gap_y(px(8.0))
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
                        this.filter_dirty = true;
                        cx.notify();
                    })),
            )
            // Spacer
            .child(div().flex_1())
            // Wrap toggle
            .child(
                div()
                    .id("wrap-btn")
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .px(px(10.0))
                    .py(px(6.0))
                    .rounded(theme.border_radius_md)
                    .when(self.word_wrap, |el| el.bg(colors.primary))
                    .when(!self.word_wrap, |el| {
                        el.border_1().border_color(colors.border)
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
                            .text_size(px(11.0))
                            .font_weight(if self.word_wrap {
                                FontWeight::SEMIBOLD
                            } else {
                                FontWeight::MEDIUM
                            })
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
                        this.clear_logs();
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
            .with_size(ui::Size::XSmall)
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
            .with_size(ui::Size::XSmall)
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
            .when(!is_first, |el| el.border_l_1().border_color(colors.border))
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
                this.filter_dirty = true;
                cx.notify();
            }))
    }

    // ── Logs Content Area ───────────────────────────────────────────────

    fn render_logs_content(&mut self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.update_filtered_indices();

        let theme = theme(cx);
        let colors = &theme.colors;
        let item_count = self.filtered_indices.len();
        let item_sizes = std::rc::Rc::new(vec![size(px(0.0), px(22.0)); item_count]);
        let is_loading = self.is_loading;
        let error = self.error.clone();
        let list_scroll_handle = self.logs_scroll_handle.clone();

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
                                    .bg(colors.surface_elevated)
                                    .when(is_loading, |el| {
                                        el.child(
                                            div()
                                                .p(px(16.0))
                                                .text_size(px(12.0))
                                                .text_color(colors.text_muted)
                                                .font_family(theme.font_family.clone())
                                                .child("Loading logs..."),
                                        )
                                    })
                                    .when(error.is_some(), |el| {
                                        el.child(
                                            div()
                                                .p(px(16.0))
                                                .text_size(px(12.0))
                                                .text_color(colors.error)
                                                .font_family(theme.font_family.clone())
                                                .child(format!(
                                                    "Error: {}",
                                                    error.unwrap_or_default()
                                                )),
                                        )
                                    })
                                    .when(!is_loading && self.error.is_none() && self.word_wrap, |el| {
                                        if item_count == 0 {
                                            el.child(
                                                div()
                                                    .p(px(16.0))
                                                    .text_size(px(12.0))
                                                    .text_color(colors.text_muted)
                                                    .font_family(theme.font_family.clone())
                                                    .child("No log lines match the current filters."),
                                            )
                                        } else {
                                            let wrap_scroll_handle = self.logs_scroll_handle.clone();
                                            let wrap_item_sizes = std::rc::Rc::new(vec![size(px(0.0), px(22.0)); item_count]);
                                            el.child(
                                                div()
                                                    .id("logs-wrap-scrollbar")
                                                    .w_full()
                                                    .h_full()
                                                    .relative()
                                                    .vertical_scrollbar(&wrap_scroll_handle)
                                                    .child(
                                                        v_virtual_list(
                                                            cx.entity(),
                                                            "logs-virtual-list-wrap",
                                                            wrap_item_sizes,
                                                            move |this, visible_range, _window, cx| {
                                                                visible_range
                                                                    .filter_map(|visible_idx| {
                                                                        let log_idx = this
                                                                            .filtered_indices
                                                                            .get(visible_idx)
                                                                            .copied()?;
                                                                        let log =
                                                                            this.logs.get(log_idx)?.clone();
                                                                        Some(Self::render_log_line(
                                                                            cx,
                                                                            log_idx,
                                                                            log,
                                                                            this.show_timestamps,
                                                                            this.word_wrap,
                                                                            this.selected_log_index == Some(log_idx),
                                                                        ))
                                                                    })
                                                                    .collect::<Vec<_>>()
                                                            },
                                                        )
                                                        .track_scroll(&wrap_scroll_handle)
                                                        .p(px(16.0))
                                                        .gap(px(2.0)),
                                                    ),
                                            )
                                        }
                                    })
                                    .when(!is_loading && self.error.is_none() && !self.word_wrap, |el| {
                                        if item_count == 0 {
                                            el.child(
                                                div()
                                                    .p(px(16.0))
                                                    .text_size(px(12.0))
                                                    .text_color(colors.text_muted)
                                                    .font_family(theme.font_family.clone())
                                                    .child("No log lines match the current filters."),
                                            )
                                        } else {
                                            el.child(
                                                div()
                                                    .id("logs-nowrap-scrollbar")
                                                    .w_full()
                                                    .h_full()
                                                    .relative()
                                                    .vertical_scrollbar(&list_scroll_handle)
                                                    .child(
                                                        v_virtual_list(
                                                            cx.entity(),
                                                            "logs-virtual-list",
                                                            item_sizes,
                                                            move |this, visible_range, _window, cx| {
                                                                visible_range
                                                                    .filter_map(|visible_idx| {
                                                                        let log_idx = this
                                                                            .filtered_indices
                                                                            .get(visible_idx)
                                                                            .copied()?;
                                                                        let log =
                                                                            this.logs.get(log_idx)?.clone();
                                                                        Some(Self::render_log_line(
                                                                            cx,
                                                                            log_idx,
                                                                    log,
                                                                    this.show_timestamps,
                                                                    this.word_wrap,
                                                                    this.selected_log_index == Some(log_idx),
                                                                ))
                                                            })
                                                            .collect::<Vec<_>>()
                                                    },
                                                )
                                                        .track_scroll(&list_scroll_handle)
                                                        .p(px(16.0))
                                                        .gap(px(2.0)),
                                                    ),
                                            )
                                        }
                                    }),
                            ),
                    ),
            )
    }

    fn render_log_sidebar(&self, cx: &Context<'_, Self>, modal: LogModalState) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let level_label = match modal.level {
            DetectedLevel::Info => "INFO",
            DetectedLevel::Warn => "WARN",
            DetectedLevel::Error => "ERROR",
            DetectedLevel::Debug => "DEBUG",
        };

        let message_lines: Vec<String> =
            modal.content.lines().map(|line| line.to_string()).collect();
        let format_label = modal.format_label.clone();
        let rendered_lines: Vec<AnyElement> = message_lines
            .iter()
            .enumerate()
            .map(|(idx, line)| {
                self.render_modal_line(cx, idx, line, &format_label)
                    .into_any_element()
            })
            .collect();

        div()
            .absolute()
            .right(px(0.0))
            .top(px(0.0))
            .h_full()
            .w(px(560.0))
            .max_w(px(900.0))
            .bg(colors.surface_elevated)
            .border_l_1()
            .border_color(colors.border)
            .overflow_hidden()
            .flex()
            .flex_col()
            .child(
                div()
                    .w_full()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(10.0))
                    .px(px(16.0))
                    .py(px(12.0))
                    .border_b_1()
                    .border_color(colors.border)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .min_w(px(0.0))
                            .flex_1()
                            .child(
                                div()
                                    .text_size(px(13.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .font_family(theme.font_family_ui.clone())
                                    .text_color(colors.text)
                                    .child("Log details"),
                            )
                            .child(
                                div()
                                    .px(px(8.0))
                                    .py(px(3.0))
                                    .rounded(theme.border_radius_sm)
                                    .bg(colors.primary.opacity(0.12))
                                    .text_size(px(11.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .font_family(theme.font_family_ui.clone())
                                    .text_color(colors.primary)
                                    .child(level_label),
                            )
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .font_family(theme.font_family.clone())
                                    .text_color(colors.text_secondary)
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .child(Self::format_log_timestamp(&modal.timestamp)),
                            )
                            .child(
                                div()
                                    .text_size(px(11.0))
                                    .font_family(theme.font_family_ui.clone())
                                    .text_color(colors.text_muted)
                                    .child(format!("Format: {}", modal.format_label)),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                secondary_btn(
                                    "log-sidebar-copy-btn",
                                    IconName::Copy,
                                    "Copy",
                                    colors,
                                )
                                .on_click(cx.listener(
                                    |this, _event, _window, cx| {
                                        if let Some(modal) = &this.log_modal {
                                            cx.write_to_clipboard(ClipboardItem::new_string(
                                                modal.content.clone(),
                                            ));
                                        }
                                    },
                                )),
                            )
                            .child(
                                secondary_btn(
                                    "log-sidebar-close-btn",
                                    IconName::Close,
                                    "Close",
                                    colors,
                                )
                                .on_click(cx.listener(
                                    |this, _event, _window, cx| {
                                        cx.stop_propagation();
                                        this.log_modal = None;
                                        this.selected_log_index = None;
                                        cx.notify();
                                    },
                                )),
                            ),
                    ),
            )
            .child(
                div()
                    .id("log-sidebar-content-scroll")
                    .flex_1()
                    .min_h(px(0.0))
                    .overflow_y_scrollbar()
                    .p(px(16.0))
                    .bg(colors.surface)
                    .children(rendered_lines),
            )
    }

    fn render_modal_line(
        &self,
        cx: &Context<'_, Self>,
        idx: usize,
        line: &str,
        format_label: &str,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let spans = Self::colorize_modal_line(line, format_label, colors);

        div()
            .id(ElementId::Name(format!("log-modal-line-{}", idx).into()))
            .flex()
            .flex_wrap()
            .items_start()
            .gap(px(0.0))
            .w_full()
            .min_w(px(0.0))
            .children(spans.into_iter().flat_map(|span| {
                Self::chunk_text_for_wrap(&span.text, MODAL_WRAP_CHUNK_CHARS)
                    .into_iter()
                    .map(move |chunk| {
                        div()
                            .text_size(px(12.0))
                            .font_family(theme.font_family.clone())
                            .text_color(span.color)
                            .child(if chunk.is_empty() {
                                " ".to_string()
                            } else {
                                chunk
                            })
                            .into_any_element()
                    })
            }))
    }

    pub fn chunk_text_for_wrap(text: &str, max_chars: usize) -> Vec<String> {
        if text.is_empty() || max_chars == 0 {
            return vec![text.to_string()];
        }

        let mut chunks = Vec::new();
        let mut start = 0;
        let mut count = 0;

        for (i, _) in text.char_indices() {
            if count == max_chars {
                chunks.push(text[start..i].to_string());
                start = i;
                count = 0;
            }
            count += 1;
        }

        if start < text.len() {
            chunks.push(text[start..].to_string());
        }

        if chunks.is_empty() {
            chunks.push(String::new());
        }

        chunks
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
            .gap(px(8.0))
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
                    .min_w(px(0.0))
                    .flex_1()
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
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(self.pod_name.clone()),
                    ),
            )
            .when(self.is_streaming, |el| {
                el.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(div().size(px(8.0)).rounded_full().bg(colors.success))
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

    fn render_log_line(
        cx: &Context<'_, Self>,
        idx: usize,
        log: PodLogEntry,
        show_timestamps: bool,
        word_wrap: bool,
        is_selected: bool,
    ) -> AnyElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let timestamp_display = Self::format_log_timestamp(&log.timestamp);
        let log_entry = log.clone();

        let (level_color, level_label, msg_color) = match log.level {
            DetectedLevel::Info => (colors.primary, "INFO", colors.text_secondary),
            DetectedLevel::Warn => (colors.warning, "WARN", colors.warning),
            DetectedLevel::Error => (colors.error, "ERROR", colors.error),
            DetectedLevel::Debug => (colors.text_muted, "DEBUG", colors.text_secondary),
        };

        div()
            .id(ElementId::Name(format!("log-line-{}", idx).into()))
            .w_full()
            .when(!word_wrap, |el| el.flex_shrink_0())
            .min_w(px(0.0))
            .flex()
            .items_start()
            .gap(px(12.0))
            .cursor_pointer()
            .when(is_selected, |el| el.bg(colors.primary.opacity(0.12)))
            .hover(|s| s.bg(colors.selection_hover))
            // Timestamp
            .when(show_timestamps && !log.timestamp.is_empty(), |el| {
                el.child(
                    div()
                        .w(px(96.0))
                        .flex_shrink_0()
                        .text_size(px(12.0))
                        .font_family(theme.font_family.clone())
                        .text_color(colors.text_muted)
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .child(timestamp_display),
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
            .on_click(cx.listener(move |this, _event, _window, cx| {
                let (formatted, format_label) =
                    Self::format_log_message_for_modal(&log_entry.message);
                this.log_modal = Some(LogModalState {
                    timestamp: log_entry.timestamp.clone(),
                    level: log_entry.level,
                    format_label,
                    content: formatted,
                });
                this.selected_log_index = Some(idx);
                cx.notify();
            }))
            .into_any_element()
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    fn render_separator(&self, colors: &ui::ThemeColors) -> impl IntoElement {
        div().w(px(1.0)).h(px(20.0)).bg(colors.border)
    }
}
