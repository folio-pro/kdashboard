mod ai_chat_panel;
mod command_bar;

use self::ai_chat_panel::{load_opencode_models, run_ai_connection_test};
use crate::app_state::{ActivePanel, ActiveView, AppState, app_state, update_app_state};
use crate::settings::AIProvider;
use crate::{Header, Sidebar, TitleBar};
use gpui::prelude::FluentBuilder;
use gpui::*;
use k8s_client::{ConnectionStatus, Resource};
use logs::PodLogsView;
use resources::{
    BulkTableAction, DeploymentAction, DeploymentDetails, GenericAction, GenericResourceDetails,
    HpaAction, HpaDetails, PodAction, PodDetails, PortForwardView, PortForwardViewAction,
    ReplicaSetAction, ReplicaSetDetails, ResourceTable, VpaAction, VpaDetails,
};
use terminal::PodTerminalView;
use ui::gpui_component::input::InputState;
use ui::{
    Button, ButtonVariant, ButtonVariants, DropdownMenu, Icon, IconName, PopupMenu, PopupMenuItem,
    Sizable, Size, Spinner, primary_icon_btn, secondary_btn, theme,
};

actions!(
    app_view,
    [
        OpenCommandMode,
        OpenSearchMode,
        CloseCommandBar,
        ExecuteCommandBar,
        CommandBarTab
    ]
);

/// Status categories for metric cards
enum MetricStatus {
    Running,
    Pending,
    Failed,
    Other,
}

pub struct AppView {
    sidebar: Entity<Sidebar>,
    header: Entity<Header>,
    title_bar: Entity<TitleBar>,
    resource_table: Entity<ResourceTable>,
    pod_details: Option<Entity<PodDetails>>,
    deployment_details: Option<Entity<DeploymentDetails>>,
    replicaset_details: Option<Entity<ReplicaSetDetails>>,
    hpa_details: Option<Entity<HpaDetails>>,
    vpa_details: Option<Entity<VpaDetails>>,
    generic_details: Option<Entity<GenericResourceDetails>>,
    pod_logs: Option<Entity<PodLogsView>>,
    pod_terminal: Option<Entity<PodTerminalView>>,
    port_forward_view: Option<Entity<PortForwardView>>,
    ai_prompt_input: Option<Entity<InputState>>,
    _ai_prompt_subscription: Option<Subscription>,
    ai_clear_input_pending: bool,
    ai_scroll_handle: ScrollHandle,
    ai_panel_maximized: bool,
    command_input: Option<Entity<InputState>>,
    _command_subscription: Option<Subscription>,
    command_bar_open: bool,
    command_bar_hint: Option<String>,
    command_bar_error: Option<String>,
    focus_handle: FocusHandle,
}

impl AppView {
    pub fn new(cx: &mut Context<'_, Self>) -> Self {
        let state = app_state(cx);
        let sidebar_collapsed = state.sidebar_collapsed;
        let resources = state
            .resources
            .as_ref()
            .map(|r| r.items.clone())
            .unwrap_or_default();
        let resource_type = state.selected_type;

        // Create resource table
        let resource_table = cx.new(|_| ResourceTable::new(resources, resource_type));

        Self {
            sidebar: cx.new(|_| Sidebar::new(sidebar_collapsed)),
            header: cx.new(|_| Header::new()),
            title_bar: cx.new(|_| TitleBar::new()),
            resource_table,
            pod_details: None,
            deployment_details: None,
            replicaset_details: None,
            hpa_details: None,
            vpa_details: None,
            generic_details: None,
            pod_logs: None,
            pod_terminal: None,
            port_forward_view: None,
            ai_prompt_input: None,
            _ai_prompt_subscription: None,
            ai_clear_input_pending: false,
            ai_scroll_handle: ScrollHandle::new(),
            ai_panel_maximized: false,
            command_input: None,
            _command_subscription: None,
            command_bar_open: false,
            command_bar_hint: None,
            command_bar_error: None,
            focus_handle: cx.focus_handle(),
        }
    }

    fn close_details(&mut self, cx: &mut Context<'_, Self>) {
        self.pod_details = None;
        self.deployment_details = None;
        self.replicaset_details = None;
        self.hpa_details = None;
        self.vpa_details = None;
        self.generic_details = None;

        update_app_state(cx, |state, _| {
            state.set_selected_resource(None);
        });

        cx.notify();
    }
}

