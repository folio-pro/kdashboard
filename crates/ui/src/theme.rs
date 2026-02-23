use std::sync::Arc;

use gpui::*;
use gpui_component::highlighter::{HighlightTheme, LanguageConfig, LanguageRegistry};
use gpui_component::theme::Theme as GpuiTheme;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ThemeMode {
    GruvboxLight,
    SolarizedLight,
    EverforestLight,
    RosePineDawn,
    GitHubLight,
    GruvboxDark,
    SolarizedDark,
    #[default]
    EverforestDark,
    DraculaDark,
    MonokaiDark,
}

impl ThemeMode {
    pub fn is_dark(self) -> bool {
        matches!(
            self,
            ThemeMode::GruvboxDark
                | ThemeMode::SolarizedDark
                | ThemeMode::EverforestDark
                | ThemeMode::DraculaDark
                | ThemeMode::MonokaiDark
        )
    }
}

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
        Self::from_mode(ThemeMode::EverforestDark)
    }
}

impl ThemeColors {
    pub fn dark() -> Self {
        Self::from_mode(ThemeMode::EverforestDark)
    }

    pub fn light() -> Self {
        Self::from_mode(ThemeMode::EverforestLight)
    }

    pub fn from_mode(mode: ThemeMode) -> Self {
        match mode {
            ThemeMode::GruvboxDark => Self {
                background: hsla(24.0 / 360.0, 0.14, 0.15, 1.0),
                surface: hsla(24.0 / 360.0, 0.18, 0.20, 1.0),
                surface_elevated: hsla(23.0 / 360.0, 0.18, 0.24, 1.0),
                text: hsla(41.0 / 360.0, 0.37, 0.86, 1.0),
                text_secondary: hsla(35.0 / 360.0, 0.22, 0.70, 1.0),
                text_muted: hsla(31.0 / 360.0, 0.18, 0.54, 1.0),
                text_accent: hsla(34.0 / 360.0, 0.76, 0.61, 1.0),
                border: hsla(24.0 / 360.0, 0.15, 0.32, 1.0),
                border_focused: hsla(34.0 / 360.0, 0.76, 0.61, 1.0),
                success: hsla(95.0 / 360.0, 0.36, 0.52, 1.0),
                warning: hsla(34.0 / 360.0, 0.76, 0.61, 1.0),
                error: hsla(0.0, 0.62, 0.62, 1.0),
                info: hsla(210.0 / 360.0, 0.32, 0.62, 1.0),
                primary: hsla(34.0 / 360.0, 0.76, 0.61, 1.0),
                primary_hover: hsla(34.0 / 360.0, 0.76, 0.54, 1.0),
                secondary: hsla(24.0 / 360.0, 0.18, 0.20, 1.0),
                secondary_hover: hsla(24.0 / 360.0, 0.15, 0.32, 1.0),
                selection: hsla(34.0 / 360.0, 0.76, 0.61, 0.18),
                selection_hover: hsla(34.0 / 360.0, 0.76, 0.61, 0.28),
            },
            ThemeMode::SolarizedDark => Self {
                background: hsla(193.0 / 360.0, 1.0, 0.15, 1.0),
                surface: hsla(192.0 / 360.0, 0.70, 0.20, 1.0),
                surface_elevated: hsla(191.0 / 360.0, 0.56, 0.24, 1.0),
                text: hsla(44.0 / 360.0, 0.87, 0.94, 1.0),
                text_secondary: hsla(45.0 / 360.0, 0.35, 0.76, 1.0),
                text_muted: hsla(45.0 / 360.0, 0.24, 0.63, 1.0),
                text_accent: hsla(18.0 / 360.0, 0.80, 0.58, 1.0),
                border: hsla(190.0 / 360.0, 0.35, 0.34, 1.0),
                border_focused: hsla(18.0 / 360.0, 0.80, 0.58, 1.0),
                success: hsla(68.0 / 360.0, 0.68, 0.45, 1.0),
                warning: hsla(45.0 / 360.0, 0.88, 0.55, 1.0),
                error: hsla(1.0 / 360.0, 0.71, 0.56, 1.0),
                info: hsla(205.0 / 360.0, 0.69, 0.56, 1.0),
                primary: hsla(18.0 / 360.0, 0.80, 0.58, 1.0),
                primary_hover: hsla(18.0 / 360.0, 0.80, 0.50, 1.0),
                secondary: hsla(192.0 / 360.0, 0.70, 0.20, 1.0),
                secondary_hover: hsla(190.0 / 360.0, 0.35, 0.34, 1.0),
                selection: hsla(18.0 / 360.0, 0.80, 0.58, 0.18),
                selection_hover: hsla(18.0 / 360.0, 0.80, 0.58, 0.28),
            },
            ThemeMode::EverforestDark => Self {
                background: hsla(140.0 / 360.0, 0.08, 0.16, 1.0),
                surface: hsla(140.0 / 360.0, 0.09, 0.21, 1.0),
                surface_elevated: hsla(140.0 / 360.0, 0.10, 0.26, 1.0),
                text: hsla(84.0 / 360.0, 0.22, 0.86, 1.0),
                text_secondary: hsla(84.0 / 360.0, 0.16, 0.72, 1.0),
                text_muted: hsla(84.0 / 360.0, 0.12, 0.58, 1.0),
                text_accent: hsla(34.0 / 360.0, 0.63, 0.62, 1.0),
                border: hsla(140.0 / 360.0, 0.11, 0.35, 1.0),
                border_focused: hsla(84.0 / 360.0, 0.34, 0.52, 1.0),
                success: hsla(122.0 / 360.0, 0.39, 0.60, 1.0),
                warning: hsla(34.0 / 360.0, 0.63, 0.62, 1.0),
                error: hsla(8.0 / 360.0, 0.62, 0.61, 1.0),
                info: hsla(84.0 / 360.0, 0.34, 0.52, 1.0),
                primary: hsla(84.0 / 360.0, 0.34, 0.52, 1.0),
                primary_hover: hsla(84.0 / 360.0, 0.34, 0.45, 1.0),
                secondary: hsla(140.0 / 360.0, 0.09, 0.21, 1.0),
                secondary_hover: hsla(140.0 / 360.0, 0.11, 0.35, 1.0),
                selection: hsla(84.0 / 360.0, 0.34, 0.52, 0.18),
                selection_hover: hsla(84.0 / 360.0, 0.34, 0.52, 0.28),
            },
            ThemeMode::DraculaDark => Self {
                background: hsla(231.0 / 360.0, 0.15, 0.18, 1.0),
                surface: hsla(231.0 / 360.0, 0.16, 0.23, 1.0),
                surface_elevated: hsla(231.0 / 360.0, 0.17, 0.29, 1.0),
                text: hsla(60.0 / 360.0, 0.30, 0.96, 1.0),
                text_secondary: hsla(230.0 / 360.0, 0.22, 0.78, 1.0),
                text_muted: hsla(230.0 / 360.0, 0.15, 0.64, 1.0),
                text_accent: hsla(326.0 / 360.0, 0.99, 0.74, 1.0),
                border: hsla(230.0 / 360.0, 0.14, 0.40, 1.0),
                border_focused: hsla(265.0 / 360.0, 0.89, 0.78, 1.0),
                success: hsla(135.0 / 360.0, 0.94, 0.65, 1.0),
                warning: hsla(31.0 / 360.0, 1.0, 0.71, 1.0),
                error: hsla(0.0, 1.0, 0.67, 1.0),
                info: hsla(191.0 / 360.0, 0.97, 0.77, 1.0),
                primary: hsla(265.0 / 360.0, 0.89, 0.78, 1.0),
                primary_hover: hsla(265.0 / 360.0, 0.89, 0.70, 1.0),
                secondary: hsla(231.0 / 360.0, 0.16, 0.23, 1.0),
                secondary_hover: hsla(230.0 / 360.0, 0.14, 0.40, 1.0),
                selection: hsla(265.0 / 360.0, 0.89, 0.78, 0.18),
                selection_hover: hsla(265.0 / 360.0, 0.89, 0.78, 0.28),
            },
            ThemeMode::MonokaiDark => Self {
                background: hsla(60.0 / 360.0, 0.02, 0.11, 1.0),
                surface: hsla(60.0 / 360.0, 0.02, 0.16, 1.0),
                surface_elevated: hsla(60.0 / 360.0, 0.03, 0.22, 1.0),
                text: hsla(60.0 / 360.0, 0.30, 0.90, 1.0),
                text_secondary: hsla(70.0 / 360.0, 0.20, 0.74, 1.0),
                text_muted: hsla(70.0 / 360.0, 0.14, 0.58, 1.0),
                text_accent: hsla(22.0 / 360.0, 0.98, 0.66, 1.0),
                border: hsla(60.0 / 360.0, 0.03, 0.30, 1.0),
                border_focused: hsla(95.0 / 360.0, 0.80, 0.63, 1.0),
                success: hsla(95.0 / 360.0, 0.80, 0.63, 1.0),
                warning: hsla(48.0 / 360.0, 0.89, 0.61, 1.0),
                error: hsla(338.0 / 360.0, 0.82, 0.65, 1.0),
                info: hsla(190.0 / 360.0, 0.80, 0.66, 1.0),
                primary: hsla(95.0 / 360.0, 0.80, 0.63, 1.0),
                primary_hover: hsla(95.0 / 360.0, 0.80, 0.54, 1.0),
                secondary: hsla(60.0 / 360.0, 0.02, 0.16, 1.0),
                secondary_hover: hsla(60.0 / 360.0, 0.03, 0.30, 1.0),
                selection: hsla(95.0 / 360.0, 0.80, 0.63, 0.18),
                selection_hover: hsla(95.0 / 360.0, 0.80, 0.63, 0.28),
            },
            ThemeMode::GruvboxLight => Self {
                background: hsla(42.0 / 360.0, 0.56, 0.95, 1.0),
                surface: hsla(40.0 / 360.0, 0.44, 0.92, 1.0),
                surface_elevated: hsla(0.0, 0.0, 1.0, 1.0),
                text: hsla(24.0 / 360.0, 0.18, 0.24, 1.0),
                text_secondary: hsla(24.0 / 360.0, 0.14, 0.38, 1.0),
                text_muted: hsla(24.0 / 360.0, 0.11, 0.50, 1.0),
                text_accent: hsla(34.0 / 360.0, 0.70, 0.45, 1.0),
                border: hsla(36.0 / 360.0, 0.25, 0.75, 1.0),
                border_focused: hsla(34.0 / 360.0, 0.70, 0.45, 1.0),
                success: hsla(95.0 / 360.0, 0.39, 0.40, 1.0),
                warning: hsla(34.0 / 360.0, 0.70, 0.45, 1.0),
                error: hsla(0.0, 0.62, 0.50, 1.0),
                info: hsla(210.0 / 360.0, 0.34, 0.44, 1.0),
                primary: hsla(34.0 / 360.0, 0.70, 0.45, 1.0),
                primary_hover: hsla(34.0 / 360.0, 0.70, 0.39, 1.0),
                secondary: hsla(40.0 / 360.0, 0.44, 0.92, 1.0),
                secondary_hover: hsla(36.0 / 360.0, 0.25, 0.75, 1.0),
                selection: hsla(34.0 / 360.0, 0.70, 0.45, 0.14),
                selection_hover: hsla(34.0 / 360.0, 0.70, 0.45, 0.22),
            },
            ThemeMode::SolarizedLight => Self {
                background: hsla(44.0 / 360.0, 0.87, 0.94, 1.0),
                surface: hsla(45.0 / 360.0, 0.50, 0.92, 1.0),
                surface_elevated: hsla(0.0, 0.0, 1.0, 1.0),
                text: hsla(193.0 / 360.0, 1.0, 0.15, 1.0),
                text_secondary: hsla(192.0 / 360.0, 0.45, 0.28, 1.0),
                text_muted: hsla(190.0 / 360.0, 0.30, 0.36, 1.0),
                text_accent: hsla(205.0 / 360.0, 0.69, 0.44, 1.0),
                border: hsla(45.0 / 360.0, 0.35, 0.78, 1.0),
                border_focused: hsla(205.0 / 360.0, 0.69, 0.44, 1.0),
                success: hsla(68.0 / 360.0, 0.68, 0.38, 1.0),
                warning: hsla(45.0 / 360.0, 0.88, 0.43, 1.0),
                error: hsla(1.0 / 360.0, 0.71, 0.45, 1.0),
                info: hsla(205.0 / 360.0, 0.69, 0.44, 1.0),
                primary: hsla(205.0 / 360.0, 0.69, 0.44, 1.0),
                primary_hover: hsla(205.0 / 360.0, 0.69, 0.37, 1.0),
                secondary: hsla(45.0 / 360.0, 0.50, 0.92, 1.0),
                secondary_hover: hsla(45.0 / 360.0, 0.35, 0.78, 1.0),
                selection: hsla(205.0 / 360.0, 0.69, 0.44, 0.14),
                selection_hover: hsla(205.0 / 360.0, 0.69, 0.44, 0.22),
            },
            ThemeMode::EverforestLight => Self {
                background: hsla(90.0 / 360.0, 0.35, 0.95, 1.0),
                surface: hsla(90.0 / 360.0, 0.30, 0.92, 1.0),
                surface_elevated: hsla(0.0, 0.0, 1.0, 1.0),
                text: hsla(100.0 / 360.0, 0.11, 0.24, 1.0),
                text_secondary: hsla(100.0 / 360.0, 0.10, 0.36, 1.0),
                text_muted: hsla(100.0 / 360.0, 0.10, 0.44, 1.0),
                text_accent: hsla(34.0 / 360.0, 0.56, 0.42, 1.0),
                border: hsla(90.0 / 360.0, 0.18, 0.78, 1.0),
                border_focused: hsla(84.0 / 360.0, 0.40, 0.38, 1.0),
                success: hsla(122.0 / 360.0, 0.45, 0.35, 1.0),
                warning: hsla(34.0 / 360.0, 0.60, 0.42, 1.0),
                error: hsla(8.0 / 360.0, 0.62, 0.45, 1.0),
                info: hsla(84.0 / 360.0, 0.40, 0.38, 1.0),
                primary: hsla(84.0 / 360.0, 0.40, 0.38, 1.0),
                primary_hover: hsla(84.0 / 360.0, 0.40, 0.32, 1.0),
                secondary: hsla(90.0 / 360.0, 0.30, 0.92, 1.0),
                secondary_hover: hsla(90.0 / 360.0, 0.18, 0.78, 1.0),
                selection: hsla(84.0 / 360.0, 0.34, 0.45, 0.14),
                selection_hover: hsla(84.0 / 360.0, 0.34, 0.45, 0.22),
            },
            ThemeMode::RosePineDawn => Self {
                background: hsla(35.0 / 360.0, 0.44, 0.95, 1.0),
                surface: hsla(34.0 / 360.0, 0.34, 0.92, 1.0),
                surface_elevated: hsla(0.0, 0.0, 1.0, 1.0),
                text: hsla(249.0 / 360.0, 0.20, 0.33, 1.0),
                text_secondary: hsla(249.0 / 360.0, 0.15, 0.45, 1.0),
                text_muted: hsla(249.0 / 360.0, 0.11, 0.56, 1.0),
                text_accent: hsla(2.0 / 360.0, 0.55, 0.57, 1.0),
                border: hsla(24.0 / 360.0, 0.20, 0.80, 1.0),
                border_focused: hsla(2.0 / 360.0, 0.55, 0.57, 1.0),
                success: hsla(152.0 / 360.0, 0.34, 0.44, 1.0),
                warning: hsla(33.0 / 360.0, 0.64, 0.51, 1.0),
                error: hsla(350.0 / 360.0, 0.63, 0.50, 1.0),
                info: hsla(197.0 / 360.0, 0.39, 0.50, 1.0),
                primary: hsla(2.0 / 360.0, 0.55, 0.57, 1.0),
                primary_hover: hsla(2.0 / 360.0, 0.55, 0.50, 1.0),
                secondary: hsla(34.0 / 360.0, 0.34, 0.92, 1.0),
                secondary_hover: hsla(24.0 / 360.0, 0.20, 0.80, 1.0),
                selection: hsla(2.0 / 360.0, 0.55, 0.57, 0.14),
                selection_hover: hsla(2.0 / 360.0, 0.55, 0.57, 0.22),
            },
            ThemeMode::GitHubLight => Self {
                background: hsla(220.0 / 360.0, 0.29, 0.97, 1.0),
                surface: hsla(0.0, 0.0, 1.0, 1.0),
                surface_elevated: hsla(0.0, 0.0, 1.0, 1.0),
                text: hsla(220.0 / 360.0, 0.13, 0.18, 1.0),
                text_secondary: hsla(220.0 / 360.0, 0.10, 0.34, 1.0),
                text_muted: hsla(220.0 / 360.0, 0.10, 0.43, 1.0),
                text_accent: hsla(212.0 / 360.0, 0.92, 0.35, 1.0),
                border: hsla(220.0 / 360.0, 0.16, 0.84, 1.0),
                border_focused: hsla(212.0 / 360.0, 0.92, 0.35, 1.0),
                success: hsla(137.0 / 360.0, 0.60, 0.32, 1.0),
                warning: hsla(39.0 / 360.0, 0.84, 0.40, 1.0),
                error: hsla(0.0, 0.67, 0.42, 1.0),
                info: hsla(212.0 / 360.0, 0.92, 0.35, 1.0),
                primary: hsla(212.0 / 360.0, 0.92, 0.35, 1.0),
                primary_hover: hsla(212.0 / 360.0, 0.92, 0.29, 1.0),
                secondary: hsla(220.0 / 360.0, 0.29, 0.97, 1.0),
                secondary_hover: hsla(220.0 / 360.0, 0.16, 0.84, 1.0),
                selection: hsla(212.0 / 360.0, 0.92, 0.40, 0.14),
                selection_hover: hsla(212.0 / 360.0, 0.92, 0.40, 0.22),
            },
        }
    }
}

