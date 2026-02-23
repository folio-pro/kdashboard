use anyhow::Result;
use gpui::*;
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::mpsc::TryRecvError;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};
use workspace::AppView;

// Actions for the native macOS menu bar
actions!(
    app,
    [
        Quit,
        Hide,
        HideOthers,
        ShowAll,
        CloseWindow,
        Minimize,
        Zoom,
        ToggleFullScreen,
        Copy,
        Paste,
        Cut,
        SelectAll,
        Undo,
        Redo,
    ]
);

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

/// Ensure the PATH includes common tool locations on macOS.
/// When launched from a .app bundle, macOS provides a minimal PATH that
/// excludes directories where kubectl auth plugins (gcloud, aws-iam-authenticator,
/// kubelogin, etc.) are typically installed.
fn ensure_path() {
    let extra_dirs = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
    ];
    let current = std::env::var("PATH").unwrap_or_default();
    let mut dirs: Vec<&str> = current.split(':').collect();
    for dir in &extra_dirs {
        if !dirs.contains(dir) && std::path::Path::new(dir).is_dir() {
            dirs.push(dir);
        }
    }
    // Also try to source the user's shell PATH for any custom locations
    if let Ok(home) = std::env::var("HOME") {
        let shell_path = std::process::Command::new("/bin/zsh")
            .args(["-l", "-c", "echo $PATH"])
            .output();
        if let Ok(output) = shell_path {
            if let Ok(shell_dirs) = String::from_utf8(output.stdout) {
                for dir in shell_dirs.trim().split(':') {
                    if !dir.is_empty() && !dirs.contains(&dir) {
                        dirs.push(Box::leak(dir.to_string().into_boxed_str()));
                    }
                }
            }
        }
        let _ = home; // suppress unused warning
    }
    // SAFETY: called once at the very start of main, before any threads are spawned.
    unsafe { std::env::set_var("PATH", dirs.join(":")) };
}

