use std::ops::Range;

use alacritty_terminal::grid::Dimensions as _;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor};
use gpui::*;
use gpui::prelude::FluentBuilder;
use k8s_client::{get_client, TerminalOutput, TerminalClosed};
use std::sync::mpsc;
use ui::{
    back_btn, secondary_btn, danger_btn, theme, Button, ButtonVariant, ButtonVariants,
    DropdownMenu, Icon, IconName, PopupMenu, PopupMenuItem, Sizable,
};

use crate::colors;
use crate::terminal_emulator::TerminalEmulator;

/// Get or create the Tokio runtime for K8s operations
fn get_tokio_runtime() -> &'static tokio::runtime::Runtime {
    use std::sync::OnceLock;
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime")
    })
}

/// Connection state for the terminal
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TerminalConnectionState {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

/// Messages from the async terminal session to the GPUI view
enum TerminalMessage {
    Connected(String), // session_id
    Output(Vec<u8>),
    Closed(String), // reason
    Error(String),
}

pub struct PodTerminalView {
    pod_name: String,
    namespace: String,
    containers: Vec<String>,
    selected_container: Option<String>,
    selected_shell: String,
    font_size: f32,

    // Session state
    session_id: Option<String>,
    connection_state: TerminalConnectionState,
    error_message: Option<String>,

    // Direct input sender (avoids thread-per-keystroke)
    input_sender: Option<tokio::sync::mpsc::Sender<Vec<u8>>>,

    // Terminal emulator
    emulator: Option<TerminalEmulator>,
    focus_handle: FocusHandle,
    /// Measured grid height from the last paint; used to resize the emulator.
    measured_grid_height: Option<Pixels>,

    // Callbacks
    on_close: Option<Box<dyn Fn(&mut Context<'_, Self>) + 'static>>,
}

impl PodTerminalView {
    pub fn new(pod_name: String, namespace: String, containers: Vec<String>, cx: &mut Context<'_, Self>) -> Self {
        let selected_container = containers.first().cloned();
        Self {
            pod_name,
            namespace,
            containers,
            selected_container,
            selected_shell: "/bin/bash".to_string(),
            font_size: 14.0,
            session_id: None,
            connection_state: TerminalConnectionState::Connecting,
            error_message: None,
            input_sender: None,
            emulator: None,
            focus_handle: cx.focus_handle(),
            measured_grid_height: None,
            on_close: None,
        }
    }

    pub fn on_close(mut self, handler: impl Fn(&mut Context<'_, Self>) + 'static) -> Self {
        self.on_close = Some(Box::new(handler));
        self
    }

    /// Initialize the terminal session - call after creating the entity
    pub fn init(view: Entity<Self>, cx: &mut App) {
        let pod_name = view.read(cx).pod_name.clone();
        let namespace = view.read(cx).namespace.clone();
        let container = view.read(cx).selected_container.clone();

        let (tx, rx) = mpsc::channel::<TerminalMessage>();

        // Spawn background thread to start the terminal session
        std::thread::spawn(move || {
            let rt = get_tokio_runtime();
            rt.block_on(async {
                let client = match get_client().await {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(TerminalMessage::Error(format!("Failed to get K8s client: {}", e)));
                        return;
                    }
                };

                // Output callback - sends terminal output to GPUI
                let output_tx = tx.clone();
                let on_output: k8s_client::OutputCallback = Box::new(move |output: TerminalOutput| {
                    let _ = output_tx.send(TerminalMessage::Output(output.data));
                });

                // Close callback - notifies GPUI when session ends
                let close_tx = tx.clone();
                let on_close: k8s_client::CloseCallback = Box::new(move |closed: TerminalClosed| {
                    let _ = close_tx.send(TerminalMessage::Closed(closed.reason));
                });

                match k8s_client::start_terminal_session(
                    &client,
                    &pod_name,
                    container.as_deref(),
                    &namespace,
                    Some(120),
                    Some(30),
                    on_output,
                    on_close,
                ).await {
                    Ok(session) => {
                        let _ = tx.send(TerminalMessage::Connected(session.session_id));
                    }
                    Err(e) => {
                        let _ = tx.send(TerminalMessage::Error(format!("Failed to start terminal: {}", e)));
                    }
                }
            });
        });

        // Poll for messages from the background thread
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(std::time::Duration::from_millis(8)).await;

                // Drain all available messages into a batch
                let mut messages = Vec::new();
                let mut disconnected = false;
                loop {
                    match rx.try_recv() {
                        Ok(msg) => messages.push(msg),
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => {
                            disconnected = true;
                            break;
                        }
                    }
                }

                let mut should_stop = disconnected;

                if !messages.is_empty() {
                    let has_terminal_stop = messages.iter().any(|m| matches!(m, TerminalMessage::Closed(_) | TerminalMessage::Error(_)));
                    let _ = view.update(&mut *cx, |this, cx| {
                        for msg in messages {
                            match msg {
                                TerminalMessage::Connected(session_id) => {
                                    this.input_sender = k8s_client::get_input_sender(&session_id);
                                    this.session_id = Some(session_id);
                                    this.connection_state = TerminalConnectionState::Connected;
                                    this.emulator = Some(TerminalEmulator::new(120, 30));
                                }
                                TerminalMessage::Output(data) => {
                                    if let Some(emulator) = &mut this.emulator {
                                        let pty_writes = emulator.write(&data);
                                        for write_data in pty_writes {
                                            if let Some(sender) = &this.input_sender {
                                                let _ = sender.try_send(write_data.into_bytes());
                                            }
                                        }
                                    }
                                }
                                TerminalMessage::Closed(_reason) => {
                                    this.connection_state = TerminalConnectionState::Disconnected;
                                    this.session_id = None;
                                    this.input_sender = None;
                                }
                                TerminalMessage::Error(err) => {
                                    this.connection_state = TerminalConnectionState::Error;
                                    this.error_message = Some(err.clone());
                                }
                            }
                        }
                        cx.notify();
                    });
                    if has_terminal_stop {
                        should_stop = true;
                    }
                }

                if should_stop {
                    break;
                }
            }
        }).detach();
    }

    /// Send input to the terminal session via direct channel (no thread spawning)
    fn send_input(&self, data: &str) {
        if let Some(sender) = &self.input_sender {
            let _ = sender.try_send(data.as_bytes().to_vec());
        }
    }

    /// Reconnect the terminal session
    fn reconnect(view: Entity<Self>, cx: &mut App) {
        view.update(cx, |this, _cx| {
            this.close_session();
            this.connection_state = TerminalConnectionState::Connecting;
            this.error_message = None;
            this.emulator = None;
        });
        Self::init(view, cx);
    }

    /// Close the terminal session
    fn close_session(&mut self) {
        if let Some(session_id) = self.session_id.take() {
            self.connection_state = TerminalConnectionState::Disconnected;
            std::thread::spawn(move || {
                if let Err(e) = k8s_client::close_terminal_session(&session_id) {
                    tracing::error!("Failed to close terminal session: {}", e);
                }
            });
        }
    }
}

