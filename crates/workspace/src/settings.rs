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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UserSettings {
    pub context: Option<String>,
    pub namespace: Option<String>,
    pub ai_provider: Option<AIProvider>,
    pub opencode_model: Option<String>,
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
