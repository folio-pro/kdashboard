use gpui::prelude::FluentBuilder;
use gpui::*;
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::scroll::ScrollableElement;
use k8s_client::{get_client, list_pods_by_labels, stream_pod_logs};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use ui::{
    Button, ButtonVariant, ButtonVariants, DropdownMenu, Icon, IconName, PopupMenu, PopupMenuItem,
    Sizable, back_btn, secondary_btn, theme,
};

use crate::pod_logs_view::{
    DetectedLevel, LogLevelFilter, LogSince, MODAL_WRAP_CHUNK_CHARS, PodLogEntry,
    PodLogsView,
};

const TAIL_OPTIONS: &[usize] = &[100, 250, 500, 1000, 2000];

/// Pod colors for visual distinction in aggregated logs
const POD_COLORS: &[(f32, f32, f32)] = &[
    (0.55, 0.75, 0.85), // blue
    (0.35, 0.75, 0.80), // teal
    (0.80, 0.55, 0.85), // purple
    (0.10, 0.75, 0.80), // green
    (0.05, 0.75, 0.85), // orange
    (0.95, 0.55, 0.80), // red
    (0.65, 0.75, 0.85), // indigo
    (0.45, 0.75, 0.80), // cyan
];

fn pod_color(pod_index: usize) -> Hsla {
    let (h, s, l) = POD_COLORS[pod_index % POD_COLORS.len()];
    hsla(h, s, l, 1.0)
}

/// A log entry tagged with the source pod name
#[derive(Clone, Debug)]
struct TaggedLogEntry {
    pod_name: String,
    pod_index: usize,
    entry: PodLogEntry,
}

#[derive(Clone, Debug)]
struct DeploymentLogModalState {
    pod_name: String,
    timestamp: String,
    level: DetectedLevel,
    format_label: String,
    content: String,
}

pub struct DeploymentLogsView {
    deployment_name: String,
    namespace: String,
    selector: BTreeMap<String, String>,

    // Pod discovery
    pods: Vec<(String, Vec<String>)>, // (pod_name, containers)
    pods_loading: bool,
    pod_visibility: Vec<bool>, // which pods are visible

    // Logs data
    logs: Vec<TaggedLogEntry>,
    is_loading: bool,
    error: Option<String>,

    // Filter state
    level_filter: LogLevelFilter,
    log_since: LogSince,
    tail_lines: usize,
    search_query: String,
    show_timestamps: bool,

    // Stream state
    is_streaming: bool,
    stream_cancels: Vec<Arc<AtomicBool>>,
    stream_generation: u64,

    // Log detail sidebar
    log_modal: Option<DeploymentLogModalState>,
    selected_log_index: Option<usize>,

    // Search input
    search_input: Option<Entity<InputState>>,
    _search_subscription: Option<Subscription>,

    // Scroll
    logs_scroll_handle: ScrollHandle,

    // Filter cache
    filtered_indices: Vec<usize>,
    filter_dirty: bool,

    // Callbacks
    on_close: Option<Box<dyn Fn(&mut Context<'_, Self>) + 'static>>,
}

impl DeploymentLogsView {
    pub fn new(
        deployment_name: String,
        namespace: String,
        selector: BTreeMap<String, String>,
    ) -> Self {
        Self {
            deployment_name,
            namespace,
            selector,
            pods: Vec::new(),
            pods_loading: true,
            pod_visibility: Vec::new(),
            logs: Vec::new(),
            is_loading: true,
            error: None,
            level_filter: LogLevelFilter::All,
            log_since: LogSince::OneHour,
            tail_lines: 500,
            search_query: String::new(),
            show_timestamps: true,
            is_streaming: true,
            stream_cancels: Vec::new(),
            stream_generation: 0,
            log_modal: None,
            selected_log_index: None,
            search_input: None,
            _search_subscription: None,
            logs_scroll_handle: ScrollHandle::new(),
            filtered_indices: Vec::new(),
            filter_dirty: true,
            on_close: None,
        }
    }

