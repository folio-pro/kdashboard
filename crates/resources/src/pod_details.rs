use crate::detail_shared::*;
use crate::detail_tabs::{DetailTab, EditorSubTab};
use editor::YamlEditor;
use gpui::prelude::FluentBuilder;
use gpui::*;
use k8s_client::{PortForwardInfo, Resource};
use std::collections::HashMap;
use ui::gpui_component::input::{Input as TextInput, InputState};
use ui::gpui_component::tooltip::Tooltip;
use ui::{back_btn, danger_btn, theme, Icon, IconName, Sizable, Size};

/// Actions that can be triggered from PodDetails
#[derive(Clone, Debug)]
pub enum PodAction {
    ViewLogs {
        pod_name: String,
        namespace: String,
        containers: Vec<String>,
        selected_container: Option<String>,
    },
    OpenTerminal {
        pod_name: String,
        namespace: String,
        containers: Vec<String>,
        selected_container: Option<String>,
    },
    Delete {
        pod_name: String,
        namespace: String,
    },
    PortForward {
        pod_name: String,
        namespace: String,
        container_port: u16,
        local_port: Option<u16>,
    },
    StopPortForward {
        session_id: String,
    },
}

/// Info about a discovered container port for the port-forward panel
#[derive(Clone, Debug)]
struct ContainerPortEntry {
    container_name: String,
    container_port: u16,
    protocol: String,
    port_name: String,
}

