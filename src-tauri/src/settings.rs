use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ContextCustomization {
    pub icon: Option<String>,
    pub label: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppSettings {
    /// The active Kubernetes context name.
    pub context: Option<String>,
    /// The active namespace.
    pub namespace: Option<String>,
    /// The selected theme mode.
    pub theme_mode: Option<String>,
    /// Custom kubeconfig file path.
    pub kubeconfig_path: Option<String>,
    /// Which UI sections are collapsed.
    pub collapsed_sections: Option<Vec<String>>,
    /// Table density: Comfortable or Compact.
    pub table_density: Option<String>,
    /// Per-context emoji/color customizations.
    pub context_customizations: Option<HashMap<String, ContextCustomization>>,
}

impl AppSettings {
    /// Return the path to the settings file: ~/.config/kdashboard/settings.json
    fn settings_path() -> Result<PathBuf> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not determine config directory"))?;
        Ok(config_dir.join("kdashboard").join("settings.json"))
    }

    /// Load settings from disk. Returns default if the file does not exist.
    pub fn load() -> Result<Self> {
        let path = Self::settings_path()?;
        if !path.exists() {
            return Ok(Self::default());
        }
        let contents = fs::read_to_string(&path)?;
        let settings: Self = serde_json::from_str(&contents)?;
        Ok(settings)
    }

    /// Persist settings to disk, creating parent directories as needed.
    pub fn save(&self) -> Result<()> {
        let path = Self::settings_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        fs::write(&path, json)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::AppSettings;

    #[test]
    fn default_settings_are_empty() {
        let settings = AppSettings::default();
        assert!(settings.context.is_none());
        assert!(settings.namespace.is_none());
        assert!(settings.theme_mode.is_none());
        assert!(settings.kubeconfig_path.is_none());
        assert!(settings.collapsed_sections.is_none());
        assert!(settings.table_density.is_none());
    }

    #[test]
    fn deserialize_partial_settings_uses_defaults() {
        let settings: AppSettings = serde_json::from_str(r#"{"namespace":"prod"}"#).unwrap();
        assert_eq!(settings.namespace.as_deref(), Some("prod"));
        assert!(settings.context.is_none());
        assert!(settings.kubeconfig_path.is_none());
    }

    #[test]
    fn deserialize_unknown_fields_is_tolerated() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"context":"dev","unknown_field":"ignored"}"#).unwrap();
        assert_eq!(settings.context.as_deref(), Some("dev"));
    }
}
