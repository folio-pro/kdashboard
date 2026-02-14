use anyhow::{Context, Result};
use dashmap::DashMap;
use kube::Client;
use kube::api::Api;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tracing::{error, info};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwardInfo {
    pub session_id: String,
    pub pod_name: String,
    pub namespace: String,
    pub container_port: u16,
    pub local_port: u16,
}

struct SessionHandle {
    info: PortForwardInfo,
    abort_handle: tokio::task::AbortHandle,
}

static PORT_FORWARD_SESSIONS: Lazy<DashMap<String, SessionHandle>> = Lazy::new(DashMap::new);

/// Start a port-forward session. Binds a local TCP listener on 127.0.0.1 and
/// forwards each accepted connection to the given container port via the K8s
/// portforward API.
///
/// If `local_port` is `None` (or 0), the OS picks an available port.
pub async fn start_port_forward(
    client: &Client,
    pod_name: &str,
    namespace: &str,
    container_port: u16,
    local_port: Option<u16>,
) -> Result<PortForwardInfo> {
    let bind_port = local_port.unwrap_or(0);
    let listener = TcpListener::bind(format!("127.0.0.1:{}", bind_port))
        .await
        .context("Failed to bind local TCP port")?;
    let actual_port = listener.local_addr()?.port();

    let session_id = Uuid::new_v4().to_string();

    info!(
        "Starting port-forward {} → {}:{} (pod {}/{})",
        actual_port, pod_name, container_port, namespace, pod_name
    );

    let info = PortForwardInfo {
        session_id: session_id.clone(),
        pod_name: pod_name.to_string(),
        namespace: namespace.to_string(),
        container_port,
        local_port: actual_port,
    };

    let client = client.clone();
    let ns = namespace.to_string();
    let pod = pod_name.to_string();
    let sid = session_id.clone();

    let task = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((mut tcp_stream, _addr)) => {
                    let api: Api<k8s_openapi::api::core::v1::Pod> =
                        Api::namespaced(client.clone(), &ns);
                    let pod = pod.clone();
                    let sid = sid.clone();

                    tokio::spawn(async move {
                        match api.portforward(&pod, &[container_port]).await {
                            Ok(mut pf) => {
                                let Some(mut upstream) = pf.take_stream(container_port) else {
                                    error!(
                                        "Port-forward stream missing for port {} (session {})",
                                        container_port, sid
                                    );
                                    return;
                                };

                                let (mut tcp_read, mut tcp_write) = tcp_stream.split();
                                let (mut pf_read, mut pf_write) = tokio::io::split(&mut upstream);

                                let client_to_pod = async {
                                    let mut buf = [0u8; 8192];
                                    loop {
                                        let n = tcp_read.read(&mut buf).await?;
                                        if n == 0 {
                                            break;
                                        }
                                        pf_write.write_all(&buf[..n]).await?;
                                    }
                                    Ok::<(), anyhow::Error>(())
                                };

                                let pod_to_client = async {
                                    let mut buf = [0u8; 8192];
                                    loop {
                                        let n = pf_read.read(&mut buf).await?;
                                        if n == 0 {
                                            break;
                                        }
                                        tcp_write.write_all(&buf[..n]).await?;
                                    }
                                    Ok::<(), anyhow::Error>(())
                                };

                                let _ = tokio::try_join!(client_to_pod, pod_to_client);
                            }
                            Err(e) => {
                                error!("Port-forward connection failed (session {}): {}", sid, e);
                            }
                        }
                    });
                }
                Err(e) => {
                    error!("TCP accept error: {}", e);
                    break;
                }
            }
        }
        PORT_FORWARD_SESSIONS.remove(&sid);
    });

    let handle = SessionHandle {
        info: info.clone(),
        abort_handle: task.abort_handle(),
    };
    PORT_FORWARD_SESSIONS.insert(session_id, handle);

    Ok(info)
}

pub fn stop_port_forward(session_id: &str) -> Result<()> {
    if let Some((_, session)) = PORT_FORWARD_SESSIONS.remove(session_id) {
        session.abort_handle.abort();
        info!("Stopped port-forward session {}", session_id);
        Ok(())
    } else {
        anyhow::bail!("Port-forward session not found: {}", session_id)
    }
}

pub fn stop_all_port_forwards() {
    let keys: Vec<String> = PORT_FORWARD_SESSIONS
        .iter()
        .map(|r| r.key().clone())
        .collect();
    for key in keys {
        if let Some((_, session)) = PORT_FORWARD_SESSIONS.remove(&key) {
            session.abort_handle.abort();
        }
    }
    info!("Stopped all port-forward sessions");
}

pub fn list_port_forwards() -> Vec<PortForwardInfo> {
    PORT_FORWARD_SESSIONS
        .iter()
        .map(|r| r.value().info.clone())
        .collect()
}
