use gpui::*;
use gpui::prelude::FluentBuilder;
use k8s_client::Resource;
use ui::{theme, Icon, IconName};
use editor::YamlEditor;
use crate::detail_tabs::{DetailTab, EditorSubTab};
use crate::pod_details::compute_diff;

// Pencil mockup colors
const ED_BG: u32 = 0x0A0F1C;
const ED_TOOLBAR_BG: u32 = 0x0F172A;
const ED_CARD_BG: u32 = 0x1E293B;
const ED_BORDER: u32 = 0x334155;
const ED_ACCENT: u32 = 0x22D3EE;
const ED_TEXT: u32 = 0xFFFFFF;
const ED_TEXT_SECONDARY: u32 = 0x94A3B8;
const ED_TEXT_MUTED: u32 = 0x64748B;
const ED_SUCCESS: u32 = 0x22C55E;
use crate::pod_details::{format_relative_time, format_timestamp, get_json_array, get_json_str, parse_resource_value};

/// Actions that can be triggered from DeploymentDetails
#[derive(Clone, Debug)]
pub enum DeploymentAction {
    Delete { name: String, namespace: String },
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

    pub fn on_action(mut self, handler: impl Fn(DeploymentAction, &mut Context<'_, Self>) + 'static) -> Self {
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
                    .child(self.render_header(cx))
            )
            .child(
                div()
                    .id("deployment-details-content")
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll_handle)
                    .p(px(24.0))
                    .child(self.render_content(cx))
            )
            .into_any_element()
    }
}

impl DeploymentDetails {
    fn render_edit_button(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div()
            .id("edit-yaml-btn")
            .px(px(16.0))
            .py(px(10.0))
            .rounded(px(6.0))
            .bg(colors.surface)
            .border_1()
            .border_color(colors.border)
            .cursor_pointer()
            .hover(|s| s.opacity(0.8))
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(Icon::new(IconName::Edit).size(px(16.0)).color(colors.text_secondary))
            .child(
                div().text_size(px(13.0)).text_color(colors.text).font_weight(FontWeight::SEMIBOLD).child("Edit YAML")
            )
            .on_click(cx.listener(|this, _event, _window, cx| {
                this.active_tab = DetailTab::Yaml;
                cx.notify();
            }))
    }

