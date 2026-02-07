use anyhow::{Context, Result};
use dashmap::DashMap;
use kube::api::{Api, AttachParams};
use kube::Client;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};
use tokio::sync::mpsc;
use tracing::{error, info};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSession {
    pub session_id: String,
    pub pod_name: String,
    pub container: String,
    pub namespace: String,
}

#[derive(Clone, Serialize)]
pub struct TerminalOutput {
    pub session_id: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Serialize)]
pub struct TerminalClosed {
    pub session_id: String,
    pub reason: String,
}

struct SessionHandle {
    input_tx: mpsc::Sender<Vec<u8>>,
    abort_handle: tokio::task::AbortHandle,
}

static SESSIONS: Lazy<DashMap<String, SessionHandle>> = Lazy::new(DashMap::new);

pub type OutputCallback = Box<dyn Fn(TerminalOutput) + Send + Sync>;
pub type CloseCallback = Box<dyn Fn(TerminalClosed) + Send + Sync>;

pub async fn start_terminal_session(
    client: &Client,
    pod_name: &str,
    container: Option<&str>,
    namespace: &str,
    cols: Option<u16>,
    rows: Option<u16>,
    on_output: OutputCallback,
    on_close: CloseCallback,
) -> Result<TerminalSession> {
    info!(
        "Starting terminal session for pod: {}, namespace: {}, container: {:?}",
        pod_name, namespace, container
    );

    let api: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client.clone(), namespace);
    let pod = api
        .get(pod_name)
        .await
        .context(format!("Failed to get pod '{}'", pod_name))?;

    let container_name = container
        .map(|c| c.to_string())
        .or_else(|| {
            pod.spec
                .as_ref()
                .and_then(|spec| spec.containers.first().map(|c| c.name.clone()))
        })
        .context("No container found")?;

    info!("Using container: {}", container_name);

    let session_id = Uuid::new_v4().to_string();

    let shell_cmd = if cols.is_some() && rows.is_some() {
        format!(
            "export TERM=xterm-256color; stty cols {} rows {} 2>/dev/null; exec /bin/sh -i",
            cols.unwrap(),
            rows.unwrap()
        )
    } else {
        "export TERM=xterm-256color; exec /bin/sh -i".to_string()
    };

    info!("Shell command: {}", shell_cmd);

    let attach_params = AttachParams {
        stdin: true,
        stdout: true,
        stderr: false,
        tty: true,
        container: Some(container_name.clone()),
        max_stdin_buf_size: Some(1024 * 1024),
        max_stdout_buf_size: Some(1024 * 1024),
        max_stderr_buf_size: None,
    };

    info!("Executing exec on pod...");
    let mut attached = api
        .exec(pod_name, vec!["/bin/sh", "-c", &shell_cmd], &attach_params)
        .await
        .context(format!("Failed to exec into pod '{}'", pod_name))?;

    info!("Exec successful, setting up streams...");

    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(256);

    let session = TerminalSession {
        session_id: session_id.clone(),
        pod_name: pod_name.to_string(),
        container: container_name.clone(),
        namespace: namespace.to_string(),
    };

    let sid = session_id.clone();

    let task = tokio::spawn(async move {
        let stdin = attached.stdin().unwrap();
        let mut stdin = BufWriter::with_capacity(1024, stdin);
        let mut stdout = attached.stdout().unwrap();

        let mut buf = [0u8; 8192];

        loop {
            tokio::select! {
                biased;

                Some(data) = input_rx.recv() => {
                    let mut write_error = false;

                    if let Err(e) = stdin.write_all(&data).await {
                        error!("Failed to write stdin: {}", e);
                        write_error = true;
                    }

                    if !write_error {
                        while let Ok(more_data) = input_rx.try_recv() {
                            if let Err(e) = stdin.write_all(&more_data).await {
                                error!("Failed to write stdin: {}", e);
                                write_error = true;
                                break;
                            }
                        }
                    }

                    if !write_error {
                        if let Err(e) = stdin.flush().await {
                            error!("Failed to flush stdin: {}", e);
                            write_error = true;
                        }
                    }

                    if write_error {
                        break;
                    }
                }

                result = stdout.read(&mut buf) => {
                    match result {
                        Ok(0) => {
                            info!("Stdout EOF");
                            break;
                        }
                        Ok(n) => {
                            let data = buf[..n].to_vec();
                            let output = TerminalOutput {
                                session_id: sid.clone(),
                                data,
                            };
                            on_output(output);
                        }
                        Err(e) => {
                            error!("Stdout read error: {}", e);
                            break;
                        }
                    }
                }
            }
        }

        SESSIONS.remove(&sid);
        on_close(TerminalClosed {
            session_id: sid,
            reason: "Connection closed".to_string(),
        });
    });

    let handle = SessionHandle {
        input_tx,
        abort_handle: task.abort_handle(),
    };

    SESSIONS.insert(session_id.clone(), handle);

    Ok(session)
}

/// Get a clone of the input sender for direct sync access (avoids thread spawning per keystroke)
pub fn get_input_sender(session_id: &str) -> Option<mpsc::Sender<Vec<u8>>> {
    SESSIONS.get(session_id).map(|s| s.input_tx.clone())
}

pub async fn send_terminal_input(session_id: &str, data: &str) -> Result<()> {
    if let Some(session) = SESSIONS.get(session_id) {
        session
            .input_tx
            .send(data.as_bytes().to_vec())
            .await
            .context("Failed to send input")?;
        Ok(())
    } else {
        anyhow::bail!("Session not found")
    }
}

pub async fn resize_terminal(session_id: &str, cols: u16, rows: u16) -> Result<()> {
    if let Some(session) = SESSIONS.get(session_id) {
        let resize_cmd = format!("\x1b[8;{};{}t", rows, cols);
        session
            .input_tx
            .send(resize_cmd.into_bytes())
            .await
            .context("Failed to resize")?;
        Ok(())
    } else {
        anyhow::bail!("Session not found")
    }
}

pub fn close_terminal_session(session_id: &str) -> Result<()> {
    if let Some((_, session)) = SESSIONS.remove(session_id) {
        session.abort_handle.abort();
        Ok(())
    } else {
        anyhow::bail!("Session not found")
    }
}

pub fn list_terminal_sessions() -> Vec<String> {
    SESSIONS.iter().map(|r| r.key().clone()).collect()
}
