use crate::settings::{AIProvider, ThemeMode};
use gpui::*;
use k8s_client::{
    ConnectionStatus, PortForwardInfo, Resource, ResourceList, ResourceType, SortDirection,
};
use std::collections::{BTreeMap, HashMap};
use std::time::Instant;
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
    DeploymentLogs,
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

/// Deployment logs context for aggregated log views
#[derive(Clone, Debug)]
pub struct DeploymentLogsContext {
    pub name: String,
    pub namespace: String,
    pub selector: BTreeMap<String, String>,
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
    /// Cached filtered resource indices — invalidated when resources or filter change
    filtered_cache: Option<Vec<usize>>,

    // UI state
    pub is_loading: bool,
    pub error: Option<String>,
    pub connection_status: ConnectionStatus,
    pub connection_error: Option<String>,
    pub last_updated: Option<Instant>,

    // View state
    pub active_view: ActiveView,
    pub pod_context: Option<PodContext>,
    pub deployment_logs_context: Option<DeploymentLogsContext>,

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
            filtered_cache: None,
            is_loading: false,
            error: None,
            connection_status: ConnectionStatus::Connecting,
            connection_error: None,
            last_updated: None,
            active_view: ActiveView::ResourceTable,
            pod_context: None,
            deployment_logs_context: None,
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

    pub fn open_deployment_logs(
        &mut self,
        name: String,
        namespace: String,
        selector: BTreeMap<String, String>,
    ) {
        self.deployment_logs_context = Some(DeploymentLogsContext {
            name,
            namespace,
            selector,
        });
        self.active_view = ActiveView::DeploymentLogs;
    }

    pub fn close_pod_view(&mut self) {
        if self.deployment_logs_context.is_some() {
            self.deployment_logs_context = None;
            self.active_view = if self.selected_resource.is_some() {
                ActiveView::PodDetails
            } else {
                ActiveView::ResourceTable
            };
            return;
        }
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
        if resources.is_some() {
            self.last_updated = Some(Instant::now());
        }
        self.resources = resources;
        self.rebuild_filtered_cache();
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
        self.rebuild_filtered_cache();
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

    /// Rebuild the filtered indices cache
    fn rebuild_filtered_cache(&mut self) {
        let Some(resources) = &self.resources else {
            self.filtered_cache = Some(Vec::new());
            return;
        };

        if self.filter.is_empty() {
            self.filtered_cache = Some((0..resources.items.len()).collect());
        } else {
            let filter_lower = self.filter.to_lowercase();
            self.filtered_cache = Some(
                resources
                    .items
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| r.metadata.name.to_lowercase().contains(&filter_lower))
                    .map(|(i, _)| i)
                    .collect(),
            );
        }
    }

