use anyhow::Result;
use kube::{Client, Config};
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

/// Global singleton holding the cached K8s client.
static K8S_CLIENT: OnceLock<RwLock<Option<Client>>> = OnceLock::new();

/// Global kubeconfig override path.
static KUBECONFIG_PATH: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn client_lock() -> &'static RwLock<Option<Client>> {
    K8S_CLIENT.get_or_init(|| RwLock::new(None))
}

fn kubeconfig_path_lock() -> &'static RwLock<Option<String>> {
    KUBECONFIG_PATH.get_or_init(|| RwLock::new(None))
}

/// Set the kubeconfig override path. Pass `None` to use the default.
pub fn set_kubeconfig_path(path: Option<String>) {
    let mut guard = kubeconfig_path_lock()
        .write()
        .unwrap_or_else(|e| e.into_inner());
    *guard = path;
}

/// Get the custom kubeconfig path if set.
pub fn get_kubeconfig_path() -> Option<String> {
    let guard = kubeconfig_path_lock()
        .read()
        .unwrap_or_else(|e| e.into_inner());
    guard.clone()
}

/// Get the resolved kubeconfig path, performing tilde expansion.
pub fn resolve_kubeconfig_path() -> PathBuf {
    let guard = kubeconfig_path_lock()
        .read()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(ref custom) = *guard {
        expand_tilde(custom)
    } else {
        default_kubeconfig_path()
    }
}

/// Expand a leading `~` to the user's home directory.
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(stripped) = path.strip_prefix('~') {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped.trim_start_matches('/'));
        }
    }
    PathBuf::from(path)
}

/// Default kubeconfig location: ~/.kube/config
fn default_kubeconfig_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".kube")
        .join("config")
}

/// Build a new K8s client from the resolved kubeconfig path.
async fn build_client() -> Result<Client> {
    let kubeconfig_path = resolve_kubeconfig_path();

    let kubeconfig = kube::config::Kubeconfig::read_from(&kubeconfig_path)?;
    let config = Config::from_custom_kubeconfig(kubeconfig, &Default::default()).await?;
    let client = Client::try_from(config)?;
    Ok(client)
}

/// Get the cached K8s client, or create one if it doesn't exist yet.
pub async fn get_client() -> Result<Client> {
    // Try reading first (cheap path).
    {
        let guard = client_lock()
            .read()
            .map_err(|e| anyhow::anyhow!("K8s client read lock poisoned: {}", e))?;
        if let Some(ref client) = *guard {
            return Ok(client.clone());
        }
    }

    // No client yet; build one and cache it.
    let client = build_client().await?;
    {
        let mut guard = client_lock()
            .write()
            .map_err(|e| anyhow::anyhow!("K8s client write lock poisoned: {}", e))?;
        *guard = Some(client.clone());
    }
    Ok(client)
}

/// Force-reset the cached client so the next `get_client()` call creates a fresh one.
pub fn reset_client() {
    let mut guard = client_lock().write().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

#[cfg(test)]
mod tests {
    use super::{get_kubeconfig_path, resolve_kubeconfig_path, set_kubeconfig_path};
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    fn path_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct PathResetGuard {
        original: Option<String>,
    }

    impl Drop for PathResetGuard {
        fn drop(&mut self) {
            set_kubeconfig_path(self.original.clone());
        }
    }

    fn set_test_path(path: Option<String>) -> PathResetGuard {
        let original = get_kubeconfig_path();
        set_kubeconfig_path(path);
        PathResetGuard { original }
    }

    #[test]
    fn set_and_get_kubeconfig_path_roundtrip() {
        let _lock = path_test_lock().lock().unwrap();
        let _reset = set_test_path(Some("/tmp/kubeconfig-test".into()));
        assert_eq!(
            get_kubeconfig_path().as_deref(),
            Some("/tmp/kubeconfig-test")
        );
    }

    #[test]
    fn resolve_custom_absolute_path() {
        let _lock = path_test_lock().lock().unwrap();
        let _reset = set_test_path(Some("/tmp/custom-kubeconfig".into()));
        assert_eq!(
            resolve_kubeconfig_path(),
            PathBuf::from("/tmp/custom-kubeconfig")
        );
    }

    #[test]
    fn resolve_custom_tilde_path() {
        let _lock = path_test_lock().lock().unwrap();
        let _reset = set_test_path(Some("~/my-kubeconfig".into()));

        let resolved = resolve_kubeconfig_path();
        let expected = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("my-kubeconfig");
        assert_eq!(resolved, expected);
    }

    #[test]
    fn resolve_default_path_when_not_set() {
        let _lock = path_test_lock().lock().unwrap();
        let _reset = set_test_path(None);
        let resolved = resolve_kubeconfig_path();
        assert!(resolved.ends_with(Path::new(".kube").join("config")));
    }
}
