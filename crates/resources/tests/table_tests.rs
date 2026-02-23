use resources::{BulkTableAction, SortDirection, SortState, StatusType};
use ui::ThemeColors;

// --- StatusType tests ---

#[test]
fn status_type_ready_label() {
    assert_eq!(StatusType::Ready.label(), "Running");
}

#[test]
fn status_type_pending_label() {
    assert_eq!(StatusType::Pending.label(), "Pending");
}

#[test]
fn status_type_failed_label() {
    assert_eq!(StatusType::Failed.label(), "Failed");
}

#[test]
fn status_type_unknown_label() {
    assert_eq!(StatusType::Unknown.label(), "Unknown");
}

#[test]
fn status_type_labels_are_non_empty() {
    let statuses = [
        StatusType::Ready,
        StatusType::Pending,
        StatusType::Failed,
        StatusType::Unknown,
    ];
    for s in statuses {
        assert!(!s.label().is_empty(), "{:?} has empty label", s);
    }
}

#[test]
fn status_type_equality() {
    assert_eq!(StatusType::Ready, StatusType::Ready);
    assert_ne!(StatusType::Ready, StatusType::Failed);
    assert_ne!(StatusType::Pending, StatusType::Unknown);
}

#[test]
fn status_type_color_returns_different_colors_for_each_status() {
    let colors = ThemeColors::default();
    let ready_color = StatusType::Ready.color(&colors);
    let failed_color = StatusType::Failed.color(&colors);
    assert_ne!(ready_color, failed_color);
}

// --- SortDirection tests ---

#[test]
fn sort_direction_default_is_ascending() {
    assert_eq!(SortDirection::default(), SortDirection::Ascending);
}

// --- SortState tests ---

#[test]
fn sort_state_default_has_no_column() {
    let state = SortState::default();
    assert!(state.column.is_none());
    assert_eq!(state.direction, SortDirection::Ascending);
}

// --- BulkTableAction tests ---

#[test]
fn bulk_table_action_delete_debug() {
    let action = BulkTableAction::Delete;
    let debug_str = format!("{:?}", action);
    assert!(debug_str.contains("Delete"));
}

#[test]
fn bulk_table_action_scale_contains_replicas() {
    let action = BulkTableAction::Scale { replicas: 3 };
    let debug_str = format!("{:?}", action);
    assert!(debug_str.contains("3"));
}

#[test]
fn bulk_table_action_label_contains_key_value() {
    let action = BulkTableAction::Label {
        key: "env".to_string(),
        value: "prod".to_string(),
    };
    let debug_str = format!("{:?}", action);
    assert!(debug_str.contains("env"));
    assert!(debug_str.contains("prod"));
}