    pub fn on_close(mut self, handler: impl Fn(&mut Context<'_, Self>) + 'static) -> Self {
        self.on_close = Some(Box::new(handler));
        self
    }

    fn ensure_search_input(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.search_input.is_some() {
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Filter logs..."));
        let sub = cx.subscribe(&input, |this, _input, ev: &InputEvent, cx| {
            if let InputEvent::Change = ev {
                let text = this
                    .search_input
                    .as_ref()
                    .map(|i| i.read(cx).text().to_string())
                    .unwrap_or_default();
                this.search_query = text;
                this.filter_dirty = true;
                cx.notify();
            }
        });
        self.search_input = Some(input);
        self._search_subscription = Some(sub);
    }

    /// Initialize: discover pods and start streaming
    pub fn init(view: Entity<Self>, cx: &mut App) {
        view.update(cx, |this, cx| {
            this.discover_pods_and_stream(cx);
        });
    }

    fn discover_pods_and_stream(&mut self, cx: &mut Context<'_, Self>) {
        self.pods_loading = true;
        self.is_loading = true;
        self.error = None;
        cx.notify();

        let namespace = self.namespace.clone();
        let selector = self.selector.clone();

        let (tx, rx) = mpsc::channel::<Result<Vec<(String, Vec<String>)>, String>>();

        std::thread::spawn(move || {
            let rt = k8s_client::tokio_runtime();
            rt.block_on(async {
                match get_client().await {
                    Ok(client) => match list_pods_by_labels(&client, &namespace, &selector).await {
                        Ok(pods) => {
                            let _ = tx.send(Ok(pods));
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e.to_string()));
                        }
                    },
                    Err(e) => {
                        let _ = tx.send(Err(format!("Failed to get K8s client: {}", e)));
                    }
                }
            });
        });

        cx.spawn(async move |view, cx| {
            for _ in 0..200 {
                if let Ok(result) = rx.try_recv() {
                    let _ = cx.update(|cx: &mut App| {
                        let _ = view.update(cx, |this, cx| {
                            this.pods_loading = false;
                            match result {
                                Ok(pods) => {
                                    this.pod_visibility = vec![true; pods.len()];
                                    this.pods = pods;
                                    if this.pods.is_empty() {
                                        this.is_loading = false;
                                        this.error =
                                            Some("No pods found matching selector".to_string());
                                    } else {
                                        this.start_all_streams(cx);
                                    }
                                }
                                Err(e) => {
                                    this.is_loading = false;
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
                    this.pods_loading = false;
                    this.is_loading = false;
                    this.error = Some("Timeout discovering pods".to_string());
                    cx.notify();
                });
            });
        })
        .detach();
    }

    fn stop_all_streams(&mut self) {
        for cancel in self.stream_cancels.drain(..) {
            cancel.store(true, Ordering::SeqCst);
        }
    }

    fn start_all_streams(&mut self, cx: &mut Context<'_, Self>) {
        self.stop_all_streams();
        self.stream_generation = self.stream_generation.wrapping_add(1);
        let generation = self.stream_generation;
        self.logs.clear();
        self.filtered_indices.clear();
        self.filter_dirty = true;
        self.is_loading = true;
        self.error = None;
        cx.notify();

        let tail_lines = self.tail_lines as i64;
        let since_seconds = self.log_since.as_seconds();

        for (pod_idx, (pod_name, containers)) in self.pods.iter().enumerate() {
            let pod_name = pod_name.clone();
            let namespace = self.namespace.clone();
            // Stream from first container
            let container = containers.first().cloned();

            let cancelled = Arc::new(AtomicBool::new(false));
            self.stream_cancels.push(cancelled.clone());

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
                        false,
                        tx.clone(),
                        cancelled.clone(),
                    )
                    .await;

                    if let Err(e) = result {
                        let _ = tx.send(Err(e.to_string()));
                    }
                });
            });

            let pod_name_for_tag = self.pods[pod_idx].0.clone();
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
                                        if this.stream_generation != generation {
                                            return;
                                        }
                                        this.is_loading = false;
                                        match msg {
                                            Ok(line) => {
                                                if let Some(entry) = parse_log_line(&line) {
                                                    this.logs.push(TaggedLogEntry {
                                                        pod_name: pod_name_for_tag.clone(),
                                                        pod_index: pod_idx,
                                                        entry,
                                                    });
                                                    this.filter_dirty = true;
                                                }
                                            }
                                            Err(e) => {
                                                // Don't overwrite with stream errors from individual pods
                                                if this.logs.is_empty() {
                                                    this.error = Some(e);
                                                }
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
                                        if this.stream_generation == generation {
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
    }

    fn refresh(&mut self, cx: &mut Context<'_, Self>) {
        self.logs.clear();
        self.filtered_indices.clear();
        self.filter_dirty = true;
        if self.pods.is_empty() {
            self.discover_pods_and_stream(cx);
        } else {
            self.start_all_streams(cx);
        }
    }

    fn update_filtered_indices(&mut self) {
        if !self.filter_dirty {
            return;
        }

        let search_lower = if self.search_query.is_empty() {
            None
        } else {
            Some(self.search_query.to_lowercase())
        };

        self.filtered_indices.clear();
        self.filtered_indices.reserve(self.logs.len());

        for (idx, tagged) in self.logs.iter().enumerate() {
            // Pod visibility filter
            if self.pod_visibility.get(tagged.pod_index) == Some(&false) {
                continue;
            }

            // Level filter
            let level_match = match self.level_filter {
                LogLevelFilter::All => true,
                LogLevelFilter::Info => tagged.entry.level == DetectedLevel::Info,
                LogLevelFilter::Warn => tagged.entry.level == DetectedLevel::Warn,
                LogLevelFilter::Error => tagged.entry.level == DetectedLevel::Error,
            };

            // Search filter
            let search_match = if let Some(ref query) = search_lower {
                tagged.entry.message.to_lowercase().contains(query)
                    || tagged.pod_name.to_lowercase().contains(query)
            } else {
                true
            };

            if level_match && search_match {
                self.filtered_indices.push(idx);
            }
        }

        self.filter_dirty = false;
    }
}

impl Drop for DeploymentLogsView {
    fn drop(&mut self) {
        self.stop_all_streams();
    }
}

// ── Log line parsing (reuse logic from PodLogsView) ─────────────────────

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

    let level = detect_log_level(&message);
    Some(PodLogEntry {
        timestamp,
        level,
        message,
    })
}

fn detect_log_level(message: &str) -> DetectedLevel {
    let msg_lower = message.to_lowercase();
    if msg_lower.contains("error") || msg_lower.contains("failed") || msg_lower.contains("err]") {
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

fn format_log_timestamp(ts: &str) -> String {
    if ts.is_empty() {
        return String::new();
    }
    // Extract HH:MM:SS from ISO timestamp
    if let Some(t_pos) = ts.find('T') {
        let time_part = &ts[t_pos + 1..];
        if let Some(dot_pos) = time_part.find('.') {
            return time_part[..dot_pos].to_string();
        }
        if let Some(z_pos) = time_part.find('Z') {
            return time_part[..z_pos].to_string();
        }
    }
    ts.to_string()
}

/// Shorten pod name: strip common deployment prefix to show unique suffix
fn short_pod_name(pod_name: &str, deployment_name: &str) -> String {
    if let Some(suffix) = pod_name.strip_prefix(deployment_name) {
        let trimmed = suffix.trim_start_matches('-');
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    pod_name.to_string()
}

// ── Render ──────────────────────────────────────────────────────────────────

impl Render for DeploymentLogsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.ensure_search_input(window, cx);

        let theme = theme(cx);
        let colors = &theme.colors;

        div()
            .id("deployment-logs-root")
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

impl DeploymentLogsView {
    // ── Top Bar ─────────────────────────────────────────────────────────

    fn render_top_bar(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let search_input = self.search_input.as_ref().map(|input| {
            Input::new(input)
                .appearance(false)
                .cleanable(true)
                .with_size(ui::Size::Small)
        });

        let pod_count = self.pods.len();
        let subtitle = if self.pods_loading {
            "Discovering pods...".to_string()
        } else {
            format!(
                "{} - {} pod{}",
                self.deployment_name,
                pod_count,
                if pod_count != 1 { "s" } else { "" }
            )
        };

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
            // Left: back + title
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(16.0))
                    .min_w(px(0.0))
                    .flex_1()
                    .child(back_btn("deploy-logs-back-btn", colors).on_click(cx.listener(
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
                                    .child("Deployment Logs"),
                            )
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .font_family(theme.font_family.clone())
                                    .text_color(colors.text_muted)
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .child(subtitle),
                            ),
                    ),
            )
            // Right: pod filter + search + stream
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_end()
                    .flex_wrap()
                    .gap(px(8.0))
                    .min_w(px(0.0))
                    .flex_1()
                    .child(self.render_pod_dropdown(cx))
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
                            .id("deploy-stream-btn")
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
                                    this.stop_all_streams();
                                    this.is_loading = false;
                                }
                                cx.notify();
                            })),
                    ),
            )
    }

    // ── Pod Filter Dropdown ─────────────────────────────────────────────

    fn render_pod_dropdown(&self, cx: &Context<'_, Self>) -> Div {
        let pods = self.pods.clone();
        let visible_count = self.pod_visibility.iter().filter(|&&v| v).count();
        let total = pods.len();
        let label: SharedString = if visible_count == total {
            format!("All pods ({})", total).into()
        } else {
            format!("{}/{} pods", visible_count, total).into()
        };

        if pods.is_empty() {
            return div().child(
                Button::new("pod-filter")
                    .icon(IconName::Layers)
                    .label(label)
                    .compact()
                    .with_variant(ButtonVariant::Ghost),
            );
        }

        let deployment_name = self.deployment_name.clone();
        let view = cx.entity().downgrade();
        div().child(
            Button::new("pod-filter")
                .icon(IconName::Layers)
                .label(label)
                .compact()
                .with_variant(ButtonVariant::Ghost)
                .dropdown_caret(true)
                .dropdown_menu(move |menu: PopupMenu, _window, _cx| {
                    let mut m = menu.scrollable(true);
                    // "All" toggle
                    let all_visible = visible_count == total;
                    let view_all = view.clone();
                    m = m.item(
                        PopupMenuItem::new("All pods")
                            .checked(all_visible)
                            .on_click(move |_, _window, cx| {
                                let _ = view_all.update(cx, |this, cx| {
                                    let new_val = !this.pod_visibility.iter().all(|&v| v);
                                    for v in &mut this.pod_visibility {
                                        *v = new_val;
                                    }
                                    this.filter_dirty = true;
                                    cx.notify();
                                });
                            }),
                    );
                    // Individual pods
                    for (i, (pod_name, _)) in pods.iter().enumerate() {
                        let short = short_pod_name(pod_name, &deployment_name);
                        let view = view.clone();
                        let is_visible = visible_count == total || i < visible_count; // approx
                        m = m.item(
                            PopupMenuItem::new(short)
                                .checked(is_visible)
                                .on_click(move |_, _window, cx| {
                                    let _ = view.update(cx, |this, cx| {
                                        if let Some(v) = this.pod_visibility.get_mut(i) {
                                            *v = !*v;
                                        }
                                        this.filter_dirty = true;
                                        cx.notify();
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
            .child(self.render_time_dropdown(cx))
            .child(self.render_separator(colors))
            .child(
                div()
                    .text_size(px(12.0))
                    .font_weight(FontWeight::MEDIUM)
                    .font_family(theme.font_family_ui.clone())
                    .text_color(colors.text_secondary)
                    .child("Tail:"),
            )
            .child(self.render_tail_dropdown(cx))
            .child(self.render_separator(colors))
            // Timestamps toggle
            .child(
                div()
                    .id("deploy-timestamps-toggle")
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
            // Spacer
            .child(div().flex_1())
            // Clear button
            .child(
                div()
                    .id("deploy-clear-btn")
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
                        this.filtered_indices.clear();
                        this.filter_dirty = false;
                        cx.notify();
                    })),
            )
    }

    fn render_separator(&self, colors: &ui::ThemeColors) -> Div {
        div()
            .w(px(1.0))
            .h(px(20.0))
            .bg(colors.border)
            .flex_shrink_0()
    }

    fn render_time_dropdown(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let current = self.log_since;
        let current_label: SharedString = current.as_str().into();
        let view = cx.entity().downgrade();

        Button::new("deploy-time-selector")
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

    fn render_tail_dropdown(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let current = self.tail_lines;
        let current_label: SharedString = current.to_string().into();
        let view = cx.entity().downgrade();

        Button::new("deploy-tail-selector")
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
            .id(ElementId::Name(format!("deploy-level-{}", label).into()))
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
                    .child(label_owned),
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
        let is_loading = self.is_loading;
        let error = self.error.clone();
        let deployment_name = &self.deployment_name;
        let has_logs = !self.logs.is_empty();
        let has_error = self.error.is_some();
        let show_content = (!is_loading || has_logs) && (!has_error || has_logs);

        // Build log line elements from filtered indices
        let log_lines: Vec<AnyElement> = if show_content && item_count > 0 {
            self.filtered_indices
                .iter()
                .enumerate()
                .filter_map(|(_, &log_idx)| {
                    let tagged = self.logs.get(log_idx)?.clone();
                    Some(Self::render_log_line(
                        cx,
                        log_idx,
                        tagged,
                        self.show_timestamps,
                        deployment_name,
                        self.selected_log_index == Some(log_idx),
                    ))
                })
                .collect()
        } else {
            Vec::new()
        };

        div()
            .flex_1()
            .min_h(px(0.0))
            .min_w(px(0.0))
            .overflow_hidden()
            .p(px(24.0))
            .child(
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
                    .child(
                        div()
                            .flex_1()
                            .min_h(px(0.0))
                            .min_w(px(0.0))
                            .overflow_hidden()
                            .child(
                                div()
                                    .id("deploy-logs-scroll")
                                    .w_full()
                                    .h_full()
                                    .overflow_y_scroll()
                                    .track_scroll(&self.logs_scroll_handle)
                                    .bg(colors.surface_elevated)
                                    .when(is_loading && !has_logs, |el| {
                                        el.child(
                                            div()
                                                .p(px(16.0))
                                                .text_size(px(12.0))
                                                .text_color(colors.text_muted)
                                                .font_family(theme.font_family.clone())
                                                .child("Loading logs..."),
                                        )
                                    })
                                    .when(has_error && !has_logs, |el| {
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
                                    .when(show_content && item_count == 0, |el| {
                                        el.child(
                                            div()
                                                .p(px(16.0))
                                                .text_size(px(12.0))
                                                .text_color(colors.text_muted)
                                                .font_family(theme.font_family.clone())
                                                .child(
                                                    "No log lines match the current filters.",
                                                ),
                                        )
                                    })
                                    .when(show_content && item_count > 0, |el| {
                                        el.child(
                                            div()
                                                .w_full()
                                                .flex()
                                                .flex_col()
                                                .p(px(16.0))
                                                .gap(px(2.0))
                                                .children(log_lines),
                                        )
                                    }),
                            ),
                    ),
            )
    }

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
                            .child(format!("{} (aggregated)", self.deployment_name)),
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
        tagged: TaggedLogEntry,
        show_timestamps: bool,
        deployment_name: &str,
        is_selected: bool,
    ) -> AnyElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let timestamp_display = format_log_timestamp(&tagged.entry.timestamp);
        let pod_short = short_pod_name(&tagged.pod_name, deployment_name);
        let pod_clr = pod_color(tagged.pod_index);

        let (_level_color, level_label, msg_color) = match tagged.entry.level {
            DetectedLevel::Info => (colors.primary, "INFO", colors.text_secondary),
            DetectedLevel::Warn => (colors.warning, "WARN", colors.warning),
            DetectedLevel::Error => (colors.error, "ERROR", colors.error),
            DetectedLevel::Debug => (colors.text_muted, "DEBUG", colors.text_secondary),
        };

        let log_entry = tagged.entry.clone();
        let pod_name_for_click = tagged.pod_name.clone();

        div()
            .id(ElementId::Name(format!("deploy-log-{}", idx).into()))
            .w_full()
            .min_w(px(0.0))
            .flex()
            .items_start()
            .gap(px(8.0))
            .cursor_pointer()
            .when(is_selected, |el| el.bg(colors.primary.opacity(0.12)))
            .hover(|s| s.bg(colors.selection_hover))
            // Pod name prefix
            .child(
                div()
                    .w(px(80.0))
                    .flex_shrink_0()
                    .text_size(px(12.0))
                    .font_family(theme.font_family.clone())
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(pod_clr)
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .child(pod_short),
            )
            // Timestamp
            .when(show_timestamps && !tagged.entry.timestamp.is_empty(), |el| {
                el.child(
                    div()
                        .w(px(80.0))
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
                    .w(px(42.0))
                    .flex_shrink_0()
                    .text_size(px(12.0))
                    .font_family(theme.font_family.clone())
                    .text_color(match tagged.entry.level {
                        DetectedLevel::Info => colors.primary,
                        DetectedLevel::Warn => colors.warning,
                        DetectedLevel::Error => colors.error,
                        DetectedLevel::Debug => colors.text_muted,
                    })
                    .child(level_label),
            )
            // Message (always wraps)
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .text_size(px(12.0))
                    .font_family(theme.font_family.clone())
                    .text_color(msg_color)
                    .child(tagged.entry.message),
            )
            .on_click(cx.listener(move |this, _event, _window, cx| {
                let (formatted, format_label) =
                    PodLogsView::format_log_message_for_modal(&log_entry.message);
                this.log_modal = Some(DeploymentLogModalState {
                    pod_name: pod_name_for_click.clone(),
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

    // ── Log Detail Sidebar ──────────────────────────────────────────────

    fn render_log_sidebar(
        &self,
        cx: &Context<'_, Self>,
        modal: DeploymentLogModalState,
    ) -> impl IntoElement {
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
            .id("deploy-log-sidebar")
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
            .on_scroll_wheel(cx.listener(|_this, _event: &ScrollWheelEvent, _window, cx| {
                cx.stop_propagation();
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(|_this, _event: &MouseDownEvent, _window, cx| {
                cx.stop_propagation();
            }))
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
                                    .px(px(8.0))
                                    .py(px(3.0))
                                    .rounded(theme.border_radius_sm)
                                    .bg(pod_color(0).opacity(0.12))
                                    .text_size(px(11.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .font_family(theme.font_family.clone())
                                    .text_color(colors.text_secondary)
                                    .child(short_pod_name(
                                        &modal.pod_name,
                                        &self.deployment_name,
                                    )),
                            )
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .font_family(theme.font_family.clone())
                                    .text_color(colors.text_secondary)
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .child(PodLogsView::format_log_timestamp(&modal.timestamp)),
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
                                    "deploy-log-sidebar-copy-btn",
                                    IconName::Copy,
                                    "Copy",
                                    colors,
                                )
                                .on_click(
                                    cx.listener(|this, _event, _window, cx| {
                                        if let Some(modal) = &this.log_modal {
                                            cx.write_to_clipboard(ClipboardItem::new_string(
                                                modal.content.clone(),
                                            ));
                                        }
                                    }),
                                ),
                            )
                            .child(
                                secondary_btn(
                                    "deploy-log-sidebar-close-btn",
                                    IconName::Close,
                                    "Close",
                                    colors,
                                )
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    cx.stop_propagation();
                                    this.log_modal = None;
                                    this.selected_log_index = None;
                                    cx.notify();
                                })),
                            ),
                    ),
            )
            .child(
                div()
                    .id("deploy-log-sidebar-content-scroll")
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
        let spans = PodLogsView::colorize_modal_line(line, format_label, colors);

        div()
            .id(ElementId::Name(
                format!("deploy-log-modal-line-{}", idx).into(),
            ))
            .flex()
            .flex_wrap()
            .items_start()
            .gap(px(0.0))
            .w_full()
            .min_w(px(0.0))
            .children(spans.into_iter().flat_map(|span| {
                PodLogsView::chunk_text_for_wrap(&span.text, MODAL_WRAP_CHUNK_CHARS)
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
}
