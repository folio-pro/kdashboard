use anyhow::Result;
use gpui::*;
use std::borrow::Cow;
use std::path::PathBuf;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use workspace::AppView;

/// Asset source for loading icons and other static files
struct Assets {
    base: PathBuf,
}

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        let full_path = self.base.join(path);
        match std::fs::read(&full_path) {
            Ok(data) => Ok(Some(Cow::Owned(data))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) if e.raw_os_error() == Some(21) => Ok(None), // EISDIR: path is a directory
            Err(e) => Err(e.into()),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let full_path = self.base.join(path);
        match std::fs::read_dir(&full_path) {
            Ok(entries) => Ok(entries
                .filter_map(|entry| {
                    entry
                        .ok()
                        .and_then(|e| e.file_name().into_string().ok())
                        .map(SharedString::from)
                })
                .collect()),
            Err(_) => Ok(Vec::new()),
        }
    }
}

fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Starting Kubernetes Dashboard");

    // Initialize Tokio runtime before GPUI
    let _ = k8s_client::tokio_runtime();

    // Get the assets path - in development it's relative to the ui crate
    let assets_path = std::env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .parent()
        .map(|p| p.join("ui/assets"))
        .unwrap_or_else(|| PathBuf::from("crates/ui/assets"));

    tracing::info!("Loading assets from: {:?}", assets_path);

    Application::new()
        .with_assets(Assets { base: assets_path })
        .run(|cx: &mut App| {
        // Initialize global state
        ui::init(cx);
        workspace::init(cx);
        editor::init(cx);

        // Open main window
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1280.0), px(800.0)),
                    cx,
                ))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Kubernetes Dashboard".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(14.0), px(10.0))),
                }),
                window_background: WindowBackgroundAppearance::Blurred,
                focus: true,
                show: true,
                kind: WindowKind::Normal,
                is_movable: true,
                display_id: None,
                window_min_size: Some(size(px(800.0), px(600.0))),
                window_decorations: Some(WindowDecorations::Client),
                app_id: Some("com.k8s-dashboard".to_string()),
                is_resizable: true,
                is_minimizable: true,
                tabbing_identifier: None,
            },
            |window, cx| {
                let app_view = cx.new(|cx| AppView::new(cx));
                cx.new(|cx| ui::gpui_component::Root::new(app_view, window, cx))
            },
        )
        .expect("Failed to open window");

        // Start Kubernetes connection check
        spawn_connection_check(cx);
    });

    Ok(())
}

/// Message from the k8s background thread to GPUI
enum K8sUpdate {
    Connected,
    Error(String),
    Context(String),
    Contexts(Vec<String>),
    Namespaces(Vec<String>),
    Resources(k8s_client::ResourceList),
    Loading(bool),
}

