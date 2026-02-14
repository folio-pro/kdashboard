use gpui::*;
use k8s_client::Resource;
use serde_json::Value;
use std::collections::BTreeMap;
use ui::{theme, Icon, IconName};

// ── Helper functions ────────────────────────────────────────────────────

pub fn format_relative_time(resource: &Resource) -> String {
    if let Some(ts) = &resource.metadata.creation_timestamp {
        if let Ok(date) = chrono::DateTime::parse_from_rfc3339(ts) {
            let now = chrono::Utc::now();
            let duration = now.signed_duration_since(date);
            if duration.num_days() > 0 {
                return format!(
                    "{} day{} ago",
                    duration.num_days(),
                    if duration.num_days() != 1 { "s" } else { "" }
                );
            } else if duration.num_hours() > 0 {
                return format!(
                    "{} hour{} ago",
                    duration.num_hours(),
                    if duration.num_hours() != 1 { "s" } else { "" }
                );
            } else {
                let mins = duration.num_minutes().max(1);
                return format!("{} min{} ago", mins, if mins != 1 { "s" } else { "" });
            }
        }
    }
    "Unknown".to_string()
}

pub fn format_timestamp(ts: &str) -> String {
    if ts == "-" {
        return ts.to_string();
    }
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(ts) {
        date.format("%Y-%m-%d %H:%M:%S UTC").to_string()
    } else {
        ts.to_string()
    }
}

pub fn parse_resource_value(value: &str) -> (String, String) {
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

pub fn get_json_str(value: &Option<Value>, path: &[&str]) -> Option<String> {
    let mut current = value.as_ref()?;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(|s| s.to_string())
}

pub fn get_json_array(value: &Option<Value>, path: &[&str]) -> Option<Vec<Value>> {
    let mut current = value.as_ref()?;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_array().cloned()
}

/// Check if all selector key-value pairs exist in the pod's labels.
pub fn labels_match_selector(
    pod_labels: &Option<BTreeMap<String, String>>,
    selector: &BTreeMap<String, String>,
) -> bool {
    let Some(labels) = pod_labels else {
        return false;
    };
    selector.iter().all(|(k, v)| labels.get(k) == Some(v))
}

pub fn compute_diff_with_colors(
    original: &str,
    current: &str,
    colors: &ui::ThemeColors,
) -> Vec<Div> {
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
                .text_color(colors.text_secondary)
                .child("No changes detected."),
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
                        .text_color(colors.text_secondary)
                        .whitespace_nowrap()
                        .child(format!("  {}", o)),
                );
            }
            (Some(o), Some(c)) => {
                result.push(
                    div()
                        .px(px(12.0))
                        .py(px(1.0))
                        .bg(colors.error.opacity(0.1))
                        .text_size(px(13.0))
                        .text_color(colors.error)
                        .whitespace_nowrap()
                        .child(format!("- {}", o)),
                );
                result.push(
                    div()
                        .px(px(12.0))
                        .py(px(1.0))
                        .bg(colors.success.opacity(0.1))
                        .text_size(px(13.0))
                        .text_color(colors.success)
                        .whitespace_nowrap()
                        .child(format!("+ {}", c)),
                );
            }
            (Some(o), None) => {
                result.push(
                    div()
                        .px(px(12.0))
                        .py(px(1.0))
                        .bg(colors.error.opacity(0.1))
                        .text_size(px(13.0))
                        .text_color(colors.error)
                        .whitespace_nowrap()
                        .child(format!("- {}", o)),
                );
            }
            (None, Some(c)) => {
                result.push(
                    div()
                        .px(px(12.0))
                        .py(px(1.0))
                        .bg(colors.success.opacity(0.1))
                        .text_size(px(13.0))
                        .text_color(colors.success)
                        .whitespace_nowrap()
                        .child(format!("+ {}", c)),
                );
            }
            (None, None) => {}
        }
    }

    result
}

pub fn compute_diff(original: &str, current: &str) -> Vec<Div> {
    let colors = ui::ThemeColors::dark();
    compute_diff_with_colors(original, current, &colors)
}

// ── Shared types ────────────────────────────────────────────────────────

#[allow(dead_code)]
pub enum EventType {
    Success,
    Info,
    Warning,
    Error,
}

pub struct ResourceEvent {
    pub title: String,
    pub description: String,
    pub time: String,
    pub event_type: EventType,
}

// ── Shared render functions ─────────────────────────────────────────────

pub fn render_detail_card(
    cx: &App,
    title: impl Into<SharedString>,
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
                .child(title.into()),
        );

    if let Some(count_text) = count {
        header = header.child(
            div()
                .text_size(px(12.0))
                .text_color(colors.text_secondary)
                .child(count_text),
        );
    }

    div()
        .w_full()
        .rounded(theme.border_radius_lg)
        .border_1()
        .border_color(colors.border)
        .bg(colors.surface)
        .overflow_hidden()
        .child(header)
        .child(content)
}