    fn render_yaml_view(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if self.yaml_editor.is_none() {
            let yaml = editor::resource_to_yaml(&self.resource).unwrap_or_else(|e| format!("# Error serializing resource: {}", e));
            self.original_yaml = yaml.clone();
            let editor_entity = cx.new(|_cx| YamlEditor::new(yaml));
            self.yaml_editor = Some(editor_entity);
        }

        let valid_badge: Option<(&str, Hsla)> = match self.yaml_valid {
            Some(true) => Some(("Valid YAML", Hsla::from(rgb(ED_SUCCESS)))),
            Some(false) => Some(("Invalid YAML", Hsla::from(rgb(0xEF4444)))),
            None => None,
        };
        let filename = format!("{}.yaml", self.resource.kind.to_lowercase());
        let subtitle = format!("{} · {}", self.resource.metadata.name, self.resource.kind);

        div()
            .size_full().flex().flex_col().bg(rgb(ED_BG))
            .child(
                div().w_full().flex().items_center().justify_between().px(px(24.0)).py(px(16.0)).border_b_1().border_color(rgb(ED_BORDER))
                    .child(
                        div().flex().items_center().gap(px(16.0))
                            .child(
                                div().id("yaml-back-btn").size(px(40.0)).rounded(px(8.0)).bg(rgb(ED_CARD_BG)).border_1().border_color(rgb(ED_BORDER))
                                    .cursor_pointer().hover(|s| s.opacity(0.8)).flex().items_center().justify_center()
                                    .child(Icon::new(IconName::ArrowLeft).size(px(18.0)).color(rgb(ED_TEXT_SECONDARY).into()))
                                    .on_click(cx.listener(|this, _event, _window, cx| { this.active_tab = DetailTab::Overview; this.editor_sub_tab = EditorSubTab::Editor; cx.notify(); }))
                            )
                            .child(
                                div().flex().flex_col().gap(px(4.0))
                                    .child(div().text_size(px(24.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::BOLD).child(filename))
                                    .child(div().text_size(px(14.0)).text_color(rgb(ED_TEXT_MUTED)).child(subtitle))
                            )
                    )
                    .child(
                        div().flex().items_center().gap(px(12.0))
                            .child(
                                div().id("validate-btn").px(px(16.0)).py(px(10.0)).rounded(px(6.0)).bg(rgb(ED_CARD_BG)).border_1().border_color(rgb(ED_BORDER))
                                    .cursor_pointer().hover(|s| s.opacity(0.8)).flex().items_center().gap(px(8.0))
                                    .child(Icon::new(IconName::Check).size(px(16.0)).color(rgb(ED_TEXT_SECONDARY).into()))
                                    .child(div().text_size(px(13.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::SEMIBOLD).child("Validate"))
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        if let Some(editor) = &this.yaml_editor {
                                            let content = editor.read(cx).input_entity().map(|i| i.read(cx).text().to_string()).unwrap_or_default();
                                            this.yaml_valid = Some(editor::validate_yaml(&content));
                                        }
                                        cx.notify();
                                    }))
                            )
                            .child(
                                div().id("apply-btn").px(px(16.0)).py(px(10.0)).rounded(px(6.0)).bg(rgb(ED_ACCENT))
                                    .cursor_pointer().hover(|s| s.opacity(0.9)).flex().items_center().gap(px(8.0))
                                    .child(div().text_size(px(13.0)).text_color(rgb(ED_BG)).font_weight(FontWeight::SEMIBOLD).child("Apply"))
                            )
                    )
            )
            .child(self.render_editor_tabs(cx))
            .child(self.render_editor_content(cx))
            .child(
                div().w_full().h(px(36.0)).flex_shrink_0().px(px(20.0)).flex().items_center().justify_between()
                    .bg(rgb(ED_CARD_BG)).border_t_1().border_color(rgb(ED_BORDER))
                    .child(
                        div().flex().items_center()
                            .when_some(valid_badge, |el: Div, (text, color)| {
                                el.child(
                                    div().px(px(10.0)).py(px(4.0)).rounded(px(100.0)).bg(color.opacity(0.12))
                                        .flex().items_center().gap(px(6.0))
                                        .child(div().size(px(6.0)).rounded_full().bg(color))
                                        .child(div().text_size(px(12.0)).text_color(color).font_weight(FontWeight::MEDIUM).child(text))
                                )
                            })
                    )
                    .child(
                        div().flex().items_center().gap(px(24.0))
                            .child(div().text_size(px(12.0)).text_color(rgb(ED_TEXT_MUTED)).child(format!("Kind: {}", self.resource.kind)))
                            .child(div().text_size(px(12.0)).text_color(rgb(ED_TEXT_MUTED)).child(format!("API: {}", self.resource.api_version)))
                    )
            )
    }

    fn render_editor_tabs(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let current = self.editor_sub_tab;
        let tabs: [(&str, EditorSubTab); 3] = [("Editor", EditorSubTab::Editor), ("Diff", EditorSubTab::Diff), ("History", EditorSubTab::History)];
        let tab_items: Vec<AnyElement> = tabs.iter().map(|(label, tab)| {
            let active = *tab == current;
            let tab_val = *tab;
            let mut el = div().id(ElementId::Name((*label).into())).px(px(16.0)).py(px(10.0)).cursor_pointer().flex().items_center().gap(px(8.0));
            if active {
                el = el.border_b_2().border_color(rgb(ED_ACCENT));
                el.child(div().text_size(px(14.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::SEMIBOLD).child(*label))
                    .on_click(cx.listener(move |this, _e, _w, cx| { this.editor_sub_tab = tab_val; cx.notify(); })).into_any_element()
            } else {
                el.hover(|s| s.opacity(0.8))
                    .child(div().text_size(px(14.0)).text_color(rgb(ED_TEXT_MUTED)).font_weight(FontWeight::MEDIUM).child(*label))
                    .on_click(cx.listener(move |this, _e, _w, cx| { this.editor_sub_tab = tab_val; cx.notify(); })).into_any_element()
            }
        }).collect();
        div().w_full().px(px(24.0)).border_b_1().border_color(rgb(ED_BORDER)).bg(rgb(ED_BG)).flex().items_center().children(tab_items)
    }

    fn render_editor_content(&self, cx: &Context<'_, Self>) -> AnyElement {
        match self.editor_sub_tab {
            EditorSubTab::Editor => {
                div().flex_1().p(px(24.0)).min_h(px(0.0))
                    .child(
                        div().size_full().rounded(px(12.0)).border_1().border_color(rgb(ED_BORDER)).bg(rgb(ED_CARD_BG)).overflow_hidden().flex().flex_col()
                            .child(div().w_full().px(px(20.0)).py(px(16.0)).border_b_1().border_color(rgb(ED_BORDER)).flex().items_center()
                                .child(div().text_size(px(15.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::SEMIBOLD).child("YAML Configuration")))
                            .child(self.yaml_editor.as_ref().unwrap().clone())
                    ).into_any_element()
            }
            EditorSubTab::Diff => {
                let current_yaml = self.yaml_editor.as_ref()
                    .and_then(|e| e.read(cx).input_entity().map(|i| i.read(cx).text().to_string())).unwrap_or_default();
                let diff_lines = compute_diff(&self.original_yaml, &current_yaml);
                div().flex_1().p(px(24.0)).min_h(px(0.0))
                    .child(
                        div().size_full().rounded(px(12.0)).border_1().border_color(rgb(ED_BORDER)).bg(rgb(ED_CARD_BG)).overflow_hidden().flex().flex_col()
                            .child(div().w_full().px(px(20.0)).py(px(16.0)).border_b_1().border_color(rgb(ED_BORDER)).flex().items_center()
                                .child(div().text_size(px(15.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::SEMIBOLD).child("Changes")))
                            .child(div().id("diff-scroll").flex_1().overflow_y_scroll().p(px(16.0)).children(diff_lines))
                    ).into_any_element()
            }
            EditorSubTab::History => {
                div().flex_1().p(px(24.0)).min_h(px(0.0))
                    .child(
                        div().size_full().rounded(px(12.0)).border_1().border_color(rgb(ED_BORDER)).bg(rgb(ED_CARD_BG)).overflow_hidden().flex().flex_col()
                            .child(div().w_full().px(px(20.0)).py(px(16.0)).border_b_1().border_color(rgb(ED_BORDER)).flex().items_center()
                                .child(div().text_size(px(15.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::SEMIBOLD).child("Original YAML")))
                            .child(div().id("history-scroll").flex_1().overflow_y_scroll().p(px(16.0))
                                .child(div().text_size(px(13.0)).text_color(rgb(ED_TEXT_SECONDARY)).whitespace_nowrap().child(self.original_yaml.clone())))
                    ).into_any_element()
            }
        }
    }

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
                    .child("Deployments")
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

        let desired = resource.spec.as_ref()
            .and_then(|s| s.get("replicas"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let available = resource.status.as_ref()
            .and_then(|s| s.get("availableReplicas"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let replicas_text = format!("{}/{} replicas", available, desired);

        let is_available = available == desired && desired > 0;
        let status_text = if is_available { "Running" } else { "Updating" };
        let (status_color, status_bg) = if is_available {
            (colors.success, colors.success.opacity(0.08))
        } else {
            (colors.warning, colors.warning.opacity(0.08))
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
                            .rounded(px(8.0))
                            .bg(colors.surface)
                            .border_1()
                            .border_color(colors.border)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                Icon::new(IconName::Layers)
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
                            .rounded(px(100.0))
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
                        div()
                            .id("delete-btn")
                            .px(px(16.0))
                            .py(px(10.0))
                            .rounded(px(6.0))
                            .bg(colors.error)
                            .cursor_pointer()
                            .hover(|s| s.opacity(0.9))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                Icon::new(IconName::Trash)
                                    .size(px(16.0))
                                    .color(colors.text)
                            )
                            .child(
                                div()
                                    .text_size(px(13.0))
                                    .text_color(colors.text)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Delete")
                            )
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                if let Some(on_action) = &this.on_action {
                                    let action = DeploymentAction::Delete {
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
                    .child(self.render_replicas_card(cx, resource))
                    .child(self.render_labels_card(cx, resource))
            )
            .child(
                div()
                    .w(px(400.0))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .gap(px(24.0))
                    .child(self.render_events_card(cx, resource))
            )
    }

    fn render_info_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let name = resource.metadata.name.clone();
        let namespace = resource.metadata.namespace.clone().unwrap_or_else(|| "default".to_string());

        let desired = resource.spec.as_ref()
            .and_then(|s| s.get("replicas"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let available = resource.status.as_ref()
            .and_then(|s| s.get("availableReplicas"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let replicas_text = format!("{} / {}", available, desired);

        let strategy = get_json_str(&resource.spec, &["strategy", "type"])
            .unwrap_or_else(|| "RollingUpdate".to_string());

        let created = resource.metadata.creation_timestamp.clone().unwrap_or_else(|| "-".to_string());

        let revision = resource.status.as_ref()
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

        let total = rows.len();
        let row_items: Vec<Div> = rows.into_iter().enumerate().map(|(idx, (label, value, value_color))| {
            let is_last = idx == total - 1;
            let mut row = div()
                .w_full()
                .flex()
                .items_center()
                .px(px(20.0))
                .py(px(12.0));

            if !is_last {
                row = row.border_b_1().border_color(colors.border);
            }

            row
                .child(
                    div()
                        .w(px(140.0))
                        .flex_shrink_0()
                        .text_size(px(13.0))
                        .text_color(colors.text_secondary)
                        .child(label.to_string())
                )
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.0))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_size(px(13.0))
                        .text_color(value_color.unwrap_or(colors.text))
                        .child(value)
                )
        }).collect();

        self.render_card(cx, "Deployment Information", None,
            div().flex().flex_col().children(row_items)
        )
    }

    fn render_replicas_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let containers = get_json_array(&resource.spec, &["template", "spec", "containers"]).unwrap_or_default();
        let available = resource.status.as_ref()
            .and_then(|s| s.get("availableReplicas"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let count_text = format!("{} running", available);

        let container_items: Vec<Div> = containers.iter().enumerate().map(|(idx, container)| {
            let name = container.get("name").and_then(|v| v.as_str()).unwrap_or("-").to_string();
            let image = container.get("image").and_then(|v| v.as_str()).unwrap_or("-").to_string();

            let cpu_request = container.get("resources")
                .and_then(|r| r.get("requests"))
                .and_then(|r| r.get("cpu"))
                .and_then(|v| v.as_str())
                .unwrap_or("-")
                .to_string();
            let cpu_limit = container.get("resources")
                .and_then(|r| r.get("limits"))
                .and_then(|r| r.get("cpu"))
                .and_then(|v| v.as_str())
                .map(|s| format!("/ {} limit", s));
            let mem_request = container.get("resources")
                .and_then(|r| r.get("requests"))
                .and_then(|r| r.get("memory"))
                .and_then(|v| v.as_str())
                .unwrap_or("-")
                .to_string();
            let mem_limit = container.get("resources")
                .and_then(|r| r.get("limits"))
                .and_then(|r| r.get("memory"))
                .and_then(|v| v.as_str())
                .map(|s| format!("/ {} limit", s));

            let (cpu_num, cpu_unit) = parse_resource_value(&cpu_request);
            let (mem_num, mem_unit) = parse_resource_value(&mem_request);

            let is_running = available > 0;
            let status_color = if is_running { colors.success } else { colors.warning };
            let state_text = if is_running { "Running" } else { "Updating" };

            div()
                .w_full()
                .p(px(20.0))
                .when(idx > 0, |el: Div| el.border_t_1().border_color(colors.border))
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
                                        .rounded(px(6.0))
                                        .bg(colors.primary)
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .child(
                                            Icon::new(IconName::Box)
                                                .size(px(18.0))
                                                .color(colors.background)
                                        )
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
                                                .child(name)
                                        )
                                        .child(
                                            div()
                                                .overflow_hidden()
                                                .whitespace_nowrap()
                                                .text_ellipsis()
                                                .text_size(px(12.0))
                                                .text_color(colors.text_secondary)
                                                .child(image)
                                        )
                                )
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .px(px(10.0))
                                .py(px(4.0))
                                .rounded(px(100.0))
                                .bg(status_color.opacity(0.08))
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
                                        .child(state_text.to_string())
                                )
                        )
                )
                .child(
                    div()
                        .w_full()
                        .flex()
                        .gap(px(16.0))
                        .child(self.render_resource_stat(cx, "CPU", &cpu_num, &cpu_unit, cpu_limit.as_deref()))
                        .child(self.render_resource_stat(cx, "MEMORY", &mem_num, &mem_unit, mem_limit.as_deref()))
                )
        }).collect();

        self.render_card(cx, "Replicas", Some(count_text),
            div().flex().flex_col().children(container_items)
        )
    }

    fn render_resource_stat(
        &self,
        cx: &Context<'_, Self>,
        label: &str,
        value: &str,
        unit: &str,
        limit: Option<&str>,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let mut card = div()
            .flex_1()
            .p(px(16.0))
            .rounded(px(8.0))
            .bg(colors.surface_elevated)
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .text_size(px(11.0))
                    .text_color(colors.text_muted)
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(label.to_string())
            )
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(px(24.0))
                            .text_color(colors.text)
                            .font_weight(FontWeight::BOLD)
                            .child(value.to_string())
                    )
                    .child(
                        div()
                            .text_size(px(14.0))
                            .text_color(colors.text_muted)
                            .child(unit.to_string())
                    )
            );

        if let Some(limit_text) = limit {
            card = card.child(
                div()
                    .text_size(px(11.0))
                    .text_color(colors.text_muted)
                    .child(limit_text.to_string())
            );
        }

        card
    }

    fn render_labels_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let labels: Vec<(String, String)> = resource.metadata.labels
            .as_ref()
            .map(|l| l.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();

        let count = labels.len();

        let label_badges: Vec<Div> = labels.iter().map(|(k, v)| {
            div()
                .px(px(12.0))
                .py(px(6.0))
                .rounded(px(6.0))
                .bg(colors.surface_elevated)
                .flex()
                .items_center()
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(colors.text_secondary)
                        .child(format!("{}={}", k, v))
                )
        }).collect();

        self.render_card(cx, "Labels", Some(format!("{} label{}", count, if count != 1 { "s" } else { "" })),
            div()
                .p(px(20.0))
                .flex()
                .flex_wrap()
                .gap(px(8.0))
                .children(label_badges)
        )
    }

    fn render_events_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let events = derive_deployment_events(resource);
        let count = events.len();
        let total = events.len();

        let event_items: Vec<Div> = events.into_iter().enumerate().map(|(idx, event)| {
            let is_last = idx == total - 1;

            let (icon_color, icon_bg, icon_name) = match event.event_type {
                EventType::Success => (colors.success, colors.success.opacity(0.12), IconName::Check),
                EventType::Info => (colors.primary, colors.primary.opacity(0.12), IconName::Download),
                EventType::Warning => (colors.warning, colors.warning.opacity(0.12), IconName::Warning),
                EventType::Error => (colors.error, colors.error.opacity(0.12), IconName::Error),
            };

            let mut row = div()
                .w_full()
                .flex()
                .gap(px(12.0))
                .px(px(20.0))
                .py(px(14.0));

            if !is_last {
                row = row.border_b_1().border_color(colors.border);
            }

            row
                .child(
                    div()
                        .size(px(28.0))
                        .rounded_full()
                        .bg(icon_bg)
                        .flex()
                        .items_center()
                        .justify_center()
                        .flex_shrink_0()
                        .child(
                            Icon::new(icon_name)
                                .size(px(14.0))
                                .color(icon_color)
                        )
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
                                .text_size(px(13.0))
                                .text_color(colors.text)
                                .font_weight(FontWeight::MEDIUM)
                                .child(event.title)
                        )
                        .child(
                            div()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_size(px(12.0))
                                .text_color(colors.text_secondary)
                                .child(event.description)
                        )
                        .child(
                            div()
                                .text_size(px(11.0))
                                .text_color(colors.text_muted)
                                .child(event.time)
                        )
                )
        }).collect();

        self.render_card(cx, "Events", Some(format!("{} event{}", count, if count != 1 { "s" } else { "" })),
            div().flex().flex_col().children(event_items)
        )
    }

    fn render_card(
        &self,
        cx: &Context<'_, Self>,
        title: &str,
        count: Option<String>,
        content: impl IntoElement,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let mut header = div()
            .w_full()
            .px(px(20.0))
            .py(px(16.0))
            .border_b_1()
            .border_color(colors.border)
            .flex()
            .items_center()
            .justify_between()
            .child(
                div()
                    .text_size(px(15.0))
                    .text_color(colors.text)
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title.to_string())
            );

        if let Some(count_text) = count {
            header = header.child(
                div()
                    .text_size(px(12.0))
                    .text_color(colors.text_secondary)
                    .child(count_text)
            );
        }

        div()
            .rounded(px(12.0))
            .border_1()
            .border_color(colors.border)
            .bg(colors.surface)
            .overflow_hidden()
            .child(header)
            .child(content)
    }
}