#[derive(Clone)]
pub struct Theme {
    pub mode: ThemeMode,
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
            mode: ThemeMode::EverforestDark,
            colors: ThemeColors::from_mode(ThemeMode::EverforestDark),
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

fn highlight_theme_for(mode: ThemeMode) -> HighlightTheme {
    let json = if mode.is_dark() {
        r##"{
        "name": "Pencil Ops Dark",
        "appearance": "dark",
        "style": {
            "editor.background": "#1b221dff",
            "editor.foreground": "#edf2e6ff",
            "editor.line_number": "#95a78fff",
            "editor.active_line.background": "#253026ff",
            "editor.active_line_number": "#c1cfb9ff",
            "syntax": {
                "keyword":               { "color": "#cc7443ff" },
                "type":                  { "color": "#cc7443ff" },
                "constant":              { "color": "#d9a63aff" },
                "boolean":               { "color": "#88a353ff" },
                "function":              { "color": "#cc7443ff" },
                "property":              { "color": "#c1cfb9ff" },
                "tag":                   { "color": "#c1cfb9ff" },
                "attribute":             { "color": "#c1cfb9ff" },
                "label":                 { "color": "#c1cfb9ff" },
                "string":               { "color": "#e0b15aff" },
                "string.escape":         { "color": "#e0b15aff" },
                "string.regex":          { "color": "#e0b15aff" },
                "string.special":        { "color": "#c1cfb9ff" },
                "string.special.symbol": { "color": "#c1cfb9ff" },
                "number":               { "color": "#e0b15aff" },
                "punctuation":           { "color": "#95a78fff" },
                "punctuation.bracket":   { "color": "#95a78fff" },
                "punctuation.delimiter": { "color": "#95a78fff" },
                "punctuation.special":   { "color": "#95a78fff" },
                "punctuation.list_marker": { "color": "#95a78fff" },
                "operator":             { "color": "#95a78fff" },
                "comment":              { "color": "#7c8f75ff", "font_style": "italic" },
                "comment_doc":          { "color": "#7c8f75ff", "font_style": "italic" },
                "variable":             { "color": "#c1cfb9ff" },
                "variable.special":     { "color": "#c1cfb9ff" },
                "primary":              { "color": "#ffffffff" },
                "title":                { "color": "#c1cfb9ff" },
                "text.literal":         { "color": "#e0b15aff" },
                "embedded":             { "color": "#cc7443ff" },
                "enum":                 { "color": "#cc7443ff" },
                "variant":              { "color": "#cc7443ff" },
                "constructor":          { "color": "#cc7443ff" },
                "link_text":            { "color": "#c1cfb9ff" },
                "link_uri":             { "color": "#cc7443ff" }
            }
        }
    }"##
    } else {
        r##"{
        "name": "Pencil Ops Light",
        "appearance": "light",
        "style": {
            "editor.background": "#fafcf2ff",
            "editor.foreground": "#262d24ff",
            "editor.line_number": "#657461ff",
            "editor.active_line.background": "#e4ead9ff",
            "editor.active_line_number": "#475347ff",
            "syntax": {
                "keyword":               { "color": "#a25a25ff" },
                "type":                  { "color": "#a25a25ff" },
                "constant":              { "color": "#b38425ff" },
                "boolean":               { "color": "#6f8b43ff" },
                "function":              { "color": "#a25a25ff" },
                "property":              { "color": "#475347ff" },
                "tag":                   { "color": "#475347ff" },
                "attribute":             { "color": "#475347ff" },
                "label":                 { "color": "#475347ff" },
                "string":               { "color": "#b38425ff" },
                "string.escape":         { "color": "#b38425ff" },
                "string.regex":          { "color": "#b38425ff" },
                "string.special":        { "color": "#475347ff" },
                "string.special.symbol": { "color": "#475347ff" },
                "number":               { "color": "#b38425ff" },
                "punctuation":           { "color": "#657461ff" },
                "punctuation.bracket":   { "color": "#657461ff" },
                "punctuation.delimiter": { "color": "#657461ff" },
                "punctuation.special":   { "color": "#657461ff" },
                "punctuation.list_marker": { "color": "#657461ff" },
                "operator":             { "color": "#657461ff" },
                "comment":              { "color": "#8a9685ff", "font_style": "italic" },
                "comment_doc":          { "color": "#8a9685ff", "font_style": "italic" },
                "variable":             { "color": "#475347ff" },
                "variable.special":     { "color": "#475347ff" },
                "primary":              { "color": "#262d24ff" },
                "title":                { "color": "#475347ff" },
                "text.literal":         { "color": "#b38425ff" },
                "embedded":             { "color": "#a25a25ff" },
                "enum":                 { "color": "#a25a25ff" },
                "variant":              { "color": "#a25a25ff" },
                "constructor":          { "color": "#a25a25ff" },
                "link_text":            { "color": "#475347ff" },
                "link_uri":             { "color": "#a25a25ff" }
            }
        }
    }"##
    };

    serde_json::from_str(json).expect("valid highlight theme JSON")
}

