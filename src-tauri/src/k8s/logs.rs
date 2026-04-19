use anyhow::Result;
use futures::io::AsyncBufReadExt;
use futures::StreamExt;
use kube::api::LogParams;
use kube::Api;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

use super::client::get_client;

/// Global flag used to signal the log-streaming task to stop.
static STOP_FLAG: AtomicBool = AtomicBool::new(false);

/// Maximum lines to buffer before emitting a batch.
const LOG_BATCH_SIZE: usize = 20;
/// Maximum time (ms) to wait before flushing a partial batch.
const LOG_FLUSH_INTERVAL_MS: u64 = 50;

/// Build LogParams from the common optional fields.
fn build_log_params(
    container: Option<String>,
    tail_lines: Option<i64>,
    since_seconds: Option<i64>,
    timestamps: Option<bool>,
    previous: Option<bool>,
) -> LogParams {
    let mut params = LogParams {
        follow: true,
        ..Default::default()
    };
    if let Some(c) = container {
        params.container = Some(c);
    }
    if let Some(tl) = tail_lines {
        params.tail_lines = Some(tl);
    }
    if let Some(ss) = since_seconds {
        params.since_seconds = Some(ss);
    }
    if let Some(ts) = timestamps {
        params.timestamps = ts;
    }
    if let Some(prev) = previous {
        params.previous = prev;
    }
    params
}

/// Spawn a tokio task that reads log lines from a stream, batches them, and emits "log-lines" events.
/// If `line_prefix` is Some, each line is prefixed with `[prefix] `.
fn spawn_log_reader(
    stream: impl futures::io::AsyncBufRead + Unpin + Send + 'static,
    app_handle: AppHandle,
    line_prefix: Option<String>,
) {
    tokio::spawn(async move {
        let mut lines = stream.lines();
        let mut batch: Vec<String> = Vec::with_capacity(LOG_BATCH_SIZE);
        let flush_duration = tokio::time::Duration::from_millis(LOG_FLUSH_INTERVAL_MS);

        let flush = |b: &mut Vec<String>, handle: &AppHandle| {
            if !b.is_empty() {
                let _ = handle.emit("log-lines", &*b);
                b.clear();
            }
        };

        loop {
            if STOP_FLAG.load(Ordering::SeqCst) {
                flush(&mut batch, &app_handle);
                break;
            }

            match tokio::time::timeout(flush_duration, lines.next()).await {
                Ok(Some(Ok(line))) => {
                    let formatted = match &line_prefix {
                        Some(prefix) => format!("[{}] {}", prefix, line),
                        None => line,
                    };
                    batch.push(formatted);
                    if batch.len() >= LOG_BATCH_SIZE {
                        flush(&mut batch, &app_handle);
                    }
                }
                Ok(Some(Err(e))) => {
                    flush(&mut batch, &app_handle);
                    let msg = match &line_prefix {
                        Some(prefix) => format!("[{}] [error reading log stream: {}]", prefix, e),
                        None => format!("[error reading log stream: {}]", e),
                    };
                    let _ = app_handle.emit("log-lines", vec![msg]);
                    break;
                }
                Ok(None) => {
                    flush(&mut batch, &app_handle);
                    if line_prefix.is_none() {
                        let _ = app_handle.emit("log-lines", vec!["[stream ended]".to_string()]);
                    }
                    break;
                }
                Err(_) => flush(&mut batch, &app_handle),
            }
        }
    });
}

/// Start streaming logs for a pod. Lines are batched and emitted as "log-lines" Tauri events.
#[allow(clippy::too_many_arguments)]
pub async fn stream_pod_logs(
    name: String,
    namespace: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    since_seconds: Option<i64>,
    timestamps: Option<bool>,
    previous: Option<bool>,
    app_handle: AppHandle,
) -> Result<()> {
    STOP_FLAG.store(false, Ordering::SeqCst);

    let client = get_client().await?;
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client, &namespace);
    let params = build_log_params(container, tail_lines, since_seconds, timestamps, previous);
    let stream = pods.log_stream(&name, &params).await?;

    spawn_log_reader(stream, app_handle, None);

    Ok(())
}

/// Stream logs from multiple pods simultaneously. Each line is prefixed with `[pod-name] `.
#[allow(clippy::too_many_arguments)]
pub async fn stream_multi_pod_logs(
    pods: Vec<String>,
    namespace: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    since_seconds: Option<i64>,
    timestamps: Option<bool>,
    previous: Option<bool>,
    app_handle: AppHandle,
) -> Result<()> {
    STOP_FLAG.store(false, Ordering::SeqCst);

    let client = get_client().await?;
    let api: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client, &namespace);

    for pod_name in pods {
        let params = build_log_params(
            container.clone(),
            tail_lines,
            since_seconds,
            timestamps,
            previous,
        );

        let stream = match api.log_stream(&pod_name, &params).await {
            Ok(s) => s,
            Err(e) => {
                let _ =
                    app_handle.emit("log-lines", vec![format!("[{}] [error: {}]", pod_name, e)]);
                continue;
            }
        };

        spawn_log_reader(stream, app_handle.clone(), Some(pod_name));
    }

    Ok(())
}

