use anyhow::Result;
use k8s_openapi::api::core::v1::Pod;
use kube::Api;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use super::client::get_client;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

static ACTIVE_FORWARDS: LazyLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwardResult {
    pub session_id: String,
    pub local_port: u16,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Start a port-forward session: binds a local TCP port and forwards traffic
/// to the target pod/container port via the K8s API.
pub async fn start_port_forward(
    pod_name: String,
    namespace: String,
    container_port: u16,
    local_port: u16,
    session_id: String,
    app_handle: AppHandle,
) -> Result<PortForwardResult> {
    let client = get_client().await?;
    let pods: Api<Pod> = Api::namespaced(client, &namespace);

    // Verify the pod exists before binding.
    pods.get(&pod_name).await?;

    // Bind a local TCP listener. If local_port is 0, the OS picks a free port.
    let listener = TcpListener::bind(format!("127.0.0.1:{}", local_port)).await?;
    let actual_port = listener.local_addr()?.port();

    // Create a cancellation channel.
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();

    // Store the cancel sender so we can stop later.
    {
        let mut map = ACTIVE_FORWARDS.lock().await;
        map.insert(session_id.clone(), cancel_tx);
    }

    let sid = session_id.clone();
    let pod = pod_name.clone();

    let emit_handle = app_handle.clone();
    tokio::spawn(async move {
        // Capture the client once for all connections in this session.
        let client = match get_client().await {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("Failed to get client for pf {}: {}", sid, e);
                ACTIVE_FORWARDS.lock().await.remove(&sid);
                let _ = emit_handle.emit("port-forward-closed", &sid);
                return;
            }
        };
        let pods: Api<Pod> = Api::namespaced(client, &namespace);
        let mut cancelled = false;

        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    tracing::info!("Port-forward {} cancelled", sid);
                    cancelled = true;
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((mut tcp_stream, _addr)) => {
                            let pods = pods.clone();
                            let pod_name = pod.clone();

                            tokio::spawn(async move {
                                if let Err(e) = handle_connection(&pods, &pod_name, container_port, &mut tcp_stream).await {
                                    tracing::debug!("Port-forward connection ended: {}", e);
                                }
                            });
                        }
                        Err(e) => {
                            tracing::error!("Accept error in port-forward: {}", e);
                            break;
                        }
                    }
                }
            }
        }

        // Cleanup
        ACTIVE_FORWARDS.lock().await.remove(&sid);
        // Notify frontend if the session ended unexpectedly (not user-cancelled)
        if !cancelled {
            let _ = emit_handle.emit("port-forward-closed", &sid);
        }
    });

    Ok(PortForwardResult {
        session_id,
        local_port: actual_port,
    })
}

/// Stop a port-forward session by its ID.
pub async fn stop_port_forward(session_id: &str) -> Result<()> {
    let mut map = ACTIVE_FORWARDS.lock().await;
    if let Some(cancel) = map.remove(session_id) {
        let _ = cancel.send(());
        return Ok(());
    }
    Err(anyhow::anyhow!(
        "No active port-forward with session_id: {}",
        session_id
    ))
}

// ---------------------------------------------------------------------------
// Internal: handle a single TCP connection through the K8s port-forward API
// ---------------------------------------------------------------------------

async fn handle_connection(
    pods: &Api<Pod>,
    pod_name: &str,
    port: u16,
    tcp_stream: &mut tokio::net::TcpStream,
) -> Result<()> {
    let mut pf = pods.portforward(pod_name, &[port]).await?;

    let mut upstream = pf
        .take_stream(port)
        .ok_or_else(|| anyhow::anyhow!("Failed to get port-forward stream for port {}", port))?;

    let (mut tcp_read, mut tcp_write) = tcp_stream.split();
    let (mut pf_read, mut pf_write) = tokio::io::split(&mut upstream);

    let client_to_pod = tokio::io::copy(&mut tcp_read, &mut pf_write);
    let pod_to_client = tokio::io::copy(&mut pf_read, &mut tcp_write);

    tokio::select! {
        r = client_to_pod => { r?; }
        r = pod_to_client => { r?; }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_forward_result_serializes() {
        let result = PortForwardResult {
            session_id: "sess-123".to_string(),
            local_port: 8080,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["session_id"], "sess-123");
        assert_eq!(json["local_port"], 8080);
    }

    #[test]
    fn port_forward_result_serializes_field_names_are_snake_case() {
        let result = PortForwardResult {
            session_id: "x".to_string(),
            local_port: 1,
        };
        let json_str = serde_json::to_string(&result).unwrap();
        assert!(
            json_str.contains("\"session_id\""),
            "expected snake_case key session_id"
        );
        assert!(
            json_str.contains("\"local_port\""),
            "expected snake_case key local_port"
        );
        // Confirm no camelCase variants leak through
        assert!(!json_str.contains("sessionId"));
        assert!(!json_str.contains("localPort"));
    }

    #[test]
    fn port_forward_result_deserializes() {
        let json = r#"{"session_id":"sess-456","local_port":9090}"#;
        let result: PortForwardResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.session_id, "sess-456");
        assert_eq!(result.local_port, 9090);
    }

    #[test]
    fn port_forward_result_roundtrip() {
        let original = PortForwardResult {
            session_id: "roundtrip-test".to_string(),
            local_port: 12345,
        };
        let json_str = serde_json::to_string(&original).unwrap();
        let restored: PortForwardResult = serde_json::from_str(&json_str).unwrap();
        assert_eq!(restored.session_id, original.session_id);
        assert_eq!(restored.local_port, original.local_port);
    }

    #[test]
    fn port_forward_result_construction() {
        let info = PortForwardResult {
            session_id: "pf-abc-123".to_string(),
            local_port: 0,
        };
        assert_eq!(info.session_id, "pf-abc-123");
        assert_eq!(info.local_port, 0);
    }

    #[test]
    fn port_forward_result_clone() {
        let original = PortForwardResult {
            session_id: "clone-me".to_string(),
            local_port: 443,
        };
        let cloned = original.clone();
        assert_eq!(cloned.session_id, "clone-me");
        assert_eq!(cloned.local_port, 443);
    }

    #[tokio::test]
    async fn stop_port_forward_returns_error_for_unknown_session() {
        let result = stop_port_forward("nonexistent-session").await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("nonexistent-session"));
    }

    #[tokio::test]
    async fn stop_port_forward_error_message_includes_session_id() {
        let weird_id = "weird/session#id!@";
        let result = stop_port_forward(weird_id).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains(weird_id),
            "error should echo back the session_id"
        );
    }

    #[tokio::test]
    async fn active_forwards_starts_empty() {
        let map = ACTIVE_FORWARDS.lock().await;
        // Map may have entries from other tests, but the key we check shouldn't exist
        assert!(!map.contains_key("test-unique-key-never-added"));
    }
}
