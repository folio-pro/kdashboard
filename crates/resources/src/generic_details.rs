use gpui::*;
use gpui::prelude::FluentBuilder;
use k8s_client::Resource;
use serde_json::Value;
use ui::{theme, Icon, IconName};
use editor::YamlEditor;
use crate::detail_tabs::{DetailTab, EditorSubTab};
use crate::pod_details::compute_diff;

const ED_BG: u32 = 0x0A0F1C;
const ED_CARD_BG: u32 = 0x1E293B;
const ED_BORDER: u32 = 0x334155;
const ED_ACCENT: u32 = 0x22D3EE;
const ED_TEXT: u32 = 0xFFFFFF;
const ED_TEXT_SECONDARY: u32 = 0x94A3B8;
const ED_TEXT_MUTED: u32 = 0x64748B;
const ED_SUCCESS: u32 = 0x22C55E;
use crate::pod_details::{format_timestamp, get_json_array, get_json_str, parse_resource_value};

#[derive(Clone, Debug)]
pub enum GenericAction {
    Delete { name: String, namespace: String },
}

pub struct GenericResourceDetails {
    resource: Resource,
    scroll_handle: ScrollHandle,
    type_label: &'static str,
    icon: IconName,
    on_close: Option<Box<dyn Fn(&mut Context<'_, Self>) + 'static>>,
    on_action: Option<Box<dyn Fn(GenericAction, &mut Context<'_, Self>) + 'static>>,
    active_tab: DetailTab,
    editor_sub_tab: EditorSubTab,
    yaml_editor: Option<Entity<YamlEditor>>,
    original_yaml: String,
    yaml_valid: Option<bool>,
}

impl GenericResourceDetails {
    pub fn new(resource: Resource, type_label: &'static str, icon: IconName) -> Self {
        Self {
            resource,
            scroll_handle: ScrollHandle::new(),
            type_label,
            icon,
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

    pub fn on_action(mut self, handler: impl Fn(GenericAction, &mut Context<'_, Self>) + 'static) -> Self {
        self.on_action = Some(Box::new(handler));
        self
    }
}

impl Render for GenericResourceDetails {
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
                    .id("generic-details-content")
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll_handle)
                    .p(px(24.0))
                    .child(self.render_content(cx))
            )
            .into_any_element()
    }
}

impl GenericResourceDetails {
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
                div().text_size(px(13.0)).text_color(colors.text).font_weight(FontWeight::SEMIBOLD).child("Edit YAML")
            )
            .on_click(cx.listener(|this, _event, _window, cx| {
                this.active_tab = DetailTab::Yaml;
                cx.notify();
            }))
    }

