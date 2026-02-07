use gpui::*;
use k8s_client::{ConnectionStatus, PortForwardInfo, Resource, ResourceList, ResourceType, SortDirection};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ActivePanel {
    None,
    Logs,
    Terminal,
    AI,
}

impl Default for ActivePanel {
    fn default() -> Self {
        ActivePanel::None
    }
}

/// Represents the current full-screen view
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub enum ActiveView {
    #[default]
    ResourceTable,
    PodDetails,
    PodLogs,
    PodTerminal,
    PortForwards,
}

/// Pod context for logs/terminal views
#[derive(Clone, Debug, Default)]
pub struct PodContext {
    pub pod_name: String,
    pub namespace: String,
    pub containers: Vec<String>,
    pub selected_container: Option<String>,
}

pub struct AppState {
    // Kubernetes state
    pub resources: Option<ResourceList>,
    pub selected_resource: Option<Resource>,
    pub selected_type: ResourceType,
    pub context: Option<String>,
    pub namespace: Option<String>,
    pub namespaces: Vec<String>,
    pub contexts: Vec<String>,
    pub filter: String,

    // UI state
    pub is_loading: bool,
    pub error: Option<String>,
    pub connection_status: ConnectionStatus,
    pub connection_error: Option<String>,

    // View state
    pub active_view: ActiveView,
    pub pod_context: Option<PodContext>,

    // Panel state
    pub active_panel: ActivePanel,
    pub sidebar_collapsed: bool,

    // Sort state
    pub sort_column: Option<String>,
    pub sort_direction: SortDirection,

    // Port forwarding
    pub port_forwards: Vec<PortForwardInfo>,
    pub pf_error: Option<String>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            resources: None,
            selected_resource: None,
            selected_type: ResourceType::Pods,
            context: None,
            namespace: None,
            namespaces: Vec::new(),
            contexts: Vec::new(),
            filter: String::new(),
            is_loading: false,
            error: None,
            connection_status: ConnectionStatus::Connecting,
            connection_error: None,
            active_view: ActiveView::ResourceTable,
            pod_context: None,
            active_panel: ActivePanel::None,
            sidebar_collapsed: false,
            sort_column: None,
            sort_direction: SortDirection::Ascending,
            port_forwards: Vec::new(),
            pf_error: None,
        }
    }

    pub fn open_pod_logs(&mut self, pod_name: String, namespace: String, containers: Vec<String>, selected_container: Option<String>) {
        self.pod_context = Some(PodContext {
            pod_name,
            namespace,
            containers,
            selected_container,
        });
        self.active_view = ActiveView::PodLogs;
    }

    pub fn open_pod_terminal(&mut self, pod_name: String, namespace: String, containers: Vec<String>, selected_container: Option<String>) {
        self.pod_context = Some(PodContext {
            pod_name,
            namespace,
            containers,
            selected_container,
        });
        self.active_view = ActiveView::PodTerminal;
    }

    pub fn close_pod_view(&mut self) {
        self.active_view = if self.selected_resource.is_some() {
            ActiveView::PodDetails
        } else {
            ActiveView::ResourceTable
        };
        self.pod_context = None;
    }

    pub fn set_resources(&mut self, resources: Option<ResourceList>) {
        self.resources = resources;
    }

    pub fn set_selected_resource(&mut self, resource: Option<Resource>) {
        self.selected_resource = resource;
    }

    pub fn set_selected_type(&mut self, resource_type: ResourceType) {
        self.selected_type = resource_type;
        self.selected_resource = None;
    }

    pub fn set_context(&mut self, context: Option<String>) {
        self.context = context.clone();
        crate::settings::save_settings(&crate::settings::UserSettings {
            context,
            namespace: self.namespace.clone(),
        });
    }

    pub fn set_namespace(&mut self, namespace: Option<String>) {
        self.namespace = namespace.clone();
        crate::settings::save_settings(&crate::settings::UserSettings {
            context: self.context.clone(),
            namespace,
        });
    }

    pub fn set_filter(&mut self, filter: String) {
        self.filter = filter;
    }

    pub fn set_loading(&mut self, loading: bool) {
        self.is_loading = loading;
    }

    pub fn set_error(&mut self, error: Option<String>) {
        self.error = error;
    }

    pub fn set_connection_status(&mut self, status: ConnectionStatus, error: Option<String>) {
        self.connection_status = status;
        self.connection_error = error;
    }

    pub fn toggle_panel(&mut self, panel: ActivePanel) {
        if self.active_panel == panel {
            self.active_panel = ActivePanel::None;
        } else {
            self.active_panel = panel;
        }
    }

    pub fn toggle_sidebar(&mut self) {
        self.sidebar_collapsed = !self.sidebar_collapsed;
    }

    pub fn set_sort(&mut self, column: &str) {
        if self.sort_column.as_deref() == Some(column) {
            self.sort_direction = self.sort_direction.toggle();
        } else {
            self.sort_column = Some(column.to_string());
            self.sort_direction = SortDirection::Ascending;
        }
    }

    pub fn add_port_forward(&mut self, info: PortForwardInfo) {
        self.port_forwards.push(info);
    }

    pub fn remove_port_forward(&mut self, session_id: &str) {
        self.port_forwards.retain(|pf| pf.session_id != session_id);
    }

    pub fn clear_port_forwards(&mut self) {
        self.port_forwards.clear();
    }

    pub fn filtered_resources(&self) -> Vec<&Resource> {
        let Some(resources) = &self.resources else {
            return Vec::new();
        };

        if self.filter.is_empty() {
            return resources.items.iter().collect();
        }

        let filter_lower = self.filter.to_lowercase();
        resources
            .items
            .iter()
            .filter(|r| r.metadata.name.to_lowercase().contains(&filter_lower))
            .collect()
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl Global for AppState {}

pub fn init(cx: &mut App) {
    let saved = crate::settings::load_settings();
    let mut state = AppState::new();
    state.context = saved.context;
    state.namespace = saved.namespace;
    cx.set_global(state);
}

pub fn app_state(cx: &App) -> &AppState {
    cx.global::<AppState>()
}

pub fn update_app_state<F, R>(cx: &mut App, f: F) -> R
where
    F: FnOnce(&mut AppState, &mut App) -> R,
{
    cx.update_global::<AppState, R>(f)
}
