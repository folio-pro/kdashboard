mod commands;
#[cfg(not(feature = "integration"))]
mod k8s;
#[cfg(feature = "integration")]
pub mod k8s;
mod settings;
mod state;
mod update;

use state::AppState;
use std::sync::OnceLock;
use tauri::Manager;

// Re-export command functions so generate_handler! can reference them.
use commands::app_commands::*;
use commands::k8s_commands::*;

// ===========================================================================
// Caches & helpers (used by commands via crate::)
// ===========================================================================

/// Cached hostname — never changes during app lifetime.
static HOSTNAME_CACHE: OnceLock<String> = OnceLock::new();

/// Cached OS version — never changes during app lifetime.
static OS_VERSION_CACHE: OnceLock<String> = OnceLock::new();

/// Cached K8s server version. Cleared on context switch.
static K8S_VERSION_CACHE: OnceLock<tokio::sync::Mutex<Option<String>>> = OnceLock::new();

pub(crate) fn get_hostname() -> &'static str {
    HOSTNAME_CACHE.get_or_init(|| {
        hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".into())
    })
}

fn k8s_version_cache() -> &'static tokio::sync::Mutex<Option<String>> {
    K8S_VERSION_CACHE.get_or_init(|| tokio::sync::Mutex::new(None))
}

pub(crate) async fn clear_k8s_version_cache() {
    let mut guard = k8s_version_cache().lock().await;
    *guard = None;
}

pub(crate) async fn get_k8s_version_cached() -> Option<String> {
    {
        let guard = k8s_version_cache().lock().await;
        if let Some(ref v) = *guard {
            return Some(v.clone());
        }
    }

    let version = match k8s::client::get_client().await {
        Ok(client) => match client.apiserver_version().await {
            Ok(info) => Some(format!("{}.{}", info.major, info.minor)),
            Err(_) => None,
        },
        Err(_) => None,
    };

    let mut guard = k8s_version_cache().lock().await;
    *guard = version.clone();

    version
}

/// Best-effort OS version string, cached after first call.
pub(crate) fn get_os_version() -> &'static str {
    OS_VERSION_CACHE.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            Command::new("sw_vers")
                .arg("-productVersion")
                .output()
                .ok()
                .and_then(|o| {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                })
                .unwrap_or_else(|| "unknown".into())
        }
        #[cfg(target_os = "linux")]
        {
            std::fs::read_to_string("/etc/os-release")
                .ok()
                .and_then(|content| {
                    content
                        .lines()
                        .find(|l| l.starts_with("PRETTY_NAME="))
                        .map(|l| {
                            l.trim_start_matches("PRETTY_NAME=")
                                .trim_matches('"')
                                .to_string()
                        })
                })
                .unwrap_or_else(|| "unknown".into())
        }
        #[cfg(target_os = "windows")]
        {
            "windows".to_string()
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            "unknown".to_string()
        }
    })
}

// ===========================================================================
// Tracing infrastructure
// ===========================================================================

const DEFAULT_LOG_FILTER: &str = "kdashboard_lib=info,kube=warn";

fn build_env_filter() -> tracing_subscriber::EnvFilter {
    tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| DEFAULT_LOG_FILTER.into())
}

// ===========================================================================
// App entry point
// ===========================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn fix_path_env() {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        if let Ok(current) = std::env::var("PATH") {
            if current.contains("/usr/local/bin") && !current.contains("homebrew") {}
        }

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        if let Ok(output) = Command::new(&shell)
            .args(["-ilc", "echo __PATH_START__${PATH}__PATH_END__"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(start) = stdout.find("__PATH_START__") {
                if let Some(end) = stdout.find("__PATH_END__") {
                    let path = &stdout[start + 14..end];
                    if !path.is_empty() {
                        std::env::set_var("PATH", path);
                        tracing::debug!("Fixed PATH from shell: {}", path);
                    }
                }
            }
        }
    }
}

pub fn run() {
    let _ = dotenvy::dotenv();
    fix_path_env();

    tracing_subscriber::fmt()
        .with_env_filter(build_env_filter())
        .init();

    tracing::info!("Starting kdashboard v2");

    let app_state = AppState::new();

    {
        let settings = app_state.settings.blocking_lock();
        if settings.kubeconfig_path.is_some() {
            k8s::client::set_kubeconfig_path(settings.kubeconfig_path.clone());
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(app_state)
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Some(splash) = handle.get_webview_window("splashscreen") {
                    tracing::warn!("Splash screen timeout — force closing");
                    let _ = splash.close();
                }
                if let Some(main) = handle.get_webview_window("main") {
                    let _ = main.show();
                }
            });

            // Check for updates in background after startup settles.
            update::check_and_notify(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Connection
            get_contexts,
            get_current_context,
            get_namespaces,
            switch_context,
            check_connection,
            // Resources
            list_resources,
            list_pods_by_selector,
            get_resource_counts,
            get_resource_yaml,
            apply_yaml,
            delete_resource,
            get_events,
            get_resource_events,
            // Workload Operations
            scale_workload,
            restart_workload,
            rollback_deployment,
            list_deployment_revisions,
            // Port Forwarding
            start_port_forward,
            stop_port_forward,
            // Terminal Exec
            start_terminal_exec,
            stop_terminal_exec,
            send_terminal_input,
            resize_terminal,
            // Logs
            stream_pod_logs,
            stream_multi_pod_logs,
            stop_log_stream,
            // Watch
            start_resource_watch,
            stop_resource_watch,
            // Topology
            get_namespace_topology,
            get_resource_topology,
            // Diagnostics
            diagnose_resource,
            // Cost
            get_cost_overview,
            get_node_costs,
            get_node_metrics,
            refresh_pricing,
            // Security
            get_security_overview,
            scan_image,
            // CRDs
            discover_crds,
            list_crd_resources,
            get_crd_counts,
            get_crd_conditions,
            // Kubectl
            run_kubectl,
            // Observability
            get_app_metadata,
            // Splash
            close_splashscreen,
            // Settings
            get_settings,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

// ===========================================================================
// Tests for infrastructure code
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::{clear_k8s_version_cache, get_hostname, get_os_version, k8s_version_cache};

    #[test]
    fn app_metadata_static_fields() {
        assert!(!env!("CARGO_PKG_VERSION").is_empty());
        assert!(!std::env::consts::OS.is_empty());
        assert!(!std::env::consts::ARCH.is_empty());
    }

    #[test]
    fn os_version_returns_nonempty_string() {
        let version = get_os_version();
        assert!(!version.is_empty());
    }

    #[tokio::test]
    async fn k8s_version_cache_clear_works() {
        {
            let mut guard = k8s_version_cache().lock().await;
            *guard = Some("1.28".to_string());
        }
        {
            let guard = k8s_version_cache().lock().await;
            assert_eq!(guard.as_deref(), Some("1.28"));
        }
        clear_k8s_version_cache().await;
        {
            let guard = k8s_version_cache().lock().await;
            assert!(guard.is_none());
        }
    }

    #[test]
    fn hostname_resolves() {
        assert!(!get_hostname().is_empty());
    }
}