// ─── Render ──────────────────────────────────────────────────────────────────

impl Render for PodTerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        // Resize emulator to fit the available space.
        // Use measured grid height if available (from previous frame's
        // on_children_prepainted), otherwise estimate from viewport.
        let row_h = px((self.font_size * 1.45).round());
        let grid_h = self.measured_grid_height.unwrap_or_else(|| {
            // Fallback: estimate from viewport minus chrome.
            // title_bar(28) + top_bar(~54) + toolbar(~40) + padding(48+32)
            // + terminal_header(~40) + borders(~4) = ~246
            window.viewport_size().height - px(246.0)
        });
        // Subtract grid padding (16 top + 16 bottom)
        let usable = grid_h - px(32.0);
        let target_rows = ((usable / row_h).floor() as usize).max(5);
        if let Some(emulator) = &mut self.emulator {
            if emulator.screen_lines() != target_rows {
                emulator.resize(emulator.columns(), target_rows);
            }
        }

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(colors.background)
            // Top bar: back + title + container/shell selects + reconnect/disconnect
            .child(self.render_top_bar(cx))
            // Terminal toolbar: connection status + size + font + actions
            .child(self.render_terminal_toolbar(cx))
            // Terminal content area
            .child(
                div()
                    .id("terminal-content-outer")
                    .flex_1()
                    .min_h(px(0.0))
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .p(px(24.0))
                    .child(self.render_terminal_container(cx))
            )
    }
}