    pub fn filtered_resources(&self) -> Vec<&Resource> {
        let Some(resources) = &self.resources else {
            return Vec::new();
        };
        match &self.filtered_cache {
            Some(indices) => indices
                .iter()
                .filter_map(|&i| resources.items.get(i))
                .collect(),
            None => {
                // Fallback: no cache yet, compute inline
                if self.filter.is_empty() {
                    resources.items.iter().collect()
                } else {
                    let filter_lower = self.filter.to_lowercase();
                    resources
                        .items
                        .iter()
                        .filter(|r| r.metadata.name.to_lowercase().contains(&filter_lower))
                        .collect()
                }
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_client::{PortForwardInfo, Resource, ResourceList, ResourceMetadata, ResourceType};

    fn make_resource(name: &str, uid: &str) -> Resource {
        Resource {
            api_version: "v1".to_string(),
            kind: "Pod".to_string(),
            metadata: ResourceMetadata {
                name: name.to_string(),
                namespace: Some("default".to_string()),
                uid: uid.to_string(),
                resource_version: "1".to_string(),
                labels: None,
                annotations: None,
                creation_timestamp: None,
                owner_references: None,
            },
            spec: None,
            status: None,
            data: None,
            type_: None,
        }
    }

    fn make_resource_list(resources: Vec<Resource>) -> ResourceList {
        ResourceList {
            resource_type: "pods".to_string(),
            namespace: Some("default".to_string()),
            items: resources,
        }
    }

    fn make_port_forward(session_id: &str) -> PortForwardInfo {
        PortForwardInfo {
            session_id: session_id.to_string(),
            pod_name: "pod".to_string(),
            namespace: "default".to_string(),
            container_port: 8080,
            local_port: 9090,
        }
    }

    // --- Default state tests ---

    #[test]
    fn new_state_has_expected_defaults() {
        let state = AppState::new();
        assert!(state.resources.is_none());
        assert!(state.selected_resource.is_none());
        assert_eq!(state.selected_type, ResourceType::Pods);
        assert!(state.context.is_none());
        assert!(state.namespace.is_none());
        assert!(state.namespaces.is_empty());
        assert!(state.contexts.is_empty());
        assert!(state.filter.is_empty());
        assert!(!state.is_loading);
        assert!(state.error.is_none());
        assert_eq!(
            state.connection_status,
            k8s_client::ConnectionStatus::Connecting
        );
        assert!(state.connection_error.is_none());
        assert_eq!(state.active_view, ActiveView::ResourceTable);
        assert!(state.pod_context.is_none());
        assert_eq!(state.active_panel, ActivePanel::None);
        assert!(!state.settings_open);
        assert_eq!(state.settings_tab, SettingsTab::Appearance);
        assert!(!state.sidebar_collapsed);
        assert_eq!(state.sort_direction, SortDirection::Ascending);
        assert!(state.sort_column.is_none());
        assert!(state.port_forwards.is_empty());
        assert!(state.pf_error.is_none());
        assert!(state.ai_messages.is_empty());
        assert!(!state.ai_request_in_flight);
        assert!(state.ai_prefill_prompt.is_none());
        assert!(!state.ai_prefill_auto_send);
        assert!(state.ai_target_resource.is_none());
    }

    #[test]
    fn default_trait_matches_new() {
        let a = AppState::new();
        let b = AppState::default();
        assert_eq!(a.selected_type, b.selected_type);
        assert_eq!(a.active_panel, b.active_panel);
        assert_eq!(a.active_view, b.active_view);
    }

    // --- Panel toggle tests ---

    #[test]
    fn toggle_panel_activates_panel() {
        let mut state = AppState::new();
        assert_eq!(state.active_panel, ActivePanel::None);
        state.toggle_panel(ActivePanel::Logs);
        assert_eq!(state.active_panel, ActivePanel::Logs);
    }

    #[test]
    fn toggle_same_panel_deactivates_it() {
        let mut state = AppState::new();
        state.toggle_panel(ActivePanel::Terminal);
        assert_eq!(state.active_panel, ActivePanel::Terminal);
        state.toggle_panel(ActivePanel::Terminal);
        assert_eq!(state.active_panel, ActivePanel::None);
    }

    #[test]
    fn toggle_different_panel_switches_panel() {
        let mut state = AppState::new();
        state.toggle_panel(ActivePanel::Logs);
        state.toggle_panel(ActivePanel::AI);
        assert_eq!(state.active_panel, ActivePanel::AI);
    }

    // --- Sidebar toggle tests ---

    #[test]
    fn toggle_sidebar_flips_state() {
        let mut state = AppState::new();
        assert!(!state.sidebar_collapsed);
        state.toggle_sidebar();
        assert!(state.sidebar_collapsed);
        state.toggle_sidebar();
        assert!(!state.sidebar_collapsed);
    }

    // --- Sort tests ---

    #[test]
    fn set_sort_sets_column_ascending_initially() {
        let mut state = AppState::new();
        state.set_sort("Name");
        assert_eq!(state.sort_column.as_deref(), Some("Name"));
        assert_eq!(state.sort_direction, SortDirection::Ascending);
    }

    #[test]
    fn set_sort_toggles_direction_on_same_column() {
        let mut state = AppState::new();
        state.set_sort("Age");
        assert_eq!(state.sort_direction, SortDirection::Ascending);
        state.set_sort("Age");
        assert_eq!(state.sort_direction, SortDirection::Descending);
        state.set_sort("Age");
        assert_eq!(state.sort_direction, SortDirection::Ascending);
    }

    #[test]
    fn set_sort_resets_direction_on_different_column() {
        let mut state = AppState::new();
        state.set_sort("Name");
        state.set_sort("Name"); // Now descending
        assert_eq!(state.sort_direction, SortDirection::Descending);
        state.set_sort("Status");
        assert_eq!(state.sort_column.as_deref(), Some("Status"));
        assert_eq!(state.sort_direction, SortDirection::Ascending);
    }

    // --- Filter / filtered_resources tests ---

    #[test]
    fn filtered_resources_returns_empty_when_no_resources() {
        let state = AppState::new();
        assert!(state.filtered_resources().is_empty());
    }

    #[test]
    fn filtered_resources_returns_all_when_filter_empty() {
        let mut state = AppState::new();
        let resources = make_resource_list(vec![
            make_resource("pod-a", "1"),
            make_resource("pod-b", "2"),
        ]);
        state.set_resources(Some(resources));
        assert_eq!(state.filtered_resources().len(), 2);
    }

    #[test]
    fn filtered_resources_filters_by_name_case_insensitive() {
        let mut state = AppState::new();
        let resources = make_resource_list(vec![
            make_resource("nginx-pod", "1"),
            make_resource("Redis-Cache", "2"),
            make_resource("postgres-db", "3"),
        ]);
        state.set_resources(Some(resources));
        state.set_filter("redis".to_string());
        let filtered = state.filtered_resources();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].metadata.name, "Redis-Cache");
    }

    #[test]
    fn filtered_resources_returns_empty_when_no_match() {
        let mut state = AppState::new();
        let resources = make_resource_list(vec![make_resource("pod-a", "1")]);
        state.set_resources(Some(resources));
        state.set_filter("nonexistent".to_string());
        assert!(state.filtered_resources().is_empty());
    }

    #[test]
    fn set_filter_updates_filter_string() {
        let mut state = AppState::new();
        state.set_filter("test".to_string());
        assert_eq!(state.filter, "test");
    }

    // --- Resource selection tests ---

    #[test]
    fn set_selected_type_clears_selected_resource() {
        let mut state = AppState::new();
        state.set_selected_resource(Some(make_resource("pod", "1")));
        assert!(state.selected_resource.is_some());
        state.set_selected_type(ResourceType::Deployments);
        assert_eq!(state.selected_type, ResourceType::Deployments);
        assert!(state.selected_resource.is_none());
    }

    #[test]
    fn set_selected_resource_stores_resource() {
        let mut state = AppState::new();
        let r = make_resource("my-pod", "uid-1");
        state.set_selected_resource(Some(r));
        assert_eq!(
            state
                .selected_resource
                .as_ref()
                .map(|r| r.metadata.name.as_str()),
            Some("my-pod")
        );
    }

    // --- set_resources syncs selected_resource ---

    #[test]
    fn set_resources_syncs_selected_resource_by_uid() {
        let mut state = AppState::new();
        let r1 = make_resource("pod-old", "uid-1");
        state.set_selected_resource(Some(r1));

        let mut r_updated = make_resource("pod-updated", "uid-1");
        r_updated.metadata.resource_version = "99".to_string();
        let resources = make_resource_list(vec![r_updated, make_resource("other", "uid-2")]);
        state.set_resources(Some(resources));

        // Selected resource should be updated to the new version
        let selected = state.selected_resource.as_ref().unwrap();
        assert_eq!(selected.metadata.name, "pod-updated");
        assert_eq!(selected.metadata.resource_version, "99");
    }

    #[test]
    fn set_resources_keeps_selected_when_uid_not_found() {
        let mut state = AppState::new();
        let r1 = make_resource("pod-gone", "uid-gone");
        state.set_selected_resource(Some(r1));

        let resources = make_resource_list(vec![make_resource("other", "uid-other")]);
        state.set_resources(Some(resources));

        // Selected resource remains the old one since UID wasn't in update
        let selected = state.selected_resource.as_ref().unwrap();
        assert_eq!(selected.metadata.name, "pod-gone");
    }

    // --- Cache tests ---

    #[test]
    fn cache_resources_stores_and_retrieves() {
        let mut state = AppState::new();
        let resources = make_resource_list(vec![make_resource("p", "1")]);
        state.cache_resources_for_scope(
            Some("ctx".to_string()),
            ResourceType::Pods,
            Some("default".to_string()),
            resources.clone(),
        );
        let cached = state.get_cached_resources_for_scope(
            Some("ctx".to_string()),
            ResourceType::Pods,
            Some("default".to_string()),
        );
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().items.len(), 1);
    }

