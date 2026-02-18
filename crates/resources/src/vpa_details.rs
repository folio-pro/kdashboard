use crate::detail_shared::*;
use crate::detail_tabs::{DetailTab, EditorSubTab};
use editor::YamlEditor;
use gpui::prelude::FluentBuilder;
use gpui::*;
use k8s_client::Resource;
use ui::{back_btn, danger_btn, theme, Icon, IconName};

/// Actions that can be triggered from VpaDetails
#[derive(Clone, Debug)]
pub enum VpaAction {
    Delete { name: String, namespace: String },
}

pub struct VpaDetails {
    resource: Resource,
    scroll_handle: ScrollHandle,
    on_close: Option<Box<dyn Fn(&mut Context<'_, Self>) + 'static>>,
    on_action: Option<Box<dyn Fn(VpaAction, &mut Context<'_, Self>) + 'static>>,
    active_tab: DetailTab,
    editor_sub_tab: EditorSubTab,
    yaml_editor: Option<Entity<YamlEditor>>,
    original_yaml: String,
    yaml_valid: Option<bool>,
}

impl VpaDetails {
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
        if resource.metadata.resource_version != self.resource.metadata.resource_version {
            self.yaml_editor = None;
            self.original_yaml.clear();
            self.yaml_valid = None;
            self.editor_sub_tab = EditorSubTab::Editor;
        }
        self.resource = resource;
    }

    pub fn on_close(mut self, handler: impl Fn(&mut Context<'_, Self>) + 'static) -> Self {
        self.on_close = Some(Box::new(handler));
        self
    }

    pub fn on_action(
        mut self,
        handler: impl Fn(VpaAction, &mut Context<'_, Self>) + 'static,
    ) -> Self {
        self.on_action = Some(Box::new(handler));
        self
    }
}

impl Render for VpaDetails {
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
                    .id("vpa-details-content")
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll_handle)
                    .p(px(24.0))
                    .child(self.render_content(cx)),
            )
            .into_any_element()
    }
}

impl VpaDetails {
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
                back_btn("vpa-details-back-btn", colors).on_click(cx.listener(
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
                    .id("bc-vpa")
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
                    .child("VPA"),
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

        let update_mode = get_json_str(&resource.spec, &["updatePolicy", "updateMode"])
            .unwrap_or_else(|| "Auto".to_string());

        let has_recommendation = resource
            .status
            .as_ref()
            .and_then(|s| s.get("recommendation"))
            .and_then(|r| r.get("containerRecommendations"))
            .and_then(|c| c.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);

        let status_text = if has_recommendation {
            "Recommendations Ready"
        } else {
            "Collecting Data"
        };
        let (status_color, status_bg) = if has_recommendation {
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
                                            .child(format!("Mode: {}", update_mode)),
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
                                    let action = VpaAction::Delete {
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
                    .child(self.render_recommendations_card(cx, resource))
                    .child(self.render_container_policies_card(cx, resource)),
            )
            .child(
                div()
                    .w(px(500.0))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .gap(px(24.0))
                    .child(self.render_update_policy_card(cx, resource))
                    .child(self.render_conditions_card(cx, resource))
                    .child(render_detail_labels_card(cx, resource)),
            )
    }

    fn render_info_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let colors = &theme(cx).colors;

        let name = resource.metadata.name.clone();
        let namespace = resource
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());

        let target_kind =
            get_json_str(&resource.spec, &["targetRef", "kind"]).unwrap_or_else(|| "-".to_string());
        let target_name =
            get_json_str(&resource.spec, &["targetRef", "name"]).unwrap_or_else(|| "-".to_string());
        let target_ref = format!("{}/{}", target_kind, target_name);

        let created = resource
            .metadata
            .creation_timestamp
            .clone()
            .unwrap_or_else(|| "-".to_string());

        let rows: Vec<(&str, String, Option<Hsla>)> = vec![
            ("Name", name, None),
            ("Namespace", namespace, Some(colors.primary)),
            ("Target", target_ref, None),
            ("API Version", resource.api_version.clone(), None),
            ("Created", format_timestamp(&created), None),
        ];

        let row_items = render_detail_info_rows(colors, rows);

        render_detail_card(
            cx,
            "VPA Information",
            None,
            div().flex().flex_col().children(row_items),
        )
    }