// ── Event types ─────────────────────────────────────────────────────────

#[allow(dead_code)]
enum EventType {
    Success,
    Info,
    Warning,
    Error,
}

struct DeploymentEvent {
    title: String,
    description: String,
    time: String,
    event_type: EventType,
}

fn derive_deployment_events(resource: &Resource) -> Vec<DeploymentEvent> {
    let mut events = Vec::new();
    let name = &resource.metadata.name;
    let namespace = resource.metadata.namespace.as_deref().unwrap_or("default");

    let available = resource.status.as_ref()
        .and_then(|s| s.get("availableReplicas"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let desired = resource.spec.as_ref()
        .and_then(|s| s.get("replicas"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Scaled event
    if available == desired && desired > 0 {
        events.push(DeploymentEvent {
            title: "Scaled".to_string(),
            description: format!("Scaled deployment {} to {} replicas", name, desired),
            time: format_relative_time(resource),
            event_type: EventType::Success,
        });
    } else if available < desired {
        events.push(DeploymentEvent {
            title: "Scaling".to_string(),
            description: format!("Scaling deployment {} from {} to {} replicas", name, available, desired),
            time: format_relative_time(resource),
            event_type: EventType::Warning,
        });
    }

    // Container image events from pod template
    let containers = get_json_array(&resource.spec, &["template", "spec", "containers"]).unwrap_or_default();
    for container in &containers {
        let image = container.get("image").and_then(|v| v.as_str()).unwrap_or("-");
        let container_name = container.get("name").and_then(|v| v.as_str()).unwrap_or("-");

        events.push(DeploymentEvent {
            title: "Created".to_string(),
            description: format!("Created container {}", container_name),
            time: format_relative_time(resource),
            event_type: EventType::Success,
        });

        events.push(DeploymentEvent {
            title: "Pulled".to_string(),
            description: format!("Successfully pulled image {}", image),
            time: format_relative_time(resource),
            event_type: EventType::Info,
        });
    }

    // Conditions
    let conditions = resource.status.as_ref()
        .and_then(|s| s.get("conditions"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for condition in &conditions {
        let cond_type = condition.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let status = condition.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if cond_type == "Available" && status == "True" {
            events.push(DeploymentEvent {
                title: "Available".to_string(),
                description: format!("Deployment {}/{} has minimum availability", namespace, name),
                time: format_relative_time(resource),
                event_type: EventType::Success,
            });
        }
    }

    events
}