impl Render for AppView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        // Sync state with views
        let (resources, resource_type, selected_resource) = {
            let state = app_state(cx);
            let resources: Vec<Resource> =
                state.filtered_resources().into_iter().cloned().collect();
            let resource_type = state.selected_type;
            let selected_resource = state.selected_resource.clone();
            (resources, resource_type, selected_resource)
        };

        // Check if we should close details (resource type changed)
        if let Some(ref selected) = selected_resource {
            if selected.kind != resource_type.api_kind() {
                self.close_details(cx);
            }
            // Clear mismatched detail views (e.g. navigating from deployment to one of its pods)
            if selected.kind != "Deployment" && self.deployment_details.is_some() {
                self.deployment_details = None;
            }
            if selected.kind != "Pod" && self.pod_details.is_some() {
                self.pod_details = None;
            }
            if selected.kind != "ReplicaSet" && self.replicaset_details.is_some() {
                self.replicaset_details = None;
            }
            if selected.kind != "HorizontalPodAutoscaler" && self.hpa_details.is_some() {
                self.hpa_details = None;
            }
            if selected.kind != "VerticalPodAutoscaler" && self.vpa_details.is_some() {
                self.vpa_details = None;
            }
        }

        // Sync detail views with selected_resource
        if selected_resource.is_none() {
            self.pod_details = None;
            self.deployment_details = None;
            self.replicaset_details = None;
            self.hpa_details = None;
            self.vpa_details = None;
            self.generic_details = None;
        }

        // Update resource table with current resources
        self.resource_table.update(cx, |table, _| {
            table.set_resources(resources);
            table.set_resource_type(resource_type);
        });

        // Set up the on_open handler for double-click
        self.resource_table.update(cx, |table, _| {
            table.set_on_open(|resource, cx| {
                // Update global state with selected resource
                // The next render will pick this up
                cx.update_global::<crate::app_state::AppState, _>(|state, _cx| {
                    state.set_selected_resource(Some(resource.clone()));
                });
                cx.notify();
            });
            table.set_on_bulk_action(|action, selected_resources, cx| {
                if selected_resources.is_empty() {
                    return;
                }

                let state = cx.global::<AppState>();
                let resource_type = state.selected_type;

                match action {
                    BulkTableAction::Delete => {
                        delete_resources_bulk_bg(cx, resource_type, selected_resources);
                    }
                    BulkTableAction::Scale { replicas } => {
                        scale_resources_bulk_bg(cx, resource_type, selected_resources, replicas);
                    }
                    BulkTableAction::Label { key, value } => {
                        label_resources_bulk_bg(cx, resource_type, selected_resources, key, value);
                    }
                }
            });
            table.set_on_ai_assist(|resource, cx| {
                let prompt = AppView::build_ai_issue_prompt(resource);
                cx.update_global::<AppState, _>(|state, _| {
                    state.active_panel = ActivePanel::AI;
                    state.queue_ai_prefill_prompt(prompt, true, Some(resource.clone()));
                });
                cx.notify();
            });
        });

        // Check if we need to create detail views from global state
        if let Some(resource) = selected_resource.clone() {
            let no_details_showing = self.pod_details.is_none()
                && self.deployment_details.is_none()
                && self.replicaset_details.is_none()
                && self.hpa_details.is_none()
                && self.vpa_details.is_none()
                && self.generic_details.is_none();

            if no_details_showing {
                match resource.kind.as_str() {
                    "Pod" => {
                        self.pod_details = Some(cx.new(|_| {
                            PodDetails::new(resource)
                                .on_close(|cx| {
                                    cx.update_global::<AppState, _>(|state, _cx| {
                                        state.set_selected_resource(None);
                                    });
                                })
                                .on_action(|action, cx| match action {
                                    PodAction::ViewLogs {
                                        pod_name,
                                        namespace,
                                        containers,
                                        selected_container,
                                    } => {
                                        cx.update_global::<AppState, _>(|state, _cx| {
                                            state.open_pod_logs(
                                                pod_name.clone(),
                                                namespace.clone(),
                                                containers.clone(),
                                                selected_container.clone(),
                                            );
                                        });
                                    }
                                    PodAction::OpenTerminal {
                                        pod_name,
                                        namespace,
                                        containers,
                                        selected_container,
                                    } => {
                                        cx.update_global::<AppState, _>(|state, _cx| {
                                            state.open_pod_terminal(
                                                pod_name.clone(),
                                                namespace.clone(),
                                                containers.clone(),
                                                selected_container.clone(),
                                            );
                                        });
                                    }
                                    PodAction::Delete {
                                        pod_name,
                                        namespace,
                                    } => {
                                        cx.update_global::<AppState, _>(|state, _cx| {
                                            state.set_selected_resource(None);
                                        });
                                        delete_resource_bg(
                                            cx,
                                            k8s_client::ResourceType::Pods,
                                            pod_name.clone(),
                                            namespace.clone(),
                                        );
                                    }
                                    PodAction::PortForward {
                                        pod_name,
                                        namespace,
                                        container_port,
                                        local_port,
                                    } => {
                                        cx.update_global::<AppState, _>(|state, _cx| {
                                            state.pf_error = None;
                                        });
                                        start_port_forward_bg(
                                            cx,
                                            pod_name,
                                            namespace,
                                            container_port,
                                            local_port,
                                        );
                                    }
                                    PodAction::StopPortForward { session_id } => {
                                        let _ = k8s_client::stop_port_forward(&session_id);
                                        cx.update_global::<AppState, _>(|state, _cx| {
                                            state.remove_port_forward(&session_id);
                                        });
                                    }
                                })
                        }));
                    }
                    "Deployment" => {
                        let deploy_resource = resource.clone();
                        let deployment_details = cx.new(|_| {
                            DeploymentDetails::new(resource)
                                .on_close(|cx| {
                                    cx.update_global::<AppState, _>(|state, _cx| {
                                        state.set_selected_resource(None);
                                    });
                                })
                                .on_action(|action, cx| match action {
                                    DeploymentAction::Delete { name, namespace } => {
                                        cx.update_global::<AppState, _>(|state, _cx| {
                                            state.set_selected_resource(None);
                                        });
                                        delete_resource_bg(
                                            cx,
                                            k8s_client::ResourceType::Deployments,
                                            name,
                                            namespace,
                                        );
                                    }
                                    DeploymentAction::SelectPod { resource: pod } => {
                                        cx.update_global::<AppState, _>(|state, _cx| {
                                            state.selected_type = k8s_client::ResourceType::Pods;
                                            state.set_selected_resource(Some(pod));
                                        });
                                    }
                                })
                        });
                        // Fetch related pods in background
                        fetch_related_pods(cx, deploy_resource, deployment_details.clone());
                        self.deployment_details = Some(deployment_details);
                    }
                    "ReplicaSet" => {
                        self.replicaset_details = Some(cx.new(|_| {
                            ReplicaSetDetails::new(resource)
                                .on_close(|cx| {
                                    cx.update_global::<AppState, _>(|state, _cx| {
                                        state.set_selected_resource(None);
                                    });
                                })
                                .on_action(|action, cx| match action {
                                    ReplicaSetAction::Delete { name, namespace } => {
                                        cx.update_global::<AppState, _>(|state, _cx| {
                                            state.set_selected_resource(None);
                                        });
                                        delete_resource_bg(
                                            cx,
                                            k8s_client::ResourceType::ReplicaSets,
                                            name,
                                            namespace,
                                        );
                                    }
                                })
                        }));
                    }
                    "HorizontalPodAutoscaler" => {
                        self.hpa_details = Some(cx.new(|_| {
                            HpaDetails::new(resource)
                                .on_close(|cx| {
                                    cx.update_global::<AppState, _>(|state, _cx| {
                                        state.set_selected_resource(None);
                                    });
                                })
                                .on_action(|action, cx| match action {
                                    HpaAction::Delete { name, namespace } => {
                                        cx.update_global::<AppState, _>(|state, _cx| {
                                            state.set_selected_resource(None);
                                        });
                                        delete_resource_bg(
                                            cx,
                                            k8s_client::ResourceType::HorizontalPodAutoscalers,
                                            name,
                                            namespace,
                                        );
                                    }
                                })
                        }));
                    }
                    "VerticalPodAutoscaler" => {
                        self.vpa_details = Some(cx.new(|_| {
                            VpaDetails::new(resource)
                                .on_close(|cx| {
                                    cx.update_global::<AppState, _>(|state, _cx| {
                                        state.set_selected_resource(None);
                                    });
                                })
                                .on_action(|action, cx| match action {
                                    VpaAction::Delete { name, namespace } => {
                                        cx.update_global::<AppState, _>(|state, _cx| {
                                            state.set_selected_resource(None);
                                        });
                                        delete_resource_bg(
                                            cx,
                                            k8s_client::ResourceType::VerticalPodAutoscalers,
                                            name,
                                            namespace,
                                        );
                                    }
                                })
                        }));
                    }
                    kind => {
                        let (type_label, icon) = match kind {
                            "StatefulSet" => ("StatefulSets", ui::IconName::StatefulSets),
                            "DaemonSet" => ("DaemonSets", ui::IconName::DaemonSets),
                            "Job" => ("Jobs", ui::IconName::Jobs),
                            "CronJob" => ("CronJobs", ui::IconName::CronJobs),
                            "Service" => ("Services", ui::IconName::Services),
                            "Ingress" => ("Ingresses", ui::IconName::Ingresses),
                            "ConfigMap" => ("ConfigMaps", ui::IconName::ConfigMaps),
                            "Secret" => ("Secrets", ui::IconName::Secrets),
                            "Node" => ("Nodes", ui::IconName::Nodes),
                            "Namespace" => ("Namespaces", ui::IconName::Namespaces),
                            _ => ("Resources", ui::IconName::Box),
                        };
                        let rt = resource_type;
                        self.generic_details = Some(cx.new(|_| {
                            GenericResourceDetails::new(resource, type_label, icon)
                                .on_close(|cx| {
                                    cx.update_global::<AppState, _>(|state, _cx| {
                                        state.set_selected_resource(None);
                                    });
                                })
                                .on_action(move |action, cx| match action {
                                    GenericAction::Delete { name, namespace } => {
                                        cx.update_global::<AppState, _>(|state, _cx| {
                                            state.set_selected_resource(None);
                                        });
                                        delete_resource_bg(cx, rt, name, namespace);
                                    }
                                })
                        }));
                    }
                }
            }
        }

        // Check if we need to create PodLogsView from global state
        {
            let state = app_state(cx);
            if state.active_view == ActiveView::PodLogs && self.pod_logs.is_none() {
                if let Some(pod_ctx) = &state.pod_context {
                    let pod_name = pod_ctx.pod_name.clone();
                    let namespace = pod_ctx.namespace.clone();
                    let containers = pod_ctx.containers.clone();
                    let logs_view = cx.new(|_| {
                        PodLogsView::new(pod_name, namespace, containers).on_close(|cx| {
                            cx.update_global::<AppState, _>(|state, _cx| {
                                state.close_pod_view();
                            });
                        })
                    });
                    // Start fetching logs
                    PodLogsView::init(logs_view.clone(), cx);
                    self.pod_logs = Some(logs_view);
                }
            } else if state.active_view != ActiveView::PodLogs && self.pod_logs.is_some() {
                self.pod_logs = None;
            }
        }

        // Check if we need to create/destroy PortForwardView
        {
            let state = app_state(cx);
            if state.active_view == ActiveView::PortForwards {
                if self.port_forward_view.is_none() {
                    let pf_list = state.port_forwards.clone();
                    self.port_forward_view = Some(cx.new(|_| {
                        PortForwardView::new(pf_list)
                            .on_close(|cx| {
                                cx.update_global::<AppState, _>(|state, _cx| {
                                    state.active_view = ActiveView::ResourceTable;
                                });
                            })
                            .on_action(|action, cx| match action {
                                PortForwardViewAction::Stop { session_id } => {
                                    let _ = k8s_client::stop_port_forward(&session_id);
                                    cx.update_global::<AppState, _>(|state, _cx| {
                                        state.remove_port_forward(&session_id);
                                    });
                                }
                                PortForwardViewAction::OpenBrowser { local_port } => {
                                    let url = format!("http://localhost:{}", local_port);
                                    #[cfg(target_os = "macos")]
                                    {
                                        let _ =
                                            std::process::Command::new("open").arg(&url).spawn();
                                    }
                                    #[cfg(target_os = "linux")]
                                    {
                                        let _ = std::process::Command::new("xdg-open")
                                            .arg(&url)
                                            .spawn();
                                    }
                                    #[cfg(target_os = "windows")]
                                    {
                                        let _ = std::process::Command::new("cmd")
                                            .args(["/C", "start", &url])
                                            .spawn();
                                    }
                                }
                            })
                    }));
                } else {
                    // Sync port forwards list
                    let pf_list = state.port_forwards.clone();
                    if let Some(port_forward_view) = self.port_forward_view.as_ref() {
                        port_forward_view.update(cx, |view, _| {
                            view.set_port_forwards(pf_list);
                        });
                    }
                }
            } else if self.port_forward_view.is_some() {
                self.port_forward_view = None;
            }
        }

        // Sync port forwards and errors into pod_details if it exists
        if let Some(ref pd) = self.pod_details {
            let state = app_state(cx);
            let pf_list = state.port_forwards.clone();
            let pf_error = state.pf_error.clone();
            pd.update(cx, |view, _| {
                view.set_port_forwards(pf_list);
                view.set_pf_error(pf_error);
            });
        }

        // Sync detail views with updated resource data from watch
        if let Some(ref selected) = selected_resource {
            if let Some(ref pd) = self.pod_details {
                pd.update(cx, |view, _| {
                    view.set_resource(selected.clone());
                });
            }
            if let Some(ref dd) = self.deployment_details {
                dd.update(cx, |view, _| {
                    view.set_resource(selected.clone());
                });
            }
            if let Some(ref rd) = self.replicaset_details {
                rd.update(cx, |view, _| {
                    view.set_resource(selected.clone());
                });
            }
            if let Some(ref hd) = self.hpa_details {
                hd.update(cx, |view, _| {
                    view.set_resource(selected.clone());
                });
            }
            if let Some(ref vd) = self.vpa_details {
                vd.update(cx, |view, _| {
                    view.set_resource(selected.clone());
                });
            }
            if let Some(ref gd) = self.generic_details {
                gd.update(cx, |view, _| {
                    view.set_resource(selected.clone());
                });
            }
        }

        // Check if we need to create PodTerminalView from global state
        {
            let state = app_state(cx);
            if state.active_view == ActiveView::PodTerminal && self.pod_terminal.is_none() {
                if let Some(pod_ctx) = &state.pod_context {
                    let pod_name = pod_ctx.pod_name.clone();
                    let namespace = pod_ctx.namespace.clone();
                    let containers = pod_ctx.containers.clone();
                    let terminal_view = cx.new(|cx| {
                        PodTerminalView::new(pod_name, namespace, containers, cx).on_close(|cx| {
                            cx.update_global::<AppState, _>(|state, _cx| {
                                state.close_pod_view();
                            });
                        })
                    });
                    // Start the terminal session
                    PodTerminalView::init(terminal_view.clone(), cx);
                    self.pod_terminal = Some(terminal_view);
                }
            } else if state.active_view != ActiveView::PodTerminal && self.pod_terminal.is_some() {
                self.pod_terminal = None;
            }
        }

        self.ensure_command_input(window, cx);

        // Render
        let theme = theme(cx);
        let colors = &theme.colors;
        let state = app_state(cx);
        let active_view = state.active_view.clone();
        let active_panel = state.active_panel;
        let showing_details = self.pod_details.is_some()
            || self.deployment_details.is_some()
            || self.replicaset_details.is_some()
            || self.hpa_details.is_some()
            || self.vpa_details.is_some()
            || self.generic_details.is_some();
        let showing_logs = self.pod_logs.is_some();
        let showing_terminal = self.pod_terminal.is_some();
        let showing_port_forwards = self.port_forward_view.is_some();
        let showing_settings = state.settings_open || active_view == ActiveView::Settings;

        div()
            .id("workspace-root")
            .track_focus(&self.focus_handle)
            .on_click(cx.listener(|this, _event, window, _cx| {
                window.focus(&this.focus_handle);
            }))
            .key_context(if self.command_bar_open {
                "CommandBar"
            } else {
                "Workspace"
            })
            .on_action(cx.listener(|this, _action: &OpenCommandMode, window, cx| {
                this.open_command_mode(window, cx);
            }))
            .on_action(cx.listener(|this, _action: &OpenSearchMode, window, cx| {
                this.open_search_mode(window, cx);
            }))
            .on_action(cx.listener(|this, _action: &CloseCommandBar, window, cx| {
                this.close_command_bar(window, cx);
            }))
            .on_action(
                cx.listener(|this, _action: &ExecuteCommandBar, _window, cx| {
                    this.execute_command_bar(cx);
                }),
            )
            .on_action(cx.listener(|this, _action: &CommandBarTab, window, cx| {
                this.handle_command_bar_tab(window, cx);
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if this.command_bar_open {
                    this.handle_command_bar_keydown(event, window, cx);
                    return;
                }

                let key = event.keystroke.key.as_str();
                let key_char = event.keystroke.key_char.as_deref().unwrap_or("");
                let open_command = key_char == ":"
                    || key == ":"
                    || (key == ";"
                        && event.keystroke.modifiers.shift
                        && !event.keystroke.modifiers.control
                        && !event.keystroke.modifiers.alt)
                    || (key == "semicolon" && key_char == ":");
                let open_search =
                    (key_char == "/" || key == "/" || (key == "slash" && key_char == "/"))
                        && !event.keystroke.modifiers.control
                        && !event.keystroke.modifiers.alt;

                if open_command {
                    this.open_command_mode(window, cx);
                } else if open_search {
                    this.open_search_mode(window, cx);
                }
            }))
            .size_full()
            .relative()
            .bg(colors.background)
            .text_color(colors.text)
            .font_family(theme.font_family.clone())
            .flex()
            .flex_col()
            // Title bar
            .child(self.title_bar.clone())
            // Main content area
            .child(
                div()
                    .flex_1()
                    .flex()
                    .overflow_hidden()
                    // Sidebar
                    .child(self.sidebar.clone())
                    // Main area
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .overflow_hidden()
                            // Header (only show in table mode)
                            .when(
                                !showing_details
                                    && !showing_logs
                                    && !showing_terminal
                                    && !showing_port_forwards,
                                |el: Div| el.child(self.header.clone()),
                            )
                            // Content
                            .child(self.render_content(
                                window,
                                cx,
                                active_view.clone(),
                                active_panel,
                                showing_details,
                                showing_logs,
                                showing_terminal,
                                showing_port_forwards,
                                showing_settings,
                            )),
                    ),
            )
            .when(self.command_bar_open, |el| {
                el.child(
                    div()
                        .absolute()
                        .bottom(px(0.0))
                        .left(px(0.0))
                        .right(px(0.0))
                        .child(self.render_command_bar(cx)),
                )
            })
    }
}