    fn render_update_policy_card(
        &self,
        cx: &Context<'_, Self>,
        resource: &Resource,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let update_mode = get_json_str(&resource.spec, &["updatePolicy", "updateMode"])
            .unwrap_or_else(|| "Auto".to_string());

        let (mode_color, mode_description) = match update_mode.as_str() {
            "Off" => (
                colors.text_muted,
                "VPA will only provide recommendations but will NOT automatically update pods",
            ),
            "Initial" => (
                colors.warning,
                "VPA will only apply recommendations at pod creation time",
            ),
            "Recreate" => (
                colors.primary,
                "VPA will apply recommendations by evicting and recreating pods",
            ),
            "Auto" => (
                colors.success,
                "VPA will automatically apply recommendations (may evict pods)",
            ),
            _ => (colors.text_secondary, "Unknown update mode"),
        };

        render_detail_card(
            cx,
            "Update Policy",
            None,
            div()
                .p(px(20.0))
                .flex()
                .flex_col()
                .gap(px(16.0))
                .child(
                    div().w_full().flex().items_center().gap(px(12.0)).child(
                        div()
                            .px(px(12.0))
                            .py(px(6.0))
                            .rounded(theme.border_radius_md)
                            .bg(mode_color.opacity(0.12))
                            .text_size(px(14.0))
                            .text_color(mode_color)
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(update_mode),
                    ),
                )
                .child(
                    div()
                        .text_size(px(13.0))
                        .text_color(colors.text_secondary)
                        .child(mode_description.to_string()),
                ),
        )
    }