// ─── Top Bar ─────────────────────────────────────────────────────────────────

impl PodTerminalView {
    fn render_top_bar(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div()
            .w_full()
            .flex()
            .items_center()
            .justify_between()
            .px(px(24.0))
            .py(px(12.0))
            .border_b_1()
            .border_color(colors.border)
            // Left: back button + title
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(16.0))
                    // Back button (36x36, rounded 6, surface bg, border)
                    .child(
                        back_btn("terminal-back-btn", colors)
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.close_session();
                                if let Some(on_close) = &this.on_close {
                                    on_close(cx);
                                }
                                cx.notify();
                            }))
                    )
                    // Title group
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
                                    .child("Terminal")
                            )
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .font_family(theme.font_family.clone())
                                    .text_color(colors.text_muted)
                                    .child(self.pod_name.clone())
                            )
                    )
            )
            // Right: container select + shell select + reconnect + disconnect
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    // Container select dropdown
                    .child(self.render_container_dropdown(cx))
                    // Shell select dropdown
                    .child(self.render_shell_dropdown(cx))
                    // Reconnect button
                    .child(
                        secondary_btn("btn-reconnect", IconName::Refresh, "Reconnect", colors)
                            .on_click(cx.listener(|_this, _event, _window, cx| {
                                let view = cx.entity().clone();
                                cx.defer(move |cx| {
                                    Self::reconnect(view, cx);
                                });
                            }))
                    )
                    // Disconnect button (red)
                    .child(
                        danger_btn("btn-disconnect", IconName::Power, "Disconnect", colors)
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.close_session();
                                cx.notify();
                            }))
                    )
            )
    }

    fn render_container_dropdown(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let containers = self.containers.clone();
        let current_label = self.selected_container.clone().unwrap_or_else(|| "default".to_string());
        let selected = self.selected_container.clone();
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
                    for c in containers.iter() {
                        let is_selected = selected.as_deref() == Some(c.as_str());
                        let container = c.clone();
                        let view = view.clone();
                        m = m.item(
                            PopupMenuItem::new(c.clone())
                                .checked(is_selected)
                                .on_click(move |_, _window, cx| {
                                    let container = container.clone();
                                    let _ = view.update(cx, |this, cx| {
                                        this.selected_container = Some(container);
                                        let view = cx.entity().clone();
                                        cx.defer(move |cx| {
                                            Self::reconnect(view, cx);
                                        });
                                    });
                                }),
                        );
                    }
                    m
                }),
        )
    }

    fn render_shell_dropdown(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let shells = ["/bin/bash", "/bin/sh", "/bin/zsh"];
        let current = self.selected_shell.clone();
        let view = cx.entity().downgrade();

        div().child(
            Button::new("shell-selector")
                .icon(IconName::Terminal)
                .label(current.clone())
                .compact()
                .with_variant(ButtonVariant::Ghost)
                .dropdown_caret(true)
                .dropdown_menu(move |menu: PopupMenu, _window, _cx| {
                    let mut m = menu;
                    for shell in shells.iter() {
                        let is_selected = *shell == current.as_str();
                        let shell_str = shell.to_string();
                        let view = view.clone();
                        m = m.item(
                            PopupMenuItem::new(*shell)
                                .checked(is_selected)
                                .on_click(move |_, _window, cx| {
                                    let shell_str = shell_str.clone();
                                    let _ = view.update(cx, |this, cx| {
                                        this.selected_shell = shell_str;
                                        cx.notify();
                                    });
                                }),
                        );
                    }
                    m
                }),
        )
    }

    fn render_font_size_dropdown(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let sizes: [f32; 5] = [11.0, 12.0, 14.0, 16.0, 18.0];
        let current = self.font_size;
        let view = cx.entity().downgrade();

        div().child(
            Button::new("font-size-selector")
                .icon(IconName::Settings)
                .label(format!("Font: {}px", current as u32))
                .compact()
                .with_size(ui::Size::XSmall)
                .with_variant(ButtonVariant::Ghost)
                .dropdown_caret(true)
                .dropdown_menu(move |menu: PopupMenu, _window, _cx| {
                    let mut m = menu;
                    for size in sizes.iter() {
                        let is_selected = (*size - current).abs() < 0.1;
                        let s = *size;
                        let view = view.clone();
                        m = m.item(
                            PopupMenuItem::new(format!("{}px", s as u32))
                                .checked(is_selected)
                                .on_click(move |_, _window, cx| {
                                    let _ = view.update(cx, |this, cx| {
                                        this.font_size = s;
                                        cx.notify();
                                    });
                                }),
                        );
                    }
                    m
                }),
        )
    }
}