pub fn render_detail_labels_card(cx: &App, resource: &Resource) -> impl IntoElement {
    let theme = theme(cx);
    let colors = &theme.colors;

    let labels: Vec<(String, String)> = resource
        .metadata
        .labels
        .as_ref()
        .map(|l| l.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    let count = labels.len();

    let label_badges: Vec<Div> = labels
        .iter()
        .map(|(k, v)| {
            div()
                .px(px(12.0))
                .py(px(6.0))
                .rounded(theme.border_radius_md)
                .bg(colors.surface_elevated)
                .flex()
                .items_center()
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(colors.text_secondary)
                        .child(format!("{}={}", k, v)),
                )
        })
        .collect();

    render_detail_card(
        cx,
        "Labels",
        Some(format!(
            "{} label{}",
            count,
            if count != 1 { "s" } else { "" }
        )),
        div()
            .p(px(20.0))
            .flex()
            .flex_wrap()
            .gap(px(8.0))
            .children(label_badges),
    )
}

pub fn render_detail_resource_stat(
    cx: &App,
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
        .rounded(theme.border_radius_md)
        .bg(colors.surface_elevated)
        .flex()
        .flex_col()
        .gap(px(8.0))
        .child(
            div()
                .text_size(px(11.0))
                .text_color(colors.text_muted)
                .font_weight(FontWeight::SEMIBOLD)
                .child(label.to_string()),
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
                        .child(value.to_string()),
                )
                .child(
                    div()
                        .text_size(px(14.0))
                        .text_color(colors.text_muted)
                        .child(unit.to_string()),
                ),
        );

    if let Some(limit_text) = limit {
        card = card.child(
            div()
                .text_size(px(11.0))
                .text_color(colors.text_muted)
                .child(limit_text.to_string()),
        );
    }

    card
}

pub fn render_detail_info_rows(
    colors: &ui::ThemeColors,
    rows: Vec<(&str, String, Option<Hsla>)>,
) -> Vec<Div> {
    let total = rows.len();
    rows.into_iter()
        .enumerate()
        .map(|(idx, (label, value, value_color))| {
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

            row.child(
                div()
                    .w(px(140.0))
                    .flex_shrink_0()
                    .text_size(px(13.0))
                    .text_color(colors.text_secondary)
                    .child(label.to_string()),
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
                    .child(value),
            )
        })
        .collect()
}

pub fn render_detail_events_card(cx: &App, events: Vec<ResourceEvent>) -> impl IntoElement {
    let theme = theme(cx);
    let colors = &theme.colors;

    let count = events.len();
    let total = events.len();

    let event_items: Vec<Div> = events
        .into_iter()
        .enumerate()
        .map(|(idx, event)| {
            let is_last = idx == total - 1;

            let (icon_color, icon_bg, icon_name) = match event.event_type {
                EventType::Success => (
                    colors.success,
                    colors.success.opacity(0.12),
                    IconName::Check,
                ),
                EventType::Info => (
                    colors.primary,
                    colors.primary.opacity(0.12),
                    IconName::Download,
                ),
                EventType::Warning => (
                    colors.warning,
                    colors.warning.opacity(0.12),
                    IconName::Warning,
                ),
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

            row.child(
                div()
                    .size(px(28.0))
                    .rounded_full()
                    .bg(icon_bg)
                    .flex()
                    .items_center()
                    .justify_center()
                    .flex_shrink_0()
                    .child(Icon::new(icon_name).size(px(14.0)).color(icon_color)),
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
                            .child(event.title),
                    )
                    .child(
                        div()
                            .text_size(px(12.0))
                            .text_color(colors.text_secondary)
                            .child(event.description),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .text_color(colors.text_muted)
                            .child(event.time),
                    ),
            )
        })
        .collect();

    render_detail_card(
        cx,
        "Events",
        Some(format!(
            "{} event{}",
            count,
            if count != 1 { "s" } else { "" }
        )),
        div().w_full().flex().flex_col().children(event_items),
    )
}

// ── YAML editor macro ───────────────────────────────────────────────────
//
// Generates render_edit_button, render_yaml_view, render_editor_tabs,
// and render_editor_content methods for detail view structs.
//
// Requires the struct to have these fields:
//   resource: Resource, active_tab: DetailTab, editor_sub_tab: EditorSubTab,
//   yaml_editor: Option<Entity<YamlEditor>>, original_yaml: String,
//   yaml_valid: Option<bool>
//
// The expansion site must have these imports in scope:
//   gpui::*, ui::{theme, secondary_btn, back_btn, primary_btn, editor_tab, IconName},
//   editor::YamlEditor, crate::detail_tabs::{DetailTab, EditorSubTab},
//   crate::detail_shared::compute_diff

