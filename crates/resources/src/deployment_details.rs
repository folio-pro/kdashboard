use crate::detail_shared::*;
use crate::detail_tabs::{DetailTab, EditorSubTab};
use editor::YamlEditor;
use gpui::prelude::FluentBuilder;
use gpui::*;
use k8s_client::Resource;
use ui::{back_btn, danger_btn, theme, Icon, IconName, Sizable};

/// Actions that can be triggered from DeploymentDetails
#[derive(Clone, Debug)]
pub enum DeploymentAction {
    Delete { name: String, namespace: String },
    SelectPod { resource: Resource },
}

pub struct DeploymentDetails {
    resource: Resource,
    scroll_handle: ScrollHandle,
    on_close: Option<Box<dyn Fn(&mut Context<'_, Self>) + 'static>>,
    on_action: Option<Box<dyn Fn(DeploymentAction, &mut Context<'_, Self>) + 'static>>,
    active_tab: DetailTab,
    editor_sub_tab: EditorSubTab,
    yaml_editor: Option<Entity<YamlEditor>>,
    original_yaml: String,
    yaml_valid: Option<bool>,
    related_pods: Vec<Resource>,
    loading_pods: bool,
}

impl DeploymentDetails {
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
            related_pods: Vec::new(),
            loading_pods: true,
        }
    }

    pub fn set_related_pods(&mut self, pods: Vec<Resource>) {
        self.related_pods = pods;
        self.loading_pods = false;
    }

    pub fn set_resource(&mut self, resource: Resource) {
        self.resource = resource;
        self.yaml_editor = None;
        self.original_yaml.clear();
        self.yaml_valid = None;
        self.editor_sub_tab = EditorSubTab::Editor;
    }

    pub fn on_close(mut self, handler: impl Fn(&mut Context<'_, Self>) + 'static) -> Self {
        self.on_close = Some(Box::new(handler));
        self
    }

    pub fn on_action(
        mut self,
        handler: impl Fn(DeploymentAction, &mut Context<'_, Self>) + 'static,
    ) -> Self {
        self.on_action = Some(Box::new(handler));
        self
    }
}

impl Render for DeploymentDetails {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if self.active_tab == DetailTab::Yaml {
            return self.render_yaml_view(window, cx).into_any_element();
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
                    .gap(px(24.0))
                    .child(self.render_breadcrumb(cx))
                    .child(self.render_header(cx)),
            )
            .child(
                div()
                    .id("deployment-details-content")
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll_handle)
                    .p(px(24.0))
                    .child(self.render_content(cx)),
            )
            .into_any_element()
    }
}

impl DeploymentDetails {
    impl_yaml_editor_methods!();

    fn render_breadcrumb(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let name = self.resource.metadata.name.clone();

        div()
            .w_full()
            .flex()
            .items_center()
            .gap(px(8.0))
            .min_w(px(0.0))
            .child(
                back_btn("deployment-details-back-btn", colors).on_click(cx.listener(
                    |this, _, _window, cx| {
                        if let Some(on_close) = &this.on_close {
                            on_close(cx);
                        }
                        cx.notify();
                    },
                )),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(px(13.0))
                    .text_color(colors.text_muted)
                    .child("Cluster"),
            )
            .child(
                Icon::new(IconName::ChevronRight)
                    .size(px(14.0))
                    .color(colors.text_muted),
            )
            .child(
                div()
                    .id("bc-deployments")
                    .flex_shrink_0()
                    .cursor_pointer()
                    .text_size(px(13.0))
                    .text_color(colors.text_muted)
                    .hover(|s| s.text_color(colors.text_secondary))
                    .on_click(cx.listener(|this, _, _window, cx| {
                        if let Some(on_close) = &this.on_close {
                            on_close(cx);
                        }
                        cx.notify();
                    }))
                    .child("Deployments"),
            )
            .child(
                Icon::new(IconName::ChevronRight)
                    .size(px(14.0))
                    .color(colors.text_muted),
            )
            .child(
                div()
                    .min_w(px(0.0))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_size(px(13.0))
                    .text_color(colors.text)
                    .font_weight(FontWeight::MEDIUM)
                    .child(name),
            )
    }

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