// ─── Terminal Toolbar ────────────────────────────────────────────────────────

impl PodTerminalView {
    fn render_terminal_toolbar(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let (status_text, status_color) = match self.connection_state {
            TerminalConnectionState::Connecting => ("Connecting...", colors.warning),
            TerminalConnectionState::Connected => ("Connected", colors.success),
            TerminalConnectionState::Disconnected => ("Disconnected", colors.text_muted),
            TerminalConnectionState::Error => ("Error", colors.error),
        };

        div()
            .w_full()
            .flex()
            .items_center()
            .gap(px(12.0))
            .px(px(24.0))
            .py(px(10.0))
            .bg(colors.surface)
            .border_b_1()
            .border_color(colors.border)
            // Connection status badge
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .size(px(8.0))
                            .rounded_full()
                            .bg(status_color)
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .font_family(theme.font_family.clone())
                            .text_color(status_color)
                            .child(status_text)
                    )
            )
            // Separator
            .child(self.render_toolbar_separator(colors))
            // Font size dropdown
            .child(self.render_font_size_dropdown(cx))
            // Separator
            .child(self.render_toolbar_separator(colors))
            // Action buttons: Clear
            .child(
                self.render_toolbar_button("btn-clear", IconName::Trash, "Clear", theme)
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        // Send clear-screen escape sequence
                        this.send_input("\x0c");
                        cx.notify();
                    }))
            )
            // Spacer
            .child(div().flex_1())
    }

    fn render_toolbar_separator(&self, colors: &ui::ThemeColors) -> impl IntoElement {
        div()
            .w(px(1.0))
            .h(px(20.0))
            .bg(colors.border)
    }

    fn render_toolbar_button(
        &self,
        id: &str,
        icon: IconName,
        label: &str,
        theme: &ui::Theme,
    ) -> Stateful<Div> {
        let colors = &theme.colors;
        div()
            .id(ElementId::Name(id.to_string().into()))
            .flex()
            .items_center()
            .gap(px(6.0))
            .px(px(10.0))
            .py(px(6.0))
            .rounded(theme.border_radius_md)
            .border_1()
            .border_color(colors.border)
            .cursor_pointer()
            .hover(|s| s.bg(colors.selection_hover))
            .child(
                Icon::new(icon)
                    .size(px(14.0))
                    .color(colors.text_secondary)
            )
            .child(
                div()
                    .text_size(px(11.0))
                    .font_weight(FontWeight::MEDIUM)
                    .font_family(theme.font_family_ui.clone())
                    .text_color(colors.text_secondary)
                    .child(label.to_string())
            )
    }
}

// ─── Terminal Container ──────────────────────────────────────────────────────

