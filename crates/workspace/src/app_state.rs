use crate::settings::{AIProvider, ThemeMode};
use gpui::*;
use k8s_client::{
    ConnectionStatus, PortForwardInfo, Resource, ResourceList, ResourceType, SortDirection,
};
use std::collections::HashMap;
use ui::ThemeMode as UiThemeMode;

fn to_ui_theme_mode(mode: ThemeMode) -> UiThemeMode {
    match mode {
        ThemeMode::GruvboxLight => UiThemeMode::GruvboxLight,
        ThemeMode::SolarizedLight => UiThemeMode::SolarizedLight,
        ThemeMode::EverforestLight => UiThemeMode::EverforestLight,
        ThemeMode::RosePineDawn => UiThemeMode::RosePineDawn,
        ThemeMode::GitHubLight => UiThemeMode::GitHubLight,
        ThemeMode::GruvboxDark => UiThemeMode::GruvboxDark,
        ThemeMode::SolarizedDark => UiThemeMode::SolarizedDark,
        ThemeMode::EverforestDark => UiThemeMode::EverforestDark,
        ThemeMode::DraculaDark => UiThemeMode::DraculaDark,
        ThemeMode::MonokaiDark => UiThemeMode::MonokaiDark,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ActivePanel {
    None,
    Logs,
    Terminal,
    AI,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum SettingsTab {
    #[default]
    Appearance,
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
    Settings,
}

/// Pod context for logs/terminal views
#[derive(Clone, Debug, Default)]
pub struct PodContext {
    pub pod_name: String,
    pub namespace: String,
    pub containers: Vec<String>,
    pub selected_container: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AIChatRole {
    User,
    Assistant,
}

#[derive(Clone, Debug)]
pub struct AIChatMessage {
    pub role: AIChatRole,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ResourceCacheKey {
    context: Option<String>,
    namespace: Option<String>,
    resource_type: ResourceType,
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
    resource_cache: HashMap<ResourceCacheKey, ResourceList>,
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
    pub settings_open: bool,
    pub settings_tab: SettingsTab,
    pub sidebar_collapsed: bool,
    pub theme_mode: ThemeMode,

    // Sort state
    pub sort_column: Option<String>,
    pub sort_direction: SortDirection,

    // Port forwarding
    pub port_forwards: Vec<PortForwardInfo>,
    pub pf_error: Option<String>,

    // AI settings and communication
    pub ai_provider: AIProvider,
    pub ai_connection_testing: bool,
    pub ai_connection_success: Option<bool>,
    pub ai_connection_message: Option<String>,
    pub ai_messages: Vec<AIChatMessage>,
    pub ai_request_in_flight: bool,
    pub ai_prefill_prompt: Option<String>,
    pub ai_prefill_auto_send: bool,
    pub ai_target_resource: Option<Resource>,
    pub opencode_models: Vec<String>,
    pub opencode_models_loading: bool,
    pub opencode_selected_model: Option<String>,
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
            resource_cache: HashMap::new(),
            filter: String::new(),
            is_loading: false,
            error: None,
            connection_status: ConnectionStatus::Connecting,
            connection_error: None,
            active_view: ActiveView::ResourceTable,
            pod_context: None,
            active_panel: ActivePanel::None,
            settings_open: false,
            settings_tab: SettingsTab::Appearance,
            sidebar_collapsed: false,
            theme_mode: ThemeMode::EverforestDark,
            sort_column: None,
            sort_direction: SortDirection::Ascending,
            port_forwards: Vec::new(),
            pf_error: None,
            ai_provider: AIProvider::OpenCode,
            ai_connection_testing: false,
            ai_connection_success: None,
            ai_connection_message: None,
            ai_messages: Vec::new(),
            ai_request_in_flight: false,
            ai_prefill_prompt: None,
            ai_prefill_auto_send: false,
            ai_target_resource: None,
            opencode_models: Vec::new(),
            opencode_models_loading: false,
            opencode_selected_model: None,
        }
    }

    fn persist_settings(&self) {
        crate::settings::save_settings(&crate::settings::UserSettings {
            context: self.context.clone(),
            namespace: self.namespace.clone(),
            ai_provider: Some(self.ai_provider),
            opencode_model: self.opencode_selected_model.clone(),
            theme_mode: Some(self.theme_mode),
        });
    }

    pub fn open_pod_logs(
        &mut self,
        pod_name: String,
        namespace: String,
        containers: Vec<String>,
        selected_container: Option<String>,
    ) {
        self.pod_context = Some(PodContext {
            pod_name,
            namespace,
            containers,
            selected_container,
        });
        self.active_view = ActiveView::PodLogs;
    }

    pub fn open_pod_terminal(
        &mut self,
        pod_name: String,
        namespace: String,
        containers: Vec<String>,
        selected_container: Option<String>,
    ) {
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
        // Sync selected_resource with updated data from watch
        if let (Some(selected), Some(res_list)) = (&self.selected_resource, &resources) {
            // Find the updated version of the selected resource by UID
            if let Some(updated) = res_list
                .items
                .iter()
                .find(|r| r.metadata.uid == selected.metadata.uid)
            {
                self.selected_resource = Some(updated.clone());
            }
        }
        self.resources = resources;
    }

    fn cache_key(
        context: Option<String>,
        resource_type: ResourceType,
        namespace: Option<String>,
    ) -> ResourceCacheKey {
        let normalized_namespace = if resource_type.is_namespaced() {
            namespace
        } else {
            None
        };

        ResourceCacheKey {
            context,
            namespace: normalized_namespace,
            resource_type,
        }
    }

    pub fn cache_resources_for_scope(
        &mut self,
        context: Option<String>,
        resource_type: ResourceType,
        namespace: Option<String>,
        resources: ResourceList,
    ) {
        let key = Self::cache_key(context, resource_type, namespace);
        self.resource_cache.insert(key, resources);
    }

    pub fn get_cached_resources_for_scope(
        &self,
        context: Option<String>,
        resource_type: ResourceType,
        namespace: Option<String>,
    ) -> Option<ResourceList> {
        let key = Self::cache_key(context, resource_type, namespace);
        self.resource_cache.get(&key).cloned()
    }

    pub fn set_selected_resource(&mut self, resource: Option<Resource>) {
        self.selected_resource = resource;
    }

    pub fn set_selected_type(&mut self, resource_type: ResourceType) {
        self.selected_type = resource_type;
        self.selected_resource = None;
    }

    pub fn set_context(&mut self, context: Option<String>) {
        self.context = context;
        self.persist_settings();
    }

    pub fn set_namespace(&mut self, namespace: Option<String>) {
        self.namespace = namespace;
        self.persist_settings();
    }

    pub fn set_ai_provider(&mut self, provider: AIProvider) {
        self.ai_provider = provider;
        self.persist_settings();
    }

    pub fn set_theme_mode(&mut self, mode: ThemeMode) {
        self.theme_mode = mode;
        self.persist_settings();
    }

    pub fn set_settings_tab(&mut self, tab: SettingsTab) {
        self.settings_tab = tab;
    }

    pub fn set_opencode_models_loading(&mut self, loading: bool) {
        self.opencode_models_loading = loading;
    }

    pub fn set_opencode_models(&mut self, models: Vec<String>) {
        self.opencode_models = models;
        if let Some(selected) = &self.opencode_selected_model {
            if !self.opencode_models.iter().any(|m| m == selected) {
                self.opencode_selected_model = self.opencode_models.first().cloned();
            }
        } else {
            self.opencode_selected_model = self.opencode_models.first().cloned();
        }
        self.persist_settings();
    }

    pub fn set_opencode_selected_model(&mut self, model: Option<String>) {
        self.opencode_selected_model = model;
        self.persist_settings();
    }

    pub fn set_ai_connection_testing(&mut self, testing: bool) {
        self.ai_connection_testing = testing;
        if testing {
            self.ai_connection_message =
                Some("Testing connection with the selected provider...".to_string());
            self.ai_connection_success = None;
        }
    }

    pub fn open_settings(&mut self) {
        self.settings_open = true;
    }

    pub fn close_settings(&mut self) {
        self.settings_open = false;
    }

    pub fn set_ai_connection_result(&mut self, result: Result<String, String>) {
        self.ai_connection_testing = false;
        match result {
            Ok(message) => {
                self.ai_connection_success = Some(true);
                self.ai_connection_message = Some(message);
            }
            Err(error) => {
                self.ai_connection_success = Some(false);
                self.ai_connection_message = Some(error);
            }
        }
    }

    pub fn push_ai_user_message(&mut self, content: String) {
        self.ai_messages.push(AIChatMessage {
            role: AIChatRole::User,
            content,
        });
    }

    pub fn push_ai_assistant_message(&mut self, content: String) {
        self.ai_messages.push(AIChatMessage {
            role: AIChatRole::Assistant,
            content,
        });
    }

    pub fn set_ai_request_in_flight(&mut self, in_flight: bool) {
        self.ai_request_in_flight = in_flight;
    }

    pub fn queue_ai_prefill_prompt(
        &mut self,
        prompt: String,
        auto_send: bool,
        target_resource: Option<Resource>,
    ) {
        self.ai_prefill_prompt = Some(prompt);
        self.ai_prefill_auto_send = auto_send;
        self.ai_target_resource = target_resource;
    }

    pub fn take_ai_prefill_prompt(&mut self) -> Option<(String, bool)> {
        let prompt = self.ai_prefill_prompt.take()?;
        let auto_send = self.ai_prefill_auto_send;
        self.ai_prefill_auto_send = false;
        Some((prompt, auto_send))
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
    state.ai_provider = saved.ai_provider.unwrap_or(AIProvider::OpenCode);
    state.opencode_selected_model = saved.opencode_model;
    state.theme_mode = saved.theme_mode.unwrap_or(ThemeMode::EverforestDark);
    ui::set_theme_mode(to_ui_theme_mode(state.theme_mode), cx);
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