    fn render_recommendations_card(
        &self,
        cx: &Context<'_, Self>,
        resource: &Resource,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let containers = resource
            .status
            .as_ref()
            .and_then(|s| s.get("recommendation"))
            .and_then(|r| r.get("containerRecommendations"))
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();

        let container_items: Vec<Div> = containers
            .iter()
            .enumerate()
            .map(|(idx, container)| {
                let name = container
                    .get("containerName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");

                let target_cpu = container
                    .get("target")
                    .and_then(|t| t.get("cpu"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("-");
                let target_mem = container
                    .get("target")
                    .and_then(|t| t.get("memory"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("-");

                let lower_cpu = container
                    .get("lowerBound")
                    .and_then(|t| t.get("cpu"))
                    .and_then(|c| c.as_str());
                let lower_mem = container
                    .get("lowerBound")
                    .and_then(|t| t.get("memory"))
                    .and_then(|m| m.as_str());

                let upper_cpu = container
                    .get("upperBound")
                    .and_then(|t| t.get("cpu"))
                    .and_then(|c| c.as_str());
                let upper_mem = container
                    .get("upperBound")
                    .and_then(|t| t.get("memory"))
                    .and_then(|m| m.as_str());

                let uncapped_cpu = container
                    .get("uncappedTarget")
                    .and_then(|t| t.get("cpu"))
                    .and_then(|c| c.as_str());
                let uncapped_mem = container
                    .get("uncappedTarget")
                    .and_then(|t| t.get("memory"))
                    .and_then(|m| m.as_str());

                let is_last = idx == containers.len() - 1;

                let mut row = div().w_full().p(px(20.0));

                if !is_last {
                    row = row.border_b_1().border_color(colors.border);
                }

                row.flex()
                    .flex_col()
                    .gap(px(16.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.0))
                            .child(
                                div()
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
                                    .text_size(px(14.0))
                                    .text_color(colors.text)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(name.to_string()),
                            ),
                    )
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .gap(px(16.0))
                            .child(render_recommendation_box(
                                cx,
                                "CPU",
                                target_cpu,
                                lower_cpu,
                                upper_cpu,
                                uncapped_cpu,
                            ))
                            .child(render_recommendation_box(
                                cx,
                                "Memory",
                                target_mem,
                                lower_mem,
                                upper_mem,
                                uncapped_mem,
                            )),
                    )
            })
            .collect();

        let count = containers.len();

        render_detail_card(
            cx,
            "Recommendations",
            Some(format!(
                "{} container{}",
                count,
                if count != 1 { "s" } else { "" }
            )),
            if container_items.is_empty() {
                div()
                    .p(px(20.0))
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(colors.text_muted)
                            .child("No recommendations available yet")
                    )
                    .child(
                        div()
                            .text_size(px(12.0))
                            .text_color(colors.text_muted)
                            .child("VPA is collecting metrics. Recommendations will appear here once enough data is gathered.")
                    )
                    .into_any_element()
            } else {
                div()
                    .flex()
                    .flex_col()
                    .children(container_items)
                    .into_any_element()
            },
        )
    }

    fn render_container_policies_card(
        &self,
        cx: &Context<'_, Self>,
        resource: &Resource,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let policies = resource
            .spec
            .as_ref()
            .and_then(|s| s.get("resourcePolicy"))
            .and_then(|r| r.get("containerPolicies"))
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();

        let policy_items: Vec<Div> = policies
            .iter()
            .enumerate()
            .map(|(idx, policy)| {
                let name = policy
                    .get("containerName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("*");

                let mode = policy
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Auto");

                let min_cpu = policy
                    .get("minAllowed")
                    .and_then(|m| m.get("cpu"))
                    .and_then(|c| c.as_str());
                let min_mem = policy
                    .get("minAllowed")
                    .and_then(|m| m.get("memory"))
                    .and_then(|c| c.as_str());

                let max_cpu = policy
                    .get("maxAllowed")
                    .and_then(|m| m.get("cpu"))
                    .and_then(|c| c.as_str());
                let max_mem = policy
                    .get("maxAllowed")
                    .and_then(|m| m.get("memory"))
                    .and_then(|c| c.as_str());

                let controlled = policy
                    .get("controlledResources")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_else(|| "cpu, memory".to_string());

                let is_last = idx == policies.len() - 1;

                let mut row = div().w_full().p(px(16.0));

                if !is_last {
                    row = row.border_b_1().border_color(colors.border);
                }

                row.flex()
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
                                    .child(if name == "*" {
                                        "All Containers".to_string()
                                    } else {
                                        name.to_string()
                                    }),
                            )
                            .child(
                                div()
                                    .px(px(8.0))
                                    .py(px(2.0))
                                    .rounded(theme.border_radius)
                                    .bg(colors.primary.opacity(0.12))
                                    .text_size(px(11.0))
                                    .text_color(colors.primary)
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(mode.to_string()),
                            ),
                    )
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .gap(px(24.0))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.0))
                                    .child(
                                        div()
                                            .text_size(px(11.0))
                                            .text_color(colors.text_muted)
                                            .child("Min Allowed"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.0))
                                            .text_color(colors.text_secondary)
                                            .child(format!(
                                                "CPU: {}, Mem: {}",
                                                min_cpu.unwrap_or("-"),
                                                min_mem.unwrap_or("-")
                                            )),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.0))
                                    .child(
                                        div()
                                            .text_size(px(11.0))
                                            .text_color(colors.text_muted)
                                            .child("Max Allowed"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.0))
                                            .text_color(colors.text_secondary)
                                            .child(format!(
                                                "CPU: {}, Mem: {}",
                                                max_cpu.unwrap_or("-"),
                                                max_mem.unwrap_or("-")
                                            )),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .text_color(colors.text_muted)
                            .child(format!("Controlled: {}", controlled)),
                    )
            })
            .collect();

        let count = policies.len();

        render_detail_card(
            cx,
            "Container Policies",
            Some(format!("{}", count)),
            if policy_items.is_empty() {
                div()
                    .p(px(20.0))
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(colors.text_muted)
                            .child("No container policies configured (using defaults)"),
                    )
                    .into_any_element()
            } else {
                div()
                    .flex()
                    .flex_col()
                    .children(policy_items)
                    .into_any_element()
            },
        )
    }

    fn render_conditions_card(
        &self,
        cx: &Context<'_, Self>,
        resource: &Resource,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let conditions = resource
            .status
            .as_ref()
            .and_then(|s| s.get("conditions"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let condition_items: Vec<Div> = conditions
            .iter()
            .enumerate()
            .map(|(idx, cond)| {
                let cond_type = cond.get("type").and_then(|v| v.as_str()).unwrap_or("-");
                let status = cond.get("status").and_then(|v| v.as_str()).unwrap_or("-");
                let reason = cond.get("reason").and_then(|v| v.as_str());
                let message = cond.get("message").and_then(|v| v.as_str()).unwrap_or("");

                let is_last = idx == conditions.len() - 1;
                let (icon, icon_color) = if status == "True" {
                    (IconName::Check, colors.success)
                } else {
                    (IconName::Warning, colors.warning)
                };

                let mut row = div().w_full().px(px(20.0)).py(px(14.0));

                if !is_last {
                    row = row.border_b_1().border_color(colors.border);
                }

                row.flex()
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
                            .child(Icon::new(icon).size(px(14.0)).color(icon_color)),
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
                                            .child(cond_type.to_string()),
                                    )
                                    .when_some(reason, |el, r| {
                                        el.child(
                                            div()
                                                .px(px(6.0))
                                                .py(px(2.0))
                                                .rounded(theme.border_radius)
                                                .bg(icon_color.opacity(0.12))
                                                .text_size(px(10.0))
                                                .text_color(icon_color)
                                                .font_weight(FontWeight::MEDIUM)
                                                .child(r.to_string()),
                                        )
                                    }),
                            )
                            .when(!message.is_empty(), |el| {
                                el.child(
                                    div()
                                        .text_size(px(12.0))
                                        .text_color(colors.text_secondary)
                                        .child(message.to_string()),
                                )
                            }),
                    )
            })
            .collect();

        let count = conditions.len();

        render_detail_card(
            cx,
            "Conditions",
            Some(format!("{}", count)),
            if condition_items.is_empty() {
                div()
                    .p(px(20.0))
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(colors.text_muted)
                            .child("No conditions"),
                    )
                    .into_any_element()
            } else {
                div()
                    .flex()
                    .flex_col()
                    .children(condition_items)
                    .into_any_element()
            },
        )
    }
}