    #[test]
    fn cache_misses_for_different_scope() {
        let mut state = AppState::new();
        let resources = make_resource_list(vec![make_resource("p", "1")]);
        state.cache_resources_for_scope(
            Some("ctx-a".to_string()),
            ResourceType::Pods,
            Some("ns-a".to_string()),
            resources,
        );
        let cached = state.get_cached_resources_for_scope(
            Some("ctx-b".to_string()),
            ResourceType::Pods,
            Some("ns-a".to_string()),
        );
        assert!(cached.is_none());
    }

    #[test]
    fn cache_key_ignores_namespace_for_cluster_scoped_resources() {
        let mut state = AppState::new();
        let resources = make_resource_list(vec![make_resource("node-1", "n1")]);
        state.cache_resources_for_scope(
            Some("ctx".to_string()),
            ResourceType::Nodes,
            Some("ns-ignored".to_string()),
            resources,
        );
        // Should be retrievable with None namespace since Nodes aren't namespaced
        let cached = state.get_cached_resources_for_scope(
            Some("ctx".to_string()),
            ResourceType::Nodes,
            None,
        );
        assert!(cached.is_some());
    }

    // --- Port forward tests ---

    #[test]
    fn add_port_forward_appends_to_list() {
        let mut state = AppState::new();
        state.add_port_forward(make_port_forward("pf-1"));
        state.add_port_forward(make_port_forward("pf-2"));
        assert_eq!(state.port_forwards.len(), 2);
    }

