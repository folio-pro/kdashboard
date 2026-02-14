use gpui::*;
use gpui::prelude::FluentBuilder;
use k8s_client::Resource;
use ui::{theme, Icon, IconName, danger_btn};
use editor::YamlEditor;
use crate::detail_tabs::{DetailTab, EditorSubTab};
use crate::detail_shared::*;

/// Actions that can be triggered from HpaDetails
#[derive(Clone, Debug)]
pub enum HpaAction {
    Delete { name: String, namespace: String },
}

pub struct HpaDetails {
    resource: Resource,
    scroll_handle: ScrollHandle,
    on_close: Option<Box<dyn Fn(&mut Context<'_, Self>) + 'static>>,
    on_action: Option<Box<dyn Fn(HpaAction, &mut Context<'_, Self>) + 'static>>,
    active_tab: DetailTab,
    editor_sub_tab: EditorSubTab,
    yaml_editor: Option<Entity<YamlEditor>>,
    original_yaml: String,
    yaml_valid: Option<bool>,
}

impl HpaDetails {
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
        }
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

    pub fn on_action(mut self, handler: impl Fn(HpaAction, &mut Context<'_, Self>) + 'static) -> Self {
        self.on_action = Some(Box::new(handler));
        self
    }
}

impl Render for HpaDetails {
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
                    .child(self.render_header(cx))
            )
            .child(
                div()
                    .id("hpa-details-content")
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll_handle)
                    .p(px(24.0))
                    .child(self.render_content(cx))
            )
            .into_any_element()
    }
}