        let desired = resource
            .spec
            .as_ref()
            .and_then(|s| s.get("replicas"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let available = resource
            .status
            .as_ref()
            .and_then(|s| s.get("availableReplicas"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let replicas_text = format!("{}/{} replicas", available, desired);

        let is_available = available == desired && desired > 0;
        let status_text = if is_available { "Running" } else { "Updating" };
        let (status_color, status_bg) = if is_available {
            (colors.success, colors.success.opacity(0.12))
        } else {
            (colors.warning, colors.warning.opacity(0.12))
        };

        div()
            .w_full()
            .flex()
            .items_center()
            .justify_between()
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .flex()
                    .items_center()
                    .gap(px(16.0))
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
                                Icon::new(IconName::Layers)
                                    .size(px(24.0))
                                    .color(colors.primary),
                            ),
                    )
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
                                            .child(replicas_text),
                                    ),
                            ),
                    )
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
                                    .child(status_text.to_string()),
                            ),
                    ),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(self.render_edit_button(cx))
                    .child(
                        danger_btn("delete-btn", IconName::Trash, "Delete", colors).on_click(
                            cx.listener(|this, _event, _window, cx| {
                                if let Some(on_action) = &this.on_action {
                                    let action = DeploymentAction::Delete {
                                        name: this.resource.metadata.name.clone(),
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

    fn render_content(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let resource = &self.resource;

        div()
            .w_full()
            .flex()
            .gap(px(24.0))
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .flex()
                    .flex_col()
                    .gap(px(24.0))
                    .child(self.render_info_card(cx, resource))
                    .child(self.render_replicas_card(cx, resource))
                    .child(render_detail_labels_card(cx, resource)),
            )
            .child(
                div()
                    .w(px(500.0))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .gap(px(24.0))
                    .child(self.render_pods_card(cx))
                    .child(self.render_events_card(cx, resource)),
            )
    }

    fn render_info_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let name = resource.metadata.name.clone();
        let namespace = resource
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());

        let desired = resource
            .spec
            .as_ref()
            .and_then(|s| s.get("replicas"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let available = resource
            .status
            .as_ref()
            .and_then(|s| s.get("availableReplicas"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let replicas_text = format!("{} / {}", available, desired);

        let strategy = get_json_str(&resource.spec, &["strategy", "type"])
            .unwrap_or_else(|| "RollingUpdate".to_string());

        let created = resource
            .metadata
            .creation_timestamp
            .clone()
            .unwrap_or_else(|| "-".to_string());

        let revision = resource
            .status
            .as_ref()
            .and_then(|s| s.get("observedGeneration"))
            .and_then(|v| v.as_u64())
            .map(|v| v.to_string())
            .unwrap_or_else(|| "-".to_string());

        let rows: Vec<(&str, String, Option<Hsla>)> = vec![
            ("Name", name, None),
            ("Namespace", namespace, Some(colors.primary)),
            ("Replicas", replicas_text, None),
            ("Strategy", strategy, None),
            ("Created", format_timestamp(&created), None),
            ("Revision", revision, Some(colors.success)),
        ];

        let row_items = render_detail_info_rows(colors, rows);

        render_detail_card(
            cx,
            "Deployment Information",
            None,
            div().flex().flex_col().children(row_items),
        )
    }

    fn render_replicas_card(
        &self,
        cx: &Context<'_, Self>,
        resource: &Resource,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let containers =
            get_json_array(&resource.spec, &["template", "spec", "containers"]).unwrap_or_default();
        let available = resource
            .status
            .as_ref()
            .and_then(|s| s.get("availableReplicas"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let count_text = format!("{} running", available);

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

                let is_running = available > 0;
                let status_color = if is_running {
                    colors.success
                } else {
                    colors.warning
                };
                let state_text = if is_running { "Running" } else { "Updating" };

                div()
                    .w_full()
                    .p(px(20.0))
                    .when(idx > 0, |el: Div| {
                        el.border_t_1().border_color(colors.border)
                    })
                    .flex()
                    .flex_col()
                    .gap(px(16.0))
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .items_center()
                            .justify_between()
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
                                            .child(
                                                div()
                                                    .overflow_hidden()
                                                    .whitespace_nowrap()
                                                    .text_ellipsis()
                                                    .text_size(px(14.0))
                                                    .text_color(colors.text)
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .child(name),
                                            )
                                            .child(
                                                div()
                                                    .overflow_hidden()
                                                    .whitespace_nowrap()
                                                    .text_ellipsis()
                                                    .text_size(px(12.0))
                                                    .text_color(colors.text_secondary)
                                                    .child(image),
                                            ),
                                    ),
                            )
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .px(px(10.0))
                                    .py(px(4.0))
                                    .rounded(theme.border_radius_full)
                                    .bg(status_color.opacity(0.12))
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(div().size(px(6.0)).rounded_full().bg(status_color))
                                    .child(
                                        div()
                                            .text_size(px(12.0))
                                            .text_color(status_color)
                                            .font_weight(FontWeight::MEDIUM)
                                            .child(state_text.to_string()),
                                    ),
                            ),
                    )
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
            })
            .collect();

        render_detail_card(
            cx,
            "Replicas",
            Some(count_text),
            div().flex().flex_col().children(container_items),
        )
    }

    fn render_pods_card(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        if self.loading_pods {
            return render_detail_card(
                cx,
                "Related Pods",
                None,
                div()
                    .p(px(20.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(ui::Spinner::new().with_size(ui::Size::Small))
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(colors.text_muted)
                            .child("Loading pods..."),
                    ),
            )
            .into_any_element();
        }

        let count = self.related_pods.len();
        let total = count;

        let pod_rows: Vec<AnyElement> = self
            .related_pods
            .iter()
            .enumerate()
            .map(|(idx, pod)| {
                let pod_name = pod.metadata.name.clone();
                let phase = pod
                    .status
                    .as_ref()
                    .and_then(|s| s.get("phase"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown")
                    .to_string();
                let node = pod
                    .status
                    .as_ref()
                    .and_then(|s| s.get("hostIP"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("-")
                    .to_string();
                let age = format_relative_time(pod);

                let status_color = match phase.as_str() {
                    "Running" | "Succeeded" => colors.success,
                    "Pending" => colors.warning,
                    "Failed" => colors.error,
                    _ => colors.text_muted,
                };

                let is_last = idx == total - 1;
                let pod_clone = pod.clone();

                let mut row = div()
                    .id(ElementId::Name(format!("pod-row-{}", idx).into()))
                    .w_full()
                    .cursor_pointer()
                    .px(px(20.0))
                    .py(px(10.0))
                    .hover(|s| s.bg(colors.surface_elevated))
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        if let Some(on_action) = &this.on_action {
                            on_action(
                                DeploymentAction::SelectPod {
                                    resource: pod_clone.clone(),
                                },
                                cx,
                            );
                        }
                    }));

                if !is_last {
                    row = row.border_b_1().border_color(colors.border);
                }

                row.child(
                    div()
                        .w_full()
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .child(
                            div()
                                .size(px(8.0))
                                .rounded_full()
                                .bg(status_color)
                                .flex_shrink_0(),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.0))
                                .flex()
                                .flex_col()
                                .gap(px(2.0))
                                .child(
                                    div()
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .text_ellipsis()
                                        .text_size(px(13.0))
                                        .text_color(colors.text)
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(pod_name),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(8.0))
                                        .child(
                                            div()
                                                .text_size(px(11.0))
                                                .text_color(status_color)
                                                .child(phase),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(11.0))
                                                .text_color(colors.text_muted)
                                                .child(age),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(11.0))
                                                .text_color(colors.text_muted)
                                                .child(node),
                                        ),
                                ),
                        )
                        .child(
                            Icon::new(IconName::ChevronRight)
                                .size(px(14.0))
                                .color(colors.text_muted),
                        ),
                )
                .into_any_element()
            })
            .collect();

        let count_text = format!("{} pod{}", count, if count != 1 { "s" } else { "" });

        render_detail_card(
            cx,
            "Related Pods",
            Some(count_text),
            if pod_rows.is_empty() {
                div()
                    .p(px(20.0))
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(colors.text_muted)
                            .child("No pods found"),
                    )
                    .into_any_element()
            } else {
                div()
                    .flex()
                    .flex_col()
                    .children(pod_rows)
                    .into_any_element()
            },
        )
        .into_any_element()
    }

    fn render_events_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let events = derive_deployment_events(resource);
        render_detail_events_card(cx, events)
    }
}

