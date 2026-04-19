use anyhow::Result;
use std::fs;

use super::client::{reset_client, resolve_kubeconfig_path};

/// List all context names from the kubeconfig file.
pub fn list_contexts() -> Result<Vec<String>> {
    let path = resolve_kubeconfig_path();
    let contents = fs::read_to_string(&path)?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(&contents)?;

    let contexts = yaml
        .get("contexts")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|entry| {
                    entry
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(contexts)
}

/// Get the current-context value from the kubeconfig file.
pub fn get_current_context() -> Result<String> {
    let path = resolve_kubeconfig_path();
    let contents = fs::read_to_string(&path)?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(&contents)?;

    let current = yaml
        .get("current-context")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("No current-context found in kubeconfig"))?
        .to_string();

    Ok(current)
}

/// Set the current-context in the kubeconfig file and reset the cached client.
pub fn set_context(context: &str) -> Result<()> {
    let path = resolve_kubeconfig_path();
    let contents = fs::read_to_string(&path)?;
    let mut yaml: serde_yaml::Value = serde_yaml::from_str(&contents)?;

    yaml["current-context"] = serde_yaml::Value::String(context.to_string());

    let updated = serde_yaml::to_string(&yaml)?;
    fs::write(&path, updated)?;

    // Force the client to reconnect with the new context.
    reset_client();

    Ok(())
}

/// Parse kubeconfig YAML and extract context names (testable without file I/O).
#[cfg(test)]
fn parse_context_names(yaml_str: &str) -> Result<Vec<String>> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(yaml_str)?;
    let contexts = yaml
        .get("contexts")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|entry| {
                    entry
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(contexts)
}

/// Parse current-context from kubeconfig YAML (testable without file I/O).
#[cfg(test)]
fn parse_current_context(yaml_str: &str) -> Result<String> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(yaml_str)?;
    let current = yaml
        .get("current-context")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("No current-context found in kubeconfig"))?
        .to_string();
    Ok(current)
}

/// List all namespace names via the Kubernetes API.
pub async fn list_namespaces() -> Result<Vec<String>> {
    use k8s_openapi::api::core::v1::Namespace;
    use kube::api::ListParams;
    use kube::Api;

    let client = super::client::get_client().await?;
    let namespaces: Api<Namespace> = Api::all(client);
    let list = namespaces.list(&ListParams::default()).await?;

    let names: Vec<String> = list
        .items
        .iter()
        .filter_map(|ns| ns.metadata.name.clone())
        .collect();

    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_KUBECONFIG: &str = r#"
apiVersion: v1
kind: Config
current-context: prod-cluster
contexts:
  - name: prod-cluster
    context:
      cluster: prod
      user: admin
  - name: staging-cluster
    context:
      cluster: staging
      user: developer
  - name: dev-local
    context:
      cluster: minikube
      user: minikube
clusters: []
users: []
"#;

    #[test]
    fn parse_context_names_extracts_all_contexts() {
        let names = parse_context_names(SAMPLE_KUBECONFIG).unwrap();
        assert_eq!(names, vec!["prod-cluster", "staging-cluster", "dev-local"]);
    }

    #[test]
    fn parse_context_names_handles_empty_contexts() {
        let yaml = "apiVersion: v1\nkind: Config\ncontexts: []\n";
        let names = parse_context_names(yaml).unwrap();
        assert!(names.is_empty());
    }

    #[test]
    fn parse_context_names_handles_missing_contexts_key() {
        let yaml = "apiVersion: v1\nkind: Config\n";
        let names = parse_context_names(yaml).unwrap();
        assert!(names.is_empty());
    }

    #[test]
    fn parse_context_names_skips_entries_without_name() {
        let yaml = r#"
contexts:
  - name: valid-context
    context: {}
  - context:
      cluster: no-name
"#;
        let names = parse_context_names(yaml).unwrap();
        assert_eq!(names, vec!["valid-context"]);
    }

    #[test]
    fn parse_context_names_returns_error_for_invalid_yaml() {
        assert!(parse_context_names("not: [valid: yaml: {{").is_err());
    }

    #[test]
    fn parse_current_context_extracts_value() {
        let current = parse_current_context(SAMPLE_KUBECONFIG).unwrap();
        assert_eq!(current, "prod-cluster");
    }

    #[test]
    fn parse_current_context_returns_error_when_missing() {
        let yaml = "apiVersion: v1\nkind: Config\n";
        let result = parse_current_context(yaml);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("current-context"));
    }

    #[test]
    fn parse_current_context_returns_error_for_invalid_yaml() {
        assert!(parse_current_context("{{invalid").is_err());
    }

    #[test]
    fn parse_single_context_kubeconfig() {
        let yaml = r#"
current-context: my-cluster
contexts:
  - name: my-cluster
    context:
      cluster: my-cluster
      user: my-user
"#;
        let names = parse_context_names(yaml).unwrap();
        assert_eq!(names, vec!["my-cluster"]);
        let current = parse_current_context(yaml).unwrap();
        assert_eq!(current, "my-cluster");
    }
}
