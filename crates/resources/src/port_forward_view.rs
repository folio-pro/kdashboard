use gpui::*;
use k8s_client::PortForwardInfo;
use ui::{Icon, IconName, theme};

/// Actions emitted by the PortForwardView
#[derive(Clone, Debug)]
pub enum PortForwardViewAction {
    Stop { session_id: String },
    OpenBrowser { local_port: u16 },
}

pub struct PortForwardView {
    port_forwards: Vec<PortForwardInfo>,
    on_action: Option<Box<dyn Fn(PortForwardViewAction, &mut Context<'_, Self>) + 'static>>,
    on_close: Option<Box<dyn Fn(&mut Context<'_, Self>) + 'static>>,
}

impl PortForwardView {
    pub fn new(port_forwards: Vec<PortForwardInfo>) -> Self {
        Self {
            port_forwards,
            on_action: None,
            on_close: None,
        }
    }

    pub fn on_action(
        mut self,
        handler: impl Fn(PortForwardViewAction, &mut Context<'_, Self>) + 'static,
    ) -> Self {
        self.on_action = Some(Box::new(handler));
        self
    }

    pub fn on_close(mut self, handler: impl Fn(&mut Context<'_, Self>) + 'static) -> Self {
        self.on_close = Some(Box::new(handler));
        self
    }

    pub fn set_port_forwards(&mut self, port_forwards: Vec<PortForwardInfo>) {
        self.port_forwards = port_forwards;
    }
}

impl Render for PortForwardView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(colors.background)
            // Header
            .child(
                div()
                    .w_full()
                    .px(px(24.0))
                    .pt(px(24.0))
                    .pb(px(16.0))
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(px(28.0))
                            .text_color(colors.text)
                            .font_weight(FontWeight::BOLD)
                            .child("Port Forwards"),
                    )
                    .child(
                        div()
                            .text_size(px(14.0))
                            .text_color(colors.text_muted)
                            .child("Manage active port forwarding sessions"),
                    ),
            )
            // Content
            .child(
                div()
                    .id("port-forwards-content")
                    .flex_1()
                    .overflow_y_scroll()
                    .px(px(24.0))
                    .pb(px(24.0))
                    .child(self.render_table(cx)),
            )
    }
}

impl PortForwardView {
    fn render_table(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        if self.port_forwards.is_empty() {
            return div()
                .w_full()
                .py(px(80.0))
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(16.0))
                .child(
                    Icon::new(IconName::PortForward)
                        .size(px(48.0))
                        .color(colors.text_muted),
                )
                .child(
                    div()
                        .text_size(px(16.0))
                        .text_color(colors.text_muted)
                        .font_weight(FontWeight::MEDIUM)
                        .child("No active port forwards"),
                )
                .child(
                    div()
                        .text_size(px(13.0))
                        .text_color(colors.text_muted)
                        .child("Open a pod and forward a container port to get started"),
                )
                .into_any_element();
        }

        let mut table = div()
            .w_full()
            .rounded(theme.border_radius_lg)
            .border_1()
            .border_color(colors.border)
            .bg(colors.surface)
            .overflow_hidden()
            .flex()
            .flex_col();

        // Table header
        table = table.child(
            div()
                .w_full()
                .flex()
                .items_center()
                .px(px(20.0))
                .py(px(12.0))
                .border_b_1()
                .border_color(colors.border)
                .bg(colors.surface_elevated)
                .child(header_cell(colors.text_muted, "Pod Name", px(200.0)))
                .child(header_cell(colors.text_muted, "Namespace", px(140.0)))
                .child(header_cell(colors.text_muted, "Container Port", px(120.0)))
                .child(header_cell(colors.text_muted, "Local Port", px(120.0)))
                .child(header_cell(colors.text_muted, "Status", px(100.0)))
                .child(
                    div()
                        .flex_1()
                        .text_size(px(11.0))
                        .text_color(colors.text_muted)
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Actions"),
                ),
        );