pub struct PodDetails {
    resource: Resource,
    scroll_handle: ScrollHandle,
    on_close: Option<Box<dyn Fn(&mut Context<'_, Self>) + 'static>>,
    on_action: Option<Box<dyn Fn(PodAction, &mut Context<'_, Self>) + 'static>>,
    active_tab: DetailTab,
    editor_sub_tab: EditorSubTab,
    yaml_editor: Option<Entity<YamlEditor>>,
    original_yaml: String,
    yaml_valid: Option<bool>,
    /// Text input entities per container_port for the local port value
    pf_inputs: HashMap<u16, Entity<InputState>>,
    /// Active port forwards (synced from AppState)
    port_forwards: Vec<PortForwardInfo>,
    /// Error message to show in the port forward panel
    pf_error: Option<String>,
}

impl PodDetails {
    pub fn new(resource: Resource) -> Self {
        Self {
            resource,
            scroll_handle: ScrollHandle::new(),
            on_close: None,
            on_action: None,
            active_tab: DetailTab::default(),
            editor_sub_tab: EditorSubTab::default(),
            yaml_editor: None,
            original_yaml: String::new(),
            yaml_valid: None,
            pf_inputs: HashMap::new(),
            port_forwards: Vec::new(),
            pf_error: None,
        }
    }

    pub fn set_resource(&mut self, resource: Resource) {
        self.resource = resource;
        self.yaml_editor = None;
        self.original_yaml.clear();
        self.yaml_valid = None;
        self.editor_sub_tab = EditorSubTab::Editor;
    }

    pub fn set_pf_error(&mut self, error: Option<String>) {
        self.pf_error = error;
    }

    pub fn set_port_forwards(&mut self, port_forwards: Vec<PortForwardInfo>) {
        self.port_forwards = port_forwards;
    }

    /// Find an active port forward for this pod + container port
    fn find_active_forward(&self, container_port: u16) -> Option<&PortForwardInfo> {
        let pod_name = &self.resource.metadata.name;
        let namespace = self
            .resource
            .metadata
            .namespace
            .as_deref()
            .unwrap_or("default");
        self.port_forwards.iter().find(|pf| {
            pf.pod_name == *pod_name
                && pf.namespace == namespace
                && pf.container_port == container_port
        })
    }

    /// Collect all container ports from the pod spec
    fn collect_container_ports(&self) -> Vec<ContainerPortEntry> {
        let containers = get_json_array(&self.resource.spec, &["containers"]).unwrap_or_default();
        let mut entries = Vec::new();
        for container in &containers {
            let container_name = container
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("-")
                .to_string();
            if let Some(ports) = container.get("ports").and_then(|p| p.as_array()) {
                for p in ports {
                    if let Some(cp) = p.get("containerPort").and_then(|v| v.as_u64()) {
                        entries.push(ContainerPortEntry {
                            container_name: container_name.clone(),
                            container_port: cp as u16,
                            protocol: p
                                .get("protocol")
                                .and_then(|v| v.as_str())
                                .unwrap_or("TCP")
                                .to_string(),
                            port_name: p
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                        });
                    }
                }
            }
        }
        entries
    }

    pub fn on_close(mut self, handler: impl Fn(&mut Context<'_, Self>) + 'static) -> Self {
        self.on_close = Some(Box::new(handler));
        self
    }

    pub fn on_action(
        mut self,
        handler: impl Fn(PodAction, &mut Context<'_, Self>) + 'static,
    ) -> Self {
        self.on_action = Some(Box::new(handler));
        self
    }
}

impl Render for PodDetails {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if self.active_tab == DetailTab::Yaml {
            return self.render_yaml_view(window, cx).into_any_element();
        }

        // Lazily create InputState entities for port forward inputs
        {
            let ports = self.collect_container_ports();
            let missing: Vec<(u16, String)> = ports
                .iter()
                .filter(|e| !self.pf_inputs.contains_key(&e.container_port))
                .map(|e| (e.container_port, e.container_port.to_string()))
                .collect();
            for (cp, default_val) in missing {
                let input_state = cx.new(|input_cx| {
                    InputState::new(window, input_cx)
                        .placeholder("Port")
                        .default_value(default_val)
                });
                self.pf_inputs.insert(cp, input_state);
            }
        }

        let colors = &theme(cx).colors;

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(colors.background)
            .child(
                div()
                    .w_full()
                    .overflow_hidden()
                    .px(px(24.0))
                    .pt(px(24.0))
                    .flex()
                    .flex_col()
                    .gap(px(18.0))
                    .child(self.render_header(cx)),
            )
            .child(
                div()
                    .id("pod-details-content")
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll_handle)
                    .p(px(24.0))
                    .child(self.render_content(cx)),
            )
            .into_any_element()
    }
}

impl PodDetails {
    impl_yaml_editor_methods!();

    // ── Header ──────────────────────────────────────────────────────────

    fn render_header(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let resource = &self.resource;

        let name = resource.metadata.name.clone();
        let namespace = resource
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let node_name =
            get_json_str(&resource.spec, &["nodeName"]).unwrap_or_else(|| "-".to_string());
        let phase =
            get_json_str(&resource.status, &["phase"]).unwrap_or_else(|| "Unknown".to_string());

        let (status_color, status_bg) = match phase.as_str() {
            "Running" | "Succeeded" => (colors.success, colors.success.opacity(0.12)),
            "Pending" => (colors.warning, colors.warning.opacity(0.12)),
            "Failed" => (colors.error, colors.error.opacity(0.12)),
            _ => (colors.text_muted, colors.text_muted.opacity(0.12)),
        };

        div()
            .w_full()
            .flex()
            .items_center()
            .justify_between()
            // Left: icon + info + status badge
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .flex()
                    .items_center()
                    .gap(px(16.0))
                    .child(
                        back_btn("pod-details-back-btn", colors).on_click(cx.listener(
                            |this, _, _window, cx| {
                                if let Some(on_close) = &this.on_close {
                                    on_close(cx);
                                }
                                cx.notify();
                            },
                        )),
                    )
                    // Pod icon box
                    .child(
                        div()
                            .flex_shrink_0()
                            .size(px(48.0))
                            .rounded(theme.border_radius_md)
                            .bg(colors.surface)
                            .border_1()
                            .border_color(colors.border)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                Icon::new(IconName::Box)
                                    .size(px(24.0))
                                    .color(colors.primary),
                            ),
                    )
                    // Name + namespace · node
                    .child(
                        div()
                            .min_w(px(0.0))
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(
                                div()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .text_size(px(20.0))
                                    .text_color(colors.text)
                                    .font_weight(FontWeight::BOLD)
                                    .child(name),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(12.0))
                                    .child(
                                        div()
                                            .text_size(px(13.0))
                                            .text_color(colors.text_secondary)
                                            .child(namespace),
                                    )
                                    .child(div().size(px(4.0)).rounded_full().bg(colors.text_muted))
                                    .child(
                                        div()
                                            .text_size(px(13.0))
                                            .text_color(colors.text_secondary)
                                            .child(node_name),
                                    ),
                            ),
                    )
                    // Status badge
                    .child(
                        div()
                            .flex_shrink_0()
                            .px(px(10.0))
                            .py(px(4.0))
                            .rounded(theme.border_radius_full)
                            .bg(status_bg)
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(div().size(px(6.0)).rounded_full().bg(status_color))
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .text_color(status_color)
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(phase),
                            ),
                    ),
            )
            // Right: action buttons
            .child(
                div()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(self.render_edit_button(cx))
                    .child(self.render_secondary_button(cx, "logs-btn", IconName::Logs, "Logs"))
                    .child(self.render_secondary_button(
                        cx,
                        "terminal-btn",
                        IconName::Terminal,
                        "Terminal",
                    ))
                    .child(
                        danger_btn("delete-btn", IconName::Trash, "Delete", colors).on_click(
                            cx.listener(|this, _event, _window, cx| {
                                if let Some(on_action) = &this.on_action {
                                    let action = PodAction::Delete {
                                        pod_name: this.resource.metadata.name.clone(),
                                        namespace: this
                                            .resource
                                            .metadata
                                            .namespace
                                            .clone()
                                            .unwrap_or_else(|| "default".to_string()),
                                    };
                                    on_action(action, cx);
                                }
                                cx.notify();
                            }),
                        ),
                    ),
            )
    }

    fn render_secondary_button(
        &self,
        cx: &Context<'_, Self>,
        id: &'static str,
        icon: IconName,
        label: &'static str,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let is_logs = id == "logs-btn";
        let is_terminal = id == "terminal-btn";

        let mut btn = ui::secondary_btn(ElementId::Name(id.into()), icon, label, colors);

        if is_logs {
            btn = btn.on_click(cx.listener(move |this, _event, _window, cx| {
                if let Some(on_action) = &this.on_action {
                    let all_containers: Vec<String> =
                        get_json_array(&this.resource.spec, &["containers"])
                            .unwrap_or_default()
                            .iter()
                            .filter_map(|c| {
                                c.get("name")
                                    .and_then(|n| n.as_str())
                                    .map(|s| s.to_string())
                            })
                            .collect();
                    let action = PodAction::ViewLogs {
                        pod_name: this.resource.metadata.name.clone(),
                        namespace: this
                            .resource
                            .metadata
                            .namespace
                            .clone()
                            .unwrap_or_else(|| "default".to_string()),
                        selected_container: all_containers.first().cloned(),
                        containers: all_containers,
                    };
                    on_action(action, cx);
                }
                cx.notify();
            }));
        } else if is_terminal {
            btn = btn.on_click(cx.listener(move |this, _event, _window, cx| {
                if let Some(on_action) = &this.on_action {
                    let all_containers: Vec<String> =
                        get_json_array(&this.resource.spec, &["containers"])
                            .unwrap_or_default()
                            .iter()
                            .filter_map(|c| {
                                c.get("name")
                                    .and_then(|n| n.as_str())
                                    .map(|s| s.to_string())
                            })
                            .collect();
                    let action = PodAction::OpenTerminal {
                        pod_name: this.resource.metadata.name.clone(),
                        namespace: this
                            .resource
                            .metadata
                            .namespace
                            .clone()
                            .unwrap_or_else(|| "default".to_string()),
                        selected_container: all_containers.first().cloned(),
                        containers: all_containers,
                    };
                    on_action(action, cx);
                }
                cx.notify();
            }));
        }

        btn
    }

    // ── Content layout ──────────────────────────────────────────────────

    fn render_content(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let resource = &self.resource;

        let left_col = div()
            .flex_1()
            .min_w(px(0.0))
            .flex()
            .flex_col()
            .gap(px(24.0))
            .child(self.render_pod_info_card(cx, resource))
            .child(self.render_containers_card(cx, resource))
            .child(render_detail_labels_card(cx, resource));

        let mut right_col = div()
            .w(px(500.0))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .gap(px(24.0));

        // Port forward panel (above events in the right column)
        right_col = right_col.child(div().w_full().child(self.render_port_forward_panel(cx)));

        right_col = right_col.child(div().w_full().child(self.render_events_card(cx, resource)));

        div()
            .w_full()
            .flex()
            .gap(px(24.0))
            .child(left_col)
            .child(right_col)
    }

    // ── Port Forward panel ────────────────────────────────────────────

    fn render_port_forward_panel(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let ports = self.collect_container_ports();

        if ports.is_empty() {
            return render_detail_card(
                cx,
                "Port Forward",
                None,
                div()
                    .p(px(20.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(colors.text_muted)
                            .child("No container ports defined in this pod"),
                    ),
            )
            .into_any_element();
        }

        let total = ports.len();
        let port_rows: Vec<AnyElement> = ports
            .iter()
            .enumerate()
            .map(|(idx, entry)| {
                let is_last = idx == total - 1;
                let cp = entry.container_port;
                let active_pf = self.find_active_forward(cp).cloned();
                let is_active = active_pf.is_some();

                let port_label = if entry.port_name.is_empty() {
                    format!("{}/{}", cp, entry.protocol)
                } else {
                    format!("{} ({}/{})", entry.port_name, cp, entry.protocol)
                };

                let pod_name_fwd = self.resource.metadata.name.clone();
                let namespace_fwd = self
                    .resource
                    .metadata
                    .namespace
                    .clone()
                    .unwrap_or_else(|| "default".to_string());

                let row_bg = if is_active {
                    colors.success.opacity(0.08)
                } else {
                    gpui::transparent_black()
                };

                let icon_color = if is_active {
                    colors.success
                } else {
                    colors.primary
                };

                let mut row = div()
                    .w_full()
                    .flex()
                    .items_center()
                    .px(px(20.0))
                    .py(px(14.0))
                    .bg(row_bg);

                if !is_last {
                    row = row.border_b_1().border_color(colors.border);
                }

                // Left: container name + port info
                row = row.child(
                    div()
                        .flex_1()
                        .min_w(px(0.0))
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    Icon::new(IconName::PortForward)
                                        .size(px(14.0))
                                        .color(icon_color),
                                )
                                .child(
                                    div()
                                        .text_size(px(13.0))
                                        .text_color(colors.text)
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(port_label),
                                ),
                        )
                        .child(
                            div()
                                .pl(px(22.0))
                                .text_size(px(11.0))
                                .text_color(colors.text_muted)
                                .child(format!("Container: {}", entry.container_name)),
                        ),
                );

                if let Some(pf) = active_pf {
                    // Active state: show local port badge + stop button
                    let session_id = pf.session_id.clone();
                    row = row
                        .child(
                            div()
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .px(px(10.0))
                                        .py(px(4.0))
                                        .rounded(theme.border_radius_full)
                                        .bg(colors.success.opacity(0.12))
                                        .flex()
                                        .items_center()
                                        .gap(px(6.0))
                                        .child(
                                            div().size(px(6.0)).rounded_full().bg(colors.success),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(12.0))
                                                .text_color(colors.success)
                                                .font_weight(FontWeight::MEDIUM)
                                                .child(format!("localhost:{}", pf.local_port)),
                                        ),
                                ),
                        )
                        .child(
                            div().flex_shrink_0().ml(px(12.0)).child(
                                div()
                                    .id(ElementId::Name(format!("pf-stop-{}", cp).into()))
                                    .cursor_pointer()
                                    .px(px(14.0))
                                    .py(px(6.0))
                                    .rounded(theme.border_radius_md)
                                    .bg(colors.error.opacity(0.12))
                                    .text_size(px(12.0))
                                    .text_color(colors.error)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .hover(|s| s.bg(colors.error.opacity(0.2)))
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(
                                        Icon::new(IconName::Close)
                                            .size(px(12.0))
                                            .color(colors.error),
                                    )
                                    .child("Stop")
                                    .on_click(cx.listener(move |this, _event, _window, cx| {
                                        if let Some(on_action) = &this.on_action {
                                            on_action(
                                                PodAction::StopPortForward {
                                                    session_id: session_id.clone(),
                                                },
                                                cx,
                                            );
                                        }
                                    })),
                            ),
                        );
                } else {
                    // Inactive state: show input + start button
                    let input_el: Option<AnyElement> = self.pf_inputs.get(&cp).map(|state| {
                        TextInput::new(state)
                            .with_size(Size::Small)
                            .cleanable(false)
                            .w(px(90.0))
                            .into_any_element()
                    });

                    row = row
                        .child(
                            div()
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .text_size(px(11.0))
                                        .text_color(colors.text_muted)
                                        .child("Local port:"),
                                )
                                .when_some(input_el, |el, input| el.child(input)),
                        )
                        .child(
                            div().flex_shrink_0().ml(px(16.0)).child(
                                div()
                                    .id(ElementId::Name(format!("pf-start-{}", cp).into()))
                                    .cursor_pointer()
                                    .px(px(14.0))
                                    .py(px(6.0))
                                    .rounded(theme.border_radius_md)
                                    .bg(colors.primary)
                                    .text_size(px(12.0))
                                    .text_color(colors.background)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .hover(|s| s.bg(colors.primary_hover))
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(
                                        Icon::new(IconName::Play)
                                            .size(px(12.0))
                                            .color(colors.background),
                                    )
                                    .child("Start")
                                    .on_click(cx.listener(move |this, _event, _window, cx| {
                                        if let Some(on_action) = &this.on_action {
                                            let local_port = this
                                                .pf_inputs
                                                .get(&cp)
                                                .and_then(|state| {
                                                    let val = state.read(cx).value().to_string();
                                                    val.trim().parse::<u16>().ok()
                                                })
                                                .filter(|&p| p > 0);
                                            on_action(
                                                PodAction::PortForward {
                                                    pod_name: pod_name_fwd.clone(),
                                                    namespace: namespace_fwd.clone(),
                                                    container_port: cp,
                                                    local_port,
                                                },
                                                cx,
                                            );
                                        }
                                    })),
                            ),
                        );
                }

                row.into_any_element()
            })
            .collect();

        render_detail_card(
            cx,
            "Port Forward",
            Some(format!(
                "{} port{}",
                total,
                if total != 1 { "s" } else { "" }
            )),
            div()
                .flex()
                .flex_col()
                .children(port_rows)
                // Error banner
                .when_some(self.pf_error.clone(), |el, error_msg| {
                    el.child(
                        div()
                            .w_full()
                            .px(px(20.0))
                            .py(px(10.0))
                            .border_t_1()
                            .border_color(colors.error.opacity(0.3))
                            .bg(colors.error.opacity(0.08))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                Icon::new(IconName::Error)
                                    .size(px(14.0))
                                    .color(colors.error),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(px(12.0))
                                    .text_color(colors.error)
                                    .child(error_msg),
                            ),
                    )
                })
                .child(
                    // Help text at the bottom
                    div()
                        .w_full()
                        .px(px(20.0))
                        .py(px(12.0))
                        .border_t_1()
                        .border_color(colors.border)
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            Icon::new(IconName::Info)
                                .size(px(12.0))
                                .color(colors.text_muted),
                        )
                        .child(
                            div()
                                .text_size(px(11.0))
                                .text_color(colors.text_muted)
                                .child("Type a port number or leave empty for auto-assign"),
                        ),
                ),
        )
        .into_any_element()
    }

    // ── Pod Information card ────────────────────────────────────────────

    fn render_pod_info_card(
        &self,
        cx: &Context<'_, Self>,
        resource: &Resource,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let name = resource.metadata.name.clone();
        let namespace = resource
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let node_name =
            get_json_str(&resource.spec, &["nodeName"]).unwrap_or_else(|| "-".to_string());
        let pod_ip = get_json_str(&resource.status, &["podIP"]).unwrap_or_else(|| "-".to_string());
        let created = resource
            .metadata
            .creation_timestamp
            .clone()
            .unwrap_or_else(|| "-".to_string());
        let restarts = get_pod_restarts(resource);

        let rows: Vec<(&str, String, Option<Hsla>)> = vec![
            ("Name", name, None),
            ("Namespace", namespace, Some(colors.primary)),
            ("Node", node_name, None),
            ("IP Address", pod_ip, None),
            ("Created", format_timestamp(&created), None),
            ("Restarts", restarts.to_string(), Some(colors.success)),
        ];

        let row_items = render_detail_info_rows(colors, rows);

        render_detail_card(
            cx,
            "Pod Information",
            None,
            div().flex().flex_col().children(row_items),
        )
    }

    // ── Containers card ─────────────────────────────────────────────────

    fn render_containers_card(
        &self,
        cx: &Context<'_, Self>,
        resource: &Resource,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let containers = get_json_array(&resource.spec, &["containers"]).unwrap_or_default();
        let container_statuses =
            get_json_array(&resource.status, &["containerStatuses"]).unwrap_or_default();
        let count = containers.len();

        let container_items: Vec<Div> = containers
            .iter()
            .enumerate()
            .map(|(idx, container)| {
                let name = container
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-")
                    .to_string();
                let image = container
                    .get("image")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-")
                    .to_string();
                let image_short = Self::image_display_name(&image);

                let status = container_statuses
                    .iter()
                    .find(|s| s.get("name").and_then(|n| n.as_str()) == Some(&name));

                let is_running = status
                    .and_then(|s| s.get("state"))
                    .and_then(|s| s.get("running"))
                    .is_some();

                let restarts = status
                    .and_then(|s| s.get("restartCount"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                let state_text = if is_running {
                    "Running"
                } else if status
                    .and_then(|s| s.get("state"))
                    .and_then(|s| s.get("waiting"))
                    .is_some()
                {
                    "Waiting"
                } else if status
                    .and_then(|s| s.get("state"))
                    .and_then(|s| s.get("terminated"))
                    .is_some()
                {
                    "Terminated"
                } else {
                    "Unknown"
                };

                let cpu_request = container
                    .get("resources")
                    .and_then(|r| r.get("requests"))
                    .and_then(|r| r.get("cpu"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("-")
                    .to_string();
                let cpu_limit = container
                    .get("resources")
                    .and_then(|r| r.get("limits"))
                    .and_then(|r| r.get("cpu"))
                    .and_then(|v| v.as_str())
                    .map(|s| format!("/ {} limit", s));
                let mem_request = container
                    .get("resources")
                    .and_then(|r| r.get("requests"))
                    .and_then(|r| r.get("memory"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("-")
                    .to_string();
                let mem_limit = container
                    .get("resources")
                    .and_then(|r| r.get("limits"))
                    .and_then(|r| r.get("memory"))
                    .and_then(|v| v.as_str())
                    .map(|s| format!("/ {} limit", s));

                let (cpu_num, cpu_unit) = parse_resource_value(&cpu_request);
                let (mem_num, mem_unit) = parse_resource_value(&mem_request);

                let status_color = if is_running {
                    colors.success
                } else {
                    colors.warning
                };

                div()
                    .w_full()
                    .p(px(20.0))
                    .when(idx > 0, |el: Div| {
                        el.border_t_1().border_color(colors.border)
                    })
                    .flex()
                    .flex_col()
                    .gap(px(16.0))
                    // Container header row
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .items_center()
                            .justify_between()
                            // Left: icon + name/image
                            .child(
                                div()
                                    .flex_1()
                                    .min_w(px(0.0))
                                    .flex()
                                    .items_center()
                                    .gap(px(12.0))
                                    .child(
                                        div()
                                            .flex_shrink_0()
                                            .size(px(36.0))
                                            .rounded(theme.border_radius_md)
                                            .bg(colors.primary)
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .child(
                                                Icon::new(IconName::Box)
                                                    .size(px(18.0))
                                                    .color(colors.background),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .min_w(px(0.0))
                                            .flex()
                                            .flex_col()
                                            .gap(px(2.0))
                                            .child(with_double_click_copy(
                                                div()
                                                    .id(ElementId::Name(
                                                        format!("container-name-{}", idx).into(),
                                                    ))
                                                    .overflow_hidden()
                                                    .whitespace_nowrap()
                                                    .text_ellipsis()
                                                    .text_size(px(14.0))
                                                    .text_color(colors.text)
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .child(name.clone()),
                                                name.clone(),
                                            ))
                                            .child(with_double_click_copy(
                                                div()
                                                    .id(ElementId::Name(
                                                        format!("container-image-{}", idx).into(),
                                                    ))
                                                    .overflow_hidden()
                                                    .whitespace_nowrap()
                                                    .text_ellipsis()
                                                    .text_size(px(12.0))
                                                    .text_color(colors.text_secondary)
                                                    .child(image_short)
                                                    .tooltip({
                                                        let full_image = image.clone();
                                                        move |_, cx| {
                                                            cx.new(|_| {
                                                                Tooltip::new(full_image.clone())
                                                            })
                                                            .into()
                                                        }
                                                    }),
                                                image.clone(),
                                            )),
                                    ),
                            )
                            // Right: restarts + status badge
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .when(restarts > 0, |el: Div| {
                                        el.child(
                                            div()
                                                .px(px(10.0))
                                                .py(px(4.0))
                                                .rounded(theme.border_radius_full)
                                                .bg(colors.warning.opacity(0.12))
                                                .flex()
                                                .items_center()
                                                .gap(px(6.0))
                                                .child(
                                                    Icon::new(IconName::Refresh)
                                                        .size(px(12.0))
                                                        .color(colors.warning),
                                                )
                                                .child(
                                                    div()
                                                        .text_size(px(12.0))
                                                        .text_color(colors.warning)
                                                        .font_weight(FontWeight::MEDIUM)
                                                        .child(format!("Restarts: {}", restarts)),
                                                ),
                                        )
                                    })
                                    .child(
                                        div()
                                            .px(px(10.0))
                                            .py(px(4.0))
                                            .rounded(theme.border_radius_full)
                                            .bg(status_color.opacity(0.12))
                                            .flex()
                                            .items_center()
                                            .gap(px(6.0))
                                            .child(
                                                div().size(px(6.0)).rounded_full().bg(status_color),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(12.0))
                                                    .text_color(status_color)
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .child(state_text.to_string()),
                                            ),
                                    ),
                            ),
                    )
                    // Resource stat cards
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .gap(px(16.0))
                            .child(render_detail_resource_stat(
                                cx,
                                "CPU",
                                &cpu_num,
                                &cpu_unit,
                                cpu_limit.as_deref(),
                            ))
                            .child(render_detail_resource_stat(
                                cx,
                                "MEMORY",
                                &mem_num,
                                &mem_unit,
                                mem_limit.as_deref(),
                            )),
                    )
                    // Container ports display
                    .when_some(
                        container.get("ports").and_then(|p| p.as_array()).cloned(),
                        move |el: Div, ports| {
                            if ports.is_empty() {
                                return el;
                            }
                            let port_items: Vec<Div> = ports
                                .iter()
                                .filter_map(|p| {
                                    let container_port =
                                        p.get("containerPort").and_then(|v| v.as_u64())? as u16;
                                    let protocol =
                                        p.get("protocol").and_then(|v| v.as_str()).unwrap_or("TCP");
                                    let port_name =
                                        p.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                    let label = if port_name.is_empty() {
                                        format!("{}/{}", container_port, protocol)
                                    } else {
                                        format!("{} ({}/{})", port_name, container_port, protocol)
                                    };

                                    Some(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(6.0))
                                            .child(
                                                Icon::new(IconName::PortForward)
                                                    .size(px(12.0))
                                                    .color(colors.text_muted),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(12.0))
                                                    .text_color(colors.text_secondary)
                                                    .child(label),
                                            ),
                                    )
                                })
                                .collect();

                            if port_items.is_empty() {
                                return el;
                            }

                            el.child(
                                div()
                                    .w_full()
                                    .flex()
                                    .flex_wrap()
                                    .gap(px(12.0))
                                    .children(port_items),
                            )
                        },
                    )
            })
            .collect();

        render_detail_card(
            cx,
            "Containers",
            Some(format!(
                "{} container{}",
                count,
                if count != 1 { "s" } else { "" }
            )),
            div().flex().flex_col().children(container_items),
        )
    }

    // ── Events card ─────────────────────────────────────────────────────

    fn render_events_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let events = derive_pod_events(resource);
        render_detail_events_card(cx, events)
    }
}