    // ── Full YAML editor view ────────────────────────────────────────

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
                div().flex_shrink_0().text_size(px(13.0)).text_color(colors.text_muted).child("Cluster")
            )
            .child(Icon::new(IconName::ChevronRight).size(px(14.0)).color(colors.text_muted))
            .child(
                div()
                    .id("bc-type")
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
                    .child(self.type_label)
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
        let (subtitle, status_text, status_color) = self.derive_header_info(colors);

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
                    // Icon box
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
                            .child(Icon::new(self.icon).size(px(24.0)).color(colors.primary))
                    )
                    // Name + subtitle
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
                                    .child(div().text_size(px(13.0)).text_color(colors.text_secondary).child(namespace))
                                    .child(div().size(px(4.0)).rounded_full().bg(colors.text_muted))
                                    .child(div().text_size(px(13.0)).text_color(colors.text_secondary).child(subtitle))
                            )
                    )
                    // Status badge
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
                            .child(div().size(px(6.0)).rounded_full().bg(status_color))
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .text_color(status_color)
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(status_text)
                            )
                    )
            )
            // Action buttons
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
                            .child(Icon::new(IconName::Trash).size(px(16.0)).color(colors.text))
                            .child(
                                div()
                                    .text_size(px(13.0))
                                    .text_color(colors.text)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Delete")
                            )
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                if let Some(on_action) = &this.on_action {
                                    on_action(GenericAction::Delete {
                                        name: this.resource.metadata.name.clone(),
                                        namespace: this.resource.metadata.namespace.clone().unwrap_or_else(|| "default".to_string()),
                                    }, cx);
                                }
                                cx.notify();
                            }))
                    )
            )
    }

    fn derive_header_info(&self, colors: &ui::ThemeColors) -> (String, String, Hsla) {
        let resource = &self.resource;
        let kind = resource.kind.as_str();

        match kind {
            "StatefulSet" => {
                let desired = get_spec_int(resource, "replicas");
                let ready = get_status_int(resource, "readyReplicas");
                let ok = ready == desired && desired > 0;
                (format!("{}/{} replicas", ready, desired),
                 if ok { "Running" } else { "Updating" }.into(),
                 if ok { colors.success } else { colors.warning })
            }
            "DaemonSet" => {
                let desired = get_status_int(resource, "desiredNumberScheduled");
                let ready = get_status_int(resource, "numberReady");
                let ok = ready == desired && desired > 0;
                (format!("{}/{} nodes", ready, desired),
                 if ok { "Running" } else { "Updating" }.into(),
                 if ok { colors.success } else { colors.warning })
            }
            "Job" => {
                let succeeded = get_status_int(resource, "succeeded");
                let active = get_status_int(resource, "active");
                let failed = get_status_int(resource, "failed");
                if succeeded > 0 {
                    ("Completed".into(), "Complete".into(), colors.success)
                } else if active > 0 {
                    (format!("{} active", active), "Running".into(), colors.primary)
                } else if failed > 0 {
                    (format!("{} failed", failed), "Failed".into(), colors.error)
                } else {
                    ("Pending".into(), "Pending".into(), colors.warning)
                }
            }
            "CronJob" => {
                let schedule = get_json_str(&resource.spec, &["schedule"]).unwrap_or_else(|| "-".into());
                let suspend = resource.spec.as_ref()
                    .and_then(|s| s.get("suspend"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if suspend {
                    (schedule, "Suspended".into(), colors.warning)
                } else {
                    (schedule, "Active".into(), colors.success)
                }
            }
            "Service" => {
                let svc_type = get_json_str(&resource.spec, &["type"]).unwrap_or_else(|| "ClusterIP".into());
                (svc_type, "Active".into(), colors.success)
            }
            "Ingress" => {
                let rules = get_json_array(&resource.spec, &["rules"]).unwrap_or_default();
                (format!("{} rule{}", rules.len(), if rules.len() != 1 { "s" } else { "" }),
                 "Active".into(), colors.success)
            }
            "ConfigMap" => {
                let data_count = resource.data.as_ref()
                    .and_then(|d| d.as_object())
                    .map(|o| o.len())
                    .unwrap_or(0);
                (format!("{} key{}", data_count, if data_count != 1 { "s" } else { "" }),
                 "Active".into(), colors.success)
            }
            "Secret" => {
                let data_count = resource.data.as_ref()
                    .and_then(|d| d.as_object())
                    .map(|o| o.len())
                    .unwrap_or(0);
                let secret_type = resource.type_.as_deref().unwrap_or("Opaque");
                (format!("{} · {} key{}", secret_type, data_count, if data_count != 1 { "s" } else { "" }),
                 "Active".into(), colors.success)
            }
            "Node" => {
                let ready = is_node_ready(resource);
                let version = get_status_str(resource, &["nodeInfo", "kubeletVersion"]);
                (version.unwrap_or_else(|| "-".into()),
                 if ready { "Ready" } else { "NotReady" }.into(),
                 if ready { colors.success } else { colors.error })
            }
            "Namespace" => {
                let phase = get_json_str(&resource.status, &["phase"]).unwrap_or_else(|| "Active".into());
                let ok = phase == "Active";
                (self.resource.kind.clone(),
                 phase.clone(),
                 if ok { colors.success } else { colors.warning })
            }
            _ => {
                (resource.kind.clone(), "Active".into(), colors.success)
            }
        }
    }

    // ── Content ─────────────────────────────────────────────────────────

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
                    .child(self.render_info_card(cx))
                    .child(self.render_type_specific_card(cx, resource))
                    .child(self.render_labels_card(cx, resource))
            )
            .child(
                div()
                    .w(px(400.0))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .gap(px(24.0))
                    .child(self.render_annotations_card(cx, resource))
            )
    }

    // ── Info Card ───────────────────────────────────────────────────────

    fn render_info_card(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let rows = self.derive_info_rows(colors);
        let title = format!("{} Information", self.resource.kind);

        let total = rows.len();
        let row_items: Vec<Div> = rows.into_iter().enumerate().map(|(idx, (label, value, color))| {
            let is_last = idx == total - 1;
            let mut row = div().w_full().flex().items_center().px(px(20.0)).py(px(12.0));
            if !is_last {
                row = row.border_b_1().border_color(colors.border);
            }
            row.child(
                div().w(px(140.0)).flex_shrink_0().text_size(px(13.0)).text_color(colors.text_secondary).child(label)
            ).child(
                div().flex_1().min_w(px(0.0)).overflow_hidden().whitespace_nowrap().text_ellipsis()
                    .text_size(px(13.0)).text_color(color.unwrap_or(colors.text)).child(value)
            )
        }).collect();

        self.render_card(cx, title, None, div().flex().flex_col().children(row_items))
    }

    fn derive_info_rows(&self, colors: &ui::ThemeColors) -> Vec<(String, String, Option<Hsla>)> {
        let r = &self.resource;
        let name = r.metadata.name.clone();
        let ns = r.metadata.namespace.clone().unwrap_or_else(|| "-".into());
        let created = format_timestamp(&r.metadata.creation_timestamp.clone().unwrap_or_else(|| "-".into()));

        match r.kind.as_str() {
            "StatefulSet" => {
                let desired = get_spec_int(r, "replicas");
                let ready = get_status_int(r, "readyReplicas");
                let svc = get_json_str(&r.spec, &["serviceName"]).unwrap_or_else(|| "-".into());
                let revision = get_status_int(r, "currentRevision").to_string();
                vec![
                    ("Name".into(), name, None),
                    ("Namespace".into(), ns, Some(colors.primary)),
                    ("Replicas".into(), format!("{} / {}", ready, desired), None),
                    ("Service Name".into(), svc, None),
                    ("Created".into(), created, None),
                    ("Revision".into(), revision, Some(colors.success)),
                ]
            }
            "DaemonSet" => {
                let desired = get_status_int(r, "desiredNumberScheduled");
                let current = get_status_int(r, "currentNumberScheduled");
                let ready = get_status_int(r, "numberReady");
                let updated = get_status_int(r, "updatedNumberScheduled");
                vec![
                    ("Name".into(), name, None),
                    ("Namespace".into(), ns, Some(colors.primary)),
                    ("Desired".into(), desired.to_string(), None),
                    ("Current".into(), current.to_string(), None),
                    ("Ready".into(), ready.to_string(), Some(colors.success)),
                    ("Updated".into(), updated.to_string(), None),
                    ("Created".into(), created, None),
                ]
            }
            "Job" => {
                let completions = get_spec_int(r, "completions");
                let parallelism = get_spec_int(r, "parallelism");
                let succeeded = get_status_int(r, "succeeded");
                let failed = get_status_int(r, "failed");
                let active = get_status_int(r, "active");
                vec![
                    ("Name".into(), name, None),
                    ("Namespace".into(), ns, Some(colors.primary)),
                    ("Completions".into(), format!("{} / {}", succeeded, completions), None),
                    ("Parallelism".into(), parallelism.to_string(), None),
                    ("Active".into(), active.to_string(), None),
                    ("Succeeded".into(), succeeded.to_string(), Some(colors.success)),
                    ("Failed".into(), failed.to_string(), if failed > 0 { Some(colors.error) } else { None }),
                    ("Created".into(), created, None),
                ]
            }
            "CronJob" => {
                let schedule = get_json_str(&r.spec, &["schedule"]).unwrap_or_else(|| "-".into());
                let suspend = r.spec.as_ref().and_then(|s| s.get("suspend")).and_then(|v| v.as_bool()).unwrap_or(false);
                let last_schedule = get_json_str(&r.status, &["lastScheduleTime"])
                    .map(|t| format_timestamp(&t))
                    .unwrap_or_else(|| "-".into());
                let active_jobs = r.status.as_ref()
                    .and_then(|s| s.get("active"))
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                vec![
                    ("Name".into(), name, None),
                    ("Namespace".into(), ns, Some(colors.primary)),
                    ("Schedule".into(), schedule, None),
                    ("Suspend".into(), if suspend { "Yes" } else { "No" }.into(), if suspend { Some(colors.warning) } else { None }),
                    ("Last Schedule".into(), last_schedule, None),
                    ("Active Jobs".into(), active_jobs.to_string(), None),
                    ("Created".into(), created, None),
                ]
            }
            "Service" => {
                let svc_type = get_json_str(&r.spec, &["type"]).unwrap_or_else(|| "ClusterIP".into());
                let cluster_ip = get_json_str(&r.spec, &["clusterIP"]).unwrap_or_else(|| "-".into());
                let ports = get_json_array(&r.spec, &["ports"]).unwrap_or_default();
                let ports_str = ports.iter().map(|p| {
                    let port = p.get("port").and_then(|v| v.as_u64()).unwrap_or(0);
                    let target = p.get("targetPort").map(|v| {
                        v.as_u64().map(|n| n.to_string()).unwrap_or_else(|| v.as_str().unwrap_or("-").to_string())
                    }).unwrap_or_else(|| "-".into());
                    let proto = p.get("protocol").and_then(|v| v.as_str()).unwrap_or("TCP");
                    let node_port = p.get("nodePort").and_then(|v| v.as_u64());
                    if let Some(np) = node_port {
                        format!("{}:{}/{}", port, np, proto)
                    } else {
                        format!("{}:{}/{}", port, target, proto)
                    }
                }).collect::<Vec<_>>().join(", ");
                let selector = r.spec.as_ref()
                    .and_then(|s| s.get("selector"))
                    .and_then(|v| v.as_object())
                    .map(|m| m.iter().map(|(k, v)| format!("{}={}", k, v.as_str().unwrap_or(""))).collect::<Vec<_>>().join(", "))
                    .unwrap_or_else(|| "-".into());
                vec![
                    ("Name".into(), name, None),
                    ("Namespace".into(), ns, Some(colors.primary)),
                    ("Type".into(), svc_type, None),
                    ("Cluster IP".into(), cluster_ip, None),
                    ("Port(s)".into(), if ports_str.is_empty() { "-".into() } else { ports_str }, None),
                    ("Selector".into(), selector, Some(colors.primary)),
                    ("Created".into(), created, None),
                ]
            }
            "Ingress" => {
                let class = get_json_str(&r.spec, &["ingressClassName"]).unwrap_or_else(|| "-".into());
                let rules = get_json_array(&r.spec, &["rules"]).unwrap_or_default();
                let hosts: Vec<String> = rules.iter().filter_map(|rule| {
                    rule.get("host").and_then(|h| h.as_str()).map(|s| s.to_string())
                }).collect();
                let hosts_str = if hosts.is_empty() { "*".into() } else { hosts.join(", ") };
                let tls = get_json_array(&r.spec, &["tls"]).unwrap_or_default();
                vec![
                    ("Name".into(), name, None),
                    ("Namespace".into(), ns, Some(colors.primary)),
                    ("Class".into(), class, None),
                    ("Host(s)".into(), hosts_str, None),
                    ("TLS".into(), if tls.is_empty() { "No".into() } else { format!("{} cert{}", tls.len(), if tls.len() != 1 { "s" } else { "" }) }, None),
                    ("Rules".into(), format!("{}", rules.len()), None),
                    ("Created".into(), created, None),
                ]
            }
            "ConfigMap" => {
                let data_count = r.data.as_ref().and_then(|d| d.as_object()).map(|o| o.len()).unwrap_or(0);
                vec![
                    ("Name".into(), name, None),
                    ("Namespace".into(), ns, Some(colors.primary)),
                    ("Data Keys".into(), data_count.to_string(), None),
                    ("Created".into(), created, None),
                ]
            }
            "Secret" => {
                let data_count = r.data.as_ref().and_then(|d| d.as_object()).map(|o| o.len()).unwrap_or(0);
                let secret_type = r.type_.as_deref().unwrap_or("Opaque").to_string();
                vec![
                    ("Name".into(), name, None),
                    ("Namespace".into(), ns, Some(colors.primary)),
                    ("Type".into(), secret_type, None),
                    ("Data Keys".into(), data_count.to_string(), None),
                    ("Created".into(), created, None),
                ]
            }
            "Node" => {
                let os = get_status_str(r, &["nodeInfo", "operatingSystem"]).unwrap_or_else(|| "-".into());
                let arch = get_status_str(r, &["nodeInfo", "architecture"]).unwrap_or_else(|| "-".into());
                let version = get_status_str(r, &["nodeInfo", "kubeletVersion"]).unwrap_or_else(|| "-".into());
                let os_image = get_status_str(r, &["nodeInfo", "osImage"]).unwrap_or_else(|| "-".into());
                let container_runtime = get_status_str(r, &["nodeInfo", "containerRuntimeVersion"]).unwrap_or_else(|| "-".into());
                let cpu = get_capacity_str(r, "cpu");
                let memory = get_capacity_str(r, "memory");
                vec![
                    ("Name".into(), name, None),
                    ("OS".into(), format!("{}/{}", os, arch), None),
                    ("OS Image".into(), os_image, None),
                    ("Kubelet".into(), version, None),
                    ("Runtime".into(), container_runtime, None),
                    ("CPU Capacity".into(), cpu, None),
                    ("Memory".into(), memory, None),
                    ("Created".into(), created, None),
                ]
            }
            "Namespace" => {
                let phase = get_json_str(&r.status, &["phase"]).unwrap_or_else(|| "Active".into());
                vec![
                    ("Name".into(), name, None),
                    ("Status".into(), phase, Some(colors.success)),
                    ("Created".into(), created, None),
                ]
            }
            _ => {
                vec![
                    ("Name".into(), name, None),
                    ("Namespace".into(), ns, Some(colors.primary)),
                    ("Kind".into(), r.kind.clone(), None),
                    ("API Version".into(), r.api_version.clone(), None),
                    ("Created".into(), created, None),
                ]
            }
        }
    }

    // ── Type-specific card ──────────────────────────────────────────────

    fn render_type_specific_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> AnyElement {
        let kind = resource.kind.as_str();
        match kind {
            "StatefulSet" | "DaemonSet" => self.render_pod_template_card(cx, resource).into_any_element(),
            "Job" => self.render_pod_template_card(cx, resource).into_any_element(),
            "CronJob" => self.render_pod_template_card_cronjob(cx, resource).into_any_element(),
            "Service" => self.render_ports_card(cx, resource).into_any_element(),
            "Ingress" => self.render_rules_card(cx, resource).into_any_element(),
            "ConfigMap" => self.render_data_keys_card(cx, resource, false).into_any_element(),
            "Secret" => self.render_data_keys_card(cx, resource, true).into_any_element(),
            "Node" => self.render_conditions_card(cx, resource).into_any_element(),
            "Namespace" => self.render_resource_quotas_card(cx, resource).into_any_element(),
            _ => self.render_card(cx, "Details", None, div().p(px(20.0)).child(
                div().text_size(px(13.0)).text_color(theme(cx).colors.text_muted).child("No additional details available")
            )).into_any_element(),
        }
    }

    // ── Pod template card (StatefulSet, DaemonSet, Job) ─────────────────

    fn render_pod_template_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let containers = get_json_array(&resource.spec, &["template", "spec", "containers"]).unwrap_or_default();
        let count = containers.len();

        let items: Vec<Div> = containers.iter().enumerate().map(|(idx, c)| {
            self.render_container_item(cx, idx, c, colors)
        }).collect();

        self.render_card(cx, "Pod Template", Some(format!("{} container{}", count, if count != 1 { "s" } else { "" })),
            div().flex().flex_col().children(items)
        )
    }

    fn render_pod_template_card_cronjob(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let containers = get_json_array(&resource.spec, &["jobTemplate", "spec", "template", "spec", "containers"]).unwrap_or_default();
        let count = containers.len();

        let items: Vec<Div> = containers.iter().enumerate().map(|(idx, c)| {
            self.render_container_item(cx, idx, c, colors)
        }).collect();

        self.render_card(cx, "Job Template", Some(format!("{} container{}", count, if count != 1 { "s" } else { "" })),
            div().flex().flex_col().children(items)
        )
    }

    fn render_container_item(&self, cx: &Context<'_, Self>, idx: usize, container: &Value, colors: &ui::ThemeColors) -> Div {
        let name = container.get("name").and_then(|v| v.as_str()).unwrap_or("-").to_string();
        let image = container.get("image").and_then(|v| v.as_str()).unwrap_or("-").to_string();
        let cpu_req = container.get("resources").and_then(|r| r.get("requests")).and_then(|r| r.get("cpu")).and_then(|v| v.as_str()).unwrap_or("-");
        let mem_req = container.get("resources").and_then(|r| r.get("requests")).and_then(|r| r.get("memory")).and_then(|v| v.as_str()).unwrap_or("-");
        let cpu_lim = container.get("resources").and_then(|r| r.get("limits")).and_then(|r| r.get("cpu")).and_then(|v| v.as_str()).map(|s| format!("/ {} limit", s));
        let mem_lim = container.get("resources").and_then(|r| r.get("limits")).and_then(|r| r.get("memory")).and_then(|v| v.as_str()).map(|s| format!("/ {} limit", s));
        let (cpu_num, cpu_unit) = parse_resource_value(cpu_req);
        let (mem_num, mem_unit) = parse_resource_value(mem_req);

        div()
            .w_full()
            .p(px(20.0))
            .when(idx > 0, |el: Div| el.border_t_1().border_color(colors.border))
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(
                div().w_full().flex().items_center().gap(px(12.0))
                    .child(
                        div().flex_shrink_0().size(px(36.0)).rounded(px(6.0)).bg(colors.primary)
                            .flex().items_center().justify_center()
                            .child(Icon::new(IconName::Box).size(px(18.0)).color(colors.background))
                    )
                    .child(
                        div().min_w(px(0.0)).flex().flex_col().gap(px(2.0))
                            .child(div().overflow_hidden().whitespace_nowrap().text_ellipsis().text_size(px(14.0)).text_color(colors.text).font_weight(FontWeight::SEMIBOLD).child(name))
                            .child(div().overflow_hidden().whitespace_nowrap().text_ellipsis().text_size(px(12.0)).text_color(colors.text_secondary).child(image))
                    )
            )
            .child(
                div().w_full().flex().gap(px(16.0))
                    .child(self.render_resource_stat(cx, "CPU", &cpu_num, &cpu_unit, cpu_lim.as_deref()))
                    .child(self.render_resource_stat(cx, "MEMORY", &mem_num, &mem_unit, mem_lim.as_deref()))
            )
    }

    // ── Service ports card ──────────────────────────────────────────────

    fn render_ports_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let ports = get_json_array(&resource.spec, &["ports"]).unwrap_or_default();
        let count = ports.len();

        let port_items: Vec<Div> = ports.iter().enumerate().map(|(idx, p)| {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("-").to_string();
            let port = p.get("port").and_then(|v| v.as_u64()).unwrap_or(0);
            let target = p.get("targetPort").map(|v| v.as_u64().map(|n| n.to_string()).unwrap_or_else(|| v.as_str().unwrap_or("-").to_string())).unwrap_or_else(|| "-".into());
            let proto = p.get("protocol").and_then(|v| v.as_str()).unwrap_or("TCP").to_string();
            let node_port = p.get("nodePort").and_then(|v| v.as_u64());

            let mut row = div().w_full().flex().items_center().px(px(20.0)).py(px(12.0));
            if idx < count - 1 { row = row.border_b_1().border_color(colors.border); }

            row.child(
                div().flex_1().flex().items_center().gap(px(16.0))
                    .child(div().w(px(100.0)).flex_shrink_0().text_size(px(13.0)).text_color(colors.text).font_weight(FontWeight::MEDIUM).child(name))
                    .child(div().text_size(px(13.0)).text_color(colors.text_secondary).child(format!("{}:{}/{}", port, target, proto)))
                    .when(node_port.is_some(), |el: Div| {
                        el.child(
                            div().px(px(8.0)).py(px(2.0)).rounded(px(4.0)).bg(colors.primary.opacity(0.1))
                                .text_size(px(11.0)).text_color(colors.primary).child(format!("NodePort: {}", node_port.unwrap()))
                        )
                    })
            )
        }).collect();

        self.render_card(cx, "Ports", Some(format!("{} port{}", count, if count != 1 { "s" } else { "" })),
            div().flex().flex_col().children(port_items)
        )
    }

    // ── Ingress rules card ──────────────────────────────────────────────

    fn render_rules_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let rules = get_json_array(&resource.spec, &["rules"]).unwrap_or_default();
        let count = rules.len();

        let rule_items: Vec<Div> = rules.iter().enumerate().map(|(idx, rule)| {
            let host = rule.get("host").and_then(|v| v.as_str()).unwrap_or("*").to_string();
            let paths = rule.get("http").and_then(|h| h.get("paths")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let paths_text: Vec<String> = paths.iter().map(|p| {
                let path = p.get("path").and_then(|v| v.as_str()).unwrap_or("/");
                let backend_svc = p.get("backend").and_then(|b| b.get("service")).and_then(|s| s.get("name")).and_then(|v| v.as_str()).unwrap_or("-");
                let backend_port = p.get("backend").and_then(|b| b.get("service")).and_then(|s| s.get("port")).and_then(|p| p.get("number")).and_then(|v| v.as_u64()).unwrap_or(0);
                format!("{} → {}:{}", path, backend_svc, backend_port)
            }).collect();

            let mut row = div().w_full().px(px(20.0)).py(px(14.0)).flex().flex_col().gap(px(6.0));
            if idx < count - 1 { row = row.border_b_1().border_color(colors.border); }

            row.child(div().text_size(px(14.0)).text_color(colors.text).font_weight(FontWeight::MEDIUM).child(host))
                .children(paths_text.into_iter().map(|p| {
                    div().text_size(px(12.0)).text_color(colors.text_secondary).child(p)
                }).collect::<Vec<_>>())
        }).collect();

        self.render_card(cx, "Rules", Some(format!("{} rule{}", count, if count != 1 { "s" } else { "" })),
            div().flex().flex_col().children(rule_items)
        )
    }

    // ── Data keys card (ConfigMap / Secret) ──────────────────────────────

    fn render_data_keys_card(&self, cx: &Context<'_, Self>, resource: &Resource, masked: bool) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let keys: Vec<String> = resource.data.as_ref()
            .and_then(|d| d.as_object())
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        let count = keys.len();

        let key_items: Vec<Div> = keys.iter().enumerate().map(|(idx, key)| {
            let value_preview = if masked {
                "••••••••".to_string()
            } else {
                resource.data.as_ref()
                    .and_then(|d| d.get(key))
                    .and_then(|v| v.as_str())
                    .map(|s| if s.len() > 80 { format!("{}...", &s[..80]) } else { s.to_string() })
                    .unwrap_or_else(|| "-".into())
            };

            let mut row = div().w_full().flex().items_center().px(px(20.0)).py(px(12.0));
            if idx < count - 1 { row = row.border_b_1().border_color(colors.border); }

            row.child(
                div().w(px(200.0)).flex_shrink_0()
                    .overflow_hidden().whitespace_nowrap().text_ellipsis()
                    .text_size(px(13.0)).text_color(colors.text).font_weight(FontWeight::MEDIUM).child(key.clone())
            ).child(
                div().flex_1().min_w(px(0.0))
                    .overflow_hidden().whitespace_nowrap().text_ellipsis()
                    .text_size(px(12.0)).text_color(colors.text_muted).child(value_preview)
            )
        }).collect();

        let title = if masked { "Data (masked)" } else { "Data" };
        self.render_card(cx, title, Some(format!("{} key{}", count, if count != 1 { "s" } else { "" })),
            if count == 0 {
                div().p(px(20.0)).child(
                    div().text_size(px(13.0)).text_color(colors.text_muted).child("No data keys")
                ).into_any_element()
            } else {
                div().flex().flex_col().children(key_items).into_any_element()
            }
        )
    }

    // ── Node conditions card ────────────────────────────────────────────

    fn render_conditions_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let conditions = resource.status.as_ref()
            .and_then(|s| s.get("conditions"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let count = conditions.len();

        let items: Vec<Div> = conditions.iter().enumerate().map(|(idx, c)| {
            let cond_type = c.get("type").and_then(|v| v.as_str()).unwrap_or("-").to_string();
            let status = c.get("status").and_then(|v| v.as_str()).unwrap_or("-").to_string();
            let reason = c.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let is_ok = (cond_type == "Ready" && status == "True") || (cond_type != "Ready" && status == "False");
            let dot_color = if is_ok { colors.success } else { colors.error };

            let mut row = div().w_full().flex().items_center().px(px(20.0)).py(px(12.0));
            if idx < count - 1 { row = row.border_b_1().border_color(colors.border); }

            row.child(div().size(px(8.0)).rounded_full().bg(dot_color).flex_shrink_0())
                .child(div().w(px(16.0)))
                .child(div().w(px(140.0)).flex_shrink_0().text_size(px(13.0)).text_color(colors.text).font_weight(FontWeight::MEDIUM).child(cond_type))
                .child(div().w(px(60.0)).flex_shrink_0().text_size(px(13.0)).text_color(colors.text_secondary).child(status))
                .child(div().flex_1().min_w(px(0.0)).overflow_hidden().whitespace_nowrap().text_ellipsis().text_size(px(12.0)).text_color(colors.text_muted).child(reason))
        }).collect();

        self.render_card(cx, "Conditions", Some(format!("{} condition{}", count, if count != 1 { "s" } else { "" })),
            div().flex().flex_col().children(items)
        )
    }

    // ── Namespace resource quotas placeholder ───────────────────────────

    fn render_resource_quotas_card(&self, cx: &Context<'_, Self>, _resource: &Resource) -> impl IntoElement {
        let colors = &theme(cx).colors;
        self.render_card(cx, "Resource Quotas", None,
            div().p(px(20.0)).child(
                div().text_size(px(13.0)).text_color(colors.text_muted).child("No resource quotas configured")
            )
        )
    }

    // ── Annotations card (right column) ─────────────────────────────────

    fn render_annotations_card(&self, cx: &Context<'_, Self>, resource: &Resource) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let annotations: Vec<(String, String)> = resource.metadata.annotations
            .as_ref()
            .map(|a| a.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        let ann_count = annotations.len();

        let ann_items: Vec<Div> = annotations.iter().enumerate().map(|(idx, (k, v))| {
            let mut row = div().w_full().flex().flex_col().gap(px(4.0)).px(px(20.0)).py(px(12.0));
            if idx < ann_count - 1 { row = row.border_b_1().border_color(colors.border); }

            row.child(
                div().overflow_hidden().whitespace_nowrap().text_ellipsis()
                    .text_size(px(12.0)).text_color(colors.text).font_weight(FontWeight::MEDIUM).child(k.clone())
            ).child(
                div().overflow_hidden().whitespace_nowrap().text_ellipsis()
                    .text_size(px(11.0)).text_color(colors.text_muted).child(v.clone())
            )
        }).collect();

        div()
            .flex()
            .flex_col()
            .gap(px(24.0))
            .child(self.render_labels_card(cx, resource))
            .child(
                self.render_card(cx, "Annotations", Some(format!("{} annotation{}", ann_count, if ann_count != 1 { "s" } else { "" })),
                    if ann_count == 0 {
                        div().p(px(20.0)).child(
                            div().text_size(px(13.0)).text_color(colors.text_muted).child("No annotations")
                        ).into_any_element()
                    } else {
                        div().flex().flex_col().children(ann_items).into_any_element()
                    }
                )
            )
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

        let badges: Vec<Div> = labels.iter().map(|(k, v)| {
            div().px(px(12.0)).py(px(6.0)).rounded(px(6.0)).bg(colors.surface_elevated)
                .flex().items_center()
                .child(div().text_size(px(12.0)).text_color(colors.text_secondary).child(format!("{}={}", k, v)))
        }).collect();

        self.render_card(cx, "Labels", Some(format!("{} label{}", count, if count != 1 { "s" } else { "" })),
            div().p(px(20.0)).flex().flex_wrap().gap(px(8.0)).children(badges)
        )
    }

    // ── Resource stat ───────────────────────────────────────────────────

    fn render_resource_stat(&self, cx: &Context<'_, Self>, label: &str, value: &str, unit: &str, limit: Option<&str>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let mut card = div().flex_1().p(px(16.0)).rounded(px(8.0)).bg(colors.surface_elevated)
            .flex().flex_col().gap(px(8.0))
            .child(div().text_size(px(11.0)).text_color(colors.text_muted).font_weight(FontWeight::SEMIBOLD).child(label.to_string()))
            .child(
                div().flex().items_end().gap(px(4.0))
                    .child(div().text_size(px(24.0)).text_color(colors.text).font_weight(FontWeight::BOLD).child(value.to_string()))
                    .child(div().text_size(px(14.0)).text_color(colors.text_muted).child(unit.to_string()))
            );
        if let Some(l) = limit {
            card = card.child(div().text_size(px(11.0)).text_color(colors.text_muted).child(l.to_string()));
        }
        card
    }

    // ── Card wrapper ────────────────────────────────────────────────────

    fn render_card(&self, cx: &Context<'_, Self>, title: impl Into<SharedString>, count: Option<String>, content: impl IntoElement) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let mut header = div().w_full().px(px(20.0)).py(px(16.0)).border_b_1().border_color(colors.border)
            .flex().items_center().justify_between()
            .child(div().text_size(px(15.0)).text_color(colors.text).font_weight(FontWeight::SEMIBOLD).child(title.into()));

        if let Some(c) = count {
            header = header.child(div().text_size(px(12.0)).text_color(colors.text_secondary).child(c));
        }

        div().rounded(px(12.0)).border_1().border_color(colors.border).bg(colors.surface).overflow_hidden()
            .child(header).child(content)
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

fn get_spec_int(r: &Resource, key: &str) -> u64 {
    r.spec.as_ref().and_then(|s| s.get(key)).and_then(|v| v.as_u64()).unwrap_or(0)
}

fn get_status_int(r: &Resource, key: &str) -> u64 {
    r.status.as_ref().and_then(|s| s.get(key)).and_then(|v| v.as_u64()).unwrap_or(0)
}

fn get_status_str(r: &Resource, path: &[&str]) -> Option<String> {
    let mut current = r.status.as_ref()?;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(|s| s.to_string())
}

fn get_capacity_str(r: &Resource, key: &str) -> String {
    r.status.as_ref()
        .and_then(|s| s.get("capacity"))
        .and_then(|c| c.get(key))
        .and_then(|v| v.as_str())
        .unwrap_or("-")
        .to_string()
}

fn is_node_ready(r: &Resource) -> bool {
    r.status.as_ref()
        .and_then(|s| s.get("conditions"))
        .and_then(|v| v.as_array())
        .map(|conds| {
            conds.iter().any(|c| {
                c.get("type").and_then(|t| t.as_str()) == Some("Ready")
                    && c.get("status").and_then(|s| s.as_str()) == Some("True")
            })
        })
        .unwrap_or(false)
}