        // Table rows
        let total = self.port_forwards.len();
        for (idx, pf) in self.port_forwards.iter().enumerate() {
            let is_last = idx == total - 1;
            let session_id = pf.session_id.clone();
            let local_port = pf.local_port;

            let session_id_stop = session_id.clone();

            let mut row = div()
                .w_full()
                .flex()
                .items_center()
                .px(px(20.0))
                .py(px(10.0));

            if !is_last {
                row = row.border_b_1().border_color(colors.border);
            }

            row = row
                .child(
                    div()
                        .w(px(200.0))
                        .flex_shrink_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_size(px(13.0))
                        .text_color(colors.text)
                        .font_weight(FontWeight::MEDIUM)
                        .child(pf.pod_name.clone()),
                )
                .child(
                    div()
                        .w(px(140.0))
                        .flex_shrink_0()
                        .text_size(px(13.0))
                        .text_color(colors.text_secondary)
                        .child(pf.namespace.clone()),
                )
                .child(
                    div()
                        .w(px(120.0))
                        .flex_shrink_0()
                        .text_size(px(13.0))
                        .text_color(colors.text_secondary)
                        .child(pf.container_port.to_string()),
                )
                .child(
                    div()
                        .w(px(120.0))
                        .flex_shrink_0()
                        .text_size(px(13.0))
                        .text_color(colors.primary)
                        .font_weight(FontWeight::MEDIUM)
                        .child(format!("localhost:{}", pf.local_port)),
                )
                // Status badge
                .child(
                    div().w(px(100.0)).flex_shrink_0().child(
                        div()
                            .px(px(8.0))
                            .py(px(3.0))
                            .rounded(theme.border_radius_full)
                            .bg(colors.success.opacity(0.12))
                            .flex()
                            .items_center()
                            .gap(px(5.0))
                            .child(div().size(px(6.0)).rounded_full().bg(colors.success))
                            .child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(colors.success)
                                    .font_weight(FontWeight::MEDIUM)
                                    .child("Active"),
                            ),
                    ),
                )
                // Actions
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            div()
                                .id(ElementId::Name(format!("open-{}", session_id).into()))
                                .cursor_pointer()
                                .px(px(10.0))
                                .py(px(4.0))
                                .rounded(theme.border_radius_md)
                                .bg(colors.primary.opacity(0.12))
                                .text_size(px(12.0))
                                .text_color(colors.primary)
                                .font_weight(FontWeight::MEDIUM)
                                .hover(|s| s.bg(colors.primary.opacity(0.2)))
                                .child("Open")
                                .on_click(cx.listener(move |this, _event, _window, cx| {
                                    if let Some(on_action) = &this.on_action {
                                        on_action(
                                            PortForwardViewAction::OpenBrowser { local_port },
                                            cx,
                                        );
                                    }
                                })),
                        )
                        .child(
                            div()
                                .id(ElementId::Name(format!("stop-{}", session_id_stop).into()))
                                .cursor_pointer()
                                .px(px(10.0))
                                .py(px(4.0))
                                .rounded(theme.border_radius_md)
                                .bg(colors.error.opacity(0.12))
                                .text_size(px(12.0))
                                .text_color(colors.error)
                                .font_weight(FontWeight::MEDIUM)
                                .hover(|s| s.bg(colors.error.opacity(0.2)))
                                .child("Stop")
                                .on_click(cx.listener(move |this, _event, _window, cx| {
                                    if let Some(on_action) = &this.on_action {
                                        on_action(
                                            PortForwardViewAction::Stop {
                                                session_id: session_id_stop.clone(),
                                            },
                                            cx,
                                        );
                                    }
                                })),
                        ),
                );

            table = table.child(row);
        }

        table.into_any_element()
    }
}

fn header_cell(color: Hsla, label: &str, width: Pixels) -> impl IntoElement {
    div()
        .w(width)
        .flex_shrink_0()
        .text_size(px(11.0))
        .text_color(color)
        .font_weight(FontWeight::SEMIBOLD)
        .child(label.to_string())
}
