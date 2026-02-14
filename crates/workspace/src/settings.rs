use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AIProvider {
    #[default]
    OpenCode,
    ClaudeCode,
}

impl AIProvider {
    pub fn display_name(self) -> &'static str {
        match self {
            AIProvider::OpenCode => "OpenCode",
            AIProvider::ClaudeCode => "ClaudeCode",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
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
    pub fn display_name(self) -> &'static str {
        match self {
            ThemeMode::GruvboxLight => "Gruvbox Light",
            ThemeMode::SolarizedLight => "Solarized Light",
            ThemeMode::EverforestLight => "Everforest Light",
            ThemeMode::RosePineDawn => "Rose Pine Dawn",
            ThemeMode::GitHubLight => "GitHub Light",
            ThemeMode::GruvboxDark => "Gruvbox Dark",
            ThemeMode::SolarizedDark => "Solarized Dark",
            ThemeMode::EverforestDark => "Everforest Dark",
            ThemeMode::DraculaDark => "Dracula Dark",
            ThemeMode::MonokaiDark => "Monokai Dark",
        }
    }

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

    pub fn light_presets() -> [ThemeMode; 5] {
        [
            ThemeMode::GruvboxLight,
            ThemeMode::SolarizedLight,
            ThemeMode::EverforestLight,
            ThemeMode::RosePineDawn,
            ThemeMode::GitHubLight,
        ]
    }

    pub fn dark_presets() -> [ThemeMode; 5] {
        [
            ThemeMode::GruvboxDark,
            ThemeMode::SolarizedDark,
            ThemeMode::EverforestDark,
            ThemeMode::DraculaDark,
            ThemeMode::MonokaiDark,
        ]
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UserSettings {
    pub context: Option<String>,
    pub namespace: Option<String>,
    pub ai_provider: Option<AIProvider>,
    pub opencode_model: Option<String>,
    pub theme_mode: Option<ThemeMode>,
}

pub fn settings_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("kdashboard").join("settings.json"))
}

pub fn load_settings() -> UserSettings {
    let Some(path) = settings_path() else {
        return UserSettings::default();
    };

    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => UserSettings::default(),
    }
}

pub fn save_settings(settings: &UserSettings) {
    let Some(path) = settings_path() else {
        tracing::warn!("Could not determine config directory for saving settings");
        return;
    };

    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::error!("Failed to create settings directory: {}", e);
            return;
        }
    }

    match serde_json::to_string_pretty(settings) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                tracing::error!("Failed to write settings file: {}", e);
            }
        }
        Err(e) => {
            tracing::error!("Failed to serialize settings: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_provider_display_name_matches_expected_labels() {
        assert_eq!(AIProvider::OpenCode.display_name(), "OpenCode");
        assert_eq!(AIProvider::ClaudeCode.display_name(), "ClaudeCode");
    }

    #[test]
    fn user_settings_roundtrip_json() {
        let settings = UserSettings {
            context: Some("prod".to_string()),
            namespace: Some("default".to_string()),
            ai_provider: Some(AIProvider::ClaudeCode),
            opencode_model: Some("gpt-5".to_string()),
            theme_mode: Some(ThemeMode::GruvboxDark),
        };

        let json = serde_json::to_string(&settings).expect("serialize settings");
        let decoded: UserSettings = serde_json::from_str(&json).expect("deserialize settings");

        assert_eq!(decoded.context.as_deref(), Some("prod"));
        assert_eq!(decoded.namespace.as_deref(), Some("default"));
        assert_eq!(decoded.ai_provider, Some(AIProvider::ClaudeCode));
        assert_eq!(decoded.opencode_model.as_deref(), Some("gpt-5"));
        assert_eq!(decoded.theme_mode, Some(ThemeMode::GruvboxDark));
    }

    #[test]
    fn settings_path_ends_with_expected_file_name_when_available() {
        if let Some(path) = settings_path() {
            assert!(path.ends_with("kdashboard/settings.json"));
        }
    }
}
