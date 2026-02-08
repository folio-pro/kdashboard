use std::sync::Arc;

use gpui::*;
use gpui_component::highlighter::{LanguageConfig, LanguageRegistry, HighlightTheme};
use gpui_component::theme::Theme as GpuiTheme;

#[derive(Clone)]
pub struct ThemeColors {
    // Background colors
    pub background: Hsla,
    pub surface: Hsla,
    pub surface_elevated: Hsla,

    // Text colors
    pub text: Hsla,
    pub text_secondary: Hsla,
    pub text_muted: Hsla,
    pub text_accent: Hsla,

    // Border colors
    pub border: Hsla,
    pub border_focused: Hsla,

    // Status colors
    pub success: Hsla,
    pub warning: Hsla,
    pub error: Hsla,
    pub info: Hsla,

    // Interactive colors
    pub primary: Hsla,
    pub primary_hover: Hsla,
    pub secondary: Hsla,
    pub secondary_hover: Hsla,

    // Selection colors
    pub selection: Hsla,
    pub selection_hover: Hsla,
}

impl Default for ThemeColors {
    fn default() -> Self {
        Self::dark()
    }
}

impl ThemeColors {
    /// Slate/Navy dark theme with Cyan accent (based on Pencil design system)
    pub fn dark() -> Self {
        Self {
            // Background - Slate Navy (#0A0F1C, #1E293B, #0F172A)
            background: hsla(220.0 / 360.0, 0.47, 0.075, 1.0),   // #0A0F1C
            surface: hsla(217.0 / 360.0, 0.33, 0.175, 1.0),      // #1E293B
            surface_elevated: hsla(222.0 / 360.0, 0.47, 0.112, 1.0), // #0F172A

            // Text - White / Slate (#FFFFFF, #94A3B8, #64748B)
            text: hsla(0.0, 0.0, 1.0, 1.0),                      // #FFFFFF
            text_secondary: hsla(215.0 / 360.0, 0.20, 0.65, 1.0), // #94A3B8
            text_muted: hsla(215.0 / 360.0, 0.16, 0.47, 1.0),    // #64748B
            text_accent: hsla(188.0 / 360.0, 0.86, 0.53, 1.0),   // #22D3EE

            // Border - Slate (#334155)
            border: hsla(215.0 / 360.0, 0.25, 0.27, 1.0),        // #334155
            border_focused: hsla(188.0 / 360.0, 0.86, 0.53, 1.0), // #22D3EE

            // Status - Tailwind (#22C55E, #F59E0B, #EF4444, #22D3EE)
            success: hsla(142.0 / 360.0, 0.71, 0.45, 1.0),       // #22C55E
            warning: hsla(38.0 / 360.0, 0.92, 0.50, 1.0),        // #F59E0B
            error: hsla(0.0, 0.84, 0.60, 1.0),                    // #EF4444
            info: hsla(188.0 / 360.0, 0.86, 0.53, 1.0),          // #22D3EE

            // Interactive - Cyan Accent
            primary: hsla(188.0 / 360.0, 0.86, 0.53, 1.0),       // #22D3EE
            primary_hover: hsla(189.0 / 360.0, 0.95, 0.43, 1.0), // #06B6D4
            secondary: hsla(217.0 / 360.0, 0.33, 0.175, 1.0),    // #1E293B (surface)
            secondary_hover: hsla(215.0 / 360.0, 0.25, 0.27, 1.0), // #334155

            // Selection
            selection: hsla(188.0 / 360.0, 0.86, 0.53, 0.15),
            selection_hover: hsla(188.0 / 360.0, 0.86, 0.53, 0.25),
        }
    }

    pub fn light() -> Self {
        Self {
            // Background
            background: hsla(0.0, 0.0, 0.98, 1.0),
            surface: hsla(0.0, 0.0, 1.0, 1.0),
            surface_elevated: hsla(0.0, 0.0, 1.0, 1.0),

            // Text
            text: hsla(0.0, 0.0, 0.10, 1.0),
            text_secondary: hsla(0.0, 0.0, 0.40, 1.0),
            text_muted: hsla(0.0, 0.0, 0.45, 1.0),
            text_accent: hsla(210.0 / 360.0, 0.9, 0.4, 1.0),

            // Border
            border: hsla(0.0, 0.0, 0.85, 1.0),
            border_focused: hsla(210.0 / 360.0, 0.9, 0.5, 1.0),

            // Status
            success: hsla(142.0 / 360.0, 0.71, 0.35, 1.0),
            warning: hsla(38.0 / 360.0, 0.92, 0.45, 1.0),
            error: hsla(0.0, 0.84, 0.50, 1.0),
            info: hsla(210.0 / 360.0, 0.9, 0.5, 1.0),

            // Interactive
            primary: hsla(210.0 / 360.0, 0.9, 0.5, 1.0),
            primary_hover: hsla(210.0 / 360.0, 0.9, 0.4, 1.0),
            secondary: hsla(0.0, 0.0, 0.90, 1.0),
            secondary_hover: hsla(0.0, 0.0, 0.85, 1.0),

            // Selection
            selection: hsla(210.0 / 360.0, 0.9, 0.5, 0.15),
            selection_hover: hsla(210.0 / 360.0, 0.9, 0.5, 0.25),
        }
    }
}

