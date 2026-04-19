use tokio::sync::Mutex;

use crate::settings::AppSettings;

/// Global application state managed by Tauri.
pub struct AppState {
    /// Persisted user settings.
    pub settings: Mutex<AppSettings>,
}

impl AppState {
    pub fn new() -> Self {
        let settings = AppSettings::load().unwrap_or_default();
        Self {
            settings: tokio::sync::Mutex::new(settings),
        }
    }
}
