use crate::app_state::{app_state, update_app_state, ActivePanel, ActiveView, AppState};
use crate::{Header, Sidebar, TitleBar};
use gpui::*;
use gpui::prelude::FluentBuilder;
use k8s_client::Resource;
use logs::PodLogsView;
use resources::{DeploymentAction, DeploymentDetails, GenericAction, GenericResourceDetails, PodAction, PodDetails, ReplicaSetAction, ReplicaSetDetails, ResourceTable};
use terminal::PodTerminalView;
use ui::{
    theme, secondary_btn, primary_icon_btn, Button, ButtonVariant, ButtonVariants, DropdownMenu,
    Icon, IconName, PopupMenu, PopupMenuItem, Sizable,
};

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
    generic_details: Option<Entity<GenericResourceDetails>>,
    pod_logs: Option<Entity<PodLogsView>>,
    pod_terminal: Option<Entity<PodTerminalView>>,
}

impl AppView {
    pub fn new(cx: &mut Context<'_, Self>) -> Self {
        let state = app_state(cx);
        let sidebar_collapsed = state.sidebar_collapsed;
        let resources = state.resources.as_ref()
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
            generic_details: None,
            pod_logs: None,
            pod_terminal: None,
        }
    }

    fn close_details(&mut self, cx: &mut Context<'_, Self>) {
        self.pod_details = None;
        self.deployment_details = None;
        self.replicaset_details = None;
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
            let resources: Vec<Resource> = state.filtered_resources().into_iter().cloned().collect();
            let resource_type = state.selected_type;
            let selected_resource = state.selected_resource.clone();
            (resources, resource_type, selected_resource)
        };

        // Check if we should close details (resource type changed)
        if let Some(ref selected) = selected_resource {
            if selected.kind != resource_type.api_kind() {
                self.close_details(cx);
            }
        }

        // Sync detail views with selected_resource
        if selected_resource.is_none() {
            self.pod_details = None;
            self.deployment_details = None;
            self.replicaset_details = None;
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
        });

        // Check if we need to create detail views from global state
        if let Some(resource) = selected_resource.clone() {
            let no_details_showing = self.pod_details.is_none()
                && self.deployment_details.is_none()
                && self.replicaset_details.is_none()
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
                                .on_action(|action, cx| {
                                    match action {
                                        PodAction::ViewLogs { pod_name, namespace, containers, selected_container } => {
                                            cx.update_global::<AppState, _>(|state, _cx| {
                                                state.open_pod_logs(pod_name.clone(), namespace.clone(), containers.clone(), selected_container.clone());
                                            });
                                        }
                                        PodAction::OpenTerminal { pod_name, namespace, containers, selected_container } => {
                                            cx.update_global::<AppState, _>(|state, _cx| {
                                                state.open_pod_terminal(pod_name.clone(), namespace.clone(), containers.clone(), selected_container.clone());
                                            });
                                        }
                                        PodAction::Delete { pod_name, namespace } => {
                                            cx.update_global::<AppState, _>(|state, _cx| {
                                                state.set_selected_resource(None);
                                            });
                                            delete_resource_bg(cx, k8s_client::ResourceType::Pods, pod_name.clone(), namespace.clone());
                                        }
                                    }
                                })
                        }));
                    }
                    "Deployment" => {
                        self.deployment_details = Some(cx.new(|_| {
                            DeploymentDetails::new(resource)
                                .on_close(|cx| {
                                    cx.update_global::<AppState, _>(|state, _cx| {
                                        state.set_selected_resource(None);
                                    });
                                })
                                .on_action(|action, cx| {
                                    match action {
                                        DeploymentAction::Delete { name, namespace } => {
                                            cx.update_global::<AppState, _>(|state, _cx| {
                                                state.set_selected_resource(None);
                                            });
                                            delete_resource_bg(cx, k8s_client::ResourceType::Deployments, name, namespace);
                                        }
                                    }
                                })
                        }));
                    }
                    "ReplicaSet" => {
                        self.replicaset_details = Some(cx.new(|_| {
                            ReplicaSetDetails::new(resource)
                                .on_close(|cx| {
                                    cx.update_global::<AppState, _>(|state, _cx| {
                                        state.set_selected_resource(None);
                                    });
                                })
                                .on_action(|action, cx| {
                                    match action {
                                        ReplicaSetAction::Delete { name, namespace } => {
                                            cx.update_global::<AppState, _>(|state, _cx| {
                                                state.set_selected_resource(None);
                                            });
                                            delete_resource_bg(cx, k8s_client::ResourceType::ReplicaSets, name, namespace);
                                        }
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
                                .on_action(move |action, cx| {
                                    match action {
                                        GenericAction::Delete { name, namespace } => {
                                            cx.update_global::<AppState, _>(|state, _cx| {
                                                state.set_selected_resource(None);
                                            });
                                            delete_resource_bg(cx, rt, name, namespace);
                                        }
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
                        PodLogsView::new(pod_name, namespace, containers)
                            .on_close(|cx| {
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

        // Check if we need to create PodTerminalView from global state
        {
            let state = app_state(cx);
            if state.active_view == ActiveView::PodTerminal && self.pod_terminal.is_none() {
                if let Some(pod_ctx) = &state.pod_context {
                    let pod_name = pod_ctx.pod_name.clone();
                    let namespace = pod_ctx.namespace.clone();
                    let containers = pod_ctx.containers.clone();
                    let terminal_view = cx.new(|cx| {
                        PodTerminalView::new(pod_name, namespace, containers, cx)
                            .on_close(|cx| {
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

        // Render
        let theme = theme(cx);
        let colors = &theme.colors;
        let state = app_state(cx);
        let active_view = state.active_view.clone();
        let active_panel = state.active_panel;
        let showing_details = self.pod_details.is_some()
            || self.deployment_details.is_some()
            || self.replicaset_details.is_some()
            || self.generic_details.is_some();
        let showing_logs = self.pod_logs.is_some();
        let showing_terminal = self.pod_terminal.is_some();

        div()
            .size_full()
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
                            .when(!showing_details && !showing_logs && !showing_terminal, |el: Div| el.child(self.header.clone()))
                            // Content
                            .child(self.render_content(cx, active_view.clone(), active_panel, showing_details, showing_logs, showing_terminal)),
                    ),
            )
    }
}

impl AppView {
    fn render_content(&self, cx: &Context<'_, Self>, active_view: ActiveView, active_panel: ActivePanel, showing_details: bool, showing_logs: bool, showing_terminal: bool) -> impl IntoElement {
        // Show terminal view (full screen)
        if showing_terminal {
            if let Some(terminal_view) = &self.pod_terminal {
                return div()
                    .flex_1()
                    .overflow_hidden()
                    .child(terminal_view.clone())
                    .into_any_element();
            }
        }

        // Show logs view (full screen)
        if showing_logs {
            if let Some(logs_view) = &self.pod_logs {
                return div()
                    .flex_1()
                    .overflow_hidden()
                    .child(logs_view.clone())
                    .into_any_element();
            }
        }

        // Show details view
        if showing_details {
            if let Some(details) = &self.pod_details {
                return div()
                    .flex_1()
                    .overflow_hidden()
                    .child(details.clone())
                    .into_any_element();
            }
            if let Some(details) = &self.deployment_details {
                return div()
                    .flex_1()
                    .overflow_hidden()
                    .child(details.clone())
                    .into_any_element();
            }
            if let Some(details) = &self.replicaset_details {
                return div()
                    .flex_1()
                    .overflow_hidden()
                    .child(details.clone())
                    .into_any_element();
            }
            if let Some(details) = &self.generic_details {
                return div()
                    .flex_1()
                    .overflow_hidden()
                    .child(details.clone())
                    .into_any_element();
            }
        }

        // Table view
        let state = app_state(cx);
        let mut content = div()
            .flex_1()
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

        // Right panel (logs, terminal, AI)
        if active_panel != ActivePanel::None {
            content = content.child(self.render_right_panel(cx, active_panel));
        }

        content.into_any_element()
    }

    fn render_resource_area(&self, cx: &Context<'_, Self>, state: &crate::app_state::AppState) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let resource_type = state.selected_type;
        let context = state.context.clone();
        let namespace = state.namespace.clone();
        let contexts = state.contexts.clone();
        let namespaces = state.namespaces.clone();

        let mut container = div()
            .size_full()
            .flex()
            .flex_col()
            .gap(px(14.0));

        // 1. Breadcrumb (context > namespace)
        container = container.child(self.render_breadcrumb(cx, &context, &namespace, contexts, namespaces));

        // 2. Page header (title + subtitle + action buttons)
        container = container.child(self.render_page_header(cx, resource_type));

        // 3. Metric cards
        container = container.child(self.render_metric_cards(cx, state));

        // Loading indicator
        if state.is_loading {
            container = container.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(ui::Spinner::new().with_size(ui::Size::Small))
                    .child(
                        div()
                            .font_family(theme.font_family_ui.clone())
                            .text_size(theme.font_size_small)
                            .text_color(colors.text_muted)
                            .child("Loading resources...")
                    )
            );
        }

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
                    .child(error.clone())
            );
        }

        // 4. Resource table
        container = container.child(
            div()
                .flex_1()
                .overflow_hidden()
                .child(self.resource_table.clone())
        );

        container
    }

    /// Render breadcrumb navigation (context > namespace) with dropdown menus to switch
    fn render_breadcrumb(
        &self,
        cx: &Context<'_, Self>,
        context: &Option<String>,
        namespace: &Option<String>,
        contexts: Vec<String>,
        namespaces: Vec<String>,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let context_label: SharedString = context
            .clone()
            .unwrap_or_else(|| "No context".to_string())
            .into();
        let ns_label: SharedString = namespace
            .clone()
            .unwrap_or_else(|| "All Namespaces".to_string())
            .into();

        // Context selector dropdown
        let current_ctx = context.clone();
        let context_button = Button::new("breadcrumb-context")
            .icon(IconName::Cloud)
            .label(context_label)
            .compact()
            .with_variant(ButtonVariant::Ghost)
            .dropdown_caret(true)
            .dropdown_menu(move |menu: PopupMenu, _window, _cx| {
                let mut m = menu.scrollable(true);
                for ctx in &contexts {
                    let ctx_value = ctx.clone();
                    let is_selected = current_ctx.as_ref() == Some(ctx);
                    m = m.item(
                        PopupMenuItem::new(ctx.clone())
                            .checked(is_selected)
                            .on_click(move |_, _window, cx| {
                                let ctx = ctx_value.clone();
                                let ctx_for_switch = ctx.clone();
                                cx.update_global::<AppState, _>(|state, _| {
                                    state.set_context(Some(ctx));
                                });
                                crate::switch_context(cx, ctx_for_switch);
                            }),
                    );
                }
                m
            });

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
            .child(context_button)
            .child(
                Icon::new(IconName::ChevronRight)
                    .size(px(14.0))
                    .color(colors.text_muted),
            )
            .child(namespace_button)
    }

    /// Render the page header with title, subtitle, and action buttons
    fn render_page_header(&self, cx: &Context<'_, Self>, resource_type: k8s_client::ResourceType) -> impl IntoElement {
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
                            .child(resource_type.display_name())
                    )
                    .child(
                        div()
                            .font_family(theme.font_family_ui.clone())
                            .text_size(px(14.0))
                            .text_color(colors.text_muted)
                            .child(format!("Manage and monitor your {} resources",
                                resource_type.display_name().to_lowercase()))
                    )
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
                            }))
                    )
                    // Create button - disabled (not yet implemented)
                    .child(
                        primary_icon_btn("page-create-btn", IconName::Plus, format!("Create {}", resource_type.api_kind()), colors.primary, colors.background)
                            .opacity(0.5)
                    )
            )
    }

    /// Render the 4 metric cards (Total, Running, Pending, Failed)
    fn render_metric_cards(&self, cx: &Context<'_, Self>, state: &crate::app_state::AppState) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let resource_type = state.selected_type;

        // Compute metrics from resources
        let resources = state.resources.as_ref()
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
                if pending > 0 { Some("waiting".to_string()) } else { None },
                colors.warning,
            ))
            .child(self.render_single_metric(
                cx,
                "FAILED",
                &failed.to_string(),
                if failed > 0 { Some("attention".to_string()) } else { None },
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
                    .child(label.to_string())
            )
            // Value row: number + optional subtitle
            .child({
                let mut row = div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .text_size(px(22.0))
                            .font_weight(FontWeight::BOLD)
                            .text_color(colors.text)
                            .child(value.to_string())
                    );
                if let Some(sub) = subtitle {
                    row = row.child(
                        div()
                            .text_size(px(11.0))
                            .text_color(subtitle_color)
                            .child(sub)
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
                let phase = resource.status.as_ref()
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
                let available = resource.status.as_ref()
                    .and_then(|s| s.get("availableReplicas"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let desired = resource.spec.as_ref()
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
                let conditions = resource.status.as_ref()
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

    fn render_right_panel(&self, cx: &Context<'_, Self>, active_panel: ActivePanel) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let title = match active_panel {
            ActivePanel::Logs => "Logs",
            ActivePanel::Terminal => "Terminal",
            ActivePanel::AI => "AI Assistant",
            ActivePanel::None => "",
        };

        div()
            .w(px(400.0))
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
                            .id("close-panel-btn")
                            .cursor_pointer()
                            .text_color(colors.text_muted)
                            .hover(|style| style.text_color(colors.text))
                            .child("×")
                            .on_click(cx.listener(|_this, _event, _window, cx| {
                                update_app_state(cx, |state, _| {
                                    state.active_panel = ActivePanel::None;
                                });
                                cx.notify();
                            })),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .p(px(16.0))
                    .child(
                        div()
                            .text_size(theme.font_size)
                            .text_color(colors.text_muted)
                            .child(format!("{} panel content", title)),
                    ),
            )
    }

}

fn delete_resource_bg<T: 'static>(cx: &mut Context<'_, T>, resource_type: k8s_client::ResourceType, name: String, namespace: String) {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::spawn(move || {
        let rt = crate::resource_loader::get_tokio_runtime_pub();
        rt.block_on(async {
            match k8s_client::get_client().await {
                Ok(client) => {
                    match k8s_client::delete_resource(
                        &client,
                        resource_type,
                        &name,
                        Some(&namespace),
                    ).await {
                        Ok(_) => { let _ = tx.send(Ok(())); }
                        Err(e) => { let _ = tx.send(Err(e.to_string())); }
                    }
                }
                Err(e) => { let _ = tx.send(Err(e.to_string())); }
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
    }).detach();
}