impl AppView {
    fn render_content(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
        _active_view: ActiveView,
        active_panel: ActivePanel,
        showing_details: bool,
        showing_logs: bool,
        showing_terminal: bool,
        showing_port_forwards: bool,
        showing_settings: bool,
    ) -> impl IntoElement {
        let overlay_bg = theme(cx).colors.background;

        // Show port forwards view (full screen)
        if showing_port_forwards {
            if let Some(pf_view) = &self.port_forward_view {
                let mut content = div()
                    .flex_1()
                    .relative()
                    .overflow_hidden()
                    .child(pf_view.clone());
                if showing_settings {
                    content = content.child(
                        div()
                            .absolute()
                            .top(px(0.0))
                            .left(px(0.0))
                            .right(px(0.0))
                            .bottom(px(0.0))
                            .bg(overlay_bg)
                            .child(self.render_settings_view(cx)),
                    );
                }
                return content.into_any_element();
            }
        }

        // Show terminal view (full screen)
        if showing_terminal {
            if let Some(terminal_view) = &self.pod_terminal {
                let mut content = div()
                    .flex_1()
                    .relative()
                    .overflow_hidden()
                    .child(terminal_view.clone());
                if showing_settings {
                    content = content.child(
                        div()
                            .absolute()
                            .top(px(0.0))
                            .left(px(0.0))
                            .right(px(0.0))
                            .bottom(px(0.0))
                            .bg(overlay_bg)
                            .child(self.render_settings_view(cx)),
                    );
                }
                return content.into_any_element();
            }
        }

        // Show logs view (full screen)
        if showing_logs {
            if let Some(logs_view) = &self.pod_logs {
                let mut content = div()
                    .flex_1()
                    .relative()
                    .overflow_hidden()
                    .child(logs_view.clone());
                if showing_settings {
                    content = content.child(
                        div()
                            .absolute()
                            .top(px(0.0))
                            .left(px(0.0))
                            .right(px(0.0))
                            .bottom(px(0.0))
                            .bg(overlay_bg)
                            .child(self.render_settings_view(cx)),
                    );
                }
                return content.into_any_element();
            }
        }

        // Show details view
        if showing_details {
            if let Some(details) = &self.pod_details {
                let mut content = div()
                    .flex_1()
                    .relative()
                    .overflow_hidden()
                    .child(details.clone());
                if showing_settings {
                    content = content.child(
                        div()
                            .absolute()
                            .top(px(0.0))
                            .left(px(0.0))
                            .right(px(0.0))
                            .bottom(px(0.0))
                            .bg(overlay_bg)
                            .child(self.render_settings_view(cx)),
                    );
                }
                return content.into_any_element();
            }
            if let Some(details) = &self.deployment_details {
                let mut content = div()
                    .flex_1()
                    .relative()
                    .overflow_hidden()
                    .child(details.clone());
                if showing_settings {
                    content = content.child(
                        div()
                            .absolute()
                            .top(px(0.0))
                            .left(px(0.0))
                            .right(px(0.0))
                            .bottom(px(0.0))
                            .bg(overlay_bg)
                            .child(self.render_settings_view(cx)),
                    );
                }
                return content.into_any_element();
            }
            if let Some(details) = &self.replicaset_details {
                let mut content = div()
                    .flex_1()
                    .relative()
                    .overflow_hidden()
                    .child(details.clone());
                if showing_settings {
                    content = content.child(
                        div()
                            .absolute()
                            .top(px(0.0))
                            .left(px(0.0))
                            .right(px(0.0))
                            .bottom(px(0.0))
                            .bg(overlay_bg)
                            .child(self.render_settings_view(cx)),
                    );
                }
                return content.into_any_element();
            }
            if let Some(details) = &self.hpa_details {
                let mut content = div()
                    .flex_1()
                    .relative()
                    .overflow_hidden()
                    .child(details.clone());
                if showing_settings {
                    content = content.child(
                        div()
                            .absolute()
                            .top(px(0.0))
                            .left(px(0.0))
                            .right(px(0.0))
                            .bottom(px(0.0))
                            .bg(overlay_bg)
                            .child(self.render_settings_view(cx)),
                    );
                }
                return content.into_any_element();
            }
            if let Some(details) = &self.vpa_details {
                let mut content = div()
                    .flex_1()
                    .relative()
                    .overflow_hidden()
                    .child(details.clone());
                if showing_settings {
                    content = content.child(
                        div()
                            .absolute()
                            .top(px(0.0))
                            .left(px(0.0))
                            .right(px(0.0))
                            .bottom(px(0.0))
                            .bg(overlay_bg)
                            .child(self.render_settings_view(cx)),
                    );
                }
                return content.into_any_element();
            }
            if let Some(details) = &self.generic_details {
                let mut content = div()
                    .flex_1()
                    .relative()
                    .overflow_hidden()
                    .child(details.clone());
                if showing_settings {
                    content = content.child(
                        div()
                            .absolute()
                            .top(px(0.0))
                            .left(px(0.0))
                            .right(px(0.0))
                            .bottom(px(0.0))
                            .bg(overlay_bg)
                            .child(self.render_settings_view(cx)),
                    );
                }
                return content.into_any_element();
            }
        }

        // Table view
        let state = app_state(cx);
        let base_content = div()
            .size_full()
            .flex()
            .overflow_hidden()
            // Resource table area
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .p(px(24.0))
                    .gap(px(24.0))
                    .child(self.render_resource_area(cx, state)),
            );

