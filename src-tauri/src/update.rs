use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

/// Payload emitted to the frontend when an update is available.
#[derive(Clone, serde::Serialize)]
pub struct UpdateAvailable {
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

/// Spawns a background task that checks for updates after a short delay,
/// then emits an `update-available` event to the frontend if one is found.
pub fn check_and_notify(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Don't block startup — wait a few seconds for the app to settle.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!("Failed to initialize updater: {e}");
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => {
                tracing::info!("Update available: v{}", update.version);
                let _ = app.emit(
                    "update-available",
                    UpdateAvailable {
                        version: update.version.clone(),
                        body: update.body.clone(),
                        date: update.date.map(|d| d.to_string()),
                    },
                );
            }
            Ok(None) => {
                tracing::debug!("No update available");
            }
            Err(e) => {
                tracing::warn!("Update check failed: {e}");
            }
        }
    });
}