// ── Event derivation ────────────────────────────────────────────────────

fn derive_deployment_events(resource: &Resource) -> Vec<ResourceEvent> {
    let mut events = Vec::new();
    let name = &resource.metadata.name;
    let namespace = resource.metadata.namespace.as_deref().unwrap_or("default");

    let available = resource
        .status
        .as_ref()
        .and_then(|s| s.get("availableReplicas"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let desired = resource
        .spec
        .as_ref()
        .and_then(|s| s.get("replicas"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Scaled event
    if available == desired && desired > 0 {
        events.push(ResourceEvent {
            title: "Scaled".to_string(),
            description: format!("Scaled deployment {} to {} replicas", name, desired),
            time: format_relative_time(resource),
            event_type: EventType::Success,
        });
    } else if available < desired {
        events.push(ResourceEvent {
            title: "Scaling".to_string(),
            description: format!(
                "Scaling deployment {} from {} to {} replicas",
                name, available, desired
            ),
            time: format_relative_time(resource),
            event_type: EventType::Warning,
        });
    }

    // Container image events from pod template
    let containers =
        get_json_array(&resource.spec, &["template", "spec", "containers"]).unwrap_or_default();
    for container in &containers {
        let image = container
            .get("image")
            .and_then(|v| v.as_str())
            .unwrap_or("-");
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

        events.push(ResourceEvent {
            title: "Pulled".to_string(),
            description: format!("Successfully pulled image {}", image),
            time: format_relative_time(resource),
            event_type: EventType::Info,
        });
    }

    // Conditions
    let conditions = resource
        .status
        .as_ref()
        .and_then(|s| s.get("conditions"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for condition in &conditions {
        let cond_type = condition.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let status = condition
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if cond_type == "Available" && status == "True" {
            events.push(ResourceEvent {
                title: "Available".to_string(),
                description: format!("Deployment {}/{} has minimum availability", namespace, name),
                time: format_relative_time(resource),
                event_type: EventType::Success,
            });
        }
    }

    events
}