fn render_recommendation_box(
    cx: &App,
    label: &str,
    target: &str,
    lower: Option<&str>,
    upper: Option<&str>,
    uncapped: Option<&str>,
) -> Div {
    let theme = theme(cx);
    let colors = &theme.colors;

    let range = match (lower, upper) {
        (Some(l), Some(u)) => format!("{} - {}", format_resource(l), format_resource(u)),
        _ => "-".to_string(),
    };

    div()
        .flex_1()
        .p(px(16.0))
        .rounded(theme.border_radius_md)
        .bg(colors.surface_elevated)
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(
            div()
                .text_size(px(11.0))
                .text_color(colors.text_muted)
                .font_weight(FontWeight::SEMIBOLD)
                .child(label.to_string()),
        )
        .child(
            div().flex().items_end().gap(px(4.0)).child(
                div()
                    .text_size(px(24.0))
                    .text_color(colors.primary)
                    .font_weight(FontWeight::BOLD)
                    .child(format_resource(target)),
            ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(colors.text_muted)
                        .child(format!("Range: {}", range)),
                )
                .when_some(uncapped, |el, u| {
                    el.child(
                        div()
                            .text_size(px(11.0))
                            .text_color(colors.text_muted)
                            .child(format!("Uncapped: {}", format_resource(u))),
                    )
                }),
        )
}

fn format_resource(value: &str) -> String {
    // Handle memory values
    if value.ends_with("Ki") {
        let num: f64 = value.trim_end_matches("Ki").parse().unwrap_or(0.0);
        if num >= 1024.0 * 1024.0 {
            return format!("{:.1}Gi", num / 1024.0 / 1024.0);
        } else if num >= 1024.0 {
            return format!("{:.0}Mi", num / 1024.0);
        }
        return format!("{:.0}Ki", num);
    }
    if value.ends_with("Mi") {
        let num: f64 = value.trim_end_matches("Mi").parse().unwrap_or(0.0);
        if num >= 1024.0 {
            return format!("{:.1}Gi", num / 1024.0);
        }
        return format!("{:.0}Mi", num);
    }
    if value.ends_with("Gi") {
        return value.to_string();
    }

    // Handle CPU values (millicores)
    if value.ends_with('m') {
        let millis: f64 = value.trim_end_matches('m').parse().unwrap_or(0.0);
        if millis >= 1000.0 {
            return format!("{:.1}", millis / 1000.0);
        }
        return format!("{}m", millis as u64);
    }

    // Plain number (CPU cores)
    if let Ok(cores) = value.parse::<f64>() {
        if cores < 1.0 {
            return format!("{}m", (cores * 1000.0) as u64);
        }
        return format!("{:.1}", cores);
    }

    value.to_string()
}