    #[test]
    fn remove_port_forward_by_session_id() {
        let mut state = AppState::new();
        state.add_port_forward(make_port_forward("pf-1"));
        state.add_port_forward(make_port_forward("pf-2"));
        state.remove_port_forward("pf-1");
        assert_eq!(state.port_forwards.len(), 1);
        assert_eq!(state.port_forwards[0].session_id, "pf-2");
    }

    #[test]
    fn remove_port_forward_no_op_for_unknown_id() {
        let mut state = AppState::new();
        state.add_port_forward(make_port_forward("pf-1"));
        state.remove_port_forward("pf-999");
        assert_eq!(state.port_forwards.len(), 1);
    }

    #[test]
    fn clear_port_forwards_removes_all() {
        let mut state = AppState::new();
        state.add_port_forward(make_port_forward("pf-1"));
        state.add_port_forward(make_port_forward("pf-2"));
        state.clear_port_forwards();
        assert!(state.port_forwards.is_empty());
    }

    // --- Pod view tests ---

    #[test]
    fn open_pod_logs_sets_view_and_context() {
        let mut state = AppState::new();
        state.open_pod_logs(
            "my-pod".to_string(),
            "production".to_string(),
            vec!["app".to_string(), "sidecar".to_string()],
            Some("app".to_string()),
        );
        assert_eq!(state.active_view, ActiveView::PodLogs);
        let ctx = state.pod_context.as_ref().unwrap();
        assert_eq!(ctx.pod_name, "my-pod");
        assert_eq!(ctx.namespace, "production");
        assert_eq!(ctx.containers.len(), 2);
        assert_eq!(ctx.selected_container.as_deref(), Some("app"));
    }

    #[test]
    fn open_pod_terminal_sets_view_and_context() {
        let mut state = AppState::new();
        state.open_pod_terminal(
            "my-pod".to_string(),
            "staging".to_string(),
            vec!["main".to_string()],
            None,
        );
        assert_eq!(state.active_view, ActiveView::PodTerminal);
        let ctx = state.pod_context.as_ref().unwrap();
        assert_eq!(ctx.pod_name, "my-pod");
        assert_eq!(ctx.namespace, "staging");
        assert!(ctx.selected_container.is_none());
    }

    #[test]
    fn close_pod_view_returns_to_details_when_resource_selected() {
        let mut state = AppState::new();
        state.set_selected_resource(Some(make_resource("pod", "1")));
        state.open_pod_logs("p".to_string(), "n".to_string(), vec![], None);
        state.close_pod_view();
        assert_eq!(state.active_view, ActiveView::PodDetails);
        assert!(state.pod_context.is_none());
    }

    #[test]
    fn close_pod_view_returns_to_table_when_no_resource_selected() {
        let mut state = AppState::new();
        state.open_pod_logs("p".to_string(), "n".to_string(), vec![], None);
        state.close_pod_view();
        assert_eq!(state.active_view, ActiveView::ResourceTable);
        assert!(state.pod_context.is_none());
    }

    // --- AI message tests ---

    #[test]
    fn push_ai_user_message_adds_to_messages() {
        let mut state = AppState::new();
        state.push_ai_user_message("hello".to_string());
        assert_eq!(state.ai_messages.len(), 1);
        assert_eq!(state.ai_messages[0].role, AIChatRole::User);
        assert_eq!(state.ai_messages[0].content, "hello");
    }

    #[test]
    fn push_ai_assistant_message_adds_to_messages() {
        let mut state = AppState::new();
        state.push_ai_assistant_message("response".to_string());
        assert_eq!(state.ai_messages.len(), 1);
        assert_eq!(state.ai_messages[0].role, AIChatRole::Assistant);
        assert_eq!(state.ai_messages[0].content, "response");
    }

