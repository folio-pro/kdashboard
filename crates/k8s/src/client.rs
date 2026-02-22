use anyhow::{Context, Result};
use kube::Client;
use once_cell::sync::OnceCell;
use parking_lot::RwLock;
use serde::Deserialize;
use std::path::PathBuf;

static KUBE_CLIENT: OnceCell<RwLock<Option<Client>>> = OnceCell::new();

#[derive(Debug, Deserialize)]
struct KubeConfig {
    #[serde(rename = "current-context")]
    current_context: Option<String>,
    contexts: Vec<KubeContext>,
}

#[derive(Debug, Deserialize)]
struct KubeContext {
    name: String,
    #[allow(dead_code)]
    context: Option<serde_yaml::Value>,
}

fn kubeconfig_path() -> Result<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join(".kube").join("config"))
        .context("Cannot find home directory")
}

pub async fn get_client() -> Result<Client> {
    let cell = KUBE_CLIENT.get_or_init(|| RwLock::new(None));

    {
        let read = cell.read();
        if let Some(client) = read.as_ref() {
            return Ok(client.clone());
        }
    }

    let client = Client::try_default()
        .await
        .context("Failed to create Kubernetes client")?;

    {
        let mut write = cell.write();
        *write = Some(client.clone());
    }

    Ok(client)
}

pub fn reset_client() {
    if let Some(cell) = KUBE_CLIENT.get() {
        let mut write = cell.write();
        *write = None;
    }
}

pub async fn list_contexts() -> Result<Vec<String>> {
    let path = kubeconfig_path()?;
    let content = tokio::fs::read_to_string(&path)
        .await
        .context("Failed to read kubeconfig")?;
    let config: KubeConfig =
        serde_yaml::from_str(&content).context("Failed to parse kubeconfig")?;
    Ok(config.contexts.into_iter().map(|c| c.name).collect())
}

pub async fn get_current_context() -> Result<String> {
    let path = kubeconfig_path()?;
    let content = tokio::fs::read_to_string(&path)
        .await
        .context("Failed to read kubeconfig")?;
    let config: KubeConfig =
        serde_yaml::from_str(&content).context("Failed to parse kubeconfig")?;
    config
        .current_context
        .context("No current context set in kubeconfig")
}

pub async fn set_context(context_name: &str) -> Result<()> {
    let path = kubeconfig_path()?;
    let content = tokio::fs::read_to_string(&path)
        .await
        .context("Failed to read kubeconfig")?;

    let mut config: serde_yaml::Value =
        serde_yaml::from_str(&content).context("Failed to parse kubeconfig")?;

    config["current-context"] = serde_yaml::Value::String(context_name.to_string());

    let output = serde_yaml::to_string(&config).context("Failed to serialize kubeconfig")?;

    tokio::fs::write(&path, output)
        .await
        .context("Failed to write kubeconfig")?;

    // Reset client so it reconnects with new context
    reset_client();

    Ok(())
}

pub async fn list_namespaces() -> Result<Vec<String>> {
    use k8s_openapi::api::core::v1::Namespace;
    use kube::api::{Api, ListParams};

    let client = get_client().await?;
    let api: Api<Namespace> = Api::all(client);
    let list = api
        .list(&ListParams::default())
        .await
        .context("Failed to list namespaces")?;

    Ok(list
        .items
        .into_iter()
        .filter_map(|ns| ns.metadata.name)
        .collect())
}

pub async fn check_connection() -> Result<()> {
    let _ = get_client().await?;
    let _ = list_namespaces().await?;
    Ok(())
}

/// Get list of containers in a pod
pub async fn get_pod_containers(pod_name: &str, namespace: &str) -> Result<Vec<String>> {
    use k8s_openapi::api::core::v1::Pod;
    use kube::api::Api;

    let client = get_client().await?;
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let pod = api.get(pod_name).await.context("Failed to get pod")?;

    let containers = pod
        .spec
        .map(|spec| spec.containers.into_iter().map(|c| c.name).collect())
        .unwrap_or_default();

    Ok(containers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kubeconfig_deserializes_with_contexts_and_current_context() {
        let yaml = r#"
current-context: prod-cluster
contexts:
  - name: prod-cluster
    context:
      cluster: prod
      user: admin
  - name: dev-cluster
    context:
      cluster: dev
      user: developer
"#;
        let config: KubeConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.current_context.as_deref(), Some("prod-cluster"));
        assert_eq!(config.contexts.len(), 2);
        assert_eq!(config.contexts[0].name, "prod-cluster");
        assert_eq!(config.contexts[1].name, "dev-cluster");
    }

    #[test]
    fn kubeconfig_deserializes_without_current_context() {
        let yaml = r#"
contexts:
  - name: my-cluster
"#;
        let config: KubeConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(config.current_context.is_none());
        assert_eq!(config.contexts.len(), 1);
        assert_eq!(config.contexts[0].name, "my-cluster");
    }

    #[test]
    fn kubeconfig_deserializes_empty_contexts() {
        let yaml = r#"
current-context: none
contexts: []
"#;
        let config: KubeConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.current_context.as_deref(), Some("none"));
        assert!(config.contexts.is_empty());
    }

    #[test]
    fn kubeconfig_context_names_extracted_correctly() {
        let yaml = r#"
current-context: ctx-a
contexts:
  - name: ctx-a
  - name: ctx-b
  - name: ctx-c
"#;
        let config: KubeConfig = serde_yaml::from_str(yaml).unwrap();
        let names: Vec<String> = config.contexts.into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["ctx-a", "ctx-b", "ctx-c"]);
    }

    #[test]
    fn kubeconfig_context_without_context_field_parses() {
        let yaml = r#"
contexts:
  - name: minimal-ctx
"#;
        let config: KubeConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.contexts[0].name, "minimal-ctx");
        assert!(config.contexts[0].context.is_none());
    }

    #[test]
    fn kubeconfig_path_ends_with_kube_config() {
        if let Ok(path) = kubeconfig_path() {
            assert!(path.ends_with(".kube/config"));
        }
    }

    #[test]
    fn kubeconfig_malformed_yaml_returns_error() {
        let yaml = "not: [valid: yaml: {{";
        let result: Result<KubeConfig, _> = serde_yaml::from_str(yaml);
        assert!(result.is_err());
    }
}