        let mut content = div()
            .flex_1()
            .relative()
            .overflow_hidden()
            .child(base_content);

        // Right panel (logs, terminal, AI)
        if active_panel != ActivePanel::None {
            content = content.child(
                div()
                    .absolute()
                    .top(px(0.0))
                    .right(px(0.0))
                    .bottom(px(0.0))
                    .child(self.render_right_panel(window, cx, active_panel)),
            );
        }

        if showing_settings {
            content = content.child(
                div()
                    .absolute()
                    .top(px(0.0))
                    .left(px(0.0))
                    .right(px(0.0))
                    .bottom(px(0.0))
                    .bg(overlay_bg)
                    .child(self.render_settings_view(cx)),
            );
        }

        content.into_any_element()
    }

    fn render_resource_area(
        &self,
        cx: &Context<'_, Self>,
        state: &crate::app_state::AppState,
    ) -> impl IntoElement {
        if state.connection_status == ConnectionStatus::Connecting {
            let theme = theme(cx);
            let colors = &theme.colors;

            return div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .w_full()
                        .max_w(px(680.0))
                        .px(px(22.0))
                        .py(px(20.0))
                        .rounded(theme.border_radius_lg)
                        .bg(colors.surface_elevated)
                        .border_1()
                        .border_color(colors.border.opacity(0.5))
                        .font_family(theme.font_family_ui.clone())
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(12.0))
                        .child(
                            div().child(
                                Spinner::new()
                                    .icon(IconName::Refresh)
                                    .color(colors.text)
                                    .with_size(Size::Large),
                            ),
                        )
                        .child(
                            div()
                                .text_size(px(16.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors.text)
                                .child("Connecting to Kubernetes cluster..."),
                        )
                        .child(
                            div()
                                .text_size(px(13.0))
                                .text_color(colors.text_muted)
                                .child("Loading contexts, namespaces, and resources."),
                        ),
                );
        }

        if state.connection_status == ConnectionStatus::Error {
            if let Some(connection_feedback) = self.render_connection_feedback(cx, state) {
                return div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(div().w_full().max_w(px(860.0)).child(connection_feedback));
            }
        }

        let theme = theme(cx);
        let colors = &theme.colors;
        let resource_type = state.selected_type;
        let namespace = state.namespace.clone();
        let namespaces = state.namespaces.clone();

        let mut container = div().size_full().flex().flex_col().gap(px(14.0));

        // 1. Breadcrumb (context > namespace)
        container = container.child(self.render_breadcrumb(cx, &namespace, namespaces));

        // 2. Page header (title + subtitle + action buttons)
        container = container.child(self.render_page_header(cx, resource_type));

        // 3. Metric cards
        container = container.child(self.render_metric_cards(cx, state));

        // Error message
        if let Some(error) = &state.error {
            container = container.child(
                div()
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(theme.border_radius_md)
                    .bg(colors.error.opacity(0.1))
                    .border_1()
                    .border_color(colors.error.opacity(0.3))
                    .text_size(theme.font_size_small)
                    .text_color(colors.error)
                    .child(error.clone()),
            );
        }

        // 4. Resource table or loading state
        if state.is_loading {
            container = container.child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .w_full()
                            .max_w(px(680.0))
                            .px(px(22.0))
                            .py(px(20.0))
                            .rounded(theme.border_radius_lg)
                            .bg(colors.surface_elevated)
                            .border_1()
                            .border_color(colors.border.opacity(0.5))
                            .font_family(theme.font_family_ui.clone())
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(12.0))
                            .child(
                                div().child(
                                    Spinner::new()
                                        .icon(IconName::Refresh)
                                        .color(colors.text)
                                        .with_size(Size::Large),
                                ),
                            )
                            .child(
                                div()
                                    .text_size(px(16.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(colors.text)
                                    .child(format!("Loading {}...", resource_type.display_name())),
                            )
                            .child(
                                div()
                                    .text_size(px(13.0))
                                    .text_color(colors.text_muted)
                                    .child("Fetching the latest data from your cluster."),
                            ),
                    ),
            );
        } else {
            container = container.child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .child(self.resource_table.clone()),
            );
        }

        container
    }

    fn render_connection_feedback(
        &self,
        cx: &Context<'_, Self>,
        state: &crate::app_state::AppState,
    ) -> Option<AnyElement> {
        if state.connection_status != ConnectionStatus::Error {
            return None;
        }

        let theme = theme(cx);
        let colors = &theme.colors;
        let raw_error = state
            .connection_error
            .clone()
            .unwrap_or_else(|| "Unknown Kubernetes connection error".to_string());

        let (possible_cause, step_1, step_2, step_3) =
            if raw_error.contains("Failed to read kubeconfig") {
                (
                    "~/.kube/config does not exist or is not readable.",
                    "1) Verify ~/.kube/config exists.",
                    "2) Run: kubectl config current-context.",
                    "3) Check file read permissions.",
                )
            } else if raw_error.contains("No current context set in kubeconfig") {
                (
                    "No active context is set in kubeconfig.",
                    "1) List contexts: kubectl config get-contexts.",
                    "2) Set one: kubectl config use-context <name>.",
                    "3) Click Retry connection.",
                )
            } else if raw_error.contains("Failed to list namespaces") {
                (
                    "The current context does not have enough permissions in the cluster.",
                    "1) Run: kubectl auth can-i list namespaces.",
                    "2) Switch to a context with permissions.",
                    "3) Click Retry connection.",
                )
            } else {
                (
                    "The Kubernetes client could not be created with the current configuration.",
                    "1) Verify kubectl works in your terminal.",
                    "2) Check the active context in kubeconfig.",
                    "3) Click Retry connection.",
                )
            };

        Some(
            div()
                .w_full()
                .px(px(22.0))
                .py(px(20.0))
                .rounded(theme.border_radius_lg)
                .bg(colors.error.opacity(0.08))
                .border_1()
                .border_color(colors.error.opacity(0.4))
                .font_family(theme.font_family_ui.clone())
                .flex()
                .flex_col()
                .gap(px(12.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .child(
                            Icon::new(IconName::Warning)
                                .size(px(18.0))
                                .color(colors.error),
                        )
                        .child(
                            div()
                                .text_size(px(16.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors.error)
                                .child("Could not connect to the Kubernetes cluster"),
                        ),
                )
                .child(
                    div()
                        .text_size(px(14.0))
                        .text_color(colors.text)
                        .child(possible_cause),
                )
                .child(
                    div()
                        .text_size(px(14.0))
                        .text_color(colors.text_muted)
                        .child(step_1),
                )
                .child(
                    div()
                        .text_size(px(14.0))
                        .text_color(colors.text_muted)
                        .child(step_2),
                )
                .child(
                    div()
                        .text_size(px(14.0))
                        .text_color(colors.text_muted)
                        .child(step_3),
                )
                .child(
                    div()
                        .text_size(px(13.0))
                        .text_color(colors.text_muted)
                        .child(format!("Technical details: {}", raw_error)),
                )
                .child(
                    div().w_full().pt(px(6.0)).child(
                        secondary_btn(
                            "connection-retry-btn",
                            IconName::Refresh,
                            "Retry connection",
                            colors,
                        )
                        .w_full()
                        .justify_center()
                        .px(px(14.0))
                        .py(px(10.0))
                        .on_click(cx.listener(
                            |_this, _event, _window, cx| {
                                cx.update_global::<AppState, _>(|state, _| {
                                    state.set_connection_status(ConnectionStatus::Connecting, None);
                                    state.set_error(None);
                                });
                                let state = cx.global::<AppState>();
                                let resource_type = state.selected_type;
                                let namespace = state.namespace.clone();
                                crate::load_resources(cx, resource_type, namespace);
                                cx.notify();
                            },
                        )),
                    ),
                )
                .into_any_element(),
        )
    }

    /// Render breadcrumb navigation (namespace selector)
    fn render_breadcrumb(
        &self,
        cx: &Context<'_, Self>,
        namespace: &Option<String>,
        namespaces: Vec<String>,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let ns_label: SharedString = namespace
            .clone()
            .unwrap_or_else(|| "All Namespaces".to_string())
            .into();

        // Namespace selector dropdown
        let current_ns = namespace.clone();
        let namespace_button = Button::new("breadcrumb-namespace")
            .icon(IconName::Layers)
            .label(ns_label)
            .compact()
            .with_variant(ButtonVariant::Ghost)
            .dropdown_caret(true)
            .dropdown_menu(move |menu: PopupMenu, _window, _cx| {
                let mut m = menu.scrollable(true);
                // "All Namespaces" option
                let is_all = current_ns.is_none();
                m = m.item(
                    PopupMenuItem::new("All Namespaces")
                        .checked(is_all)
                        .on_click(|_, _window, cx| {
                            cx.update_global::<AppState, _>(|state, _| {
                                state.set_namespace(None);
                            });
                            let resource_type = cx.global::<AppState>().selected_type;
                            crate::load_resources(cx, resource_type, None);
                        }),
                );
                for ns in &namespaces {
                    let ns_for_state = ns.clone();
                    let ns_for_reload = ns.clone();
                    let is_selected = current_ns.as_ref() == Some(ns);
                    m = m.item(
                        PopupMenuItem::new(ns.clone())
                            .checked(is_selected)
                            .on_click(move |_, _window, cx| {
                                let ns = ns_for_state.clone();
                                let ns2 = ns_for_reload.clone();
                                cx.update_global::<AppState, _>(|state, _| {
                                    state.set_namespace(Some(ns));
                                });
                                let resource_type = cx.global::<AppState>().selected_type;
                                crate::load_resources(cx, resource_type, Some(ns2));
                            }),
                    );
                }
                m
            });

        div()
            .flex()
            .items_center()
            .gap(px(4.0))
            .font_family(theme.font_family_ui.clone())
            .child(namespace_button)
    }

    /// Render the page header with title, subtitle, and action buttons
    fn render_page_header(
        &self,
        cx: &Context<'_, Self>,
        resource_type: k8s_client::ResourceType,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div()
            .w_full()
            .flex()
            .items_center()
            .justify_between()
            // Left: title + subtitle
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .font_family(theme.font_family_ui.clone())
                            .text_size(px(28.0))
                            .font_weight(FontWeight::BOLD)
                            .text_color(colors.text)
                            .child(resource_type.display_name()),
                    )
                    .child(
                        div()
                            .font_family(theme.font_family_ui.clone())
                            .text_size(px(14.0))
                            .text_color(colors.text_muted)
                            .child(format!(
                                "Manage and monitor your {} resources",
                                resource_type.display_name().to_lowercase()
                            )),
                    ),
            )
            // Right: action buttons
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    // Refresh button
                    .child(
                        secondary_btn("page-refresh-btn", IconName::Refresh, "Refresh", colors)
                            .on_click(cx.listener(|_this, _event, _window, cx| {
                                let state = cx.global::<AppState>();
                                let resource_type = state.selected_type;
                                let namespace = state.namespace.clone();
                                crate::load_resources(cx, resource_type, namespace);
                                cx.notify();
                            })),
                    )
                    .child(
                        secondary_btn("page-ai-btn", IconName::AI, "AI Assistant", colors)
                            .on_click(cx.listener(|_this, _event, _window, cx| {
                                cx.update_global::<AppState, _>(|state, _| {
                                    state.toggle_panel(ActivePanel::AI);
                                });
                                cx.notify();
                            })),
                    )
                    // Create button - disabled (not yet implemented)
                    .child(
                        primary_icon_btn(
                            "page-create-btn",
                            IconName::Plus,
                            format!("Create {}", resource_type.api_kind()),
                            colors.primary,
                            colors.background,
                        )
                        .opacity(0.5),
                    ),
            )
    }

    /// Render the 4 metric cards (Total, Running, Pending, Failed)
    fn render_metric_cards(
        &self,
        cx: &Context<'_, Self>,
        state: &crate::app_state::AppState,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let resource_type = state.selected_type;

        // Compute metrics from resources
        let resources = state
            .resources
            .as_ref()
            .map(|r| &r.items[..])
            .unwrap_or(&[]);

        let total = resources.len();
        let mut running = 0usize;
        let mut pending = 0usize;
        let mut failed = 0usize;

        for resource in resources {
            let status = Self::get_status_for_metric(resource);
            match status {
                MetricStatus::Running => running += 1,
                MetricStatus::Pending => pending += 1,
                MetricStatus::Failed => failed += 1,
                MetricStatus::Other => {}
            }
        }

        let type_name = resource_type.display_name().to_uppercase();

        div()
            .w_full()
            .flex()
            .gap(px(10.0))
            .child(self.render_single_metric(
                cx,
                &format!("TOTAL {}", type_name),
                &total.to_string(),
                None,
                colors.text_accent,
            ))
            .child(self.render_single_metric(
                cx,
                "RUNNING",
                &running.to_string(),
                if total > 0 {
                    Some(format!("{:.0}%", running as f64 / total as f64 * 100.0))
                } else {
                    None
                },
                colors.text_accent,
            ))
            .child(self.render_single_metric(
                cx,
                "PENDING",
                &pending.to_string(),
                if pending > 0 {
                    Some("waiting".to_string())
                } else {
                    None
                },
                colors.warning,
            ))
            .child(self.render_single_metric(
                cx,
                "FAILED",
                &failed.to_string(),
                if failed > 0 {
                    Some("attention".to_string())
                } else {
                    None
                },
                colors.error,
            ))
    }

    /// Render a single metric card
    fn render_single_metric(
        &self,
        cx: &Context<'_, Self>,
        label: &str,
        value: &str,
        subtitle: Option<String>,
        subtitle_color: Hsla,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let card = div()
            .flex_1()
            .px(px(14.0))
            .py(px(10.0))
            .rounded(theme.border_radius_md)
            .bg(colors.surface)
            .border_1()
            .border_color(colors.border)
            .flex()
            .flex_col()
            .gap(px(2.0))
            // Label
            .child(
                div()
                    .font_family(theme.font_family_ui.clone())
                    .text_size(px(10.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(colors.text_muted)
                    .child(label.to_string()),
            )
            // Value row: number + optional subtitle
            .child({
                let mut row = div().flex().items_center().gap(px(6.0)).child(
                    div()
                        .text_size(px(22.0))
                        .font_weight(FontWeight::BOLD)
                        .text_color(colors.text)
                        .child(value.to_string()),
                );
                if let Some(sub) = subtitle {
                    row = row.child(
                        div()
                            .text_size(px(11.0))
                            .text_color(subtitle_color)
                            .child(sub),
                    );
                }
                row
            });

        card
    }

    /// Determine the metric status for a resource
    fn get_status_for_metric(resource: &Resource) -> MetricStatus {
        let kind = resource.kind.as_str();
        match kind {
            "Pod" => {
                let phase = resource
                    .status
                    .as_ref()
                    .and_then(|s| s.get("phase"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                match phase.as_str() {
                    "running" | "succeeded" => MetricStatus::Running,
                    "pending" => MetricStatus::Pending,
                    "failed" => MetricStatus::Failed,
                    _ => MetricStatus::Other,
                }
            }
            "Deployment" => {
                let available = resource
                    .status
                    .as_ref()
                    .and_then(|s| s.get("availableReplicas"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let desired = resource
                    .spec
                    .as_ref()
                    .and_then(|s| s.get("replicas"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                if available == desired && desired > 0 {
                    MetricStatus::Running
                } else if available < desired {
                    MetricStatus::Pending
                } else {
                    MetricStatus::Other
                }
            }
            "Node" => {
                let conditions = resource
                    .status
                    .as_ref()
                    .and_then(|s| s.get("conditions"))
                    .and_then(|v| v.as_array());
                if let Some(conds) = conditions {
                    for c in conds {
                        if c.get("type").and_then(|t| t.as_str()) == Some("Ready") {
                            return match c.get("status").and_then(|s| s.as_str()) {
                                Some("True") => MetricStatus::Running,
                                Some("False") => MetricStatus::Failed,
                                _ => MetricStatus::Other,
                            };
                        }
                    }
                }
                MetricStatus::Other
            }
            "Service" | "ConfigMap" | "Secret" | "Namespace" => MetricStatus::Running,
            _ => MetricStatus::Other,
        }
    }

    fn build_ai_issue_prompt(resource: &Resource) -> String {
        let namespace = resource
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let kind = resource.kind.clone();
        let name = resource.metadata.name.clone();

        let phase = resource
            .status
            .as_ref()
            .and_then(|s| s.get("phase"))
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");

        if kind == "Pod" && phase.eq_ignore_ascii_case("Pending") {
            return format!(
                "Investigate why pod '{}' in namespace '{}' is Pending. Run automatic diagnostics first and provide root cause plus the next best action.",
                name, namespace
            );
        }

        format!(
            "Investigate issues for {} '{}' in namespace '{}'. Analyze current state, identify likely root cause, and recommend the next best action.",
            kind, name, namespace
        )
    }

    fn render_right_panel(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
        active_panel: ActivePanel,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let is_ai_panel = active_panel == ActivePanel::AI;
        let panel_width = if is_ai_panel && self.ai_panel_maximized {
            px(760.0)
        } else {
            px(400.0)
        };

        let title = match active_panel {
            ActivePanel::Logs => "Logs",
            ActivePanel::Terminal => "Terminal",
            ActivePanel::AI => "AI Assistant",
            ActivePanel::None => "",
        };

        div()
            .w(panel_width)
            .h_full()
            .border_l_1()
            .border_color(colors.border)
            .bg(colors.surface)
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(40.0))
                    .px(px(16.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(colors.border)
                    .child(
                        div()
                            .text_size(theme.font_size)
                            .text_color(colors.text)
                            .child(title),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .when(is_ai_panel, |el| {
                                el.child(
                                    div()
                                        .id("maximize-panel-btn")
                                        .cursor_pointer()
                                        .text_color(colors.text_muted)
                                        .hover(|style| style.text_color(colors.text))
                                        .child(
                                            Icon::new(IconName::Maximize)
                                                .size(px(14.0))
                                                .color(colors.text_muted),
                                        )
                                        .on_click(cx.listener(|this, _event, _window, cx| {
                                            this.ai_panel_maximized = !this.ai_panel_maximized;
                                            cx.notify();
                                        })),
                                )
                            })
                            .child(
                                div()
                                    .id("close-panel-btn")
                                    .cursor_pointer()
                                    .text_color(colors.text_muted)
                                    .hover(|style| style.text_color(colors.text))
                                    .child("×")
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        this.ai_panel_maximized = false;
                                        update_app_state(cx, |state, _| {
                                            state.active_panel = ActivePanel::None;
                                        });
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.0))
                    .overflow_hidden()
                    .p(px(16.0))
                    .child(
                        div().size_full().min_h(px(0.0)).overflow_hidden().child(
                            match active_panel {
                                ActivePanel::AI => {
                                    self.render_ai_panel_body(window, cx).into_any_element()
                                }
                                _ => div()
                                    .text_size(theme.font_size)
                                    .text_color(colors.text_muted)
                                    .child(format!("{} panel content", title))
                                    .into_any_element(),
                            },
                        ),
                    ),
            )
    }

    fn render_settings_view(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let should_load_models = {
            let state = app_state(cx);
            state.ai_provider == AIProvider::OpenCode
                && !state.opencode_models_loading
                && state.opencode_models.is_empty()
        };
        if should_load_models {
            cx.defer(|cx| {
                load_opencode_models(cx);
            });
        }

        let theme = theme(cx);
        let colors = &theme.colors;
        let state = app_state(cx);
        let provider = state.ai_provider;
        let is_testing = state.ai_connection_testing;
        let opencode_models = state.opencode_models.clone();
        let opencode_models_loading = state.opencode_models_loading;
        let selected_model = state.opencode_selected_model.clone();

        let status_text = if is_testing {
            "Testing connection..."
        } else {
            match state.ai_connection_success {
                Some(true) => "Connection OK",
                Some(false) => "Connection failed",
                None => "Not tested yet",
            }
        };
        let status_color = if is_testing {
            colors.warning
        } else if state.ai_connection_success == Some(true) {
            colors.success
        } else if state.ai_connection_success == Some(false) {
            colors.error
        } else {
            colors.text_muted
        };
        let status_icon = if is_testing {
            IconName::Refresh
        } else if state.ai_connection_success == Some(true) {
            IconName::Check
        } else if state.ai_connection_success == Some(false) {
            IconName::Error
        } else {
            IconName::Info
        };
        let test_button_icon = if is_testing {
            IconName::Refresh
        } else {
            IconName::Play
        };
        let test_button_label = if is_testing {
            "Testing..."
        } else {
            "Test connection"
        };

        div()
            .size_full()
            .overflow_hidden()
            .p(px(24.0))
            .flex()
            .flex_col()
            .child(
                div()
                    .w_full()
                    .h_full()
                    .flex()
                    .flex_col()
                    .gap(px(16.0))
                    .p(px(20.0))
                    .rounded(theme.border_radius_lg)
                    .bg(colors.background)
                    .border_1()
                    .border_color(colors.border)
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .justify_between()
                            .gap(px(12.0))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.0))
                                    .child(
                                        div()
                                            .font_family(theme.font_family_ui.clone())
                                            .text_size(px(28.0))
                                            .font_weight(FontWeight::BOLD)
                                            .text_color(colors.text)
                                            .child("Settings")
                                    )
                                    .child(
                                        div()
                                            .font_family(theme.font_family_ui.clone())
                                            .text_size(px(14.0))
                                            .text_color(colors.text_muted)
                                            .child("Configure your AI provider, model, and quick validation flow for the assistant panel.")
                                    )
                            )
                            .child(
                                secondary_btn("settings-close-btn", IconName::Close, "Close", colors)
                                    .on_click(cx.listener(|_this, _event, _window, cx| {
                                        cx.update_global::<AppState, _>(|state, _| {
                                            state.close_settings();
                                        });
                                        cx.notify();
                                    }))
                            )
                    )
                    .child(
                        div()
                            .id("settings-scroll")
                            .w_full()
                            .max_w(px(960.0))
                            .min_h(px(0.0))
                            .overflow_y_scroll()
                            .flex()
                            .flex_col()
                            .gap(px(12.0))
                            .pr(px(4.0))
                            .child(
                                div()
                                    .w_full()
                                    .p(px(14.0))
                                    .rounded(theme.border_radius_lg)
                                    .bg(colors.surface_elevated)
                                    .border_1()
                                    .border_color(colors.border)
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(12.0))
                                    .child(
                                        div()
                                            .flex()
                                            .flex_col()
                                            .gap(px(4.0))
                                            .child(
                                                div()
                                                    .text_size(px(13.0))
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .text_color(colors.text)
                                                    .child("AI status")
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(12.0))
                                                    .text_color(colors.text_muted)
                                                    .child("Run a quick check after changing provider or model.")
                                            )
                                    )
                                    .child(
                                        div()
                                            .px(px(10.0))
                                            .py(px(6.0))
                                            .rounded(theme.border_radius_md)
                                            .bg(colors.surface)
                                            .border_1()
                                            .border_color(colors.border)
                                            .flex()
                                            .items_center()
                                            .gap(px(6.0))
                                            .child(Icon::new(status_icon).size(px(13.0)).color(status_color))
                                            .text_size(px(12.0))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(status_color)
                                            .child(status_text)
                                    )
                            )
                            .child(
                                div()
                                    .w_full()
                                    .p(px(16.0))
                                    .rounded(theme.border_radius_lg)
                                    .bg(colors.surface)
                                    .border_1()
                                    .border_color(colors.border)
                                    .flex()
                                    .flex_col()
                                    .gap(px(14.0))
                                    .child(
                                        div()
                                            .text_size(px(16.0))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(colors.text)
                                            .child("AI Connection")
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.0))
                                            .text_color(colors.text_muted)
                                            .child("Choose which provider is used by connection tests and by the AI panel.")
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .flex_col()
                                            .gap(px(8.0))
                                            .child(
                                                div()
                                                    .text_size(px(12.0))
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .text_color(colors.text_muted)
                                                    .child("Provider")
                                            )
                                            .child(
                                                div()
                                                    .w_full()
                                                    .flex()
                                                    .flex_wrap()
                                                    .gap(px(10.0))
                                                    .child({
                                                        let is_selected = provider == AIProvider::OpenCode;
                                                        let mut card = div()
                                                            .id("settings-provider-opencode")
                                                            .flex_1()
                                                            .min_w(px(260.0))
                                                            .p(px(12.0))
                                                            .rounded(theme.border_radius_md)
                                                            .border_1()
                                                            .cursor_pointer()
                                                            .bg(if is_selected {
                                                                colors.primary.opacity(0.12)
                                                            } else {
                                                                colors.surface
                                                            })
                                                            .border_color(if is_selected {
                                                                colors.primary
                                                            } else {
                                                                colors.border
                                                            })
                                                            .hover(|style| style.opacity(0.9))
                                                            .on_click(cx.listener(|_this, _event, _window, cx| {
                                                                cx.update_global::<AppState, _>(|state, _| {
                                                                    state.set_ai_provider(AIProvider::OpenCode);
                                                                });
                                                                load_opencode_models(cx);
                                                            }))
                                                            .child(
                                                                div()
                                                                    .flex()
                                                                    .items_center()
                                                                    .gap(px(8.0))
                                                                    .child(Icon::new(IconName::Cloud).size(px(14.0)).color(
                                                                        if is_selected {
                                                                            colors.primary
                                                                        } else {
                                                                            colors.text_secondary
                                                                        },
                                                                    ))
                                                                    .child(
                                                                        div()
                                                                            .text_size(px(13.0))
                                                                            .font_weight(FontWeight::SEMIBOLD)
                                                                            .text_color(colors.text)
                                                                            .child("OpenCode")
                                                                    )
                                                            )
                                                            .child(
                                                                div()
                                                                    .mt(px(6.0))
                                                                    .text_size(px(12.0))
                                                                    .text_color(colors.text_muted)
                                                                    .child("Model selection with explicit refresh and diagnostics.")
                                                            );
                                                        if is_selected {
                                                            card = card.child(
                                                                div()
                                                                    .mt(px(8.0))
                                                                    .text_size(px(11.0))
                                                                    .font_weight(FontWeight::SEMIBOLD)
                                                                    .text_color(colors.primary)
                                                                    .child("Selected")
                                                            );
                                                        }
                                                        card
                                                    })
                                                    .child({
                                                        let is_selected = provider == AIProvider::ClaudeCode;
                                                        let mut card = div()
                                                            .id("settings-provider-claudecode")
                                                            .flex_1()
                                                            .min_w(px(260.0))
                                                            .p(px(12.0))
                                                            .rounded(theme.border_radius_md)
                                                            .border_1()
                                                            .cursor_pointer()
                                                            .bg(if is_selected {
                                                                colors.primary.opacity(0.12)
                                                            } else {
                                                                colors.surface
                                                            })
                                                            .border_color(if is_selected {
                                                                colors.primary
                                                            } else {
                                                                colors.border
                                                            })
                                                            .hover(|style| style.opacity(0.9))
                                                            .on_click(cx.listener(|_this, _event, _window, cx| {
                                                                cx.update_global::<AppState, _>(|state, _| {
                                                                    state.set_ai_provider(AIProvider::ClaudeCode);
                                                                });
                                                            }))
                                                            .child(
                                                                div()
                                                                    .flex()
                                                                    .items_center()
                                                                    .gap(px(8.0))
                                                                    .child(Icon::new(IconName::AI).size(px(14.0)).color(
                                                                        if is_selected {
                                                                            colors.primary
                                                                        } else {
                                                                            colors.text_secondary
                                                                        },
                                                                    ))
                                                                    .child(
                                                                        div()
                                                                            .text_size(px(13.0))
                                                                            .font_weight(FontWeight::SEMIBOLD)
                                                                            .text_color(colors.text)
                                                                            .child("ClaudeCode")
                                                                    )
                                                            )
                                                            .child(
                                                                div()
                                                                    .mt(px(6.0))
                                                                    .text_size(px(12.0))
                                                                    .text_color(colors.text_muted)
                                                                    .child("Uses local CLI auth and default model from environment.")
                                                            );
                                                        if is_selected {
                                                            card = card.child(
                                                                div()
                                                                    .mt(px(8.0))
                                                                    .text_size(px(11.0))
                                                                    .font_weight(FontWeight::SEMIBOLD)
                                                                    .text_color(colors.primary)
                                                                    .child("Selected")
                                                            );
                                                        }
                                                        card
                                                    })
                                            )
                                    )
                                    .when(provider == AIProvider::OpenCode, |el| {
                                        let model_label = selected_model
                                            .clone()
                                            .unwrap_or_else(|| "Select model".to_string());
                                        let models_for_menu = opencode_models.clone();
                                        let selected_for_menu = selected_model.clone();

                                        let model_button = Button::new("settings-opencode-model")
                                            .icon(IconName::Layers)
                                            .label(model_label)
                                            .compact()
                                            .with_variant(ButtonVariant::Ghost)
                                            .dropdown_caret(true)
                                            .dropdown_menu(move |menu: PopupMenu, _window, _cx| {
                                                let mut m = menu.scrollable(true);
                                                for model in &models_for_menu {
                                                    let model_value = model.clone();
                                                    let is_selected = selected_for_menu.as_ref() == Some(model);
                                                    m = m.item(
                                                        PopupMenuItem::new(model.clone())
                                                            .checked(is_selected)
                                                            .on_click(move |_, _window, cx| {
                                                                cx.update_global::<AppState, _>(|state, _| {
                                                                    state.set_opencode_selected_model(Some(model_value.clone()));
                                                                });
                                                            }),
                                                    );
                                                }
                                                m
                                            });

                                        el.child(
                                            div()
                                                .flex()
                                                .flex_col()
                                                .gap(px(8.0))
                                                .child(
                                                    div()
                                                        .text_size(px(12.0))
                                                        .font_weight(FontWeight::SEMIBOLD)
                                                        .text_color(colors.text_muted)
                                                        .child("OpenCode model")
                                                )
                                                .child(
                                                    div()
                                                        .flex()
                                                        .items_center()
                                                        .gap(px(12.0))
                                                        .child(model_button)
                                                        .child(
                                                            secondary_btn("settings-opencode-models-refresh", IconName::Refresh, "Refresh models", colors)
                                                                .when(opencode_models_loading, |btn| btn.opacity(0.5))
                                                                .on_click(cx.listener(move |_this, _event, _window, cx| {
                                                                    if !opencode_models_loading {
                                                                        load_opencode_models(cx);
                                                                    }
                                                                }))
                                                        )
                                                )
                                                .child(
                                                    div()
                                                        .text_size(px(12.0))
                                                        .text_color(colors.text_muted)
                                                        .child(if opencode_models_loading {
                                                            "Loading OpenCode models...".to_string()
                                                        } else if opencode_models.is_empty() {
                                                            "Could not load models. Check auth/network and click refresh.".to_string()
                                                        } else {
                                                            format!("{} models available", opencode_models.len())
                                                        })
                                                )
                                        )
                                    })
                                    .when(provider == AIProvider::ClaudeCode, |el| {
                                        el.child(
                                            div()
                                                .text_size(px(12.0))
                                                .text_color(colors.text_muted)
                                                .child("ClaudeCode uses your local CLI authentication and default model unless configured externally.")
                                        )
                                    })
                            )
                            .child(
                                div()
                                    .w_full()
                                    .p(px(16.0))
                                    .rounded(theme.border_radius_lg)
                                    .bg(colors.surface)
                                    .border_1()
                                    .border_color(colors.border)
                                    .flex()
                                    .flex_col()
                                    .gap(px(12.0))
                                    .child(
                                        div()
                                            .text_size(px(16.0))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(colors.text)
                                            .child("Actions")
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.0))
                                            .text_color(colors.text_muted)
                                            .child("Validate your configuration, then jump directly into the AI panel.")
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(12.0))
                                            .child(
                                                secondary_btn("settings-ai-test-btn", test_button_icon, test_button_label, colors)
                                                    .when(is_testing, |el| el.opacity(0.5))
                                                    .on_click(cx.listener(move |_this, _event, _window, cx| {
                                                        if !is_testing {
                                                            run_ai_connection_test(cx, provider, selected_model.clone());
                                                        }
                                                    }))
                                            )
                                            .child(
                                                secondary_btn("settings-open-ai-panel-btn", IconName::AI, "Open AI panel", colors)
                                                    .on_click(cx.listener(|_this, _event, _window, cx| {
                                                        cx.update_global::<AppState, _>(|state, _| {
                                                            if state.active_panel != ActivePanel::AI {
                                                                state.active_panel = ActivePanel::AI;
                                                            }
                                                            state.close_settings();
                                                        });
                                                        cx.notify();
                                                    }))
                                            )
                                    )
                            )
                            .child(
                                div()
                                    .w_full()
                                    .p(px(16.0))
                                    .rounded(theme.border_radius_lg)
                                    .bg(colors.surface)
                                    .border_1()
                                    .border_color(colors.border)
                                    .flex()
                                    .flex_col()
                                    .gap(px(10.0))
                                    .child(
                                        div()
                                            .text_size(px(16.0))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(colors.text)
                                            .child("Diagnostics")
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.0))
                                            .text_color(colors.text_muted)
                                            .child("Latest output from the provider check.")
                                    )
                                    .child(
                                        div()
                                            .p(px(12.0))
                                            .rounded(theme.border_radius_md)
                                            .bg(colors.surface_elevated)
                                            .border_1()
                                            .border_color(colors.border)
                                            .child(
                                                div()
                                                    .text_size(px(12.0))
                                                    .text_color(colors.text)
                                                    .child(
                                                        format!("\"{}\"", state.ai_connection_message
                                                            .clone()
                                                            .unwrap_or_else(|| "No output yet. Use \"Test connection\" to verify communication.".to_string()))
                                                    )
                                            )
                                    )
                            )
                    )
            )
    }
}