fn main() -> Result<()> {
    // Fix PATH before anything else so auth exec plugins are discoverable
    ensure_path();

    // Initialize logging
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Starting kdashboard");

    // Initialize Tokio runtime before GPUI
    let _ = k8s_client::tokio_runtime();

    // Get the assets path:
    // 1. In development (cargo run): use CARGO_MANIFEST_DIR relative path
    // 2. In .app bundle: use Contents/Resources next to the executable
    // 3. Fallback: relative path from working directory
    let assets_path = if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        PathBuf::from(manifest_dir)
            .parent()
            .map(|p| p.join("ui/assets"))
            .unwrap_or_else(|| PathBuf::from("crates/ui/assets"))
    } else if let Ok(exe_path) = std::env::current_exe() {
        // exe is at .app/Contents/MacOS/binary → Resources is at .app/Contents/Resources
        let resources = exe_path
            .parent() // MacOS/
            .and_then(|p| p.parent()) // Contents/
            .map(|p| p.join("Resources"));
        match resources {
            Some(ref p) if p.exists() => p.clone(),
            _ => PathBuf::from("crates/ui/assets"),
        }
    } else {
        PathBuf::from("crates/ui/assets")
    };

    tracing::info!("Loading assets from: {:?}", assets_path);

    Application::new()
        .with_assets(Assets { base: assets_path })
        .run(|cx: &mut App| {
            // Register bundled fonts so the app works even if they're
            // not installed on the user's system (e.g. JetBrains Mono).
            let font_bytes: Vec<Cow<'static, [u8]>> = [
                // Inter (static weights for UI)
                include_bytes!("../../ui/assets/fonts/Inter-Regular.ttf").as_slice(),
                include_bytes!("../../ui/assets/fonts/Inter-Medium.ttf").as_slice(),
                include_bytes!("../../ui/assets/fonts/Inter-SemiBold.ttf").as_slice(),
                include_bytes!("../../ui/assets/fonts/Inter-Bold.ttf").as_slice(),
                include_bytes!("../../ui/assets/fonts/Inter-ExtraBold.ttf").as_slice(),
                // JetBrains Mono (regular — with ligatures for code editor)
                include_bytes!("../../ui/assets/fonts/JetBrainsMono-Regular.ttf").as_slice(),
                include_bytes!("../../ui/assets/fonts/JetBrainsMono-Bold.ttf").as_slice(),
                include_bytes!("../../ui/assets/fonts/JetBrainsMono-Italic.ttf").as_slice(),
                include_bytes!("../../ui/assets/fonts/JetBrainsMono-BoldItalic.ttf").as_slice(),
                // JetBrains Mono NL (No Ligatures — for terminal)
                include_bytes!("../../ui/assets/fonts/JetBrainsMonoNL-Regular.ttf").as_slice(),
                include_bytes!("../../ui/assets/fonts/JetBrainsMonoNL-Bold.ttf").as_slice(),
                include_bytes!("../../ui/assets/fonts/JetBrainsMonoNL-Italic.ttf").as_slice(),
                include_bytes!("../../ui/assets/fonts/JetBrainsMonoNL-BoldItalic.ttf").as_slice(),
            ]
            .into_iter()
            .map(Cow::Borrowed)
            .collect();
            if let Err(e) = cx.text_system().add_fonts(font_bytes) {
                tracing::warn!("Failed to register bundled fonts: {}", e);
            }

            // Initialize global state
            ui::init(cx);
            workspace::init(cx);
            editor::init(cx);

            // Set up native macOS menu bar
            setup_menus(cx);

            // Open main window
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                        None,
                        size(px(1280.0), px(800.0)),
                        cx,
                    ))),
                    titlebar: Some(TitlebarOptions {
                        title: Some("kdashboard".into()),
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

fn setup_menus(cx: &mut App) {
    // Register action handlers
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &CloseWindow, cx| {
        if let Some(window) = cx.active_window() {
            let _ = window.update(cx, |_, window, _cx| {
                window.remove_window();
            });
        }
    });
    cx.on_action(|_: &Minimize, cx| {
        if let Some(window) = cx.active_window() {
            let _ = window.update(cx, |_, window, _cx| {
                window.minimize_window();
            });
        }
    });
    cx.on_action(|_: &Zoom, cx| {
        if let Some(window) = cx.active_window() {
            let _ = window.update(cx, |_, window, _cx| {
                window.zoom_window();
            });
        }
    });
    cx.on_action(|_: &ToggleFullScreen, cx| {
        if let Some(window) = cx.active_window() {
            let _ = window.update(cx, |_, window, _cx| {
                window.toggle_fullscreen();
            });
        }
    });

    cx.set_menus(vec![
        // Application menu
        Menu {
            name: "kdashboard".into(),
            items: vec![
                MenuItem::action("About kdashboard", Quit),
                MenuItem::separator(),
                MenuItem::os_submenu("Services", SystemMenuType::Services),
                MenuItem::separator(),
                MenuItem::action("Hide kdashboard", Hide),
                MenuItem::action("Hide Others", HideOthers),
                MenuItem::action("Show All", ShowAll),
                MenuItem::separator(),
                MenuItem::action("Quit kdashboard", Quit),
            ],
        },
        // Edit menu
        Menu {
            name: "Edit".into(),
            items: vec![
                MenuItem::os_action("Undo", Undo, OsAction::Undo),
                MenuItem::os_action("Redo", Redo, OsAction::Redo),
                MenuItem::separator(),
                MenuItem::os_action("Cut", Cut, OsAction::Cut),
                MenuItem::os_action("Copy", Copy, OsAction::Copy),
                MenuItem::os_action("Paste", Paste, OsAction::Paste),
                MenuItem::separator(),
                MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
            ],
        },
        // Window menu
        Menu {
            name: "Window".into(),
            items: vec![
                MenuItem::action("Minimize", Minimize),
                MenuItem::action("Zoom", Zoom),
                MenuItem::separator(),
                MenuItem::action("Enter Full Screen", ToggleFullScreen),
            ],
        },
    ]);

    // Bind keyboard shortcuts for menu actions
    cx.bind_keys([
        KeyBinding::new("secondary-q", Quit, None),
        KeyBinding::new("secondary-h", Hide, None),
        KeyBinding::new("secondary-alt-h", HideOthers, None),
        KeyBinding::new("secondary-w", CloseWindow, None),
        KeyBinding::new("secondary-m", Minimize, None),
        KeyBinding::new("ctrl-secondary-f", ToggleFullScreen, None),
        KeyBinding::new("secondary-z", Undo, None),
        KeyBinding::new("secondary-shift-z", Redo, None),
        KeyBinding::new("secondary-x", Cut, None),
        KeyBinding::new("secondary-c", Copy, None),
        KeyBinding::new("secondary-v", Paste, None),
        KeyBinding::new("secondary-a", SelectAll, None),
    ]);
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
            let _ = tx.send(K8sUpdate::Loading(true));

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

            // Load context metadata from kubeconfig even before connectivity checks,
            // so the UI can always show all available clusters.
            if let Ok(context) = k8s_client::get_current_context().await {
                let _ = tx.send(K8sUpdate::Context(context));
            }

            if let Ok(contexts) = k8s_client::list_contexts().await {
                let _ = tx.send(K8sUpdate::Contexts(contexts));
            }

            // Check connection
            match k8s_client::check_connection().await {
                Ok(()) => {
                    tracing::info!("Connected to Kubernetes cluster");
                    let _ = tx.send(K8sUpdate::Connected);

                    let initial_namespace = match k8s_client::list_namespaces().await {
                        Ok(namespaces) => {
                            // Validate saved namespace against available list
                            let initial_namespace = if let Some(ref saved_ns) = saved_namespace {
                                if namespaces.contains(saved_ns) {
                                    Some(saved_ns.clone())
                                } else {
                                    tracing::warn!("Saved namespace '{}' not found in cluster, using first available", saved_ns);
                                    namespaces.first().cloned()
                                }
                            } else {
                                namespaces.first().cloned()
                            };
                            let _ = tx.send(K8sUpdate::Namespaces(namespaces));
                            initial_namespace
                        }
                        Err(e) => {
                            tracing::error!("Failed to load namespaces after connection: {:#}", e);
                            let _ = tx.send(K8sUpdate::Error(format!(
                                "Connected to Kubernetes, but failed to load namespaces.\n\nError details:\n{:#}",
                                e
                            )));
                            let _ = tx.send(K8sUpdate::Loading(false));
                            return;
                        }
                    };

                    // Send the validated namespace selection
                    if initial_namespace != saved_namespace {
                        // Namespace changed from what was saved, update via K8sUpdate
                        // (The state already has the saved value; we'll update below via Resources)
                    }

                    // Load initial pods
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
                    let _ = tx.send(K8sUpdate::Loading(false));
                }
            }
        });
    });

    // Poll the channel from GPUI's async context
    cx.spawn(async move |cx| {
        // Give the background thread time to start
        cx.background_executor()
            .timer(std::time::Duration::from_millis(100))
            .await;

        // Helper function to handle updates
        fn handle_update(cx: &mut gpui::App, update: K8sUpdate) {
            match update {
                K8sUpdate::Connected => {
                    workspace::update_app_state(cx, |state, _cx| {
                        state.set_connection_status(k8s_client::ConnectionStatus::Connected, None);
                    });
                }
                K8sUpdate::Error(e) => {
                    workspace::update_app_state(cx, |state, _cx| {
                        state.set_connection_status(k8s_client::ConnectionStatus::Error, Some(e));
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

        loop {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(100))
                .await;

            let mut disconnected = false;
            loop {
                match rx.try_recv() {
                    Ok(update) => {
                        let _ = cx.update(|cx| handle_update(cx, update));
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }

            if disconnected {
                break;
            }
        }
    })
    .detach();
}