    #[test]
    fn ai_messages_maintain_order() {
        let mut state = AppState::new();
        state.push_ai_user_message("q1".to_string());
        state.push_ai_assistant_message("a1".to_string());
        state.push_ai_user_message("q2".to_string());
        assert_eq!(state.ai_messages.len(), 3);
        assert_eq!(state.ai_messages[0].role, AIChatRole::User);
        assert_eq!(state.ai_messages[1].role, AIChatRole::Assistant);
        assert_eq!(state.ai_messages[2].role, AIChatRole::User);
    }

    // --- AI prefill prompt tests ---

    #[test]
    fn queue_and_take_ai_prefill_prompt() {
        let mut state = AppState::new();
        state.queue_ai_prefill_prompt("explain this pod".to_string(), true, None);
        assert!(state.ai_prefill_prompt.is_some());
        assert!(state.ai_prefill_auto_send);

        let taken = state.take_ai_prefill_prompt();
        assert_eq!(taken, Some(("explain this pod".to_string(), true)));
        assert!(state.ai_prefill_prompt.is_none());
        assert!(!state.ai_prefill_auto_send);
    }

    #[test]
    fn take_ai_prefill_prompt_returns_none_when_empty() {
        let mut state = AppState::new();
        assert!(state.take_ai_prefill_prompt().is_none());
    }

    // --- AI connection testing tests ---

    #[test]
    fn set_ai_connection_testing_resets_state() {
        let mut state = AppState::new();
        state.set_ai_connection_testing(true);
        assert!(state.ai_connection_testing);
        assert_eq!(
            state.ai_connection_message.as_deref(),
            Some("Testing connection with the selected provider...")
        );
        assert!(state.ai_connection_success.is_none());
    }

    #[test]
    fn set_ai_connection_result_ok() {
        let mut state = AppState::new();
        state.set_ai_connection_testing(true);
        state.set_ai_connection_result(Ok("Connected!".to_string()));
        assert!(!state.ai_connection_testing);
        assert_eq!(state.ai_connection_success, Some(true));
        assert_eq!(state.ai_connection_message.as_deref(), Some("Connected!"));
    }

    #[test]
    fn set_ai_connection_result_err() {
        let mut state = AppState::new();
        state.set_ai_connection_testing(true);
        state.set_ai_connection_result(Err("Timeout".to_string()));
        assert!(!state.ai_connection_testing);
        assert_eq!(state.ai_connection_success, Some(false));
        assert_eq!(state.ai_connection_message.as_deref(), Some("Timeout"));
    }

    // --- OpenCode model selection tests ---

    #[test]
    fn set_opencode_models_selects_first_when_none_selected() {
        let mut state = AppState::new();
        state.set_opencode_models(vec!["gpt-4".to_string(), "gpt-3.5".to_string()]);
        assert_eq!(state.opencode_selected_model.as_deref(), Some("gpt-4"));
    }

    #[test]
    fn set_opencode_models_keeps_selection_when_still_available() {
        let mut state = AppState::new();
        state.opencode_selected_model = Some("gpt-3.5".to_string());
        state.set_opencode_models(vec!["gpt-4".to_string(), "gpt-3.5".to_string()]);
        assert_eq!(state.opencode_selected_model.as_deref(), Some("gpt-3.5"));
    }

    #[test]
    fn set_opencode_models_resets_selection_when_model_removed() {
        let mut state = AppState::new();
        state.opencode_selected_model = Some("gpt-3".to_string());
        state.set_opencode_models(vec!["gpt-4".to_string(), "gpt-4o".to_string()]);
        // "gpt-3" not in the new list, so falls back to first
        assert_eq!(state.opencode_selected_model.as_deref(), Some("gpt-4"));
    }

    #[test]
    fn set_opencode_models_empty_clears_selection() {
        let mut state = AppState::new();
        state.opencode_selected_model = Some("m".to_string());
        state.set_opencode_models(vec![]);
        assert!(state.opencode_selected_model.is_none());
    }

    // --- Settings tests ---

    #[test]
    fn open_and_close_settings() {
        let mut state = AppState::new();
        assert!(!state.settings_open);
        state.open_settings();
        assert!(state.settings_open);
        state.close_settings();
        assert!(!state.settings_open);
    }

