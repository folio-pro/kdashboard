use serde::Serialize;
use tauri::Manager;

use super::StrErr;
use crate::k8s;
use crate::settings::AppSettings;
use crate::state::AppState;

// ===========================================================================
// Splash Screen
// ===========================================================================

#[tauri::command]
pub async fn close_splashscreen(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(splash) = app.get_webview_window("splashscreen") {
        splash.close().str_err()?;
    }
    if let Some(main) = app.get_webview_window("main") {
        main.show().str_err()?;
    }
    Ok(())
}

// ===========================================================================
// Settings
// ===========================================================================

#[tauri::command]
pub async fn get_settings(state: tauri::State<'_, AppState>) -> Result<AppSettings, String> {
    let settings = state.settings.lock().await.clone();
    Ok(settings)
}

#[tauri::command]
pub async fn save_settings(
    settings: AppSettings,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    {
        let old = state.settings.lock().await;
        if old.kubeconfig_path != settings.kubeconfig_path {
            k8s::client::set_kubeconfig_path(settings.kubeconfig_path.clone());
            k8s::client::reset_client();
        }
    }

    settings.save().str_err()?;

    let mut guard = state.settings.lock().await;
    *guard = settings;
    Ok(())
}

// ===========================================================================
// App Metadata (observability)
// ===========================================================================

#[derive(Clone, Serialize)]
pub struct AppMetadata {
    app_version: String,
    os: String,
    os_version: String,
    arch: String,
    hostname: String,
    k8s_version: Option<String>,
}