impl PodTerminalView {
    fn render_terminal_container(&self, cx: &Context<'_, Self>) -> AnyElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        match self.connection_state {
            TerminalConnectionState::Connecting => {
                // Loading state in container frame
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .rounded(theme.border_radius_md)
                    .bg(colors.surface_elevated)
                    .border_1()
                    .border_color(colors.border)
                    .overflow_hidden()
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .gap(px(12.0))
                                    .child(ui::Spinner::new().with_size(ui::Size::Medium))
                                    .child(
                                        div()
                                            .text_size(px(14.0))
                                            .font_family(theme.font_family_ui.clone())
                                            .text_color(colors.text_muted)
                                            .child(format!("Connecting to {}...", self.pod_name))
                                    )
                            )
                    )
                    .into_any_element()
            }
            TerminalConnectionState::Error => {
                let error_msg = self.error_message.clone().unwrap_or_else(|| "Unknown error".to_string());
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .rounded(theme.border_radius_md)
                    .bg(colors.surface_elevated)
                    .border_1()
                    .border_color(colors.border)
                    .overflow_hidden()
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .gap(px(12.0))
                                    .child(
                                        Icon::new(IconName::Close)
                                            .size(px(32.0))
                                            .color(colors.error)
                                    )
                                    .child(
                                        div()
                                            .text_size(px(14.0))
                                            .font_family(theme.font_family_ui.clone())
                                            .text_color(colors.error)
                                            .child("Failed to connect")
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.0))
                                            .font_family(theme.font_family_ui.clone())
                                            .text_color(colors.text_muted)
                                            .max_w(px(400.0))
                                            .child(error_msg)
                                    )
                            )
                    )
                    .into_any_element()
            }
            _ => {
                // Connected or Disconnected - terminal container with header + body
                let container_name = self.selected_container.as_deref().unwrap_or("default");
                let prompt_path = format!("root@{}:/app#", self.pod_name.split('-').next().unwrap_or(&self.pod_name));

                div()
                    .id("terminal-container")
                    .track_focus(&self.focus_handle)
                    .key_context("Terminal")
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, _window, cx| {
                        this.handle_key_down(event, cx);
                    }))
                    .on_click(cx.listener(|this, _event, window, _cx| {
                        window.focus(&this.focus_handle);
                    }))
                    .flex_1()
                    .min_h(px(0.0))
                    .flex()
                    .flex_col()
                    .rounded(theme.border_radius_md)
                    .bg(colors.surface_elevated)
                    .border_1()
                    .border_color(colors.border)
                    .overflow_hidden()
                    // Inner layout wrapper (non-stateful) for measurement
                    .child(
                        div()
                            .size_full()
                            .flex()
                            .flex_col()
                            .on_children_prepainted({
                                let view = cx.entity().downgrade();
                                move |children_bounds: Vec<Bounds<Pixels>>, _window, cx| {
                                    // children[0] = header (fixed), children[1] = body (flex_1)
                                    // body bounds = the actual available space for the grid
                                    if children_bounds.len() >= 2 {
                                        let body_h = children_bounds[1].size.height;
                                        let _ = view.update(cx, |this, cx| {
                                            if this.measured_grid_height != Some(body_h) {
                                                this.measured_grid_height = Some(body_h);
                                                cx.notify();
                                            }
                                        });
                                    }
                                }
                            })
                            // Terminal header
                            .child(self.render_terminal_header(&prompt_path, container_name, theme))
                            // Terminal body
                            .child(self.render_terminal_body(theme, cx))
                    )
                    .into_any_element()
            }
        }
    }

    fn render_terminal_header(
        &self,
        prompt_path: &str,
        _container_name: &str,
        theme: &ui::Theme,
    ) -> impl IntoElement {
        let colors = &theme.colors;
        div()
            .w_full()
            .flex()
            .items_center()
            .justify_between()
            .px(px(16.0))
            .py(px(12.0))
            .bg(colors.surface)
            .border_b_1()
            .border_color(colors.border)
            // Left: terminal icon + path
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        Icon::new(IconName::Terminal)
                            .size(px(16.0))
                            .color(colors.text_muted)
                    )
                    .child(
                        div()
                            .text_size(px(12.0))
                            .font_family(theme.font_family.clone())
                            .text_color(colors.text_secondary)
                            .child(format!("{}  ~", prompt_path))
                    )
            )
            // Right: session time
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .text_size(px(11.0))
                            .font_family(theme.font_family.clone())
                            .text_color(colors.text_muted)
                            .child("Session: 00:00:00")
                    )
            )
    }

    fn render_terminal_body(
        &self,
        theme: &ui::Theme,
        cx: &Context<'_, Self>,
    ) -> AnyElement {
        let emulator = match &self.emulator {
            Some(e) => e,
            None => {
                // No emulator yet — show empty terminal area
                return div()
                    .id("terminal-grid")
                    .flex_1()
                    .flex()
                    .flex_col()
                    .p(px(16.0))
                    .into_any_element();
            }
        };

        let term = emulator.term();
        let grid = term.grid();
        let display_offset = grid.display_offset();
        let content = term.renderable_content();
        let cursor = content.cursor;
        let term_colors = term.colors();
        let num_cols = emulator.columns();
        let num_rows = emulator.screen_lines();

        let default_fg_hsla = colors::rgb_to_hsla(colors::DEFAULT_FG);
        let font_family = &theme.font_family;

        let mut row_elements: Vec<AnyElement> = Vec::with_capacity(num_rows);
        for row_idx in 0..num_rows {
            // Convert viewport row to grid line, accounting for scroll offset.
            // viewport_to_point: Line(row as i32) - display_offset
            let line = Line(row_idx as i32) - display_offset;
            row_elements.push(
                self.render_grid_row(row_idx, line, grid, num_cols, &cursor, term_colors, default_fg_hsla, font_family)
            );
        }

        // Calculate scrollbar metrics
        let total_lines = grid.total_lines();
        let history_size = total_lines.saturating_sub(num_rows);
        let has_scrollbar = history_size > 0;

        div()
            .id("terminal-grid")
            .flex_1()
            .min_h(px(0.0))
            .flex()
            .overflow_hidden()
            .on_scroll_wheel(cx.listener(|this, event: &ScrollWheelEvent, _window, cx| {
                if let Some(emulator) = &mut this.emulator {
                    let row_h = px((this.font_size * 1.45).round());
                    let lines = match event.delta {
                        ScrollDelta::Lines(pt) => pt.y.round() as i32,
                        ScrollDelta::Pixels(pt) => (pt.y / row_h).round() as i32,
                    };
                    if lines != 0 {
                        emulator.scroll(lines);
                        cx.notify();
                    }
                }
            }))
            // Terminal rows
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .flex()
                    .flex_col()
                    .p(px(16.0))
                    .children(row_elements)
            )
            // Scrollbar
            .when(has_scrollbar, |el: Stateful<Div>| {
                let row_h_val = (self.font_size * 1.45).round();
                let track_h = num_rows as f32 * row_h_val;
                let thumb_frac = (num_rows as f32 / total_lines as f32).clamp(0.05, 1.0);
                let thumb_h = (track_h * thumb_frac).max(20.0);
                let scroll_frac = if history_size > 0 {
                    display_offset as f32 / history_size as f32
                } else {
                    0.0
                };
                // scroll_frac=0 → bottom (thumb at end), scroll_frac=1 → top (thumb at start)
                let thumb_top = (1.0 - scroll_frac) * (track_h - thumb_h);

                el.child(
                    div()
                        .w(px(8.0))
                        .flex_shrink_0()
                        .py(px(16.0))
                        .pr(px(4.0))
                        .child(
                            div()
                                .w(px(4.0))
                                .h(px(track_h))
                                .rounded(px(2.0))
                                .bg(theme.colors.border.opacity(0.15))
                                .relative()
                                .child(
                                    div()
                                        .absolute()
                                        .left(px(0.0))
                                        .top(px(thumb_top))
                                        .w(px(4.0))
                                        .h(px(thumb_h))
                                        .rounded(px(2.0))
                                        .bg(theme.colors.text_muted.opacity(0.4))
                                )
                        )
                )
            })
            .into_any_element()
    }

    fn render_grid_row(
        &self,
        _row_idx: usize,
        line: Line,
        grid: &alacritty_terminal::Grid<alacritty_terminal::term::cell::Cell>,
        num_cols: usize,
        cursor: &alacritty_terminal::term::RenderableCursor,
        term_colors: &Colors,
        default_fg: Hsla,
        font_family: &SharedString,
    ) -> AnyElement {
        let mut text = String::with_capacity(num_cols);
        let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
        let mut run_start: usize = 0;
        let mut current_hs: Option<HighlightStyle> = None;

        // Track cursor position for this row
        let cursor_on_this_row = cursor.shape != CursorShape::Hidden
            && cursor.point.line == line;
        let mut cursor_byte_range: Option<Range<usize>> = None;

        for col in 0..num_cols {
            let cell = &grid[line][Column(col)];

            // Skip spacer cells for wide characters
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }

            let byte_start = text.len();
            let ch = if cell.flags.contains(Flags::HIDDEN) { ' ' } else { cell.c };
            text.push(ch);
            let byte_end = text.len();

            // Track cursor byte range
            if cursor_on_this_row && cursor.point.column == Column(col) {
                cursor_byte_range = Some(byte_start..byte_end);
            }

            let hs = cell_to_highlight(cell, term_colors);

            match &current_hs {
                Some(prev) if *prev == hs => {
                    // Same style, extend the run
                }
                _ => {
                    // Flush previous run
                    if let Some(prev) = current_hs.take() {
                        if run_start < byte_start {
                            highlights.push((run_start..byte_start, prev));
                        }
                    }
                    run_start = byte_start;
                    current_hs = Some(hs);
                }
            }
        }

        // Flush last run
        if let Some(hs) = current_hs {
            if run_start < text.len() {
                highlights.push((run_start..text.len(), hs));
            }
        }

        // Cursor overlay
        if let Some(range) = cursor_byte_range {
            let cursor_hsla = colors::rgb_to_hsla(colors::CURSOR_COLOR);
            let bg_hsla = colors::rgb_to_hsla(colors::DEFAULT_BG);
            highlights.push((range, HighlightStyle {
                color: Some(bg_hsla),
                background_color: Some(cursor_hsla),
                ..Default::default()
            }));
        }

        // Ensure text is non-empty for StyledText
        if text.is_empty() {
            text.push(' ');
        }

        let font_size = self.font_size;
        let row_height = (font_size * 1.45).round();

        div()
            .w_full()
            .h(px(row_height))
            .text_size(px(font_size))
            .font_family(font_family.clone())
            .text_color(default_fg)
            .child(
                StyledText::new(SharedString::from(text))
                    .with_highlights(highlights)
            )
            .into_any_element()
    }

    fn handle_key_down(&mut self, event: &KeyDownEvent, _cx: &mut Context<'_, Self>) {
        if self.connection_state != TerminalConnectionState::Connected {
            return;
        }

        // Auto-scroll to bottom when typing
        if let Some(emulator) = &mut self.emulator {
            emulator.scroll_to_bottom();
        }

        let keystroke = &event.keystroke;

        // Handle modifier keys
        if keystroke.modifiers.control {
            // Ctrl+key combinations
            if let Some(key_char) = keystroke.key.chars().next() {
                let ctrl_char = match key_char {
                    'c' => Some("\x03"), // ETX - interrupt
                    'd' => Some("\x04"), // EOT - end of transmission
                    'z' => Some("\x1a"), // SUB - suspend
                    'l' => Some("\x0c"), // FF - form feed (clear)
                    'a' => Some("\x01"), // SOH - start of heading (home)
                    'e' => Some("\x05"), // ENQ - end (end of line)
                    'u' => Some("\x15"), // NAK - kill line
                    'k' => Some("\x0b"), // VT - kill to end of line
                    'w' => Some("\x17"), // ETB - delete word
                    'r' => Some("\x12"), // DC2 - reverse search
                    'p' => Some("\x10"), // DLE - previous history
                    'n' => Some("\x0e"), // SO - next history
                    _ => None,
                };
                if let Some(data) = ctrl_char {
                    self.send_input(data);
                    return;
                }
            }
        }

        // Named keys
        match keystroke.key.as_ref() {
            "enter" => {
                self.send_input("\r");
            }
            "backspace" => {
                self.send_input("\x7f");
            }
            "tab" => {
                self.send_input("\t");
            }
            "escape" => {
                self.send_input("\x1b");
            }
            "up" => {
                self.send_input("\x1b[A");
            }
            "down" => {
                self.send_input("\x1b[B");
            }
            "right" => {
                self.send_input("\x1b[C");
            }
            "left" => {
                self.send_input("\x1b[D");
            }
            "home" => {
                self.send_input("\x1b[H");
            }
            "end" => {
                self.send_input("\x1b[F");
            }
            "delete" => {
                self.send_input("\x1b[3~");
            }
            "pageup" => {
                self.send_input("\x1b[5~");
            }
            "pagedown" => {
                self.send_input("\x1b[6~");
            }
            "space" => {
                self.send_input(" ");
            }
            key => {
                // Regular character input
                if key.len() == 1 && !keystroke.modifiers.control && !keystroke.modifiers.alt {
                    self.send_input(key);
                } else if keystroke.modifiers.alt {
                    // Alt+key - send as escape sequence
                    if let Some(ch) = key.chars().next() {
                        let alt_seq = format!("\x1b{}", ch);
                        self.send_input(&alt_seq);
                    }
                }
            }
        }
    }
}