impl PodDetails {
    fn image_display_name(image: &str) -> String {
        image.rsplit('/').next().unwrap_or(image).to_string()
    }
}

/// Derive events from pod status data (conditions + container statuses).
/// Real K8s events would come from the Events API.
fn derive_pod_events(resource: &Resource) -> Vec<ResourceEvent> {
    let mut events = Vec::new();
    let name = &resource.metadata.name;
    let namespace = resource.metadata.namespace.as_deref().unwrap_or("default");

    let containers = get_json_array(&resource.spec, &["containers"]).unwrap_or_default();
    let container_statuses =
        get_json_array(&resource.status, &["containerStatuses"]).unwrap_or_default();

    // Started events from running containers
    for cs in &container_statuses {
        let container_name = cs.get("name").and_then(|v| v.as_str()).unwrap_or("-");
        if cs.get("state").and_then(|s| s.get("running")).is_some() {
            events.push(ResourceEvent {
                title: "Started".to_string(),
                description: format!("Started container {}", container_name),
                time: format_relative_time(resource),
                event_type: EventType::Success,
            });
        }
    }

    // Created events from containers
    for container in &containers {
        let container_name = container
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("-");
        events.push(ResourceEvent {
            title: "Created".to_string(),
            description: format!("Created container {}", container_name),
            time: format_relative_time(resource),
            event_type: EventType::Success,
        });
    }

    // Pulled events from container images
    for container in &containers {
        let image = container
            .get("image")
            .and_then(|v| v.as_str())
            .unwrap_or("-");
        events.push(ResourceEvent {
            title: "Pulled".to_string(),
            description: format!("Successfully pulled image {}", image),
            time: format_relative_time(resource),
            event_type: EventType::Info,
        });
    }

    // Scheduled event from PodScheduled condition
    let conditions = get_json_array(&resource.status, &["conditions"]).unwrap_or_default();
    let is_scheduled = conditions.iter().any(|c| {
        c.get("type").and_then(|v| v.as_str()) == Some("PodScheduled")
            && c.get("status").and_then(|v| v.as_str()) == Some("True")
    });
    let node = get_json_str(&resource.spec, &["nodeName"]).unwrap_or_else(|| "-".to_string());

    if is_scheduled {
        events.push(ResourceEvent {
            title: "Scheduled".to_string(),
            description: format!("Successfully assigned {}/{} to {}", namespace, name, node),
            time: format_relative_time(resource),
            event_type: EventType::Info,
        });
    }

    events
}

// ── Helpers ─────────────────────────────────────────────────────────────

fn get_pod_restarts(resource: &Resource) -> u64 {
    let container_statuses =
        get_json_array(&resource.status, &["containerStatuses"]).unwrap_or_default();
    container_statuses
        .iter()
        .map(|s| s.get("restartCount").and_then(|r| r.as_u64()).unwrap_or(0))
        .sum()
}