    #[test]
    fn set_settings_tab_changes_tab() {
        let mut state = AppState::new();
        assert_eq!(state.settings_tab, SettingsTab::Appearance);
        state.set_settings_tab(SettingsTab::AI);
        assert_eq!(state.settings_tab, SettingsTab::AI);
    }

    // --- Loading / error state tests ---

    #[test]
    fn set_loading_updates_flag() {
        let mut state = AppState::new();
        state.set_loading(true);
        assert!(state.is_loading);
        state.set_loading(false);
        assert!(!state.is_loading);
    }

    #[test]
    fn set_error_stores_and_clears_error() {
        let mut state = AppState::new();
        state.set_error(Some("something failed".to_string()));
        assert_eq!(state.error.as_deref(), Some("something failed"));
        state.set_error(None);
        assert!(state.error.is_none());
    }

    #[test]
    fn set_connection_status_updates_both_fields() {
        let mut state = AppState::new();
        state.set_connection_status(
            k8s_client::ConnectionStatus::Error,
            Some("timed out".to_string()),
        );
        assert_eq!(state.connection_status, k8s_client::ConnectionStatus::Error);
        assert_eq!(state.connection_error.as_deref(), Some("timed out"));
    }

    #[test]
    fn set_ai_request_in_flight_updates_flag() {
        let mut state = AppState::new();
        state.set_ai_request_in_flight(true);
        assert!(state.ai_request_in_flight);
        state.set_ai_request_in_flight(false);
        assert!(!state.ai_request_in_flight);
    }

    // --- Enum default / equality tests ---

    #[test]
    fn active_panel_default_is_none() {
        assert_eq!(ActivePanel::default(), ActivePanel::None);
    }

    #[test]
    fn active_view_default_is_resource_table() {
        assert_eq!(ActiveView::default(), ActiveView::ResourceTable);
    }

    #[test]
    fn settings_tab_default_is_appearance() {
        assert_eq!(SettingsTab::default(), SettingsTab::Appearance);
    }

    #[test]
    fn active_panel_variants_are_distinct() {
        assert_ne!(ActivePanel::None, ActivePanel::Logs);
        assert_ne!(ActivePanel::Logs, ActivePanel::Terminal);
        assert_ne!(ActivePanel::Terminal, ActivePanel::AI);
    }

    #[test]
    fn active_view_variants_are_distinct() {
        assert_ne!(ActiveView::ResourceTable, ActiveView::PodDetails);
        assert_ne!(ActiveView::PodDetails, ActiveView::PodLogs);
        assert_ne!(ActiveView::PodLogs, ActiveView::PodTerminal);
        assert_ne!(ActiveView::PodTerminal, ActiveView::PortForwards);
        assert_ne!(ActiveView::PortForwards, ActiveView::Settings);
    }

    #[test]
    fn pod_context_default_has_empty_fields() {
        let ctx = PodContext::default();
        assert!(ctx.pod_name.is_empty());
        assert!(ctx.namespace.is_empty());
        assert!(ctx.containers.is_empty());
        assert!(ctx.selected_container.is_none());
    }

    #[test]
    fn ai_chat_role_equality() {
        assert_eq!(AIChatRole::User, AIChatRole::User);
        assert_eq!(AIChatRole::Assistant, AIChatRole::Assistant);
        assert_ne!(AIChatRole::User, AIChatRole::Assistant);
    }

    #[test]
    fn to_ui_theme_mode_maps_all_variants() {
        use crate::settings::ThemeMode as WsThemeMode;

        let mappings = vec![
            (WsThemeMode::GruvboxLight, UiThemeMode::GruvboxLight),
            (WsThemeMode::SolarizedLight, UiThemeMode::SolarizedLight),
            (WsThemeMode::EverforestLight, UiThemeMode::EverforestLight),
            (WsThemeMode::RosePineDawn, UiThemeMode::RosePineDawn),
            (WsThemeMode::GitHubLight, UiThemeMode::GitHubLight),
            (WsThemeMode::GruvboxDark, UiThemeMode::GruvboxDark),
            (WsThemeMode::SolarizedDark, UiThemeMode::SolarizedDark),
            (WsThemeMode::EverforestDark, UiThemeMode::EverforestDark),
            (WsThemeMode::DraculaDark, UiThemeMode::DraculaDark),
            (WsThemeMode::MonokaiDark, UiThemeMode::MonokaiDark),
        ];

        for (ws_mode, expected_ui_mode) in mappings {
            assert_eq!(
                to_ui_theme_mode(ws_mode),
                expected_ui_mode,
                "Mismatch for {:?}",
                ws_mode
            );
        }
    }
}