/// Apply our custom warm palette to gpui-component's theme system.
fn apply_k8s_theme(mode: ThemeMode, cx: &mut App) {
    let colors = ThemeColors::from_mode(mode);

    let gpui_mode = if mode.is_dark() {
        gpui_component::theme::ThemeMode::Dark
    } else {
        gpui_component::theme::ThemeMode::Light
    };

    GpuiTheme::change(gpui_mode, None, cx);

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

        // Primary
        tc.primary = colors.primary;
        tc.primary_hover = colors.primary_hover;
        tc.primary_foreground = if mode.is_dark() {
            colors.background
        } else {
            colors.surface_elevated
        };

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
        tc.warning_foreground = if mode.is_dark() {
            hsla(0.0, 0.0, 0.10, 1.0) // dark text on warning bg (dark themes)
        } else {
            hsla(0.0, 0.0, 1.0, 1.0) // white text on warning bg (light themes)
        };

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
        tc.sidebar_primary_foreground = tc.primary_foreground;
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

    theme.highlight_theme = Arc::new(highlight_theme_for(mode));

    cx.update_global::<Theme, _>(|theme, _| {
        theme.mode = mode;
        theme.colors = colors;
    });
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

    // Set our Theme global for backwards compatibility
    cx.set_global(Theme::default());

    // Apply default mode until user settings are loaded.
    apply_k8s_theme(ThemeMode::EverforestDark, cx);
}

pub fn set_theme_mode(mode: ThemeMode, cx: &mut App) {
    apply_k8s_theme(mode, cx);
}

pub fn theme(cx: &App) -> &Theme {
    cx.global::<Theme>()
}

pub fn with_theme<R>(cx: &App, f: impl FnOnce(&Theme) -> R) -> R {
    f(theme(cx))
}
