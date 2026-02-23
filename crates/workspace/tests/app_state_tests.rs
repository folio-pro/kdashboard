use k8s_client::{PortForwardInfo, Resource, ResourceList, ResourceMetadata, ResourceType};
use workspace::{
    AIChatRole, ActivePanel, ActiveView, AppState, PodContext, SettingsTab,
};

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
    assert_eq!(state.sort_direction, k8s_client::SortDirection::Ascending);
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
    assert_eq!(state.sort_direction, k8s_client::SortDirection::Ascending);
}

#[test]
fn set_sort_toggles_direction_on_same_column() {
    let mut state = AppState::new();
    state.set_sort("Age");
    assert_eq!(state.sort_direction, k8s_client::SortDirection::Ascending);
    state.set_sort("Age");
    assert_eq!(state.sort_direction, k8s_client::SortDirection::Descending);
    state.set_sort("Age");
    assert_eq!(state.sort_direction, k8s_client::SortDirection::Ascending);
}

#[test]
fn set_sort_resets_direction_on_different_column() {
    let mut state = AppState::new();
    state.set_sort("Name");
    state.set_sort("Name");
    assert_eq!(state.sort_direction, k8s_client::SortDirection::Descending);
    state.set_sort("Status");
    assert_eq!(state.sort_column.as_deref(), Some("Status"));
    assert_eq!(state.sort_direction, k8s_client::SortDirection::Ascending);
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
        resources,
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