#[derive(Clone)]
pub struct Theme {
    pub colors: ThemeColors,
    /// Monospace font for data values, code (JetBrains Mono)
    pub font_family: SharedString,
    /// UI/sans font for labels, titles, navigation (Inter)
    pub font_family_ui: SharedString,
    pub font_size: Pixels,
    pub font_size_small: Pixels,
    pub font_size_large: Pixels,
    pub font_size_xs: Pixels,
    pub font_size_title: Pixels,
    pub line_height: f32,
    pub spacing_unit: Pixels,
    pub border_radius: Pixels,
    pub border_radius_sm: Pixels,
    pub border_radius_md: Pixels,
    pub border_radius_lg: Pixels,
    pub border_radius_full: Pixels,
    pub status_badge_opacity: f32,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            colors: ThemeColors::dark(),
            font_family: "JetBrains Mono".into(),
            font_family_ui: "Inter".into(),
            font_size: px(13.0),
            font_size_small: px(11.0),
            font_size_large: px(15.0),
            font_size_xs: px(10.0),
            font_size_title: px(24.0),
            line_height: 1.5,
            spacing_unit: px(4.0),
            border_radius: px(4.0),
            border_radius_sm: px(4.0),
            border_radius_md: px(8.0),
            border_radius_lg: px(12.0),
            border_radius_full: px(100.0),
            status_badge_opacity: 0.12,
        }
    }
}

impl Global for Theme {}