macro_rules! impl_yaml_editor_methods {
    () => {
        fn render_edit_button(&self, cx: &Context<'_, Self>) -> impl IntoElement {
            let theme = ui::theme(cx);
            let colors = &theme.colors;
            ui::secondary_btn("edit-yaml-btn", ui::IconName::Edit, "Edit", colors).on_click(
                cx.listener(|this, _event, _window, cx| {
                    this.active_tab = DetailTab::Yaml;
                    cx.notify();
                }),
            )
        }

        fn render_yaml_view(
            &mut self,
            _window: &mut Window,
            cx: &mut Context<'_, Self>,
        ) -> impl IntoElement {
            if self.yaml_editor.is_none() {
                let yaml = editor::resource_to_yaml(&self.resource)
                    .unwrap_or_else(|e| format!("# Error serializing resource: {}", e));
                self.original_yaml = yaml.clone();
                let editor_entity = cx.new(|_cx| YamlEditor::new(yaml));
                self.yaml_editor = Some(editor_entity);
            }

            let theme = ui::theme(cx);
            let colors = &theme.colors;

            let valid_badge: Option<(&str, Hsla)> = match self.yaml_valid {
                Some(true) => Some(("Valid YAML", colors.success)),
                Some(false) => Some(("Invalid YAML", colors.error)),
                None => None,
            };
            let filename = format!("{}.yaml", self.resource.kind.to_lowercase());
            let subtitle = format!("{} · {}", self.resource.metadata.name, self.resource.kind);

            div()
                .size_full()
                .flex()
                .flex_col()
                .bg(colors.background)
                .child(
                    div()
                        .w_full()
                        .flex()
                        .items_center()
                        .justify_between()
                        .px(px(24.0))
                        .py(px(12.0))
                        .border_b_1()
                        .border_color(colors.border)
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(16.0))
                                .child(ui::back_btn("yaml-back-btn", colors).on_click(cx.listener(
                                    |this, _event, _window, cx| {
                                        this.active_tab = DetailTab::Overview;
                                        this.editor_sub_tab = EditorSubTab::Editor;
                                        cx.notify();
                                    },
                                )))
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(4.0))
                                        .child(
                                            div()
                                                .text_size(px(16.0))
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .font_family(theme.font_family_ui.clone())
                                                .text_color(colors.text)
                                                .child(filename),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(12.0))
                                                .text_color(colors.text_muted)
                                                .child(subtitle),
                                        ),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(12.0))
                                .child(
                                    ui::secondary_btn(
                                        "validate-btn",
                                        ui::IconName::Check,
                                        "Validate",
                                        colors,
                                    )
                                    .on_click(cx.listener(
                                        |this, _event, _window, cx| {
                                            if let Some(editor) = &this.yaml_editor {
                                                let content = editor
                                                    .read(cx)
                                                    .input_entity()
                                                    .map(|i| i.read(cx).text().to_string())
                                                    .unwrap_or_default();
                                                this.yaml_valid =
                                                    Some(editor::validate_yaml(&content));
                                            }
                                            cx.notify();
                                        },
                                    )),
                                )
                                .child(ui::primary_btn(
                                    "apply-btn",
                                    "Apply",
                                    colors.primary,
                                    colors.background,
                                )),
                        ),
                )
                .child(self.render_editor_tabs(cx))
                .child(self.render_editor_content(cx))
                .child(
                    div()
                        .w_full()
                        .h(px(36.0))
                        .flex_shrink_0()
                        .px(px(20.0))
                        .flex()
                        .items_center()
                        .justify_between()
                        .bg(colors.surface)
                        .border_t_1()
                        .border_color(colors.border)
                        .child(div().flex().items_center().when_some(
                            valid_badge,
                            |el: Div, (text, color)| {
                                el.child(
                                    div()
                                        .px(px(10.0))
                                        .py(px(4.0))
                                        .rounded(theme.border_radius_full)
                                        .bg(color.opacity(0.12))
                                        .flex()
                                        .items_center()
                                        .gap(px(6.0))
                                        .child(div().size(px(6.0)).rounded_full().bg(color))
                                        .child(
                                            div()
                                                .text_size(px(12.0))
                                                .text_color(color)
                                                .font_weight(FontWeight::MEDIUM)
                                                .child(text),
                                        ),
                                )
                            },
                        ))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(24.0))
                                .child(
                                    div()
                                        .text_size(px(12.0))
                                        .text_color(colors.text_muted)
                                        .child(format!("Kind: {}", self.resource.kind)),
                                )
                                .child(
                                    div()
                                        .text_size(px(12.0))
                                        .text_color(colors.text_muted)
                                        .child(format!("API: {}", self.resource.api_version)),
                                ),
                        ),
                )
        }

        fn render_editor_tabs(&self, cx: &Context<'_, Self>) -> impl IntoElement {
            let theme = ui::theme(cx);
            let colors = &theme.colors;
            let current = self.editor_sub_tab;
            let tabs: [(&str, EditorSubTab); 3] = [
                ("Editor", EditorSubTab::Editor),
                ("Diff", EditorSubTab::Diff),
                ("History", EditorSubTab::History),
            ];
            let tab_items: Vec<AnyElement> = tabs
                .iter()
                .map(|(label, tab)| {
                    let active = *tab == current;
                    let tab_val = *tab;
                    ui::editor_tab(
                        ElementId::Name((*label).into()),
                        *label,
                        active,
                        colors.primary,
                        colors.text,
                        colors.text_muted,
                    )
                    .on_click(cx.listener(move |this, _e, _w, cx| {
                        this.editor_sub_tab = tab_val;
                        cx.notify();
                    }))
                    .into_any_element()
                })
                .collect();

            div()
                .w_full()
                .px(px(24.0))
                .border_b_1()
                .border_color(colors.border)
                .bg(colors.background)
                .flex()
                .items_center()
                .children(tab_items)
        }

        fn render_editor_content(&self, cx: &Context<'_, Self>) -> AnyElement {
            let theme = ui::theme(cx);
            let colors = &theme.colors;

            match self.editor_sub_tab {
                EditorSubTab::Editor => div()
                    .flex_1()
                    .p(px(24.0))
                    .min_h(px(0.0))
                    .child(
                        div()
                            .size_full()
                            .rounded(theme.border_radius_lg)
                            .border_1()
                            .border_color(colors.border)
                            .bg(colors.surface)
                            .overflow_hidden()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .w_full()
                                    .px(px(20.0))
                                    .py(px(16.0))
                                    .border_b_1()
                                    .border_color(colors.border)
                                    .flex()
                                    .items_center()
                                    .child(
                                        div()
                                            .text_size(px(15.0))
                                            .text_color(colors.text)
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("YAML Configuration"),
                                    ),
                            )
                            .child(self.yaml_editor.as_ref().unwrap().clone()),
                    )
                    .into_any_element(),
                EditorSubTab::Diff => {
                    let current_yaml = self
                        .yaml_editor
                        .as_ref()
                        .and_then(|e| {
                            e.read(cx)
                                .input_entity()
                                .map(|i| i.read(cx).text().to_string())
                        })
                        .unwrap_or_default();
                    let diff_lines = compute_diff(&self.original_yaml, &current_yaml);

                    div()
                        .flex_1()
                        .p(px(24.0))
                        .min_h(px(0.0))
                        .child(
                            div()
                                .size_full()
                                .rounded(theme.border_radius_lg)
                                .border_1()
                                .border_color(colors.border)
                                .bg(colors.surface)
                                .overflow_hidden()
                                .flex()
                                .flex_col()
                                .child(
                                    div()
                                        .w_full()
                                        .px(px(20.0))
                                        .py(px(16.0))
                                        .border_b_1()
                                        .border_color(colors.border)
                                        .flex()
                                        .items_center()
                                        .child(
                                            div()
                                                .text_size(px(15.0))
                                                .text_color(colors.text)
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .child("Changes"),
                                        ),
                                )
                                .child(
                                    div()
                                        .id("diff-scroll")
                                        .flex_1()
                                        .overflow_y_scroll()
                                        .p(px(16.0))
                                        .children(diff_lines),
                                ),
                        )
                        .into_any_element()
                }
                EditorSubTab::History => div()
                    .flex_1()
                    .p(px(24.0))
                    .min_h(px(0.0))
                    .child(
                        div()
                            .size_full()
                            .rounded(theme.border_radius_lg)
                            .border_1()
                            .border_color(colors.border)
                            .bg(colors.surface)
                            .overflow_hidden()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .w_full()
                                    .px(px(20.0))
                                    .py(px(16.0))
                                    .border_b_1()
                                    .border_color(colors.border)
                                    .flex()
                                    .items_center()
                                    .child(
                                        div()
                                            .text_size(px(15.0))
                                            .text_color(colors.text)
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("Original YAML"),
                                    ),
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
                                            .text_color(colors.text_secondary)
                                            .whitespace_nowrap()
                                            .child(self.original_yaml.clone()),
                                    ),
                            ),
                    )
                    .into_any_element(),
            }
        }
    };
}

pub(crate) use impl_yaml_editor_methods;