#[tauri::command]
pub async fn get_app_metadata() -> Result<AppMetadata, String> {
    let k8s_version = crate::get_k8s_version_cached().await;

    Ok(AppMetadata {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        os_version: crate::get_os_version().to_string(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: crate::get_hostname().to_string(),
        k8s_version,
    })
}

// ===========================================================================
// kubectl execution
// ===========================================================================

#[derive(Clone, Serialize)]
pub struct KubectlResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

/// Flags that could redirect kubectl to a different cluster or read arbitrary files.
const BLOCKED_KUBECTL_FLAGS: &[&str] = &[
    "--kubeconfig",
    "--server",
    "--certificate-authority",
    "--client-certificate",
    "--client-key",
    "--token",
    "--as",
    "--as-group",
    "-s", // short for --server
];

pub fn validate_kubectl_args(args: &[String]) -> Result<(), String> {
    for arg in args {
        let lower = arg.to_lowercase();
        for blocked in BLOCKED_KUBECTL_FLAGS {
            if lower == *blocked || lower.starts_with(&format!("{}=", blocked)) {
                return Err(format!("Blocked flag for security: {}", blocked));
            }
        }
    }
    Ok(())
}

/// Maximum time (seconds) kubectl can run before being killed.
const KUBECTL_TIMEOUT_SECS: u64 = 30;

#[tauri::command]
pub async fn run_kubectl(args: Vec<String>) -> Result<KubectlResult, String> {
    use std::process::Stdio;
    use tokio::process::Command;

    validate_kubectl_args(&args)?;

    let mut cmd = Command::new("kubectl");
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(kp) = k8s::client::get_kubeconfig_path() {
        cmd.env("KUBECONFIG", kp);
    }

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(KUBECTL_TIMEOUT_SECS),
        cmd.output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => Ok(KubectlResult {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        }),
        Ok(Err(e)) => Err(format!("Failed to run kubectl: {}", e)),
        Err(_) => {
            Err(format!(
                "kubectl timed out after {}s. The command may be waiting for input or the cluster is unresponsive.",
                KUBECTL_TIMEOUT_SECS
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::validate_kubectl_args;

    #[test]
    fn allows_regular_kubectl_arguments() {
        let args = vec!["get".into(), "pods".into(), "-n".into(), "default".into()];
        assert!(validate_kubectl_args(&args).is_ok());
    }

    #[test]
    fn blocks_exact_sensitive_flags() {
        let args = vec!["get".into(), "pods".into(), "--server".into()];
        let err = validate_kubectl_args(&args).unwrap_err();
        assert!(err.contains("--server"));
    }

    #[test]
    fn blocks_assignment_form_of_sensitive_flags() {
        let args = vec!["get".into(), "pods".into(), "--token=abc".into()];
        let err = validate_kubectl_args(&args).unwrap_err();
        assert!(err.contains("--token"));
    }

    #[test]
    fn blocks_case_insensitive_flags() {
        let args = vec!["get".into(), "pods".into(), "--KUBECONFIG=/tmp/k".into()];
        let err = validate_kubectl_args(&args).unwrap_err();
        assert!(err.contains("--kubeconfig"));
    }

    #[test]
    fn blocks_short_server_flag() {
        let args = vec!["get".into(), "pods".into(), "-s".into(), "https://x".into()];
        let err = validate_kubectl_args(&args).unwrap_err();
        assert!(err.contains("-s"));
    }

    // -----------------------------------------------------------------------
    // BLOCKED_KUBECTL_FLAGS coverage
    // -----------------------------------------------------------------------

    #[test]
    fn blocked_flags_list_contains_all_expected_flags() {
        use super::BLOCKED_KUBECTL_FLAGS;
        let expected = [
            "--kubeconfig",
            "--server",
            "--certificate-authority",
            "--client-certificate",
            "--client-key",
            "--token",
            "--as",
            "--as-group",
            "-s",
        ];
        for flag in expected {
            assert!(
                BLOCKED_KUBECTL_FLAGS.contains(&flag),
                "{} should be in BLOCKED_KUBECTL_FLAGS",
                flag
            );
        }
    }

    #[test]
    fn blocked_flags_count_matches_expected() {
        use super::BLOCKED_KUBECTL_FLAGS;
        // If someone adds or removes a flag, this test catches it
        assert_eq!(
            BLOCKED_KUBECTL_FLAGS.len(),
            9,
            "Expected 9 blocked flags, got {}. Update this test if flags were intentionally added/removed.",
            BLOCKED_KUBECTL_FLAGS.len()
        );
    }

    #[test]
    fn blocks_kubeconfig_flag() {
        let args = vec![
            "get".into(),
            "pods".into(),
            "--kubeconfig".into(),
            "/tmp/k".into(),
        ];
        assert!(validate_kubectl_args(&args).is_err());
    }

    #[test]
    fn blocks_kubeconfig_assignment_form() {
        let args = vec!["get".into(), "pods".into(), "--kubeconfig=/tmp/k".into()];
        assert!(validate_kubectl_args(&args).is_err());
    }

    #[test]
    fn blocks_token_flag() {
        let args = vec![
            "get".into(),
            "pods".into(),
            "--token".into(),
            "abc123".into(),
        ];
        assert!(validate_kubectl_args(&args).is_err());
    }

    #[test]
    fn blocks_as_flag() {
        let args = vec!["get".into(), "pods".into(), "--as".into(), "admin".into()];
        assert!(validate_kubectl_args(&args).is_err());
    }

    #[test]
    fn blocks_as_group_flag() {
        let args = vec![
            "get".into(),
            "pods".into(),
            "--as-group".into(),
            "system:masters".into(),
        ];
        assert!(validate_kubectl_args(&args).is_err());
    }

    #[test]
    fn blocks_certificate_authority_flag() {
        let args = vec![
            "get".into(),
            "pods".into(),
            "--certificate-authority".into(),
            "/tmp/ca.crt".into(),
        ];
        assert!(validate_kubectl_args(&args).is_err());
    }

    #[test]
    fn blocks_client_certificate_flag() {
        let args = vec![
            "get".into(),
            "pods".into(),
            "--client-certificate".into(),
            "/tmp/client.crt".into(),
        ];
        assert!(validate_kubectl_args(&args).is_err());
    }

    #[test]
    fn blocks_client_key_flag() {
        let args = vec![
            "get".into(),
            "pods".into(),
            "--client-key".into(),
            "/tmp/client.key".into(),
        ];
        assert!(validate_kubectl_args(&args).is_err());
    }

    #[test]
    fn allows_similar_but_safe_flags() {
        // Flags that look similar but are not blocked
        let args = vec!["get".into(), "pods".into(), "--server-dry-run".into()];
        assert!(validate_kubectl_args(&args).is_ok());
    }
}
