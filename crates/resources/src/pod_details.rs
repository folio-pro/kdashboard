use gpui::*;
use gpui::prelude::FluentBuilder;
use k8s_client::Resource;
use serde_json::Value;
use ui::{theme, Icon, IconName};
use editor::YamlEditor;
use crate::detail_tabs::{DetailTab, EditorSubTab};

/// Actions that can be triggered from PodDetails
#[derive(Clone, Debug)]
pub enum PodAction {
    ViewLogs { pod_name: String, namespace: String, containers: Vec<String>, selected_container: Option<String> },
    OpenTerminal { pod_name: String, namespace: String, containers: Vec<String>, selected_container: Option<String> },
    Delete { pod_name: String, namespace: String },
}

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

    pub fn on_action(mut self, handler: impl Fn(PodAction, &mut Context<'_, Self>) + 'static) -> Self {
        self.on_action = Some(Box::new(handler));
        self
    }
}

impl Render for PodDetails {
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
                    .id("pod-details-content")
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll_handle)
                    .p(px(24.0))
                    .child(self.render_content(cx))
            )
            .into_any_element()
    }
}

impl PodDetails {
    // ── Edit button (overview header) ──────────────────────────────────

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
                div()
                    .text_size(px(13.0))
                    .text_color(colors.text)
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Edit YAML")
            )
            .on_click(cx.listener(|this, _event, _window, cx| {
                this.active_tab = DetailTab::Yaml;
                cx.notify();
            }))
    }

    // ── Full YAML editor view ────────────────────────────────────────

    fn render_yaml_view(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if self.yaml_editor.is_none() {
            let yaml = editor::resource_to_yaml(&self.resource).unwrap_or_else(|e| {
                format!("# Error serializing resource: {}", e)
            });
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
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(ED_BG))
            // ── Page Header ──
            .child(
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(px(24.0))
                    .py(px(16.0))
                    .border_b_1()
                    .border_color(rgb(ED_BORDER))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(16.0))
                            .child(
                                div()
                                    .id("yaml-back-btn")
                                    .size(px(40.0))
                                    .rounded(px(8.0))
                                    .bg(rgb(ED_CARD_BG))
                                    .border_1()
                                    .border_color(rgb(ED_BORDER))
                                    .cursor_pointer()
                                    .hover(|s| s.opacity(0.8))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(Icon::new(IconName::ArrowLeft).size(px(18.0)).color(rgb(ED_TEXT_SECONDARY).into()))
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        this.active_tab = DetailTab::Overview;
                                        this.editor_sub_tab = EditorSubTab::Editor;
                                        cx.notify();
                                    }))
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.0))
                                    .child(div().text_size(px(24.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::BOLD).child(filename))
                                    .child(div().text_size(px(14.0)).text_color(rgb(ED_TEXT_MUTED)).child(subtitle))
                            )
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.0))
                            .child(
                                div()
                                    .id("validate-btn")
                                    .px(px(16.0))
                                    .py(px(10.0))
                                    .rounded(px(6.0))
                                    .bg(rgb(ED_CARD_BG))
                                    .border_1()
                                    .border_color(rgb(ED_BORDER))
                                    .cursor_pointer()
                                    .hover(|s| s.opacity(0.8))
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .child(Icon::new(IconName::Check).size(px(16.0)).color(rgb(ED_TEXT_SECONDARY).into()))
                                    .child(div().text_size(px(13.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::SEMIBOLD).child("Validate"))
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        if let Some(editor) = &this.yaml_editor {
                                            let content = editor.read(cx).input_entity()
                                                .map(|i| i.read(cx).text().to_string())
                                                .unwrap_or_default();
                                            this.yaml_valid = Some(editor::validate_yaml(&content));
                                        }
                                        cx.notify();
                                    }))
                            )
                            .child(
                                div()
                                    .id("apply-btn")
                                    .px(px(16.0))
                                    .py(px(10.0))
                                    .rounded(px(6.0))
                                    .bg(rgb(ED_ACCENT))
                                    .cursor_pointer()
                                    .hover(|s| s.opacity(0.9))
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .child(div().text_size(px(13.0)).text_color(rgb(ED_BG)).font_weight(FontWeight::SEMIBOLD).child("Apply"))
                            )
                    )
            )
            // ── Tab Bar ──
            .child(self.render_editor_tabs(cx))
            // ── Content area (switches based on sub-tab) ──
            .child(self.render_editor_content(cx))
            // ── Status Bar ──
            .child(
                div()
                    .w_full()
                    .h(px(36.0))
                    .flex_shrink_0()
                    .px(px(20.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .bg(rgb(ED_CARD_BG))
                    .border_t_1()
                    .border_color(rgb(ED_BORDER))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .when_some(valid_badge, |el: Div, (text, color)| {
                                el.child(
                                    div()
                                        .px(px(10.0))
                                        .py(px(4.0))
                                        .rounded(px(100.0))
                                        .bg(color.opacity(0.12))
                                        .flex()
                                        .items_center()
                                        .gap(px(6.0))
                                        .child(div().size(px(6.0)).rounded_full().bg(color))
                                        .child(div().text_size(px(12.0)).text_color(color).font_weight(FontWeight::MEDIUM).child(text))
                                )
                            })
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(24.0))
                            .child(div().text_size(px(12.0)).text_color(rgb(ED_TEXT_MUTED)).child(format!("Kind: {}", self.resource.kind)))
                            .child(div().text_size(px(12.0)).text_color(rgb(ED_TEXT_MUTED)).child(format!("API: {}", self.resource.api_version)))
                    )
            )
    }

    fn render_editor_tabs(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let current = self.editor_sub_tab;
        let tabs: [(& str, EditorSubTab); 3] = [
            ("Editor", EditorSubTab::Editor),
            ("Diff", EditorSubTab::Diff),
            ("History", EditorSubTab::History),
        ];

        let tab_items: Vec<AnyElement> = tabs.iter().map(|(label, tab)| {
            let active = *tab == current;
            let tab_val = *tab;
            let mut el = div()
                .id(ElementId::Name((*label).into()))
                .px(px(16.0))
                .py(px(10.0))
                .cursor_pointer()
                .flex()
                .items_center()
                .gap(px(8.0));

            if active {
                el = el.border_b_2().border_color(rgb(ED_ACCENT));
                el.child(div().text_size(px(14.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::SEMIBOLD).child(*label))
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.editor_sub_tab = tab_val;
                        cx.notify();
                    }))
                    .into_any_element()
            } else {
                el.hover(|s| s.opacity(0.8))
                    .child(div().text_size(px(14.0)).text_color(rgb(ED_TEXT_MUTED)).font_weight(FontWeight::MEDIUM).child(*label))
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.editor_sub_tab = tab_val;
                        cx.notify();
                    }))
                    .into_any_element()
            }
        }).collect();

        div()
            .w_full()
            .px(px(24.0))
            .border_b_1()
            .border_color(rgb(ED_BORDER))
            .bg(rgb(ED_BG))
            .flex()
            .items_center()
            .children(tab_items)
    }

    fn render_editor_content(&self, cx: &Context<'_, Self>) -> AnyElement {
        match self.editor_sub_tab {
            EditorSubTab::Editor => {
                div()
                    .flex_1()
                    .p(px(24.0))
                    .min_h(px(0.0))
                    .child(
                        div()
                            .size_full()
                            .rounded(px(12.0))
                            .border_1()
                            .border_color(rgb(ED_BORDER))
                            .bg(rgb(ED_CARD_BG))
                            .overflow_hidden()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .w_full()
                                    .px(px(20.0))
                                    .py(px(16.0))
                                    .border_b_1()
                                    .border_color(rgb(ED_BORDER))
                                    .flex()
                                    .items_center()
                                    .child(div().text_size(px(15.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::SEMIBOLD).child("YAML Configuration"))
                            )
                            .child(self.yaml_editor.as_ref().unwrap().clone())
                    )
                    .into_any_element()
            }
            EditorSubTab::Diff => {
                let current_yaml = self.yaml_editor.as_ref()
                    .and_then(|e| e.read(cx).input_entity().map(|i| i.read(cx).text().to_string()))
                    .unwrap_or_default();
                let diff_lines = compute_diff(&self.original_yaml, &current_yaml);

                div()
                    .flex_1()
                    .p(px(24.0))
                    .min_h(px(0.0))
                    .child(
                        div()
                            .size_full()
                            .rounded(px(12.0))
                            .border_1()
                            .border_color(rgb(ED_BORDER))
                            .bg(rgb(ED_CARD_BG))
                            .overflow_hidden()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .w_full()
                                    .px(px(20.0))
                                    .py(px(16.0))
                                    .border_b_1()
                                    .border_color(rgb(ED_BORDER))
                                    .flex()
                                    .items_center()
                                    .child(div().text_size(px(15.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::SEMIBOLD).child("Changes"))
                            )
                            .child(
                                div()
                                    .id("diff-scroll")
                                    .flex_1()
                                    .overflow_y_scroll()
                                    .p(px(16.0))
                                    .children(diff_lines)
                            )
                    )
                    .into_any_element()
            }
            EditorSubTab::History => {
                div()
                    .flex_1()
                    .p(px(24.0))
                    .min_h(px(0.0))
                    .child(
                        div()
                            .size_full()
                            .rounded(px(12.0))
                            .border_1()
                            .border_color(rgb(ED_BORDER))
                            .bg(rgb(ED_CARD_BG))
                            .overflow_hidden()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .w_full()
                                    .px(px(20.0))
                                    .py(px(16.0))
                                    .border_b_1()
                                    .border_color(rgb(ED_BORDER))
                                    .flex()
                                    .items_center()
                                    .child(div().text_size(px(15.0)).text_color(rgb(ED_TEXT)).font_weight(FontWeight::SEMIBOLD).child("Original YAML"))
                            )
                            .child(
                                div()
                                    .id("history-scroll")
                                    .flex_1()
                                    .overflow_y_scroll()
                                    .p(px(16.0))
                                    .child(
                                        div()
                                            .text_size(px(13.0))
                                            .text_color(rgb(ED_TEXT_SECONDARY))
                                            .whitespace_nowrap()
                                            .child(self.original_yaml.clone())
                                    )
                            )
                    )
                    .into_any_element()
            }
        }
    }

    // ── Breadcrumb ──────────────────────────────────────────────────────

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
                    .id("bc-pods")
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
                    .child("Pods")
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

    // ── Header ──────────────────────────────────────────────────────────

    fn render_header(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let resource = &self.resource;

        let name = resource.metadata.name.clone();
        let namespace = resource.metadata.namespace.clone().unwrap_or_else(|| "default".to_string());
        let node_name = get_json_str(&resource.spec, &["nodeName"]).unwrap_or_else(|| "-".to_string());
        let phase = get_json_str(&resource.status, &["phase"]).unwrap_or_else(|| "Unknown".to_string());

        let (status_color, status_bg) = match phase.as_str() {
            "Running" | "Succeeded" => (colors.success, colors.success.opacity(0.08)),
            "Pending" => (colors.warning, colors.warning.opacity(0.08)),
            "Failed" => (colors.error, colors.error.opacity(0.08)),
            _ => (colors.text_muted, colors.text_muted.opacity(0.08)),
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
                    // Pod icon box
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
                                Icon::new(IconName::Box)
                                    .size(px(24.0))
                                    .color(colors.primary)
                            )
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
                                            .child(node_name)
                                    )
                            )
                    )
                    // Status badge
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
                                    .child(phase)
                            )
                    )
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
                    .child(self.render_secondary_button(cx, "terminal-btn", IconName::Terminal, "Terminal"))
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
                                    let action = PodAction::Delete {
                                        pod_name: this.resource.metadata.name.clone(),
                                        namespace: this.resource.metadata.namespace.clone().unwrap_or_else(|| "default".to_string()),
                                    };
                                    on_action(action, cx);
                                }
                                cx.notify();
                            }))
                    )
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

        let mut btn = div()
            .id(ElementId::Name(id.into()))
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
            .child(
                Icon::new(icon)
                    .size(px(16.0))
                    .color(colors.text_secondary)
            )
            .child(
                div()
                    .text_size(px(13.0))
                    .text_color(colors.text)
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(label)
            );

        if is_logs {
            btn = btn.on_click(cx.listener(move |this, _event, _window, cx| {
                if let Some(on_action) = &this.on_action {
                    let all_containers: Vec<String> = get_json_array(&this.resource.spec, &["containers"])
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                        .collect();
                    let action = PodAction::ViewLogs {
                        pod_name: this.resource.metadata.name.clone(),
                        namespace: this.resource.metadata.namespace.clone().unwrap_or_else(|| "default".to_string()),
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
                    let all_containers: Vec<String> = get_json_array(&this.resource.spec, &["containers"])
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                        .collect();
                    let action = PodAction::OpenTerminal {
                        pod_name: this.resource.metadata.name.clone(),
                        namespace: this.resource.metadata.namespace.clone().unwrap_or_else(|| "default".to_string()),
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

        div()
            .w_full()
            .flex()
            .gap(px(24.0))
            // Left column
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .flex()
                    .flex_col()
                    .gap(px(24.0))
                    .child(self.render_pod_info_card(cx, resource))
                    .child(self.render_containers_card(cx, resource))
                    .child(self.render_labels_card(cx, resource))
            )
            // Right column (400px)
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

    // ── Pod Information card ────────────────────────────────────────────

    fn render_pod_info_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let name = resource.metadata.name.clone();
        let namespace = resource.metadata.namespace.clone().unwrap_or_else(|| "default".to_string());
        let node_name = get_json_str(&resource.spec, &["nodeName"]).unwrap_or_else(|| "-".to_string());
        let pod_ip = get_json_str(&resource.status, &["podIP"]).unwrap_or_else(|| "-".to_string());
        let created = resource.metadata.creation_timestamp.clone().unwrap_or_else(|| "-".to_string());
        let restarts = get_pod_restarts(resource);

        let rows: Vec<(&str, String, Option<Hsla>)> = vec![
            ("Name", name, None),
            ("Namespace", namespace, Some(colors.primary)),
            ("Node", node_name, None),
            ("IP Address", pod_ip, None),
            ("Created", format_timestamp(&created), None),
            ("Restarts", restarts.to_string(), Some(colors.success)),
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

        self.render_card(cx, "Pod Information", None,
            div().flex().flex_col().children(row_items)
        )
    }

    // ── Containers card ─────────────────────────────────────────────────

    fn render_containers_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let containers = get_json_array(&resource.spec, &["containers"]).unwrap_or_default();
        let container_statuses = get_json_array(&resource.status, &["containerStatuses"]).unwrap_or_default();
        let count = containers.len();

        let container_items: Vec<Div> = containers.iter().enumerate().map(|(idx, container)| {
            let name = container.get("name").and_then(|v| v.as_str()).unwrap_or("-").to_string();
            let image = container.get("image").and_then(|v| v.as_str()).unwrap_or("-").to_string();

            let status = container_statuses.iter().find(|s| {
                s.get("name").and_then(|n| n.as_str()) == Some(&name)
            });

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
            } else if status.and_then(|s| s.get("state")).and_then(|s| s.get("waiting")).is_some() {
                "Waiting"
            } else if status.and_then(|s| s.get("state")).and_then(|s| s.get("terminated")).is_some() {
                "Terminated"
            } else {
                "Unknown"
            };

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

            let status_color = if is_running { colors.success } else { colors.warning };

            div()
                .w_full()
                .p(px(20.0))
                .when(idx > 0, |el: Div| el.border_t_1().border_color(colors.border))
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
                                                .child(name.clone())
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
                                            .rounded(px(100.0))
                                            .bg(colors.warning.opacity(0.08))
                                            .flex()
                                            .items_center()
                                            .gap(px(6.0))
                                            .child(
                                                Icon::new(IconName::Refresh)
                                                    .size(px(12.0))
                                                    .color(colors.warning)
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(12.0))
                                                    .text_color(colors.warning)
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .child(format!("Restarts: {}", restarts))
                                            )
                                    )
                                })
                                .child(
                                    div()
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
                )
                // Resource stat cards
                .child(
                    div()
                        .w_full()
                        .flex()
                        .gap(px(16.0))
                        .child(self.render_resource_stat(cx, "CPU", &cpu_num, &cpu_unit, cpu_limit.as_deref()))
                        .child(self.render_resource_stat(cx, "MEMORY", &mem_num, &mem_unit, mem_limit.as_deref()))
                )
        }).collect();

        self.render_card(cx, "Containers", Some(format!("{} container{}", count, if count != 1 { "s" } else { "" })),
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

    // ── Labels card ─────────────────────────────────────────────────────

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

    // ── Events card ─────────────────────────────────────────────────────

    fn render_events_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let events = derive_pod_events(resource);
        let count = events.len();
        let total = events.len();

        let event_items: Vec<Div> = events.into_iter().enumerate().map(|(idx, event)| {
            let is_last = idx == total - 1;

            let (icon_color, icon_bg, icon_name) = match event.event_type {
                PodEventType::Success => (colors.success, colors.success.opacity(0.12), IconName::Check),
                PodEventType::Info => (colors.primary, colors.primary.opacity(0.12), IconName::Download),
                PodEventType::Warning => (colors.warning, colors.warning.opacity(0.12), IconName::Warning),
                PodEventType::Error => (colors.error, colors.error.opacity(0.12), IconName::Error),
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
                // Icon circle
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
                // Event content
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

    // ── Card wrapper ────────────────────────────────────────────────────

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
enum PodEventType {
    Success,
    Info,
    Warning,
    Error,
}

struct PodEvent {
    title: String,
    description: String,
    time: String,
    event_type: PodEventType,
}

/// Derive events from pod status data (conditions + container statuses).
/// Real K8s events would come from the Events API.
fn derive_pod_events(resource: &Resource) -> Vec<PodEvent> {
    let mut events = Vec::new();
    let name = &resource.metadata.name;
    let namespace = resource.metadata.namespace.as_deref().unwrap_or("default");

    let containers = get_json_array(&resource.spec, &["containers"]).unwrap_or_default();
    let container_statuses = get_json_array(&resource.status, &["containerStatuses"]).unwrap_or_default();

    // Started events from running containers
    for cs in &container_statuses {
        let container_name = cs.get("name").and_then(|v| v.as_str()).unwrap_or("-");
        if cs.get("state").and_then(|s| s.get("running")).is_some() {
            events.push(PodEvent {
                title: "Started".to_string(),
                description: format!("Started container {}", container_name),
                time: format_relative_time(resource),
                event_type: PodEventType::Success,
            });
        }
    }

    // Created events from containers
    for container in &containers {
        let container_name = container.get("name").and_then(|v| v.as_str()).unwrap_or("-");
        events.push(PodEvent {
            title: "Created".to_string(),
            description: format!("Created container {}", container_name),
            time: format_relative_time(resource),
            event_type: PodEventType::Success,
        });
    }

    // Pulled events from container images
    for container in &containers {
        let image = container.get("image").and_then(|v| v.as_str()).unwrap_or("-");
        events.push(PodEvent {
            title: "Pulled".to_string(),
            description: format!("Successfully pulled image {}", image),
            time: format_relative_time(resource),
            event_type: PodEventType::Info,
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
        events.push(PodEvent {
            title: "Scheduled".to_string(),
            description: format!("Successfully assigned {}/{} to {}", namespace, name, node),
            time: format_relative_time(resource),
            event_type: PodEventType::Info,
        });
    }

    events
}

// ── Helpers ─────────────────────────────────────────────────────────────

pub(crate) fn format_relative_time(resource: &Resource) -> String {
    if let Some(ts) = &resource.metadata.creation_timestamp {
        if let Ok(date) = chrono::DateTime::parse_from_rfc3339(ts) {
            let now = chrono::Utc::now();
            let duration = now.signed_duration_since(date);
            if duration.num_days() > 0 {
                return format!("{} day{} ago", duration.num_days(), if duration.num_days() != 1 { "s" } else { "" });
            } else if duration.num_hours() > 0 {
                return format!("{} hour{} ago", duration.num_hours(), if duration.num_hours() != 1 { "s" } else { "" });
            } else {
                let mins = duration.num_minutes().max(1);
                return format!("{} min{} ago", mins, if mins != 1 { "s" } else { "" });
            }
        }
    }
    "Unknown".to_string()
}

/// Parse a K8s resource value like "25m" or "64Mi" into (number, unit).
pub(crate) fn parse_resource_value(value: &str) -> (String, String) {
    if value == "-" {
        return ("-".to_string(), String::new());
    }
    let mut num_end = 0;
    for (i, c) in value.char_indices() {
        if c.is_ascii_digit() || c == '.' {
            num_end = i + c.len_utf8();
        } else {
            break;
        }
    }
    if num_end == 0 {
        (value.to_string(), String::new())
    } else {
        (value[..num_end].to_string(), value[num_end..].to_string())
    }
}

pub(crate) fn get_json_str(value: &Option<Value>, path: &[&str]) -> Option<String> {
    let mut current = value.as_ref()?;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(|s| s.to_string())
}

pub(crate) fn get_json_array(value: &Option<Value>, path: &[&str]) -> Option<Vec<Value>> {
    let mut current = value.as_ref()?;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_array().cloned()
}

fn get_pod_restarts(resource: &Resource) -> u64 {
    let container_statuses = get_json_array(&resource.status, &["containerStatuses"])
        .unwrap_or_default();
    container_statuses.iter().map(|s| {
        s.get("restartCount").and_then(|r| r.as_u64()).unwrap_or(0)
    }).sum()
}

/// Simple line-by-line diff between original and current YAML.
pub(crate) fn compute_diff(original: &str, current: &str) -> Vec<Div> {
    let orig_lines: Vec<&str> = original.lines().collect();
    let curr_lines: Vec<&str> = current.lines().collect();
    let mut result = Vec::new();
    let max = orig_lines.len().max(curr_lines.len());

    if original == current {
        result.push(
            div()
                .px(px(12.0))
                .py(px(8.0))
                .text_size(px(13.0))
                .text_color(rgb(0x94A3B8))
                .child("No changes detected.")
        );
        return result;
    }

    for i in 0..max {
        let orig = orig_lines.get(i).copied();
        let curr = curr_lines.get(i).copied();

        match (orig, curr) {
            (Some(o), Some(c)) if o == c => {
                result.push(
                    div()
                        .px(px(12.0))
                        .py(px(1.0))
                        .text_size(px(13.0))
                        .text_color(rgb(0x94A3B8))
                        .whitespace_nowrap()
                        .child(format!("  {}", o))
                );
            }
            (Some(o), Some(c)) => {
                result.push(
                    div()
                        .px(px(12.0))
                        .py(px(1.0))
                        .bg(Hsla::from(rgb(0xEF4444)).opacity(0.1))
                        .text_size(px(13.0))
                        .text_color(rgb(0xEF4444))
                        .whitespace_nowrap()
                        .child(format!("- {}", o))
                );
                result.push(
                    div()
                        .px(px(12.0))
                        .py(px(1.0))
                        .bg(Hsla::from(rgb(0x22C55E)).opacity(0.1))
                        .text_size(px(13.0))
                        .text_color(rgb(0x22C55E))
                        .whitespace_nowrap()
                        .child(format!("+ {}", c))
                );
            }
            (Some(o), None) => {
                result.push(
                    div()
                        .px(px(12.0))
                        .py(px(1.0))
                        .bg(Hsla::from(rgb(0xEF4444)).opacity(0.1))
                        .text_size(px(13.0))
                        .text_color(rgb(0xEF4444))
                        .whitespace_nowrap()
                        .child(format!("- {}", o))
                );
            }
            (None, Some(c)) => {
                result.push(
                    div()
                        .px(px(12.0))
                        .py(px(1.0))
                        .bg(Hsla::from(rgb(0x22C55E)).opacity(0.1))
                        .text_size(px(13.0))
                        .text_color(rgb(0x22C55E))
                        .whitespace_nowrap()
                        .child(format!("+ {}", c))
                );
            }
            (None, None) => {}
        }
    }

    result
}

pub(crate) fn format_timestamp(ts: &str) -> String {
    if ts == "-" {
        return ts.to_string();
    }
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(ts) {
        date.format("%Y-%m-%d %H:%M:%S UTC").to_string()
    } else {
        ts.to_string()
    }
}