/// Convert a terminal cell to a HighlightStyle.
fn cell_to_highlight(
    cell: &alacritty_terminal::term::cell::Cell,
    term_colors: &Colors,
) -> HighlightStyle {
    let (fg, bg) = if cell.flags.contains(Flags::INVERSE) {
        // Inverted: fg becomes bg, bg becomes fg
        let fg = colors::to_hsla(cell.bg, term_colors, false);
        let bg_color = cell.fg;
        let bg = if matches!(bg_color, Color::Named(NamedColor::Foreground)) {
            // When inverted, foreground becoming background — use default fg color as bg
            Some(colors::to_hsla(Color::Named(NamedColor::Foreground), term_colors, true))
        } else {
            Some(colors::to_hsla(bg_color, term_colors, true))
        };
        (fg, bg)
    } else {
        let fg = colors::to_hsla(cell.fg, term_colors, true);
        let bg = if matches!(cell.bg, Color::Named(NamedColor::Background)) {
            None // transparent — let the container bg show through
        } else {
            Some(colors::to_hsla(cell.bg, term_colors, false))
        };
        (fg, bg)
    };

    // Apply DIM flag
    let fg = if cell.flags.contains(Flags::DIM) {
        Hsla { a: fg.a * 0.66, ..fg }
    } else {
        fg
    };

    let font_weight = if cell.flags.contains(Flags::BOLD) {
        Some(FontWeight::BOLD)
    } else {
        None
    };

    let font_style = if cell.flags.contains(Flags::ITALIC) {
        Some(FontStyle::Italic)
    } else {
        None
    };

    let underline = if cell.flags.intersects(Flags::ALL_UNDERLINES) {
        Some(UnderlineStyle {
            thickness: px(1.0),
            color: Some(fg),
            ..Default::default()
        })
    } else {
        None
    };

    let strikethrough = if cell.flags.contains(Flags::STRIKEOUT) {
        Some(StrikethroughStyle {
            thickness: px(1.0),
            color: Some(fg),
        })
    } else {
        None
    };

    HighlightStyle {
        color: Some(fg),
        background_color: bg,
        font_weight,
        font_style,
        underline,
        strikethrough,
        ..Default::default()
    }
}

impl Drop for PodTerminalView {
    fn drop(&mut self) {
        // Clean up the terminal session when the view is dropped
        if let Some(session_id) = self.session_id.take() {
            std::thread::spawn(move || {
                if let Err(e) = k8s_client::close_terminal_session(&session_id) {
                    tracing::warn!("Failed to close terminal session on drop: {}", e);
                }
            });
        }
    }
}