/// Apply our Slate/Navy dark colors to gpui-component's theme system.
fn apply_k8s_theme(cx: &mut App) {
    let colors = ThemeColors::dark();

    GpuiTheme::change(gpui_component::theme::ThemeMode::Dark, None, cx);

    let theme = GpuiTheme::global_mut(cx);
    {
        let tc = &mut theme.colors;

        // Background & Surface
        tc.background = colors.background;
        tc.foreground = colors.text;
        tc.accent = colors.surface_elevated;
        tc.accent_foreground = colors.text;
        tc.muted = colors.surface;
        tc.muted_foreground = colors.text_secondary;

        // Borders
        tc.border = colors.border;
        tc.ring = colors.border_focused;
        tc.input = colors.border;

        // Primary (Zed Accent Blue)
        tc.primary = colors.primary;
        tc.primary_hover = colors.primary_hover;
        tc.primary_foreground = hsla(0.0, 0.0, 1.0, 1.0);

        // Secondary
        tc.secondary = colors.secondary;
        tc.secondary_hover = colors.secondary_hover;
        tc.secondary_foreground = colors.text;

        // Status colors
        tc.success = colors.success;
        tc.success_hover = colors.success;
        tc.success_foreground = hsla(0.0, 0.0, 1.0, 1.0);

        tc.warning = colors.warning;
        tc.warning_hover = colors.warning;
        tc.warning_foreground = hsla(0.0, 0.0, 0.0, 1.0);

        tc.danger = colors.error;
        tc.danger_hover = colors.error;
        tc.danger_foreground = hsla(0.0, 0.0, 1.0, 1.0);

        tc.info = colors.info;
        tc.info_hover = colors.info;
        tc.info_foreground = hsla(0.0, 0.0, 1.0, 1.0);

        // Selection
        tc.selection = colors.selection;

        // Sidebar
        tc.sidebar = colors.surface;
        tc.sidebar_foreground = colors.text;
        tc.sidebar_border = colors.border;
        tc.sidebar_primary = colors.primary;
        tc.sidebar_primary_foreground = hsla(0.0, 0.0, 1.0, 1.0);
        tc.sidebar_accent = colors.surface_elevated;
        tc.sidebar_accent_foreground = colors.text;

        // List & Table
        tc.list = colors.surface;
        tc.list_hover = colors.selection_hover;
        tc.list_active = colors.selection;

        tc.table = colors.surface;
        tc.table_hover = colors.selection_hover;
        tc.table_active = colors.selection;
        tc.table_head = colors.surface_elevated;

        // Title bar
        tc.title_bar = colors.background;
        tc.title_bar_border = colors.border;

        // Popover
        tc.popover = colors.surface_elevated;
        tc.popover_foreground = colors.text;

        // Link
        tc.link = colors.primary;
        tc.link_hover = colors.primary_hover;
    }

    // Apply Pencil editor syntax highlighting colors
    let pencil_highlight: HighlightTheme = serde_json::from_str(r##"{
        "name": "Pencil Dark",
        "appearance": "dark",
        "style": {
            "editor.background": "#1e293bff",
            "editor.foreground": "#cbd5e1ff",
            "editor.line_number": "#64748bff",
            "editor.active_line.background": "#253347ff",
            "editor.active_line_number": "#94a3b8ff",
            "syntax": {
                "keyword":               { "color": "#22d3eeff" },
                "type":                  { "color": "#22d3eeff" },
                "constant":              { "color": "#f59e0bff" },
                "boolean":               { "color": "#a3e635ff" },
                "function":              { "color": "#22d3eeff" },
                "property":              { "color": "#7dd3fcff" },
                "tag":                   { "color": "#7dd3fcff" },
                "attribute":             { "color": "#7dd3fcff" },
                "label":                 { "color": "#7dd3fcff" },
                "string":               { "color": "#ff8400ff" },
                "string.escape":         { "color": "#ff8400ff" },
                "string.regex":          { "color": "#ff8400ff" },
                "string.special":        { "color": "#7dd3fcff" },
                "string.special.symbol": { "color": "#7dd3fcff" },
                "number":               { "color": "#ff8400ff" },
                "punctuation":           { "color": "#64748bff" },
                "punctuation.bracket":   { "color": "#64748bff" },
                "punctuation.delimiter": { "color": "#64748bff" },
                "punctuation.special":   { "color": "#64748bff" },
                "punctuation.list_marker": { "color": "#64748bff" },
                "operator":             { "color": "#64748bff" },
                "comment":              { "color": "#64748bff", "font_style": "italic" },
                "comment_doc":          { "color": "#64748bff", "font_style": "italic" },
                "variable":             { "color": "#7dd3fcff" },
                "variable.special":     { "color": "#7dd3fcff" },
                "primary":              { "color": "#ffffffff" },
                "title":                { "color": "#7dd3fcff" },
                "text.literal":         { "color": "#ff8400ff" },
                "embedded":             { "color": "#22d3eeff" },
                "enum":                 { "color": "#22d3eeff" },
                "variant":              { "color": "#22d3eeff" },
                "constructor":          { "color": "#22d3eeff" },
                "link_text":            { "color": "#94a3b8ff" },
                "link_uri":             { "color": "#22d3eeff" }
            }
        }
    }"##)
    .expect("valid Pencil highlight theme JSON");

    theme.highlight_theme = Arc::new(pencil_highlight);
}

/// Extend YAML highlights so any mapping key is captured as `@property`.
/// This avoids relying on specific key names and fixes inconsistent key coloring.
fn register_yaml_highlight_overrides() {
    let registry = LanguageRegistry::singleton();
    let Some(base_yaml) = registry.language("yaml") else {
        return;
    };

    let mut highlights = base_yaml.highlights.to_string();
    highlights.push_str(
        r#"

; Generic key highlighting: capture any YAML mapping key as @property.
(block_mapping_pair
  key: (flow_node
    (_) @property))

(flow_mapping
  (_
    key: (flow_node
      (_) @property)))
"#,
    );

    registry.register(
        "yaml",
        &LanguageConfig::new(
            "yaml",
            base_yaml.language,
            base_yaml.injection_languages.clone(),
            &highlights,
            &base_yaml.injections,
            &base_yaml.locals,
        ),
    );
}

pub fn init(cx: &mut App) {
    // Initialize gpui-component first
    gpui_component::init(cx);

    // Ensure YAML keys are highlighted consistently before applying theme.
    register_yaml_highlight_overrides();

    // Apply our custom Zed dark theme colors
    apply_k8s_theme(cx);

    // Set our Theme global for backwards compatibility
    cx.set_global(Theme::default());
}

pub fn theme(cx: &App) -> &Theme {
    cx.global::<Theme>()
}

pub fn with_theme<R>(cx: &App, f: impl FnOnce(&Theme) -> R) -> R {
    f(theme(cx))
}
