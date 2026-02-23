use gpui::px;
use ui::{Theme, ThemeColors, ThemeMode};

// --- ThemeMode tests ---

#[test]
fn theme_mode_default_is_everforest_dark() {
    assert_eq!(ThemeMode::default(), ThemeMode::EverforestDark);
}

#[test]
fn theme_mode_is_dark_for_dark_variants() {
    assert!(ThemeMode::GruvboxDark.is_dark());
    assert!(ThemeMode::SolarizedDark.is_dark());
    assert!(ThemeMode::EverforestDark.is_dark());
    assert!(ThemeMode::DraculaDark.is_dark());
    assert!(ThemeMode::MonokaiDark.is_dark());
}

#[test]
fn theme_mode_is_not_dark_for_light_variants() {
    assert!(!ThemeMode::GruvboxLight.is_dark());
    assert!(!ThemeMode::SolarizedLight.is_dark());
    assert!(!ThemeMode::EverforestLight.is_dark());
    assert!(!ThemeMode::RosePineDawn.is_dark());
    assert!(!ThemeMode::GitHubLight.is_dark());
}

// --- ThemeColors tests ---

#[test]
fn theme_colors_default_uses_everforest_dark() {
    let default = ThemeColors::default();
    let everforest = ThemeColors::from_mode(ThemeMode::EverforestDark);
    assert_eq!(default.background, everforest.background);
}

#[test]
fn theme_colors_dark_is_everforest_dark() {
    let dark = ThemeColors::dark();
    let everforest = ThemeColors::from_mode(ThemeMode::EverforestDark);
    assert_eq!(dark.background, everforest.background);
}

#[test]
fn theme_colors_light_is_everforest_light() {
    let light = ThemeColors::light();
    let everforest = ThemeColors::from_mode(ThemeMode::EverforestLight);
    assert_eq!(light.background, everforest.background);
}

#[test]
fn theme_colors_from_mode_works_for_all_variants() {
    let modes = [
        ThemeMode::GruvboxLight,
        ThemeMode::SolarizedLight,
        ThemeMode::EverforestLight,
        ThemeMode::RosePineDawn,
        ThemeMode::GitHubLight,
        ThemeMode::GruvboxDark,
        ThemeMode::SolarizedDark,
        ThemeMode::EverforestDark,
        ThemeMode::DraculaDark,
        ThemeMode::MonokaiDark,
    ];
    for mode in modes {
        let colors = ThemeColors::from_mode(mode);
        assert_eq!(colors.background.a, 1.0, "{:?} background alpha", mode);
        assert_eq!(colors.text.a, 1.0, "{:?} text alpha", mode);
    }
}

#[test]
fn dark_themes_have_dark_backgrounds() {
    let dark_modes = [
        ThemeMode::GruvboxDark,
        ThemeMode::SolarizedDark,
        ThemeMode::EverforestDark,
        ThemeMode::DraculaDark,
        ThemeMode::MonokaiDark,
    ];
    for mode in dark_modes {
        let colors = ThemeColors::from_mode(mode);
        assert!(
            colors.background.l < 0.3,
            "{:?} background lightness {} should be < 0.3",
            mode,
            colors.background.l
        );
    }
}

#[test]
fn light_themes_have_light_backgrounds() {
    let light_modes = [
        ThemeMode::GruvboxLight,
        ThemeMode::SolarizedLight,
        ThemeMode::EverforestLight,
        ThemeMode::RosePineDawn,
        ThemeMode::GitHubLight,
    ];
    for mode in light_modes {
        let colors = ThemeColors::from_mode(mode);
        assert!(
            colors.background.l > 0.8,
            "{:?} background lightness {} should be > 0.8",
            mode,
            colors.background.l
        );
    }
}

#[test]
fn selection_colors_have_transparency() {
    let modes = [
        ThemeMode::GruvboxDark,
        ThemeMode::EverforestLight,
        ThemeMode::DraculaDark,
    ];
    for mode in modes {
        let colors = ThemeColors::from_mode(mode);
        assert!(
            colors.selection.a < 1.0,
            "{:?} selection should be transparent",
            mode
        );
        assert!(
            colors.selection_hover.a < 1.0,
            "{:?} selection_hover should be transparent",
            mode
        );
    }
}

#[test]
fn selection_hover_has_higher_alpha_than_selection() {
    let modes = [
        ThemeMode::GruvboxDark,
        ThemeMode::SolarizedDark,
        ThemeMode::EverforestDark,
        ThemeMode::DraculaDark,
        ThemeMode::MonokaiDark,
        ThemeMode::GruvboxLight,
        ThemeMode::SolarizedLight,
        ThemeMode::EverforestLight,
        ThemeMode::RosePineDawn,
        ThemeMode::GitHubLight,
    ];
    for mode in modes {
        let colors = ThemeColors::from_mode(mode);
        assert!(
            colors.selection_hover.a > colors.selection.a,
            "{:?} selection_hover alpha {} should be > selection alpha {}",
            mode,
            colors.selection_hover.a,
            colors.selection.a
        );
    }
}

// --- Theme struct tests ---

#[test]
fn theme_default_uses_everforest_dark() {
    let theme = Theme::default();
    assert_eq!(theme.mode, ThemeMode::EverforestDark);
}

#[test]
fn theme_default_has_reasonable_font_sizes() {
    let theme = Theme::default();
    assert!(theme.font_size > px(0.0));
    assert!(theme.font_size_small < theme.font_size);
    assert!(theme.font_size_large > theme.font_size);
    assert!(theme.font_size_xs < theme.font_size_small);
    assert!(theme.font_size_title > theme.font_size_large);
}

#[test]
fn theme_default_has_standard_fonts() {
    let theme = Theme::default();
    assert_eq!(theme.font_family.as_ref(), "JetBrains Mono");
    assert_eq!(theme.font_family_ui.as_ref(), "Inter");
}

#[test]
fn theme_default_border_radii_are_ordered() {
    let theme = Theme::default();
    assert!(theme.border_radius_sm <= theme.border_radius_md);
    assert!(theme.border_radius_md <= theme.border_radius_lg);
    assert!(theme.border_radius_lg <= theme.border_radius_full);
}
