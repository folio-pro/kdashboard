use anyhow::Result;
use futures::SinkExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams, TerminalSize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use super::client::get_client;

/// Shared state for the active exec session.
struct ExecSession {
    stdin: Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    resize: Option<Mutex<futures::channel::mpsc::Sender<TerminalSize>>>,
}

/// Global session handle.
static SESSION: std::sync::OnceLock<tokio::sync::Mutex<Option<Arc<ExecSession>>>> =
    std::sync::OnceLock::new();

fn session_lock() -> &'static tokio::sync::Mutex<Option<Arc<ExecSession>>> {
    SESSION.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Start an interactive exec session (shell) in a pod container.
/// Output is sent via "terminal-output" events.
/// Input is sent via the `send_terminal_input` command.
pub async fn start_exec(
    name: String,
    namespace: String,
    container: Option<String>,
    command: Vec<String>,
    app_handle: AppHandle,
) -> Result<()> {
    // Stop any previous session first
    stop_exec_inner().await;

    let client = get_client().await?;
    let pods: Api<Pod> = Api::namespaced(client, &namespace);

    let mut ap = AttachParams::interactive_tty();
    if let Some(ref c) = container {
        ap = ap.container(c);
    }

    let mut process = pods.exec(&name, command, &ap).await?;

    let stdin_writer = process
        .stdin()
        .ok_or_else(|| anyhow::anyhow!("No stdin available"))?;
    let mut stdout_reader = process
        .stdout()
        .ok_or_else(|| anyhow::anyhow!("No stdout available"))?;

    let resize_sender = process.terminal_size();

    // Store session — take the weak ref first, then move the Arc into the
    // global so the spawned task never holds a strong reference.
    let session = Arc::new(ExecSession {
        stdin: Mutex::new(Box::new(stdin_writer)),
        resize: resize_sender.map(|s| Mutex::new(s)),
    });
    let session_weak = Arc::downgrade(&session);

    {
        let mut guard = session_lock().lock().await;
        *guard = Some(session); // move, not clone — only the global owns it
    }

    // Read stdout and send to frontend
    let app_out = app_handle.clone();
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            // If our session was stopped/replaced, the strong count is 0
            if session_weak.strong_count() == 0 {
                break;
            }

            match stdout_reader.read(&mut buf).await {
                Ok(0) => {
                    let _ = app_out.emit("terminal-output", "\r\n[session ended]\r\n");
                    break;
                }
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]);
                    let _ = app_out.emit("terminal-output", text.as_ref());
                }
                Err(e) => {
                    let _ = app_out.emit("terminal-output", format!("\r\n[exec error: {}]\r\n", e));
                    break;
                }
            }
        }

        // Clear session if we're still the active one
        {
            let mut guard = session_lock().lock().await;
            if let Some(ref current) = *guard {
                if session_weak
                    .upgrade()
                    .is_some_and(|s| Arc::ptr_eq(current, &s))
                {
                    *guard = None;
                }
            }
        }

        let _ = app_out.emit("terminal-exit", ());
    });

    Ok(())
}

/// Write data to the active session's stdin.
pub async fn write_stdin(data: String) -> Result<()> {
    let session = {
        let guard = session_lock().lock().await;
        guard.clone()
    };

    if let Some(session) = session {
        let bytes = data.into_bytes();
        let mut stdin = session.stdin.lock().await;
        stdin.write_all(&bytes).await?;
        stdin.flush().await?;
    }

    Ok(())
}

/// Send a resize to the active session.
pub async fn resize_terminal(width: u16, height: u16) -> Result<()> {
    let session = {
        let guard = session_lock().lock().await;
        guard.clone()
    };

    if let Some(session) = session {
        if let Some(ref resize) = session.resize {
            let mut sender = resize.lock().await;
            let _ = sender.send(TerminalSize { width, height }).await;
        }
    }

    Ok(())
}

async fn stop_exec_inner() {
    let mut guard = session_lock().lock().await;
    *guard = None;
    // Dropping the Arc drops the stdin writer, which closes the WebSocket stdin channel,
    // causing the remote process to receive EOF and exit.
}

/// Signal the running exec session to stop.
pub async fn stop_exec() {
    stop_exec_inner().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_lock_returns_same_instance() {
        let lock1 = session_lock();
        let lock2 = session_lock();
        assert!(std::ptr::eq(lock1, lock2));
    }

    #[test]
    fn session_lock_is_singleton_across_many_calls() {
        let ptrs: Vec<*const tokio::sync::Mutex<Option<Arc<ExecSession>>>> =
            (0..10).map(|_| session_lock() as *const _).collect();
        for p in &ptrs {
            assert_eq!(*p, ptrs[0], "all calls must return the same pointer");
        }
    }

    #[tokio::test]
    async fn session_lock_initializes_with_none() {
        let guard = session_lock().lock().await;
        // The global starts as None (no active session).
        // Other tests may have cleared it, but it should never be Some
        // without an explicit start_exec call.
        assert!(guard.is_none());
    }

    #[tokio::test]
    async fn stop_exec_clears_session() {
        // Ensure stop_exec doesn't panic when no session is active
        stop_exec().await;
        let guard = session_lock().lock().await;
        assert!(guard.is_none());
    }

    #[tokio::test]
    async fn stop_exec_inner_is_idempotent() {
        stop_exec_inner().await;
        stop_exec_inner().await;
        stop_exec_inner().await;
        // No panic = pass
    }

    #[tokio::test]
    async fn stop_exec_then_stop_exec_inner_no_panic() {
        stop_exec().await;
        stop_exec_inner().await;
        stop_exec().await;
        // Mixed calls must also be safe
    }
}