/// Signal the running log stream to stop.
pub fn stop_log_stream() {
    STOP_FLAG.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_flag_can_be_toggled() {
        STOP_FLAG.store(false, Ordering::SeqCst);
        assert!(!STOP_FLAG.load(Ordering::SeqCst));

        stop_log_stream();
        assert!(STOP_FLAG.load(Ordering::SeqCst));

        // Reset for other tests
        STOP_FLAG.store(false, Ordering::SeqCst);
    }

    #[test]
    fn batch_size_constant_is_reasonable() {
        assert!(LOG_BATCH_SIZE > 0);
        assert!(LOG_BATCH_SIZE <= 100);
    }

    #[test]
    fn flush_interval_constant_is_reasonable() {
        assert!(LOG_FLUSH_INTERVAL_MS > 0);
        assert!(LOG_FLUSH_INTERVAL_MS <= 1000);
    }

    // -----------------------------------------------------------------------
    // build_log_params
    // -----------------------------------------------------------------------

    #[test]
    fn build_log_params_default_follow_is_true() {
        let params = build_log_params(None, None, None, None, None);
        assert!(params.follow);
    }

    #[test]
    fn build_log_params_with_all_fields() {
        let params = build_log_params(
            Some("nginx".to_string()),
            Some(100),
            Some(3600),
            Some(true),
            Some(true),
        );
        assert!(params.follow);
        assert_eq!(params.container.as_deref(), Some("nginx"));
        assert_eq!(params.tail_lines, Some(100));
        assert_eq!(params.since_seconds, Some(3600));
        assert!(params.timestamps);
        assert!(params.previous);
    }

    #[test]
    fn build_log_params_with_only_container() {
        let params = build_log_params(Some("sidecar".to_string()), None, None, None, None);
        assert_eq!(params.container.as_deref(), Some("sidecar"));
        assert_eq!(params.tail_lines, None);
        assert_eq!(params.since_seconds, None);
        assert!(!params.timestamps);
        assert!(!params.previous);
    }

    #[test]
    fn build_log_params_with_only_tail_lines() {
        let params = build_log_params(None, Some(50), None, None, None);
        assert!(params.container.is_none());
        assert_eq!(params.tail_lines, Some(50));
    }

    #[test]
    fn build_log_params_with_only_since_seconds() {
        let params = build_log_params(None, None, Some(300), None, None);
        assert_eq!(params.since_seconds, Some(300));
    }

    #[test]
    fn build_log_params_timestamps_false_when_none() {
        let params = build_log_params(None, None, None, None, None);
        assert!(!params.timestamps);
    }

    #[test]
    fn build_log_params_previous_false_when_none() {
        let params = build_log_params(None, None, None, None, None);
        assert!(!params.previous);
    }

    #[test]
    fn build_log_params_timestamps_explicit_false() {
        let params = build_log_params(None, None, None, Some(false), None);
        assert!(!params.timestamps);
    }

    #[test]
    fn build_log_params_previous_explicit_false() {
        let params = build_log_params(None, None, None, None, Some(false));
        assert!(!params.previous);
    }

    // -----------------------------------------------------------------------
    // STOP_FLAG atomic operations
    // -----------------------------------------------------------------------

    #[test]
    fn stop_flag_default_is_false() {
        // Reset to known state, then verify
        STOP_FLAG.store(false, Ordering::SeqCst);
        assert!(!STOP_FLAG.load(Ordering::SeqCst));
    }

    #[test]
    fn stop_flag_toggling_is_idempotent() {
        STOP_FLAG.store(false, Ordering::SeqCst);

        // Multiple calls to stop should be fine
        stop_log_stream();
        assert!(STOP_FLAG.load(Ordering::SeqCst));
        stop_log_stream();
        assert!(STOP_FLAG.load(Ordering::SeqCst));

        // Reset
        STOP_FLAG.store(false, Ordering::SeqCst);
    }

    // -----------------------------------------------------------------------
    // Constants — additional sanity checks
    // -----------------------------------------------------------------------

    #[test]
    fn batch_size_and_flush_interval_are_compatible() {
        // The batch size should be small enough that flushing is responsive,
        // and the flush interval should be short enough for real-time streaming.
        assert!(
            LOG_BATCH_SIZE <= 50,
            "Batch size {} too large for responsive log streaming",
            LOG_BATCH_SIZE
        );
        assert!(
            LOG_FLUSH_INTERVAL_MS <= 200,
            "Flush interval {}ms too long for real-time streaming",
            LOG_FLUSH_INTERVAL_MS
        );
    }
}