fn spawn_connection_check(cx: &mut App) {
    use std::sync::mpsc;

    // Read saved preferences from AppState (already loaded from settings in workspace::init)
    let saved_context = workspace::app_state(cx).context.clone();
    let saved_namespace = workspace::app_state(cx).namespace.clone();

    // Create a channel to send updates from Tokio to GPUI
    let (tx, rx) = mpsc::channel::<K8sUpdate>();

    // Spawn a thread to run Tokio operations
    std::thread::spawn(move || {
        let rt = k8s_client::tokio_runtime();
        rt.block_on(async {
            // If a saved context differs from current, switch to it first
            if let Some(ref target_ctx) = saved_context {
                if let Ok(current_ctx) = k8s_client::get_current_context().await {
                    if &current_ctx != target_ctx {
                        tracing::info!("Restoring saved context: {}", target_ctx);
                        if let Err(e) = k8s_client::set_context(target_ctx).await {
                            tracing::warn!("Failed to restore saved context '{}': {}", target_ctx, e);
                        }
                    }
                }
            }

            // Check connection
            match k8s_client::check_connection().await {
                Ok(()) => {
                    tracing::info!("Connected to Kubernetes cluster");
                    let _ = tx.send(K8sUpdate::Connected);

                    // Load initial data
                    if let Ok(context) = k8s_client::get_current_context().await {
                        let _ = tx.send(K8sUpdate::Context(context));
                    }

                    if let Ok(contexts) = k8s_client::list_contexts().await {
                        let _ = tx.send(K8sUpdate::Contexts(contexts));
                    }

                    let mut initial_namespace: Option<String> = None;
                    if let Ok(namespaces) = k8s_client::list_namespaces().await {
                        // Validate saved namespace against available list
                        if let Some(ref saved_ns) = saved_namespace {
                            if namespaces.contains(saved_ns) {
                                initial_namespace = Some(saved_ns.clone());
                            } else {
                                tracing::warn!("Saved namespace '{}' not found in cluster, using first available", saved_ns);
                                initial_namespace = namespaces.first().cloned();
                            }
                        } else {
                            initial_namespace = namespaces.first().cloned();
                        }
                        let _ = tx.send(K8sUpdate::Namespaces(namespaces));
                    }

                    // Send the validated namespace selection
                    if initial_namespace != saved_namespace {
                        // Namespace changed from what was saved, update via K8sUpdate
                        // (The state already has the saved value; we'll update below via Resources)
                    }

                    // Load initial pods
                    let _ = tx.send(K8sUpdate::Loading(true));
                    match k8s_client::get_client().await {
                        Ok(client) => {
                            // Try with specific namespace first, then all namespaces as fallback
                            let namespace_ref = initial_namespace.as_deref();
                            match k8s_client::list_resources(
                                &client,
                                k8s_client::ResourceType::Pods,
                                namespace_ref,
                            ).await {
                                Ok(resources) => {
                                    tracing::info!("Loaded {} pods from namespace {:?}", resources.items.len(), namespace_ref);
                                    let _ = tx.send(K8sUpdate::Resources(resources));
                                }
                                Err(e) => {
                                    tracing::warn!("Failed to list pods in namespace {:?}: {}. Trying all namespaces...", namespace_ref, e);
                                    // Try all namespaces if specific namespace fails
                                    match k8s_client::list_resources(
                                        &client,
                                        k8s_client::ResourceType::Pods,
                                        None,
                                    ).await {
                                        Ok(resources) => {
                                            tracing::info!("Loaded {} pods from all namespaces", resources.items.len());
                                            let _ = tx.send(K8sUpdate::Resources(resources));
                                        }
                                        Err(e2) => {
                                            tracing::error!("Failed to list pods: {:#}", e2);
                                            let _ = tx.send(K8sUpdate::Error(format!(
                                                "Cannot list pods. Try selecting a specific namespace.\n\nError details:\n{:#}",
                                                e2
                                            )));
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            tracing::error!("Failed to get client: {:#}", e);
                            let _ = tx.send(K8sUpdate::Error(format!(
                                "Failed to create Kubernetes client.\n\nError details:\n{:#}",
                                e
                            )));
                        }
                    }
                    let _ = tx.send(K8sUpdate::Loading(false));
                }
                Err(e) => {
                    tracing::error!("Failed to connect to Kubernetes: {:#}", e);
                    let _ = tx.send(K8sUpdate::Error(format!("{:#}", e)));
                }
            }
        });
    });

    // Poll the channel from GPUI's async context
    cx.spawn(async move |cx| {
        // Give the background thread time to start
        cx.background_executor().timer(std::time::Duration::from_millis(100)).await;

        // Helper function to handle updates
        fn handle_update(cx: &mut gpui::App, update: K8sUpdate) {
            match update {
                K8sUpdate::Connected => {
                    workspace::update_app_state(cx, |state, _cx| {
                        state.set_connection_status(
                            k8s_client::ConnectionStatus::Connected,
                            None,
                        );
                    });
                }
                K8sUpdate::Error(e) => {
                    workspace::update_app_state(cx, |state, _cx| {
                        state.set_connection_status(
                            k8s_client::ConnectionStatus::Error,
                            Some(e),
                        );
                    });
                }
                K8sUpdate::Context(context) => {
                    workspace::update_app_state(cx, |state, _cx| {
                        state.set_context(Some(context));
                    });
                }
                K8sUpdate::Contexts(contexts) => {
                    workspace::update_app_state(cx, |state, _cx| {
                        state.contexts = contexts;
                    });
                }
                K8sUpdate::Namespaces(namespaces) => {
                    workspace::update_app_state(cx, |state, _cx| {
                        state.namespaces = namespaces;
                    });
                }
                K8sUpdate::Resources(resources) => {
                    workspace::update_app_state(cx, |state, _cx| {
                        state.set_resources(Some(resources));
                    });
                }
                K8sUpdate::Loading(loading) => {
                    workspace::update_app_state(cx, |state, _cx| {
                        state.set_loading(loading);
                    });
                }
            }
        }

        // Process updates from the channel
        while let Ok(update) = rx.try_recv() {
            let _ = cx.update(|cx| handle_update(cx, update));
        }

        // Keep polling for a bit to catch all messages
        for _ in 0..50 {
            cx.background_executor().timer(std::time::Duration::from_millis(100)).await;
            while let Ok(update) = rx.try_recv() {
                let _ = cx.update(|cx| handle_update(cx, update));
            }
        }
    }).detach();
}