impl HpaDetails {
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
                div()
                    .flex_shrink_0()
                    .text_size(px(13.0))
                    .text_color(colors.text_muted)
                    .child("Cluster")
            )
            .child(Icon::new(IconName::ChevronRight).size(px(14.0)).color(colors.text_muted))
            .child(
                div()
                    .id("bc-hpa")
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
                    .child("HPA")
            )
            .child(Icon::new(IconName::ChevronRight).size(px(14.0)).color(colors.text_muted))
            .child(
                div()
                    .min_w(px(0.0))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_size(px(13.0))
                    .text_color(colors.text)
                    .font_weight(FontWeight::MEDIUM)
                    .child(name)
            )
    }

    fn render_header(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let resource = &self.resource;

        let name = resource.metadata.name.clone();
        let namespace = resource.metadata.namespace.clone().unwrap_or_else(|| "default".to_string());

        let current = get_json_u64(&resource.status, &["currentReplicas"]).unwrap_or(0);
        let desired = get_json_u64(&resource.status, &["desiredReplicas"]).unwrap_or(0);
        let min = get_json_u64(&resource.spec, &["minReplicas"]).unwrap_or(1);
        let max = get_json_u64(&resource.spec, &["maxReplicas"]).unwrap_or(0);

        let replicas_text = format!("{}/{} replicas (min: {}, max: {})", current, desired, min, max);

        let is_stable = current == desired;
        let status_text = if is_stable { "Stable" } else if current < desired { "Scaling Up" } else { "Scaling Down" };
        let (status_color, status_bg) = if is_stable {
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
                                Icon::new(IconName::Scale)
                                    .size(px(24.0))
                                    .color(colors.primary)
                            )
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
                                    .child(name)
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
                                            .child(namespace)
                                    )
                                    .child(
                                        div()
                                            .size(px(4.0))
                                            .rounded_full()
                                            .bg(colors.text_muted)
                                    )
                                    .child(
                                        div()
                                            .text_size(px(13.0))
                                            .text_color(colors.text_secondary)
                                            .child(replicas_text)
                                    )
                            )
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
                            .child(
                                div()
                                    .size(px(6.0))
                                    .rounded_full()
                                    .bg(status_color)
                            )
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .text_color(status_color)
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(status_text.to_string())
                            )
                    )
            )
            .child(
                div()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(self.render_edit_button(cx))
                    .child(
                        danger_btn("delete-btn", IconName::Trash, "Delete", colors)
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                if let Some(on_action) = &this.on_action {
                                    let action = HpaAction::Delete {
                                        name: this.resource.metadata.name.clone(),
                                        namespace: this.resource.metadata.namespace.clone().unwrap_or_else(|| "default".to_string()),
                                    };
                                    on_action(action, cx);
                                }
                                cx.notify();
                            }))
                    )
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
                    .child(self.render_scaling_card(cx, resource))
                    .child(self.render_metrics_card(cx, resource))
            )
            .child(
                div()
                    .w(px(400.0))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .gap(px(24.0))
                    .child(self.render_conditions_card(cx, resource))
                    .child(render_detail_labels_card(cx, resource))
            )
    }

    fn render_info_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let colors = &theme(cx).colors;

        let name = resource.metadata.name.clone();
        let namespace = resource.metadata.namespace.clone().unwrap_or_else(|| "default".to_string());

        let target_kind = get_json_str(&resource.spec, &["scaleTargetRef", "kind"])
            .unwrap_or_else(|| "-".to_string());
        let target_name = get_json_str(&resource.spec, &["scaleTargetRef", "name"])
            .unwrap_or_else(|| "-".to_string());
        let target_ref = format!("{}/{}", target_kind, target_name);

        let created = resource.metadata.creation_timestamp.clone().unwrap_or_else(|| "-".to_string());

        let rows: Vec<(&str, String, Option<Hsla>)> = vec![
            ("Name", name, None),
            ("Namespace", namespace, Some(colors.primary)),
            ("Target", target_ref, None),
            ("API Version", resource.api_version.clone(), None),
            ("Created", format_timestamp(&created), None),
        ];

        let row_items = render_detail_info_rows(colors, rows);

        render_detail_card(cx, "HPA Information", None,
            div().flex().flex_col().children(row_items)
        )
    }

    fn render_scaling_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let min = get_json_u64(&resource.spec, &["minReplicas"]).unwrap_or(1);
        let max = get_json_u64(&resource.spec, &["maxReplicas"]).unwrap_or(0);
        let current = get_json_u64(&resource.status, &["currentReplicas"]).unwrap_or(0);
        let desired = get_json_u64(&resource.status, &["desiredReplicas"]).unwrap_or(0);

        let progress = if max > min {
            ((current - min) as f32 / (max - min) as f32 * 100.0).min(100.0).max(0.0)
        } else {
            0.0
        };

        render_detail_card(cx, "Scaling Status", None,
            div()
                .p(px(20.0))
                .flex()
                .flex_col()
                .gap(px(20.0))
                .child(
                    div()
                        .w_full()
                        .flex()
                        .gap(px(16.0))
                        .child(render_stat_box(cx, "Min Replicas", min.to_string(), colors.text_muted))
                        .child(render_stat_box(cx, "Current", current.to_string(), if current == desired { colors.success } else { colors.warning }))
                        .child(render_stat_box(cx, "Desired", desired.to_string(), colors.primary))
                        .child(render_stat_box(cx, "Max Replicas", max.to_string(), colors.text_muted))
                )
                .child(
                    div()
                        .w_full()
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(colors.text_secondary)
                                .child("Scaling Range")
                        )
                        .child(
                            div()
                                .w_full()
                                .h(px(8.0))
                                .rounded(theme.border_radius_full)
                                .bg(colors.surface_elevated)
                                .child(
                                    div()
                                        .h_full()
                                        .w(px(progress * 2.0)) // Approximate width scaling
                                        .rounded(theme.border_radius_full)
                                        .bg(colors.primary)
                                )
                        )
                        .child(
                            div()
                                .w_full()
                                .flex()
                                .justify_between()
                                .child(
                                    div().text_size(px(11.0)).text_color(colors.text_muted).child(min.to_string())
                                )
                                .child(
                                    div().text_size(px(11.0)).text_color(colors.text_muted).child(max.to_string())
                                )
                        )
                )
        )
    }

    fn render_metrics_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let spec_metrics = resource.spec.as_ref()
            .and_then(|s| s.get("metrics"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let current_metrics = resource.status.as_ref()
            .and_then(|s| s.get("currentMetrics"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let metric_items: Vec<Div> = spec_metrics.iter().enumerate().map(|(idx, metric)| {
            let metric_type = metric.get("type").and_then(|v| v.as_str()).unwrap_or("");

            let (name, target, current_val) = if metric_type == "Resource" {
                let res_name = metric.get("resource")
                    .and_then(|r| r.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("-");

                let target_util = metric.get("resource")
                    .and_then(|r| r.get("target"))
                    .and_then(|t| t.get("averageUtilization"))
                    .and_then(|a| a.as_u64());

                let current_util = current_metrics.iter()
                    .find(|m| {
                        m.get("resource")
                            .and_then(|r| r.get("name"))
                            .and_then(|n| n.as_str()) == Some(res_name)
                    })
                    .and_then(|m| m.get("resource"))
                    .and_then(|r| r.get("current"))
                    .and_then(|c| c.get("averageUtilization"))
                    .and_then(|a| a.as_u64());

                let label = if res_name == "cpu" { "CPU" } else if res_name == "memory" { "Memory" } else { res_name };
                (label.to_string(), target_util, current_util)
            } else {
                (metric_type.to_string(), None, None)
            };

            let is_last = idx == spec_metrics.len() - 1;
            let current_str = current_val.map(|c| format!("{}%", c)).unwrap_or_else(|| "-".to_string());
            let target_str = target.map(|t| format!("{}%", t)).unwrap_or_else(|| "-".to_string());

            let progress = match (current_val, target) {
                (Some(c), Some(t)) if t > 0 => (c as f32 / t as f32 * 100.0).min(150.0),
                _ => 0.0,
            };

            let bar_color = if progress > 100.0 { colors.error } else if progress > 80.0 { colors.warning } else { colors.success };

            let mut row = div()
                .w_full()
                .p(px(16.0));

            if !is_last {
                row = row.border_b_1().border_color(colors.border);
            }

            row
                .flex()
                .flex_col()
                .gap(px(12.0))
                .child(
                    div()
                        .w_full()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(14.0))
                                .text_color(colors.text)
                                .font_weight(FontWeight::MEDIUM)
                                .child(name)
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .text_size(px(14.0))
                                        .text_color(bar_color)
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(current_str)
                                )
                                .child(
                                    div()
                                        .text_size(px(13.0))
                                        .text_color(colors.text_muted)
                                        .child("/")
                                )
                                .child(
                                    div()
                                        .text_size(px(13.0))
                                        .text_color(colors.text_secondary)
                                        .child(target_str)
                                )
                        )
                )
                .child(
                    div()
                        .w_full()
                        .h(px(6.0))
                        .rounded(theme.border_radius_full)
                        .bg(colors.surface_elevated)
                        .child(
                            div()
                                .h_full()
                                .w(px(progress.min(100.0) * 2.0))
                                .rounded(theme.border_radius_full)
                                .bg(bar_color)
                        )
                )
        }).collect();

        let count = spec_metrics.len();

        render_detail_card(cx, "Metrics", Some(format!("{} metric{}", count, if count != 1 { "s" } else { "" })),
            if metric_items.is_empty() {
                div()
                    .p(px(20.0))
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(colors.text_muted)
                            .child("No metrics configured")
                    )
                    .into_any_element()
            } else {
                div().flex().flex_col().children(metric_items).into_any_element()
            }
        )
    }

    fn render_conditions_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let conditions = resource.status.as_ref()
            .and_then(|s| s.get("conditions"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let condition_items: Vec<Div> = conditions.iter().enumerate().map(|(idx, cond)| {
            let cond_type = cond.get("type").and_then(|v| v.as_str()).unwrap_or("-");
            let status = cond.get("status").and_then(|v| v.as_str()).unwrap_or("-");
            let reason = cond.get("reason").and_then(|v| v.as_str()).unwrap_or("-");
            let message = cond.get("message").and_then(|v| v.as_str()).unwrap_or("");

            let is_last = idx == conditions.len() - 1;
            let (icon, icon_color) = if status == "True" {
                (IconName::Check, colors.success)
            } else {
                (IconName::Warning, colors.warning)
            };

            let mut row = div()
                .w_full()
                .px(px(20.0))
                .py(px(14.0));

            if !is_last {
                row = row.border_b_1().border_color(colors.border);
            }

            row
                .flex()
                .gap(px(12.0))
                .child(
                    div()
                        .size(px(28.0))
                        .rounded_full()
                        .bg(icon_color.opacity(0.12))
                        .flex()
                        .items_center()
                        .justify_center()
                        .flex_shrink_0()
                        .child(Icon::new(icon).size(px(14.0)).color(icon_color))
                )
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.0))
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .text_size(px(13.0))
                                        .text_color(colors.text)
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(cond_type.to_string())
                                )
                                .child(
                                    div()
                                        .px(px(6.0))
                                        .py(px(2.0))
                                        .rounded(theme.border_radius)
                                        .bg(icon_color.opacity(0.12))
                                        .text_size(px(10.0))
                                        .text_color(icon_color)
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(reason.to_string())
                                )
                        )
                        .when(!message.is_empty(), |el| {
                            el.child(
                                div()
                                    .text_size(px(12.0))
                                    .text_color(colors.text_secondary)
                                    .child(message.to_string())
                            )
                        })
                )
        }).collect();

        let count = conditions.len();

        render_detail_card(cx, "Conditions", Some(format!("{}", count)),
            if condition_items.is_empty() {
                div()
                    .p(px(20.0))
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(colors.text_muted)
                            .child("No conditions")
                    )
                    .into_any_element()
            } else {
                div().flex().flex_col().children(condition_items).into_any_element()
            }
        )
    }
}

// Helper functions
fn get_json_u64(value: &Option<serde_json::Value>, path: &[&str]) -> Option<u64> {
    let mut current = value.as_ref()?;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_u64()
}

fn render_stat_box(cx: &App, label: &str, value: String, color: Hsla) -> Div {
    let theme = theme(cx);
    let colors = &theme.colors;

    div()
        .flex_1()
        .p(px(16.0))
        .rounded(theme.border_radius_md)
        .bg(colors.surface_elevated)
        .flex()
        .flex_col()
        .items_center()
        .gap(px(4.0))
        .child(
            div()
                .text_size(px(24.0))
                .text_color(color)
                .font_weight(FontWeight::BOLD)
                .child(value)
        )
        .child(
            div()
                .text_size(px(11.0))
                .text_color(colors.text_muted)
                .child(label.to_string())
        )
}
