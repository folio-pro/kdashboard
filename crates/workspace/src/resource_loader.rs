use gpui::*;
use k8s_client::{ConnectionStatus, ResourceList, ResourceType};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;

/// Generation counter to cancel previous watch when user switches resource/namespace
static WATCH_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Message types for resource loading
pub enum ResourceUpdate {
    Loading(bool),
    Resources(ResourceList),
    Namespaces(Vec<String>),
    Error(String),
}

/// Start watching resources. Performs an initial list via the watcher and then
/// streams live updates. Each call cancels any previous watch.
pub fn load_resources(cx: &mut App, resource_type: ResourceType, namespace: Option<String>) {
    let generation = WATCH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel::<ResourceUpdate>();

    // Set loading state
    crate::update_app_state(cx, |state, _| {
        state.set_loading(true);
        state.set_error(None);
    });

    // Cancellation flag for this watch
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_bg = cancelled.clone();

    // Spawn background thread that runs the watch stream
    std::thread::spawn(move || {
        let rt = k8s_client::tokio_runtime();
        rt.block_on(async {
            let _ = tx.send(ResourceUpdate::Loading(true));

            match k8s_client::get_client().await {
                Ok(client) => {
                    // Channel to receive ResourceList updates from the watcher
                    let (watch_tx, watch_rx) = mpsc::channel::<ResourceList>();

                    let cancelled_watch = cancelled_bg.clone();
                    let ns_clone = namespace.clone();

                    // Spawn the watcher on a Tokio task
                    let handle = tokio::spawn(async move {
                        if let Err(e) = k8s_client::watch_resources(
                            &client,
                            resource_type,
                            ns_clone,
                            watch_tx,
                            cancelled_watch,
                        )
                        .await
                        {
                            tracing::error!(
                                "Watch error for {}: {}",
                                resource_type.display_name(),
                                e
                            );
                            return Err(e);
                        }
                        Ok(())
                    });

                    // Forward watch updates to the GPUI channel
                    let mut first_update = true;
                    loop {
                        if cancelled_bg.load(Ordering::SeqCst) {
                            break;
                        }

                        match watch_rx.recv_timeout(std::time::Duration::from_millis(200)) {
                            Ok(resources) => {
                                if first_update {
                                    tracing::info!(
                                        "Watch established for {} ({} items)",
                                        resource_type.display_name(),
                                        resources.items.len()
                                    );
                                    let _ = tx.send(ResourceUpdate::Loading(false));
                                    first_update = false;
                                }
                                let _ = tx.send(ResourceUpdate::Resources(resources));
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                // Check if the tokio task finished (error or stream ended)
                                if handle.is_finished() {
                                    if first_update {
                                        let _ = tx.send(ResourceUpdate::Loading(false));
                                    }
                                    match handle.try_join() {
                                        Ok(Ok(())) => {
                                            tracing::info!(
                                                "Watch stream ended for {}",
                                                resource_type.display_name()
                                            );
                                        }
                                        Ok(Err(e)) => {
                                            let _ = tx.send(ResourceUpdate::Error(format!(
                                                "Watch failed for {}: {}",
                                                resource_type.display_name(),
                                                e
                                            )));
                                        }
                                        Err(e) => {
                                            let _ = tx.send(ResourceUpdate::Error(format!(
                                                "Watch task panicked: {}",
                                                e
                                            )));
                                        }
                                    }
                                    break;
                                }
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => {
                                if first_update {
                                    let _ = tx.send(ResourceUpdate::Loading(false));
                                }
                                break;
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to get k8s client: {:#}", e);
                    let _ = tx.send(ResourceUpdate::Error(format!("Connection error:\n{:#}", e)));
                    let _ = tx.send(ResourceUpdate::Loading(false));
                }
            }
        });
    });

    // Continuously poll the mpsc channel from GPUI
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(100))
                .await;

            // If a newer watch was started, cancel this one and stop polling
            if WATCH_GENERATION.load(Ordering::SeqCst) != generation {
                cancelled.store(true, Ordering::SeqCst);
                return;
            }

            while let Ok(update) = rx.try_recv() {
                let _ = cx.update(|cx| {
                    handle_resource_update(cx, update);
                });
            }
        }
    })
    .detach();
}

fn handle_resource_update(cx: &mut App, update: ResourceUpdate) {
    match update {
        ResourceUpdate::Loading(loading) => {
            crate::update_app_state(cx, |state, _| {
                state.set_loading(loading);
            });
        }
        ResourceUpdate::Resources(resources) => {
            crate::update_app_state(cx, |state, _| {
                state.set_resources(Some(resources));
                state.set_connection_status(ConnectionStatus::Connected, None);
            });
        }
        ResourceUpdate::Namespaces(namespaces) => {
            crate::update_app_state(cx, |state, _| {
                state.namespaces = namespaces;
                state.set_namespace(None);
            });
        }
        ResourceUpdate::Error(error) => {
            crate::update_app_state(cx, |state, _| {
                state.set_error(Some(error.clone()));
                state.set_connection_status(ConnectionStatus::Error, Some(error));
            });
        }
    }
}

/// Switch to a different Kubernetes context, reload namespaces and resources
pub fn switch_context(cx: &mut App, context_name: String) {
    // Stop all active port forwards when switching context
    k8s_client::stop_all_port_forwards();
    crate::update_app_state(cx, |state, _| {
        state.clear_port_forwards();
    });

    let (tx, rx) = mpsc::channel::<ResourceUpdate>();

    crate::update_app_state(cx, |state, _| {
        state.set_loading(true);
        state.set_error(None);
    });

    std::thread::spawn(move || {
        let rt = k8s_client::tokio_runtime();
        rt.block_on(async {
            let _ = tx.send(ResourceUpdate::Loading(true));

            // Switch context
            if let Err(e) = k8s_client::set_context(&context_name).await {
                tracing::error!("Failed to switch context to {}: {:#}", context_name, e);
                let _ = tx.send(ResourceUpdate::Error(format!(
                    "Failed to switch context:\n{:#}",
                    e
                )));
                let _ = tx.send(ResourceUpdate::Loading(false));
                return;
            }

            // Reload namespaces
            match k8s_client::list_namespaces().await {
                Ok(namespaces) => {
                    let _ = tx.send(ResourceUpdate::Namespaces(namespaces));
                }
                Err(e) => {
                    let _ = tx.send(ResourceUpdate::Error(format!(
                        "Failed to list namespaces:\n{:#}",
                        e
                    )));
                }
            }

            let _ = tx.send(ResourceUpdate::Loading(false));
        });
    });

    cx.spawn(async move |cx| {
        loop {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(50))
                .await;

            let mut disconnected = false;
            loop {
                match rx.try_recv() {
                    Ok(update) => {
                        let _ = cx.update(|cx| {
                            handle_resource_update(cx, update);
                        });
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }

            if disconnected {
                break;
            }
        }

        // After context switch, trigger load_resources which will start a new watch
        let _ = cx.update(|cx| {
            let state = crate::app_state(cx);
            let resource_type = state.selected_type;
            let namespace = state.namespace.clone();
            crate::load_resources(cx, resource_type, namespace);
        });
    })
    .detach();
}

/// Helper trait to try joining a finished JoinHandle without await
trait TryJoin {
    type Output;
    fn try_join(self) -> Result<Self::Output, tokio::task::JoinError>;
}

impl<T> TryJoin for tokio::task::JoinHandle<T> {
    type Output = T;
    fn try_join(self) -> Result<T, tokio::task::JoinError> {
        // Since we only call this after is_finished() returns true,
        // blocking here is safe and instant
        futures::executor::block_on(self)
    }
}
