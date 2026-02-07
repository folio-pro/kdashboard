use gpui::*;
use k8s_client::{ResourceList, ResourceType};
use std::sync::mpsc;

/// Message types for resource loading
pub enum ResourceUpdate {
    Loading(bool),
    Resources(ResourceList),
    Namespaces(Vec<String>),
    Error(String),
}

/// Spawn a task to load resources in the background
pub fn load_resources(cx: &mut App, resource_type: ResourceType, namespace: Option<String>) {
    let (tx, rx) = mpsc::channel::<ResourceUpdate>();

    // Set loading state
    crate::update_app_state(cx, |state, _| {
        state.set_loading(true);
        state.set_error(None);
    });

    // Spawn background thread for k8s operations
    std::thread::spawn(move || {
        let rt = get_tokio_runtime();
        rt.block_on(async {
            let _ = tx.send(ResourceUpdate::Loading(true));

            match k8s_client::get_client().await {
                Ok(client) => {
                    let namespace_ref = namespace.as_deref();
                    match k8s_client::list_resources(&client, resource_type, namespace_ref).await {
                        Ok(resources) => {
                            tracing::info!(
                                "Loaded {} {} from namespace {:?}",
                                resources.items.len(),
                                resource_type.display_name(),
                                namespace_ref
                            );
                            let _ = tx.send(ResourceUpdate::Resources(resources));
                        }
                        Err(e) => {
                            tracing::error!("Failed to list {}: {}", resource_type.display_name(), e);
                            let _ = tx.send(ResourceUpdate::Error(format!(
                                "Failed to load {}: {}",
                                resource_type.display_name(),
                                e
                            )));
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to get k8s client: {}", e);
                    let _ = tx.send(ResourceUpdate::Error(format!("Connection error: {}", e)));
                }
            }

            let _ = tx.send(ResourceUpdate::Loading(false));
        });
    });

    // Poll the channel from GPUI
    cx.spawn(async move |cx| {
        // Give background thread time to start
        cx.background_executor()
            .timer(std::time::Duration::from_millis(50))
            .await;

        // Poll for updates
        for _ in 0..100 {
            while let Ok(update) = rx.try_recv() {
                let _ = cx.update(|cx| {
                    handle_resource_update(cx, update);
                });
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(50))
                .await;
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
                state.set_error(Some(error));
            });
        }
    }
}

/// Switch to a different Kubernetes context, reload namespaces and resources
pub fn switch_context(cx: &mut App, context_name: String) {
    let (tx, rx) = mpsc::channel::<ResourceUpdate>();

    crate::update_app_state(cx, |state, _| {
        state.set_loading(true);
        state.set_error(None);
    });

    std::thread::spawn(move || {
        let rt = get_tokio_runtime();
        rt.block_on(async {
            let _ = tx.send(ResourceUpdate::Loading(true));

            // Switch context
            if let Err(e) = k8s_client::set_context(&context_name).await {
                tracing::error!("Failed to switch context to {}: {}", context_name, e);
                let _ = tx.send(ResourceUpdate::Error(format!(
                    "Failed to switch context: {}",
                    e
                )));
                let _ = tx.send(ResourceUpdate::Loading(false));
                return;
            }

            // Reload namespaces
            match k8s_client::list_namespaces().await {
                Ok(namespaces) => {
                    let default_ns = namespaces.first().cloned();
                    let _ = tx.send(ResourceUpdate::Namespaces(namespaces));

                    // Reload resources with first namespace
                    match k8s_client::get_client().await {
                        Ok(client) => {
                            let ns_ref = default_ns.as_deref();
                            match k8s_client::list_resources(
                                &client,
                                ResourceType::Pods,
                                ns_ref,
                            )
                            .await
                            {
                                Ok(resources) => {
                                    let _ = tx.send(ResourceUpdate::Resources(resources));
                                }
                                Err(e) => {
                                    let _ = tx.send(ResourceUpdate::Error(format!(
                                        "Failed to load resources: {}",
                                        e
                                    )));
                                }
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(ResourceUpdate::Error(format!(
                                "Failed to get client: {}",
                                e
                            )));
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(ResourceUpdate::Error(format!(
                        "Failed to list namespaces: {}",
                        e
                    )));
                }
            }

            let _ = tx.send(ResourceUpdate::Loading(false));
        });
    });

    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(std::time::Duration::from_millis(50))
            .await;

        for _ in 0..100 {
            while let Ok(update) = rx.try_recv() {
                let _ = cx.update(|cx| {
                    handle_resource_update(cx, update);
                });
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(50))
                .await;
        }
    })
    .detach();
}

/// Get or create the Tokio runtime (public accessor for other modules)
pub fn get_tokio_runtime_pub() -> &'static tokio::runtime::Runtime {
    get_tokio_runtime()
}

/// Get or create the Tokio runtime
fn get_tokio_runtime() -> &'static tokio::runtime::Runtime {
    use std::sync::OnceLock;
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime")
    })
}