fn start_port_forward_bg<T: 'static>(
    cx: &mut Context<'_, T>,
    pod_name: String,
    namespace: String,
    container_port: u16,
    local_port: Option<u16>,
) {
    let (tx, rx) = std::sync::mpsc::channel::<Result<k8s_client::PortForwardInfo, String>>();

    std::thread::spawn(move || {
        let rt = k8s_client::tokio_runtime();
        rt.block_on(async {
            match k8s_client::get_client().await {
                Ok(client) => {
                    match k8s_client::start_port_forward(
                        &client,
                        &pod_name,
                        &namespace,
                        container_port,
                        local_port,
                    )
                    .await
                    {
                        Ok(info) => {
                            let _ = tx.send(Ok(info));
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e.to_string()));
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        });
    });

    cx.spawn(async move |_view, cx| {
        for _ in 0..100 {
            if let Ok(result) = rx.try_recv() {
                let _ = cx.update(|cx: &mut gpui::App| match result {
                    Ok(info) => {
                        tracing::info!(
                            "Port forward started: localhost:{} → {}:{}",
                            info.local_port,
                            info.pod_name,
                            info.container_port
                        );
                        cx.update_global::<AppState, _>(|state, _cx| {
                            state.pf_error = None;
                            state.add_port_forward(info);
                        });
                    }
                    Err(e) => {
                        tracing::error!("Failed to start port forward: {}", e);
                        cx.update_global::<AppState, _>(|state, _cx| {
                            state.pf_error = Some(format!("Port forward failed: {}", e));
                        });
                    }
                });
                return;
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(50))
                .await;
        }
    })
    .detach();
}

fn fetch_related_pods(
    cx: &mut Context<'_, AppView>,
    deployment: k8s_client::Resource,
    details_entity: Entity<DeploymentDetails>,
) {
    // Extract matchLabels from deployment spec.selector.matchLabels
    let selector: std::collections::BTreeMap<String, String> = deployment
        .spec
        .as_ref()
        .and_then(|s| s.get("selector"))
        .and_then(|s| s.get("matchLabels"))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let namespace = deployment.metadata.namespace.clone();

    let (tx, rx) = std::sync::mpsc::channel::<Vec<k8s_client::Resource>>();

    std::thread::spawn(move || {
        let rt = k8s_client::tokio_runtime();
        rt.block_on(async {
            match k8s_client::get_client().await {
                Ok(client) => {
                    match k8s_client::list_resources(
                        &client,
                        k8s_client::ResourceType::Pods,
                        namespace.as_deref(),
                    )
                    .await
                    {
                        Ok(pod_list) => {
                            let matched: Vec<k8s_client::Resource> = pod_list
                                .items
                                .into_iter()
                                .filter(|pod| {
                                    resources::labels_match_selector(
                                        &pod.metadata.labels,
                                        &selector,
                                    )
                                })
                                .collect();
                            let _ = tx.send(matched);
                        }
                        Err(e) => {
                            tracing::error!("Failed to fetch pods for deployment: {}", e);
                            let _ = tx.send(Vec::new());
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to get k8s client: {}", e);
                    let _ = tx.send(Vec::new());
                }
            }
        });
    });

    cx.spawn(async move |_view, cx| {
        for _ in 0..100 {
            if let Ok(pods) = rx.try_recv() {
                let _ = cx.update(|cx: &mut gpui::App| {
                    details_entity.update(cx, |view, _| {
                        view.set_related_pods(pods);
                    });
                });
                return;
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(50))
                .await;
        }
    })
    .detach();
}

fn delete_resources_bulk_bg<T: 'static>(
    cx: &mut Context<'_, T>,
    resource_type: k8s_client::ResourceType,
    resources: Vec<k8s_client::Resource>,
) {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::spawn(move || {
        let rt = k8s_client::tokio_runtime();
        rt.block_on(async {
            match k8s_client::get_client().await {
                Ok(client) => {
                    let mut errors = Vec::new();
                    for resource in &resources {
                        let namespace = resource.metadata.namespace.as_deref();
                        if let Err(e) = k8s_client::delete_resource(
                            &client,
                            resource_type,
                            &resource.metadata.name,
                            namespace,
                        )
                        .await
                        {
                            errors.push(format!("{}: {}", resource.metadata.name, e));
                        }
                    }
                    if errors.is_empty() {
                        let _ = tx.send(Ok(()));
                    } else {
                        let _ = tx.send(Err(format!(
                            "Bulk delete failed for {} resource(s): {}",
                            errors.len(),
                            errors.join("; ")
                        )));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        });
    });

    cx.spawn(async move |_view, cx| {
        for _ in 0..120 {
            if let Ok(result) = rx.try_recv() {
                let _ = cx.update(|cx: &mut gpui::App| {
                    cx.update_global::<AppState, _>(|state, _| {
                        state.set_error(result.err());
                    });
                    let state = cx.global::<AppState>();
                    crate::load_resources(cx, state.selected_type, state.namespace.clone());
                });
                return;
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(50))
                .await;
        }
    })
    .detach();
}

fn scale_resources_bulk_bg<T: 'static>(
    cx: &mut Context<'_, T>,
    resource_type: k8s_client::ResourceType,
    resources: Vec<k8s_client::Resource>,
    replicas: i32,
) {
    if !matches!(
        resource_type,
        k8s_client::ResourceType::Deployments | k8s_client::ResourceType::StatefulSets
    ) {
        cx.update_global::<AppState, _>(|state, _| {
            state.set_error(Some(format!(
                "Bulk scale is only supported for Deployments and StatefulSets (current: {}).",
                resource_type.display_name()
            )));
        });
        return;
    }

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let rt = k8s_client::tokio_runtime();
        rt.block_on(async {
            match k8s_client::get_client().await {
                Ok(client) => {
                    let mut errors = Vec::new();
                    for resource in &resources {
                        let namespace = resource.metadata.namespace.as_deref();
                        if let Err(e) = k8s_client::scale_resource(
                            &client,
                            resource_type,
                            &resource.metadata.name,
                            replicas,
                            namespace,
                        )
                        .await
                        {
                            errors.push(format!("{}: {}", resource.metadata.name, e));
                        }
                    }
                    if errors.is_empty() {
                        let _ = tx.send(Ok(()));
                    } else {
                        let _ = tx.send(Err(format!(
                            "Bulk scale failed for {} resource(s): {}",
                            errors.len(),
                            errors.join("; ")
                        )));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        });
    });

    cx.spawn(async move |_view, cx| {
        for _ in 0..120 {
            if let Ok(result) = rx.try_recv() {
                let _ = cx.update(|cx: &mut gpui::App| {
                    cx.update_global::<AppState, _>(|state, _| {
                        state.set_error(result.err());
                    });
                    let state = cx.global::<AppState>();
                    crate::load_resources(cx, state.selected_type, state.namespace.clone());
                });
                return;
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(50))
                .await;
        }
    })
    .detach();
}

fn label_resources_bulk_bg<T: 'static>(
    cx: &mut Context<'_, T>,
    resource_type: k8s_client::ResourceType,
    resources: Vec<k8s_client::Resource>,
    key: String,
    value: String,
) {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let rt = k8s_client::tokio_runtime();
        rt.block_on(async {
            match k8s_client::get_client().await {
                Ok(client) => {
                    let mut errors = Vec::new();
                    for resource in &resources {
                        let namespace = resource.metadata.namespace.as_deref();
                        if let Err(e) = k8s_client::label_resource(
                            &client,
                            resource_type,
                            &resource.metadata.name,
                            &key,
                            &value,
                            namespace,
                        )
                        .await
                        {
                            errors.push(format!("{}: {}", resource.metadata.name, e));
                        }
                    }
                    if errors.is_empty() {
                        let _ = tx.send(Ok(()));
                    } else {
                        let _ = tx.send(Err(format!(
                            "Bulk label failed for {} resource(s): {}",
                            errors.len(),
                            errors.join("; ")
                        )));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        });
    });

    cx.spawn(async move |_view, cx| {
        for _ in 0..120 {
            if let Ok(result) = rx.try_recv() {
                let _ = cx.update(|cx: &mut gpui::App| {
                    cx.update_global::<AppState, _>(|state, _| {
                        state.set_error(result.err());
                    });
                    let state = cx.global::<AppState>();
                    crate::load_resources(cx, state.selected_type, state.namespace.clone());
                });
                return;
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(50))
                .await;
        }
    })
    .detach();
}

fn delete_resource_bg<T: 'static>(
    cx: &mut Context<'_, T>,
    resource_type: k8s_client::ResourceType,
    name: String,
    namespace: String,
) {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::spawn(move || {
        let rt = k8s_client::tokio_runtime();
        rt.block_on(async {
            match k8s_client::get_client().await {
                Ok(client) => {
                    match k8s_client::delete_resource(
                        &client,
                        resource_type,
                        &name,
                        Some(&namespace),
                    )
                    .await
                    {
                        Ok(_) => {
                            let _ = tx.send(Ok(()));
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e.to_string()));
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        });
    });

    cx.spawn(async move |_view, cx| {
        for _ in 0..100 {
            if let Ok(result) = rx.try_recv() {
                let _ = cx.update(|cx: &mut gpui::App| {
                    if let Err(e) = result {
                        tracing::error!("Failed to delete resource: {}", e);
                    }
                    let state = cx.global::<AppState>();
                    let resource_type = state.selected_type;
                    let namespace = state.namespace.clone();
                    crate::load_resources(cx, resource_type, namespace);
                });
                return;
            }
            cx.background_executor()
                .timer(std::time::Duration::from_millis(50))
                .await;
        }
    })
    .detach();
}
