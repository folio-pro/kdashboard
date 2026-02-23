mod helpers;

use self::helpers::*;
use gpui::*;
use k8s_client::{Resource, ResourceType};
use std::collections::{HashMap, HashSet};
use ui::{
    Icon, IconName, Sizable, ThemeColors, danger_btn,
    gpui_component::{
        input::{Input, InputState},
        scroll::ScrollableElement,
        v_virtual_list, VirtualListScrollHandle,
    },
    secondary_btn, theme,
};

/// Status type for resources
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StatusType {
    Ready,
    Pending,
    Failed,
    Unknown,
}

impl StatusType {
    pub fn label(&self) -> &'static str {
        match self {
            StatusType::Ready => "Running",
            StatusType::Pending => "Pending",
            StatusType::Failed => "Failed",
            StatusType::Unknown => "Unknown",
        }
    }

    pub fn color(&self, colors: &ThemeColors) -> Hsla {
        match self {
            StatusType::Ready => colors.success,
            StatusType::Pending => colors.warning,
            StatusType::Failed => colors.error,
            StatusType::Unknown => colors.text_muted,
        }
    }
}

/// Sort direction for columns
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SortDirection {
    #[default]
    Ascending,
    Descending,
}

impl SortDirection {
    fn toggle(&self) -> Self {
        match self {
            SortDirection::Ascending => SortDirection::Descending,
            SortDirection::Descending => SortDirection::Ascending,
        }
    }
}

/// Sort state for the table
#[derive(Clone, Default)]
pub struct SortState {
    pub column: Option<String>,
    pub direction: SortDirection,
}

#[derive(Clone, Debug)]
pub enum BulkTableAction {
    Delete,
    Scale { replicas: i32 },
    Label { key: String, value: String },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BulkDialog {
    ConfirmDelete,
    Scale,
    Label,
}

/// Fixed row height for virtual scrolling (14px top + 14px bottom padding + ~20px text + 1px border)
const ROW_HEIGHT: f32 = 49.0;

pub struct ResourceTable {
    resources: Vec<Resource>,
    resource_type: ResourceType,
    selected_index: Option<usize>,
    selected_indices: HashSet<usize>,
    scroll_handle: VirtualListScrollHandle,
    on_select: Option<Box<dyn Fn(usize, &Resource, &mut Context<'_, Self>) + 'static>>,
    on_open: Option<Box<dyn Fn(&Resource, &mut Context<'_, Self>) + 'static>>,
    on_ai_assist: Option<Box<dyn Fn(&Resource, &mut Context<'_, Self>) + 'static>>,
    on_bulk_action:
        Option<Box<dyn Fn(BulkTableAction, Vec<Resource>, &mut Context<'_, Self>) + 'static>>,
    /// Custom column widths (column name -> width in pixels)
    column_widths: HashMap<String, f32>,
    /// Current sort state
    sort_state: SortState,
    /// Cached sorted indices — maps virtual position to original resource index
    sorted_indices: Vec<usize>,
    /// Whether the sort cache needs rebuilding
    sort_dirty: bool,
    /// Column being resized
    resizing_column: Option<String>,
    /// Starting X position for resize drag
    resize_start_x: f32,
    /// Starting width for resize drag
    resize_start_width: f32,
    focus_handle: FocusHandle,
    bulk_dialog: Option<BulkDialog>,
    bulk_error: Option<String>,
    scale_input: Option<Entity<InputState>>,
    label_key_input: Option<Entity<InputState>>,
    label_value_input: Option<Entity<InputState>>,
    suppress_row_open_once: bool,
}

impl ResourceTable {
    pub fn new(
        resources: Vec<Resource>,
        resource_type: ResourceType,
        focus_handle: FocusHandle,
    ) -> Self {
        let sorted_indices: Vec<usize> = (0..resources.len()).collect();
        Self {
            resources,
            resource_type,
            selected_index: None,
            selected_indices: HashSet::new(),
            scroll_handle: VirtualListScrollHandle::new(),
            on_select: None,
            on_open: None,
            on_ai_assist: None,
            on_bulk_action: None,
            column_widths: HashMap::new(),
            sort_state: SortState::default(),
            sorted_indices,
            sort_dirty: true,
            resizing_column: None,
            resize_start_x: 0.0,
            resize_start_width: 0.0,
            focus_handle,
            bulk_dialog: None,
            bulk_error: None,
            scale_input: None,
            label_key_input: None,
            label_value_input: None,
            suppress_row_open_once: false,
        }
    }

    pub fn set_resources(&mut self, resources: Vec<Resource>) {
        self.resources = resources;
        self.sort_dirty = true;
        self.selected_indices.retain(|i| *i < self.resources.len());
        if self
            .selected_index
            .is_some_and(|i| i >= self.resources.len())
        {
            self.selected_index = None;
        }
    }

    pub fn set_resource_type(&mut self, resource_type: ResourceType) {
        if self.resource_type != resource_type {
            self.resource_type = resource_type;
            self.selected_index = None;
            self.selected_indices.clear();
        }
    }

    pub fn set_selected(&mut self, index: Option<usize>) {
        self.selected_index = index;
    }

    pub fn selected_count(&self) -> usize {
        self.selected_indices.len()
    }

    pub fn on_select(
        mut self,
        handler: impl Fn(usize, &Resource, &mut Context<'_, Self>) + 'static,
    ) -> Self {
        self.on_select = Some(Box::new(handler));
        self
    }

    pub fn set_on_open(&mut self, handler: impl Fn(&Resource, &mut Context<'_, Self>) + 'static) {
        self.on_open = Some(Box::new(handler));
    }

    pub fn set_on_ai_assist(
        &mut self,
        handler: impl Fn(&Resource, &mut Context<'_, Self>) + 'static,
    ) {
        self.on_ai_assist = Some(Box::new(handler));
    }

    pub fn set_on_bulk_action(
        &mut self,
        handler: impl Fn(BulkTableAction, Vec<Resource>, &mut Context<'_, Self>) + 'static,
    ) {
        self.on_bulk_action = Some(Box::new(handler));
    }

    fn open_row(&mut self, index: usize, cx: &mut Context<'_, Self>) {
        if let Some(resource) = self.resources.get(index).cloned() {
            if let Some(on_open) = &self.on_open {
                on_open(&resource, cx);
            }
        }
    }

    fn trigger_ai_assist(&mut self, resource: Resource, cx: &mut Context<'_, Self>) {
        if let Some(on_ai_assist) = &self.on_ai_assist {
            on_ai_assist(&resource, cx);
        }
    }

    /// Toggle sort for a column
    fn toggle_sort(&mut self, column: &str, cx: &mut Context<'_, Self>) {
        if self.sort_state.column.as_deref() == Some(column) {
            self.sort_state.direction = self.sort_state.direction.toggle();
        } else {
            self.sort_state.column = Some(column.to_string());
            self.sort_state.direction = SortDirection::Ascending;
        }
        self.sort_dirty = true;
        cx.notify();
    }

    /// Get column width (custom or default)
    fn get_column_width(&self, name: &str, default: f32) -> f32 {
        self.column_widths.get(name).copied().unwrap_or(default)
    }

    /// Set column width
    fn set_column_width(&mut self, name: &str, width: f32, cx: &mut Context<'_, Self>) {
        let min_width = 40.0;
        let max_width = 600.0;
        let clamped = width.max(min_width).min(max_width);
        self.column_widths.insert(name.to_string(), clamped);
        cx.notify();
    }

    /// Start resizing a column
    fn start_resize(&mut self, column: &str, x: f32, current_width: f32) {
        self.resizing_column = Some(column.to_string());
        self.resize_start_x = x;
        self.resize_start_width = current_width;
    }

    /// Update resize drag
    fn update_resize(&mut self, x: f32, cx: &mut Context<'_, Self>) {
        if let Some(col) = self.resizing_column.clone() {
            let delta = x - self.resize_start_x;
            let new_width = self.resize_start_width + delta;
            self.set_column_width(&col, new_width, cx);
        }
    }

    /// Auto-fit column width to content (double-click on resize handle)
    fn auto_fit_column(&mut self, column: &str, cx: &mut Context<'_, Self>) {
        let optimal_width = self.calculate_optimal_width(column);
        self.set_column_width(column, optimal_width, cx);
    }

    /// Calculate optimal width for a column based on content
    fn calculate_optimal_width(&self, column: &str) -> f32 {
        // Base width for the column header text (approximate: 7px per char + padding)
        let header_width = (column.len() as f32 * 7.0) + 40.0; // extra for sort icon and padding

        // Calculate max content width
        let content_width = self
            .resources
            .iter()
            .map(|resource| self.get_cell_text_length(column, resource))
            .fold(0.0_f32, |a, b| a.max(b));

        // Return the larger of header or content, with some padding
        let optimal = header_width.max(content_width + 24.0); // 24px padding

        // Clamp to reasonable bounds
        optimal.max(60.0).min(500.0)
    }

    /// Get approximate text length for a cell (in pixels)
    fn get_cell_text_length(&self, column: &str, resource: &Resource) -> f32 {
        let char_width = 7.5; // approximate width per character at 13px font
        let icon_width = 22.0; // icon + gap for name columns

        let text = match column {
            "Name" => {
                let base = resource.metadata.name.len() as f32 * char_width;
                base + icon_width // account for icon
            }
            "Namespace" => resource
                .metadata
                .namespace
                .as_ref()
                .map(|s| s.len() as f32 * char_width)
                .unwrap_or(char_width),
            "Status" => {
                let status = get_resource_status(resource);
                (status.label().len() as f32 * char_width) + 36.0 // pill padding + dot + gap
            }
            "Restarts" => {
                let restarts = get_pod_restarts(resource);
                (restarts.to_string().len() as f32 * char_width).max(30.0)
            }
            "Containers" => {
                let count = get_pod_container_images(resource).len();
                (count as f32 * 26.0).max(26.0) // 22px icon + 4px gap each
            }
            "Age" => 50.0, // ages are short like "5d", "12h"
            "Type" => get_json_value(&resource.spec, &["type"])
                .and_then(|v| v.as_str())
                .map(|s| s.len() as f32 * char_width)
                .unwrap_or(60.0),
            "Cluster-IP" => 110.0, // IP addresses are fixed length
            "Ports" => {
                let ports = get_service_ports(resource);
                (ports.len() as f32 * char_width).max(60.0)
            }
            "Up-to-date" | "Available" => 50.0,
            "Roles" => {
                let roles = get_node_roles(resource);
                (roles.len() as f32 * char_width).max(60.0)
            }
            "Version" => get_json_value(&resource.status, &["nodeInfo", "kubeletVersion"])
                .and_then(|v| v.as_str())
                .map(|s| s.len() as f32 * char_width)
                .unwrap_or(80.0),
            "Node" => get_json_value(&resource.spec, &["nodeName"])
                .and_then(|v| v.as_str())
                .map(|s| s.len() as f32 * char_width)
                .unwrap_or(60.0),
            _ => 80.0,
        };

        text
    }

    /// Rebuild sorted indices cache if dirty
    fn ensure_sorted(&mut self) {
        if !self.sort_dirty {
            return;
        }
        self.sort_dirty = false;

        self.sorted_indices = (0..self.resources.len()).collect();

        if let Some(ref col) = self.sort_state.column {
            let direction = self.sort_state.direction;
            let resource_type = self.resource_type;
            let resources = &self.resources;

            self.sorted_indices.sort_by(|&a, &b| {
                let cmp =
                    compare_resources_by_column(&resources[a], &resources[b], col, resource_type);
                match direction {
                    SortDirection::Ascending => cmp,
                    SortDirection::Descending => cmp.reverse(),
                }
            });
        }
    }

    fn get_columns(&self) -> Vec<ColumnDef> {
        match self.resource_type {
            ResourceType::Pods => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 240.0).with_icon(),
                ColumnDef::new("Containers", 120.0),
                ColumnDef::new("Namespace", 120.0),
                ColumnDef::new("Status", 120.0).status_dot(),
                ColumnDef::new("Restarts", 90.0),
                ColumnDef::new("Age", 70.0).right(),
                ColumnDef::new("Node", 0.0), // fills remaining space
            ],
            ResourceType::Deployments => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 240.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Ready", 80.0).center(),
                ColumnDef::new("Up-to-date", 90.0).right(),
                ColumnDef::new("Available", 80.0).right(),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::ReplicaSets => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 280.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Desired", 70.0).right(),
                ColumnDef::new("Current", 70.0).right(),
                ColumnDef::new("Ready", 70.0).right(),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::StatefulSets => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 240.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Ready", 80.0).center(),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::DaemonSets => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 240.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Desired", 70.0).right(),
                ColumnDef::new("Current", 70.0).right(),
                ColumnDef::new("Ready", 70.0).right(),
                ColumnDef::new("Up-to-date", 90.0).right(),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::Jobs => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 280.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Completions", 100.0).center(),
                ColumnDef::new("Duration", 80.0).right(),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::CronJobs => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 240.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Schedule", 120.0),
                ColumnDef::new("Suspend", 70.0).center(),
                ColumnDef::new("Active", 60.0).right(),
                ColumnDef::new("Last Schedule", 110.0).right(),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::Services => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 200.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Type", 100.0),
                ColumnDef::new("Cluster-IP", 120.0),
                ColumnDef::new("Ports", 140.0),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::Ingresses => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 200.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Class", 100.0),
                ColumnDef::new("Hosts", 200.0),
                ColumnDef::new("Address", 120.0),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::ConfigMaps => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 280.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Data", 60.0).right(),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::Secrets => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 280.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Type", 180.0),
                ColumnDef::new("Data", 60.0).right(),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::Nodes => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 200.0).with_icon(),
                ColumnDef::new("Status", 100.0).status_dot(),
                ColumnDef::new("Roles", 120.0),
                ColumnDef::new("Version", 120.0),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::Namespaces => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 280.0).with_icon(),
                ColumnDef::new("Status", 100.0).status_dot(),
                ColumnDef::new("Age", 70.0).right(),
            ],
            ResourceType::HorizontalPodAutoscalers => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 200.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Reference", 140.0),
                ColumnDef::new("Metrics", 180.0),
                ColumnDef::new("Replicas", 100.0).center(),
                ColumnDef::new("Min/Max", 80.0).center(),
                ColumnDef::new("Status", 100.0).status_dot(),
                ColumnDef::new("Age", 60.0).right(),
            ],
            ResourceType::VerticalPodAutoscalers => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 200.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Target", 140.0),
                ColumnDef::new("Mode", 80.0).center(),
                ColumnDef::new("CPU Rec.", 120.0).center(),
                ColumnDef::new("Mem Rec.", 120.0).center(),
                ColumnDef::new("Status", 100.0).status_dot(),
                ColumnDef::new("Age", 60.0).right(),
            ],
        }
    }

    fn toggle_row_checkbox(&mut self, index: usize, cx: &mut Context<'_, Self>) {
        if self.selected_indices.contains(&index) {
            self.selected_indices.remove(&index);
        } else {
            self.selected_indices.insert(index);
        }
        cx.notify();
    }

    fn set_all_selected(&mut self, indices: &[usize], selected: bool, cx: &mut Context<'_, Self>) {
        if selected {
            for idx in indices {
                self.selected_indices.insert(*idx);
            }
        } else {
            for idx in indices {
                self.selected_indices.remove(idx);
            }
        }
        cx.notify();
    }

    fn selected_resources(&self) -> Vec<Resource> {
        let mut indices: Vec<usize> = self.selected_indices.iter().copied().collect();
        indices.sort_unstable();
        indices
            .into_iter()
            .filter_map(|idx| self.resources.get(idx).cloned())
            .collect()
    }

    fn trigger_bulk_action(&mut self, action: BulkTableAction, cx: &mut Context<'_, Self>) {
        if self.selected_indices.is_empty() {
            return;
        }
        let selected = self.selected_resources();
        if let Some(on_bulk_action) = &self.on_bulk_action {
            on_bulk_action(action, selected, cx);
        }
    }

    fn open_bulk_dialog(
        &mut self,
        dialog: BulkDialog,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.bulk_dialog = Some(dialog);
        self.bulk_error = None;

        match dialog {
            BulkDialog::ConfirmDelete => {}
            BulkDialog::Scale => {
                if self.scale_input.is_none() {
                    self.scale_input = Some(cx.new(|input_cx| {
                        InputState::new(window, input_cx)
                            .placeholder("Replicas")
                            .default_value("1")
                    }));
                }
            }
            BulkDialog::Label => {
                if self.label_key_input.is_none() {
                    self.label_key_input = Some(cx.new(|input_cx| {
                        InputState::new(window, input_cx)
                            .placeholder("label key")
                            .default_value("managed-by")
                    }));
                }
                if self.label_value_input.is_none() {
                    self.label_value_input = Some(cx.new(|input_cx| {
                        InputState::new(window, input_cx)
                            .placeholder("label value")
                            .default_value("kdashboard")
                    }));
                }
            }
        }

        cx.notify();
    }

    fn close_bulk_dialog(&mut self, cx: &mut Context<'_, Self>) {
        self.bulk_dialog = None;
        self.bulk_error = None;
        cx.notify();
    }

    fn confirm_bulk_dialog(&mut self, cx: &mut Context<'_, Self>) {
        let Some(dialog) = self.bulk_dialog else {
            return;
        };

        match dialog {
            BulkDialog::ConfirmDelete => {
                self.trigger_bulk_action(BulkTableAction::Delete, cx);
                self.bulk_dialog = None;
                self.bulk_error = None;
            }
            BulkDialog::Scale => {
                let replicas_text = self
                    .scale_input
                    .as_ref()
                    .map(|input| input.read(cx).text().to_string())
                    .map(|text| text.trim().to_string())
                    .unwrap_or_default();
                match replicas_text.parse::<i32>() {
                    Ok(replicas) if replicas >= 0 => {
                        self.trigger_bulk_action(BulkTableAction::Scale { replicas }, cx);
                        self.bulk_dialog = None;
                        self.bulk_error = None;
                    }
                    _ => {
                        self.bulk_error =
                            Some("Replicas must be a non-negative integer".to_string());
                    }
                }
            }
            BulkDialog::Label => {
                let key = self
                    .label_key_input
                    .as_ref()
                    .map(|input| input.read(cx).text().to_string())
                    .map(|text| text.trim().to_string())
                    .unwrap_or_default();
                let value = self
                    .label_value_input
                    .as_ref()
                    .map(|input| input.read(cx).text().to_string())
                    .map(|text| text.trim().to_string())
                    .unwrap_or_default();

                if key.is_empty() {
                    self.bulk_error = Some("Label key cannot be empty".to_string());
                    return;
                }

                if value.is_empty() {
                    self.bulk_error = Some("Label value cannot be empty".to_string());
                    return;
                }

                self.trigger_bulk_action(BulkTableAction::Label { key, value }, cx);
                self.bulk_dialog = None;
                self.bulk_error = None;
            }
        }

        cx.notify();
    }

    fn select_row(&mut self, index: usize, cx: &mut Context<'_, Self>) {
        self.selected_index = Some(index);
        if let Some(resource) = self.resources.get(index).cloned() {
            if let Some(on_select) = &self.on_select {
                on_select(index, &resource, cx);
            }
        }
        cx.notify();
    }

    fn can_scale(&self) -> bool {
        matches!(
            self.resource_type,
            ResourceType::Deployments | ResourceType::StatefulSets
        )
    }
}

struct ColumnDef {
    name: &'static str,
    default_width: f32,
    align: Align,
    column_type: ColumnType,
    sortable: bool,
}

#[derive(Clone, Copy, Default)]
enum Align {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Default, PartialEq)]
enum ColumnType {
    #[default]
    Text,
    Checkbox,
    NameWithIcon,
    StatusDot,
    Actions,
}

/// Drag value for column resizing
#[derive(Clone)]
struct DragValue {
    column: String,
    start_width: f32,
}

impl ColumnDef {
    fn new(name: &'static str, width: f32) -> Self {
        Self {
            name,
            default_width: width,
            align: Align::Left,
            column_type: ColumnType::Text,
            sortable: true,
        }
    }

    fn center(mut self) -> Self {
        self.align = Align::Center;
        self
    }

    fn right(mut self) -> Self {
        self.align = Align::Right;
        self
    }

    fn checkbox(mut self) -> Self {
        self.column_type = ColumnType::Checkbox;
        self.sortable = false;
        self
    }

    fn with_icon(mut self) -> Self {
        self.column_type = ColumnType::NameWithIcon;
        self
    }

    fn status_dot(mut self) -> Self {
        self.column_type = ColumnType::StatusDot;
        self
    }

    fn actions(mut self) -> Self {
        self.column_type = ColumnType::Actions;
        self.sortable = false;
        self
    }
}

impl Render for ResourceTable {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        // Rebuild sorted indices if needed (only when resources or sort state change)
        self.ensure_sorted();

        let theme = theme(cx);
        let colors = &theme.colors;
        let columns = self.get_columns();
        let resource_type = self.resource_type;
        let sort_state = self.sort_state.clone();

        let is_empty = self.resources.is_empty();
        let item_count = self.sorted_indices.len();

        let mut container = div()
            .id("resource-table-root")
            .size_full()
            .flex()
            .flex_col()
            .track_focus(&self.focus_handle)
            .bg(colors.surface)
            .rounded(theme.border_radius_lg)
            .border_1()
            .border_color(colors.border)
            .relative()
            .overflow_hidden()
            .on_click(cx.listener(|this, _event, window, _cx| {
                window.focus(&this.focus_handle);
            }));

        let visible_indices: Vec<usize> = self.sorted_indices.clone();
        let selected_visible_count = visible_indices
            .iter()
            .filter(|idx| self.selected_indices.contains(idx))
            .count();
        let all_visible_selected =
            !visible_indices.is_empty() && selected_visible_count == visible_indices.len();
        let some_visible_selected = selected_visible_count > 0 && !all_visible_selected;

        if !self.selected_indices.is_empty() {
            container = container.child(self.render_bulk_actions(cx));
        }

        // Header row (fixed, not scrollable)
        container = container.child(self.render_header(
            cx,
            &columns,
            &sort_state,
            visible_indices.clone(),
            all_visible_selected,
            some_visible_selected,
        ));

        // Table body
        if is_empty {
            let type_name = resource_type.display_name();
            let has_all_resources = !self.resources.is_empty();
            let (title, subtitle) = if has_all_resources {
                (
                    format!("No matching {} found", type_name.to_lowercase()),
                    "All resources are filtered out. Try adjusting your search filter.".to_string(),
                )
            } else {
                (
                    format!("No {} in this namespace", type_name.to_lowercase()),
                    "Try selecting a different namespace or check cluster connectivity.".to_string(),
                )
            };
            container = container.child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .py(px(48.0))
                    .gap(px(8.0))
                    .child(
                        Icon::new(IconName::Search)
                            .size(px(32.0))
                            .color(colors.text_muted.opacity(0.5)),
                    )
                    .child(
                        div()
                            .text_size(theme.font_size)
                            .text_color(colors.text_secondary)
                            .font_weight(FontWeight::MEDIUM)
                            .font_family(theme.font_family_ui.clone())
                            .child(title),
                    )
                    .child(
                        div()
                            .text_size(theme.font_size_small)
                            .text_color(colors.text_muted)
                            .font_family(theme.font_family_ui.clone())
                            .child(subtitle),
                    ),
            );
        } else {
            // Virtual scrolling — only renders rows in the visible viewport
            let item_sizes = std::rc::Rc::new(
                vec![size(px(0.0), px(ROW_HEIGHT)); item_count],
            );
            let scroll_handle = self.scroll_handle.clone();

            container = container.child(
                div()
                    .id("table-body-scroll")
                    .flex_1()
                    .relative()
                    .vertical_scrollbar(&scroll_handle)
                    .child(
                        v_virtual_list(
                            cx.entity(),
                            "table-body",
                            item_sizes,
                            move |this, visible_range, _window, cx| {
                                visible_range
                                    .filter_map(|virtual_idx| {
                                        let original_idx =
                                            *this.sorted_indices.get(virtual_idx)?;
                                        let resource = this.resources.get(original_idx)?;
                                        let selected =
                                            this.selected_indices.contains(&original_idx)
                                                || this.selected_index == Some(original_idx);
                                        let columns = this.get_columns();
                                        Some(
                                            this.render_row(
                                                cx,
                                                &columns,
                                                original_idx,
                                                resource,
                                                selected,
                                                resource_type,
                                            )
                                            .into_any_element(),
                                        )
                                    })
                                    .collect::<Vec<_>>()
                            },
                        )
                        .track_scroll(&scroll_handle),
                    ),
            );
        }

        let key_nav_indices = visible_indices.clone();
        container =
            container.on_key_down(cx.listener(move |this, event: &KeyDownEvent, _window, cx| {
                if this.bulk_dialog.is_some() {
                    match event.keystroke.key.as_str() {
                        "escape" => {
                            this.close_bulk_dialog(cx);
                        }
                        "enter" => {
                            this.confirm_bulk_dialog(cx);
                        }
                        _ => {}
                    }
                    return;
                }

                if key_nav_indices.is_empty() {
                    return;
                }

                match event.keystroke.key.as_str() {
                    "enter" => {
                        if let Some(idx) = this.selected_index {
                            this.open_row(idx, cx);
                        }
                    }
                    "up" => {
                        let current_pos = this
                            .selected_index
                            .and_then(|idx| key_nav_indices.iter().position(|v| *v == idx));
                        let next_pos = current_pos.map(|p| p.saturating_sub(1)).unwrap_or(0);
                        if let Some(next_idx) = key_nav_indices.get(next_pos) {
                            this.select_row(*next_idx, cx);
                        }
                    }
                    "down" => {
                        let current_pos = this
                            .selected_index
                            .and_then(|idx| key_nav_indices.iter().position(|v| *v == idx));
                        let next_pos = current_pos
                            .map(|p| (p + 1).min(key_nav_indices.len().saturating_sub(1)))
                            .unwrap_or(0);
                        if let Some(next_idx) = key_nav_indices.get(next_pos) {
                            this.select_row(*next_idx, cx);
                        }
                    }
                    _ => {}
                }
            }));

        if self.bulk_dialog.is_some() {
            container = container.child(self.render_bulk_dialog(cx));
        }

        container
    }
}

impl ResourceTable {
    fn render_bulk_actions(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let count = self.selected_count();
        let can_scale = self.can_scale();

        div()
            .w_full()
            .px(px(20.0))
            .py(px(10.0))
            .bg(colors.surface_elevated)
            .border_b_1()
            .border_color(colors.border)
            .flex()
            .items_center()
            .justify_between()
            .child(
                div()
                    .font_family(theme.font_family_ui.clone())
                    .text_size(px(12.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(colors.text_secondary)
                    .child(format!("{} selected", count)),
            )
            .child({
                let scale_button = if can_scale {
                    secondary_btn("bulk-scale-btn", IconName::Scale, "Scale", colors).on_click(
                        cx.listener(|this, _event, window, cx| {
                            this.open_bulk_dialog(BulkDialog::Scale, window, cx);
                        }),
                    )
                } else {
                    secondary_btn("bulk-scale-btn", IconName::Scale, "Scale", colors).opacity(0.5)
                };

                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        secondary_btn("bulk-label-btn", IconName::Clipboard, "Label", colors)
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.open_bulk_dialog(BulkDialog::Label, window, cx);
                            })),
                    )
                    .child(scale_button)
                    .child(
                        danger_btn("bulk-delete-btn", IconName::Trash, "Delete", colors).on_click(
                            cx.listener(|this, _event, window, cx| {
                                this.open_bulk_dialog(BulkDialog::ConfirmDelete, window, cx);
                            }),
                        ),
                    )
            })
    }

    fn render_bulk_dialog(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let dialog = self.bulk_dialog.unwrap_or(BulkDialog::ConfirmDelete);

        let (title, message) = match dialog {
            BulkDialog::ConfirmDelete => (
                "Delete selected resources",
                format!(
                    "This will permanently delete {} selected resource(s).",
                    self.selected_count()
                ),
            ),
            BulkDialog::Scale => (
                "Scale selected resources",
                format!(
                    "Set replica count for {} selected resource(s).",
                    self.selected_count()
                ),
            ),
            BulkDialog::Label => (
                "Label selected resources",
                format!(
                    "Apply label to {} selected resource(s).",
                    self.selected_count()
                ),
            ),
        };

        let mut content = div()
            .w(px(460.0))
            .max_w(px(560.0))
            .bg(colors.surface)
            .border_1()
            .border_color(colors.border)
            .rounded(theme.border_radius_lg)
            .overflow_hidden()
            .flex()
            .flex_col()
            .child(
                div()
                    .px(px(18.0))
                    .py(px(14.0))
                    .border_b_1()
                    .border_color(colors.border)
                    .child(
                        div()
                            .text_size(px(14.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(colors.text)
                            .child(title),
                    ),
            )
            .child(
                div()
                    .px(px(18.0))
                    .pt(px(12.0))
                    .pb(px(8.0))
                    .text_size(px(12.0))
                    .text_color(colors.text_secondary)
                    .child(message),
            );

        if dialog == BulkDialog::Scale {
            let mut input_box = div()
                .w_full()
                .px(px(10.0))
                .py(px(6.0))
                .rounded(theme.border_radius_md)
                .bg(colors.surface_elevated)
                .border_1()
                .border_color(colors.border);
            if let Some(input) = self.scale_input.as_ref() {
                input_box = input_box.child(
                    Input::new(input)
                        .appearance(false)
                        .with_size(ui::Size::Small),
                );
            }
            content = content.child(div().px(px(18.0)).pb(px(10.0)).child(input_box));
        }

        if dialog == BulkDialog::Label {
            let mut key_box = div()
                .w_full()
                .px(px(10.0))
                .py(px(6.0))
                .rounded(theme.border_radius_md)
                .bg(colors.surface_elevated)
                .border_1()
                .border_color(colors.border);
            if let Some(input) = self.label_key_input.as_ref() {
                key_box = key_box.child(
                    Input::new(input)
                        .appearance(false)
                        .with_size(ui::Size::Small),
                );
            }

            let mut value_box = div()
                .w_full()
                .px(px(10.0))
                .py(px(6.0))
                .rounded(theme.border_radius_md)
                .bg(colors.surface_elevated)
                .border_1()
                .border_color(colors.border);
            if let Some(input) = self.label_value_input.as_ref() {
                value_box = value_box.child(
                    Input::new(input)
                        .appearance(false)
                        .with_size(ui::Size::Small),
                );
            }

            content = content
                .child(div().px(px(18.0)).pb(px(10.0)).child(key_box))
                .child(div().px(px(18.0)).pb(px(10.0)).child(value_box));
        }

        if let Some(error) = &self.bulk_error {
            content = content.child(
                div()
                    .px(px(18.0))
                    .pb(px(6.0))
                    .text_size(px(11.0))
                    .text_color(colors.error)
                    .child(error.clone()),
            );
        }

        let confirm_label = match dialog {
            BulkDialog::ConfirmDelete => "Delete",
            BulkDialog::Scale => "Apply scale",
            BulkDialog::Label => "Apply label",
        };

        content = content.child(
            div()
                .px(px(18.0))
                .py(px(14.0))
                .border_t_1()
                .border_color(colors.border)
                .flex()
                .justify_end()
                .gap(px(8.0))
                .child(
                    secondary_btn("bulk-dialog-cancel", IconName::Close, "Cancel", colors)
                        .on_click(cx.listener(|this, _event, _window, cx| {
                            this.close_bulk_dialog(cx);
                        })),
                )
                .child(
                    if dialog == BulkDialog::ConfirmDelete {
                        danger_btn(
                            "bulk-dialog-confirm",
                            IconName::Trash,
                            confirm_label,
                            colors,
                        )
                    } else {
                        secondary_btn(
                            "bulk-dialog-confirm",
                            IconName::Check,
                            confirm_label,
                            colors,
                        )
                    }
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.confirm_bulk_dialog(cx);
                    })),
                ),
        );

        div()
            .absolute()
            .top(px(0.0))
            .left(px(0.0))
            .right(px(0.0))
            .bottom(px(0.0))
            .bg(colors.background.opacity(0.7))
            .flex()
            .items_center()
            .justify_center()
            .child(content)
    }

    fn render_header(
        &self,
        cx: &Context<'_, Self>,
        columns: &[ColumnDef],
        sort_state: &SortState,
        visible_indices: Vec<usize>,
        all_visible_selected: bool,
        some_visible_selected: bool,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        div()
            .w_full()
            .px(px(20.0))
            .py(px(14.0))
            .flex()
            .items_center()
            .gap(px(0.0))
            .bg(colors.surface_elevated)
            .rounded_t(theme.border_radius_lg)
            .border_b_1()
            .border_color(colors.border)
            .children(columns.iter().enumerate().flat_map(|(i, col)| {
                let col_name = col.name;
                let width = self.get_column_width(col_name, col.default_width);
                let is_sorted = sort_state.column.as_deref() == Some(col_name);
                let sort_direction = sort_state.direction;
                let is_sortable = col.sortable;
                let is_last = i == columns.len() - 1;
                let column_type = col.column_type;
                let align = col.align;
                let header_visible_indices = visible_indices.clone();

                let mut elements: Vec<AnyElement> = Vec::new();

                // Create the header cell
                let cell = self.render_header_cell(
                    cx,
                    col_name,
                    width,
                    is_sorted,
                    sort_direction,
                    is_sortable,
                    column_type,
                    align,
                    all_visible_selected,
                    some_visible_selected,
                    header_visible_indices,
                    colors,
                );
                elements.push(cell.into_any_element());

                // Add resize handle between columns (except after last column and not for checkbox/actions)
                if !is_last
                    && column_type != ColumnType::Checkbox
                    && column_type != ColumnType::Actions
                {
                    let resizer = self.render_resize_handle(cx, col_name, width, colors);
                    elements.push(resizer.into_any_element());
                }

                elements
            }))
    }

    fn render_header_cell(
        &self,
        cx: &Context<'_, Self>,
        col_name: &'static str,
        width: f32,
        is_sorted: bool,
        sort_direction: SortDirection,
        is_sortable: bool,
        column_type: ColumnType,
        align: Align,
        all_visible_selected: bool,
        some_visible_selected: bool,
        visible_indices: Vec<usize>,
        colors: &ThemeColors,
    ) -> impl IntoElement {
        // Create the header cell content
        let cell_content: Div = match column_type {
            ColumnType::Checkbox => {
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(render_checkbox_visual(
                        all_visible_selected,
                        some_visible_selected,
                        colors,
                    ))
            }
            ColumnType::Actions => div(),
            _ => {
                let mut content = div().flex().items_center().gap(px(4.0));

                content = match align {
                    Align::Left => content,
                    Align::Center => content.justify_center(),
                    Align::Right => content.flex_row_reverse(),
                };

                content = content.child(div().child(col_name.to_uppercase()));

                // Add sort indicator if sorted
                if is_sorted {
                    let icon = match sort_direction {
                        SortDirection::Ascending => IconName::ChevronUp,
                        SortDirection::Descending => IconName::ChevronDown,
                    };
                    content = content.child(Icon::new(icon).size(px(12.0)).color(colors.text));
                } else if is_sortable {
                    content = content.child(
                        Icon::new(IconName::ChevronsUpDown)
                            .size(px(12.0))
                            .color(colors.text_muted),
                    );
                }

                content
            }
        };

        // Create the cell wrapper
        let theme = theme(cx);
        let mut cell = if width > 0.0 {
            div().w(px(width))
        } else {
            div().flex_1()
        }
        .id(ElementId::Name(format!("header-{}", col_name).into()))
        .h_full()
            .flex()
            .items_center()
            .font_family(theme.font_family_ui.clone())
            .text_size(px(11.0))
            .text_color(colors.text_muted)
            .font_weight(FontWeight::SEMIBOLD)
            .child(cell_content);
        if column_type == ColumnType::Checkbox || column_type == ColumnType::Actions {
            cell = cell.justify_center();
        }
        if col_name == "Name" {
            cell = cell.pl(px(2.0));
        }

        if column_type == ColumnType::Checkbox {
            let indices = visible_indices;
            cell.cursor_pointer().on_click(cx.listener(
                move |this, _event: &ClickEvent, _window, cx| {
                    this.set_all_selected(&indices, !all_visible_selected, cx);
                },
            ))
        } else if is_sortable {
            cell.cursor_pointer()
                .hover(|style| style.text_color(colors.text))
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    this.toggle_sort(col_name, cx);
                }))
        } else {
            cell
        }
    }

    fn render_resize_handle(
        &self,
        cx: &Context<'_, Self>,
        col_name: &'static str,
        current_width: f32,
        colors: &ThemeColors,
    ) -> impl IntoElement {
        let resize_col_name = col_name.to_string();
        let resize_col_name_click = col_name.to_string();
        let border_color = colors.border;
        let primary_color = colors.primary;

        div()
            .id(ElementId::Name(format!("resizer-{}", col_name).into()))
            .w(px(8.0))
            .h_full()
            .flex()
            .items_center()
            .justify_center()
            .cursor(CursorStyle::ResizeColumn)
            .child(div().w(px(1.0)).h(px(20.0)).bg(border_color.opacity(0.5)))
            .hover(|style| style.bg(primary_color.opacity(0.1)))
            .on_click(cx.listener(move |this, event: &ClickEvent, _window, cx| {
                // Double-click to auto-fit column width
                if event.click_count() == 2 {
                    this.auto_fit_column(&resize_col_name_click, cx);
                }
            }))
            .on_drag(
                DragValue {
                    column: resize_col_name.clone(),
                    start_width: current_width,
                },
                |_drag, _position, _window, cx| cx.new(|_| EmptyView),
            )
            .on_drag_move(cx.listener(
                move |this, event: &DragMoveEvent<DragValue>, _window, cx| {
                    let drag_value = event.drag(cx);
                    if this.resizing_column.is_none() {
                        let x: f32 = event.event.position.x.into();
                        this.start_resize(&drag_value.column, x, drag_value.start_width);
                    }
                    let x: f32 = event.event.position.x.into();
                    this.update_resize(x, cx);
                },
            ))
    }

    fn render_row(
        &self,
        cx: &Context<'_, Self>,
        columns: &[ColumnDef],
        index: usize,
        resource: &Resource,
        selected: bool,
        resource_type: ResourceType,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let bg = if selected {
            colors.selection
        } else {
            gpui::transparent_black()
        };

        let hover_bg = colors.selection_hover;

        // Get cell values based on resource type
        let row_group = format!("resource-row-{}", index);
        let cells = self.get_row_cells(
            cx,
            columns,
            index,
            selected,
            row_group.clone(),
            resource,
            resource_type,
        );

        // Build row with cells and spacers to match header (for resize handles)
        let mut row_children: Vec<AnyElement> = Vec::new();
        for (i, cell) in cells.into_iter().enumerate() {
            row_children.push(cell);
            // Add spacer to match resize handle width
            if i < columns.len() - 1 {
                let col = &columns[i];
                if col.column_type != ColumnType::Checkbox && col.column_type != ColumnType::Actions
                {
                    row_children.push(div().w(px(8.0)).into_any_element());
                }
            }
        }

        div()
            .id(ElementId::NamedInteger("row".into(), index as u64))
            .group(row_group)
            .w_full()
            .h(px(ROW_HEIGHT))
            .px(px(20.0))
            .flex()
            .items_center()
            .gap(px(0.0))
            .bg(bg)
            .border_b_1()
            .border_color(colors.border)
            .cursor_pointer()
            .hover(|style| style.bg(hover_bg))
            .on_click(cx.listener(move |this, event: &ClickEvent, _window, cx| {
                if this.suppress_row_open_once {
                    this.suppress_row_open_once = false;
                    return;
                }
                if event.click_count() >= 1 {
                    this.select_row(index, cx);
                    this.open_row(index, cx);
                }
            }))
            .children(row_children)
    }

    fn get_row_cells(
        &self,
        cx: &Context<'_, Self>,
        columns: &[ColumnDef],
        row_index: usize,
        row_selected: bool,
        row_group: String,
        resource: &Resource,
        resource_type: ResourceType,
    ) -> Vec<AnyElement> {
        let theme = theme(cx);
        let colors = &theme.colors;
        let checked = self.selected_indices.contains(&row_index);

        columns
            .iter()
            .enumerate()
            .map(|(_i, col)| {
                let width = self.get_column_width(col.name, col.default_width);
                if col.column_type == ColumnType::Checkbox {
                    return div()
                        .id(ElementId::Name(
                            format!("row-checkbox-{}", row_index).into(),
                        ))
                        .w(px(width))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(render_row_checkbox_visual(
                            checked,
                            row_selected,
                            &row_group,
                            colors,
                        ))
                        .cursor_pointer()
                        .on_click(cx.listener(move |this, _event: &ClickEvent, _window, cx| {
                            this.suppress_row_open_once = true;
                            this.toggle_row_checkbox(row_index, cx);
                        }))
                        .into_any_element();
                }

                let mut cell = if width > 0.0 {
                    div().w(px(width))
                } else {
                    div().flex_1()
                }
                .text_size(px(13.0))
                .text_color(colors.text)
                .overflow_hidden()
                .text_ellipsis();

                cell = match col.align {
                    Align::Left => cell,
                    Align::Center => cell.flex().justify_center(),
                    Align::Right => cell.flex().justify_end(),
                };
                if col.name == "Name" {
                    cell = cell.pl(px(2.0));
                }

                if col.name == "Actions" {
                    return self
                        .render_actions_cell(cell, colors, resource, cx)
                        .into_any_element();
                }

                // Get value based on column and resource type
                match resource_type {
                    ResourceType::Pods => self.get_pod_cell_value(cx, cell, col.name, resource, colors),
                    ResourceType::Deployments => {
                        self.get_deployment_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::ReplicaSets => {
                        self.get_replicaset_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::StatefulSets => {
                        self.get_statefulset_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::DaemonSets => {
                        self.get_daemonset_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::Jobs => self.get_job_cell_value(cell, col.name, resource, colors),
                    ResourceType::CronJobs => {
                        self.get_cronjob_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::Services => {
                        self.get_service_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::Ingresses => {
                        self.get_ingress_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::ConfigMaps => {
                        self.get_configmap_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::Secrets => {
                        self.get_secret_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::Nodes => {
                        self.get_node_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::Namespaces => {
                        self.get_namespace_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::HorizontalPodAutoscalers => {
                        self.get_hpa_cell_value(cell, col.name, resource, colors)
                    }
                    ResourceType::VerticalPodAutoscalers => {
                        self.get_vpa_cell_value(cell, col.name, resource, colors)
                    }
                }
                .into_any_element()
            })
            .collect()
    }

    fn get_pod_cell_value(
        &self,
        cx: &Context<'_, Self>,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => cell.flex().items_center().child(
                div()
                    .text_ellipsis()
                    .overflow_hidden()
                    .text_color(colors.text)
                    .child(resource.metadata.name.clone()),
            ),
            "Containers" => {
                let images = get_pod_container_images(resource);
                let theme = theme(cx);
                cell.flex().items_center().gap(px(4.0)).children(
                    images.into_iter().enumerate().map(|(i, image)| {
                        let tooltip_image = image.clone();
                        div()
                            .id(ElementId::Name(
                                format!(
                                    "ctr-{}-{}",
                                    resource.metadata.name, i
                                )
                                .into(),
                            ))
                            .child(
                                ui::container_icon::container_icon_small(
                                    &image,
                                    &theme,
                                ),
                            )
                            .tooltip(move |_, cx| {
                                let img = tooltip_image.clone();
                                cx.new(|_| ui::gpui_component::tooltip::Tooltip::new(img))
                                    .into()
                            })
                    }),
                )
            }
            "Namespace" => cell.text_color(colors.text_secondary).child(
                resource
                    .metadata
                    .namespace
                    .clone()
                    .unwrap_or_else(|| "-".to_string()),
            ),
            "Status" => {
                // Pill-shaped status badge with translucent background
                let status = get_resource_status(resource);
                let status_color = status.color(colors);
                cell.flex().items_center().child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .px(px(10.0))
                        .py(px(4.0))
                        .rounded(px(100.0))
                        .bg(status_color.opacity(0.12))
                        .child(
                            // Status dot
                            div().w(px(6.0)).h(px(6.0)).rounded_full().bg(status_color),
                        )
                        .child(
                            div()
                                .text_size(px(12.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(status_color)
                                .child(status.label()),
                        ),
                )
            }
            "Restarts" => {
                let restarts = get_pod_restarts(resource);
                let text_color = if restarts >= 4 {
                    colors.error
                } else if restarts > 0 {
                    colors.text_secondary
                } else {
                    colors.text_secondary
                };
                cell.text_color(text_color).child(restarts.to_string())
            }
            "Age" => {
                let age = format_age(&resource.metadata.creation_timestamp);
                cell.text_color(colors.text_secondary).child(age)
            }
            "Node" => {
                let node = get_json_value(&resource.spec, &["nodeName"])
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "\u{2014}".to_string());
                let text_color = if node == "\u{2014}" {
                    colors.text_muted
                } else {
                    colors.text_secondary
                };
                cell.text_color(text_color).child(node)
            }
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_deployment_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => {
                let status = get_resource_status(resource);
                let icon_color = status.color(colors);
                cell.flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        Icon::new(IconName::Deployments)
                            .size(px(14.0))
                            .color(icon_color),
                    )
                    .child(
                        div()
                            .text_ellipsis()
                            .overflow_hidden()
                            .child(resource.metadata.name.clone()),
                    )
            }
            "Namespace" => cell.text_color(colors.text_secondary).child(
                resource
                    .metadata
                    .namespace
                    .clone()
                    .unwrap_or_else(|| "-".to_string()),
            ),
            "Ready" => {
                let (ready, total) = get_deployment_ready_count(resource);
                cell.child(format!("{}/{}", ready, total))
            }
            "Up-to-date" => {
                let updated = get_json_value(&resource.status, &["updatedReplicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(updated.to_string())
            }
            "Available" => {
                let available = get_json_value(&resource.status, &["availableReplicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(available.to_string())
            }
            "Age" => {
                let age = format_age(&resource.metadata.creation_timestamp);
                cell.text_color(colors.text_secondary).child(age)
            }
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_service_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => cell
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    Icon::new(IconName::Services)
                        .size(px(14.0))
                        .color(colors.success),
                )
                .child(
                    div()
                        .text_ellipsis()
                        .overflow_hidden()
                        .child(resource.metadata.name.clone()),
                ),
            "Namespace" => cell.text_color(colors.text_secondary).child(
                resource
                    .metadata
                    .namespace
                    .clone()
                    .unwrap_or_else(|| "-".to_string()),
            ),
            "Type" => {
                let svc_type = get_json_value(&resource.spec, &["type"])
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "ClusterIP".to_string());
                cell.child(svc_type)
            }
            "Cluster-IP" => {
                let cluster_ip = get_json_value(&resource.spec, &["clusterIP"])
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "-".to_string());
                cell.text_color(colors.text_secondary).child(cluster_ip)
            }
            "Ports" => {
                let ports = get_service_ports(resource);
                cell.text_color(colors.text_secondary).child(ports)
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_node_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => {
                let status = get_node_status(resource);
                let icon_color = status.color(colors);
                cell.flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(Icon::new(IconName::Nodes).size(px(14.0)).color(icon_color))
                    .child(
                        div()
                            .text_ellipsis()
                            .overflow_hidden()
                            .child(resource.metadata.name.clone()),
                    )
            }
            "Status" => {
                let status = get_node_status(resource);
                let status_color = status.color(colors);
                let label = if status == StatusType::Ready {
                    "Ready"
                } else if status == StatusType::Failed {
                    "NotReady"
                } else {
                    "Unknown"
                };
                cell.flex()
                    .items_center()
                    .child(render_status_pill(status_color, label))
            }
            "Roles" => {
                let roles = get_node_roles(resource);
                cell.text_color(colors.text_secondary).child(roles)
            }
            "Version" => {
                let version = get_json_value(&resource.status, &["nodeInfo", "kubeletVersion"])
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "-".to_string());
                cell.text_color(colors.text_secondary).child(version)
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_replicaset_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Copy, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Desired" => {
                let desired = get_json_value(&resource.spec, &["replicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(desired.to_string())
            }
            "Current" => {
                let current = get_json_value(&resource.status, &["replicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(current.to_string())
            }
            "Ready" => {
                let ready = get_json_value(&resource.status, &["readyReplicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(ready.to_string())
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_statefulset_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Layers, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Ready" => {
                let ready = get_json_value(&resource.status, &["readyReplicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total = get_json_value(&resource.spec, &["replicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.child(format!("{}/{}", ready, total))
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_daemonset_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Layers, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Desired" => {
                let desired = get_json_value(&resource.status, &["desiredNumberScheduled"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(desired.to_string())
            }
            "Current" => {
                let current = get_json_value(&resource.status, &["currentNumberScheduled"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(current.to_string())
            }
            "Ready" => {
                let ready = get_json_value(&resource.status, &["numberReady"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(ready.to_string())
            }
            "Up-to-date" => {
                let updated = get_json_value(&resource.status, &["updatedNumberScheduled"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(updated.to_string())
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_job_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Box, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Completions" => {
                let succeeded = get_json_value(&resource.status, &["succeeded"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let completions = get_json_value(&resource.spec, &["completions"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1);
                cell.child(format!("{}/{}", succeeded, completions))
            }
            "Duration" => {
                let start =
                    get_json_value(&resource.status, &["startTime"]).and_then(|v| v.as_str());
                let completion =
                    get_json_value(&resource.status, &["completionTime"]).and_then(|v| v.as_str());
                let duration = match (start, completion) {
                    (Some(s), Some(c)) => {
                        if let (Ok(start_dt), Ok(end_dt)) = (
                            chrono::DateTime::parse_from_rfc3339(s),
                            chrono::DateTime::parse_from_rfc3339(c),
                        ) {
                            let dur = end_dt.signed_duration_since(start_dt);
                            format!("{}s", dur.num_seconds())
                        } else {
                            "-".to_string()
                        }
                    }
                    _ => "-".to_string(),
                };
                cell.text_color(colors.text_secondary).child(duration)
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_cronjob_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Box, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Schedule" => {
                let schedule = get_json_value(&resource.spec, &["schedule"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                cell.text_color(colors.text_secondary)
                    .child(schedule.to_string())
            }
            "Suspend" => {
                let suspend = get_json_value(&resource.spec, &["suspend"])
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let text = if suspend { "Yes" } else { "No" };
                let color = if suspend {
                    colors.warning
                } else {
                    colors.text_muted
                };
                cell.text_color(color).child(text)
            }
            "Active" => {
                let active = get_json_value(&resource.status, &["active"])
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(active.to_string())
            }
            "Last Schedule" => {
                let last = get_json_value(&resource.status, &["lastScheduleTime"])
                    .and_then(|v| v.as_str().map(|s| s.to_string()));
                let age = format_age(&last);
                cell.text_color(colors.text_secondary).child(age)
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_ingress_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Network, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Class" => {
                let class = get_json_value(&resource.spec, &["ingressClassName"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                cell.text_color(colors.text_secondary)
                    .child(class.to_string())
            }
            "Hosts" => {
                let hosts = get_json_value(&resource.spec, &["rules"])
                    .and_then(|v| v.as_array())
                    .map(|rules| {
                        rules
                            .iter()
                            .filter_map(|r| r.get("host").and_then(|h| h.as_str()))
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_else(|| "-".to_string());
                cell.text_color(colors.text_secondary).child(hosts)
            }
            "Address" => {
                let address = get_json_value(&resource.status, &["loadBalancer", "ingress"])
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|ing| {
                        ing.get("ip")
                            .or(ing.get("hostname"))
                            .and_then(|v| v.as_str())
                    })
                    .unwrap_or("-");
                cell.text_color(colors.text_secondary)
                    .child(address.to_string())
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_configmap_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::FileText, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Data" => {
                let count = resource
                    .data
                    .as_ref()
                    .and_then(|d| d.as_object())
                    .map(|o| o.len())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(count.to_string())
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_secret_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Key, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Type" => {
                let secret_type = resource.type_.as_deref().unwrap_or("Opaque");
                cell.text_color(colors.text_secondary)
                    .child(secret_type.to_string())
            }
            "Data" => {
                let count = resource
                    .data
                    .as_ref()
                    .and_then(|d| d.as_object())
                    .map(|o| o.len())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(count.to_string())
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_namespace_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Layers, colors),
            "Status" => {
                let phase = get_json_value(&resource.status, &["phase"])
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| "Unknown".to_string());
                let status = match phase.as_str() {
                    "Active" => StatusType::Ready,
                    "Terminating" => StatusType::Pending,
                    _ => StatusType::Unknown,
                };
                let status_color = status.color(colors);
                cell.flex()
                    .items_center()
                    .child(render_status_pill(status_color, &phase))
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_hpa_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Scale, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Reference" => {
                let kind = get_json_value(&resource.spec, &["scaleTargetRef", "kind"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let name = get_json_value(&resource.spec, &["scaleTargetRef", "name"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let short_kind = match kind {
                    "Deployment" => "deploy",
                    "StatefulSet" => "sts",
                    "ReplicaSet" => "rs",
                    _ => kind,
                };
                cell.text_color(colors.text_secondary)
                    .child(format!("{}/{}", short_kind, name))
            }
            "Metrics" => {
                // Extract current metrics from status
                let metrics = get_json_value(&resource.status, &["currentMetrics"])
                    .and_then(|v| v.as_array());

                let metrics_str = if let Some(metrics_arr) = metrics {
                    metrics_arr
                        .iter()
                        .filter_map(|m| {
                            let metric_type = m.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            match metric_type {
                                "Resource" => {
                                    let name = m
                                        .get("resource")
                                        .and_then(|r| r.get("name"))
                                        .and_then(|n| n.as_str())
                                        .unwrap_or("");
                                    let current = m
                                        .get("resource")
                                        .and_then(|r| r.get("current"))
                                        .and_then(|c| c.get("averageUtilization"))
                                        .and_then(|a| a.as_u64());

                                    // Get target from spec
                                    let target = get_json_value(&resource.spec, &["metrics"])
                                        .and_then(|v| v.as_array())
                                        .and_then(|arr| {
                                            arr.iter().find(|sm| {
                                                sm.get("resource")
                                                    .and_then(|r| r.get("name"))
                                                    .and_then(|n| n.as_str())
                                                    == Some(name)
                                            })
                                        })
                                        .and_then(|sm| sm.get("resource"))
                                        .and_then(|r| r.get("target"))
                                        .and_then(|t| t.get("averageUtilization"))
                                        .and_then(|a| a.as_u64());

                                    match (current, target) {
                                        (Some(c), Some(t)) => {
                                            let label = if name == "cpu" {
                                                "CPU"
                                            } else if name == "memory" {
                                                "Mem"
                                            } else {
                                                name
                                            };
                                            Some(format!("{}:{}%/{}", label, c, t))
                                        }
                                        _ => None,
                                    }
                                }
                                _ => None,
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(" ")
                } else {
                    // Fallback: show spec metrics targets
                    let spec_metrics =
                        get_json_value(&resource.spec, &["metrics"]).and_then(|v| v.as_array());
                    if let Some(arr) = spec_metrics {
                        arr.iter()
                            .filter_map(|m| {
                                let name = m
                                    .get("resource")
                                    .and_then(|r| r.get("name"))
                                    .and_then(|n| n.as_str())?;
                                let target = m
                                    .get("resource")
                                    .and_then(|r| r.get("target"))
                                    .and_then(|t| t.get("averageUtilization"))
                                    .and_then(|a| a.as_u64())?;
                                let label = if name == "cpu" {
                                    "CPU"
                                } else if name == "memory" {
                                    "Mem"
                                } else {
                                    name
                                };
                                Some(format!("{}:-/{}%", label, target))
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    } else {
                        "-".to_string()
                    }
                };

                cell.text_color(colors.text_secondary)
                    .text_size(px(12.0))
                    .child(if metrics_str.is_empty() {
                        "-".to_string()
                    } else {
                        metrics_str
                    })
            }
            "Replicas" => {
                let current = get_json_value(&resource.status, &["currentReplicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let desired = get_json_value(&resource.status, &["desiredReplicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                let color = if current == desired {
                    colors.success
                } else if current < desired {
                    colors.warning
                } else {
                    colors.primary
                };

                cell.flex().items_center().justify_center().child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.0))
                        .child(
                            div()
                                .text_color(color)
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(current.to_string()),
                        )
                        .child(div().text_color(colors.text_muted).child("/"))
                        .child(
                            div()
                                .text_color(colors.text_secondary)
                                .child(desired.to_string()),
                        ),
                )
            }
            "Min/Max" => {
                let min = get_json_value(&resource.spec, &["minReplicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1);
                let max = get_json_value(&resource.spec, &["maxReplicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary)
                    .child(format!("{}-{}", min, max))
            }
            "Status" => {
                let (status, label) = get_hpa_status(resource);
                let status_color = status.color(colors);
                cell.flex()
                    .items_center()
                    .child(render_status_pill(status_color, label))
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_vpa_cell_value(
        &self,
        cell: Div,
        column: &str,
        resource: &Resource,
        colors: &ThemeColors,
    ) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Scale, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Target" => {
                let kind = get_json_value(&resource.spec, &["targetRef", "kind"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let name = get_json_value(&resource.spec, &["targetRef", "name"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let short_kind = match kind {
                    "Deployment" => "deploy",
                    "StatefulSet" => "sts",
                    "ReplicaSet" => "rs",
                    "DaemonSet" => "ds",
                    _ => kind,
                };
                cell.text_color(colors.text_secondary)
                    .child(format!("{}/{}", short_kind, name))
            }
            "Mode" => {
                let mode = get_json_value(&resource.spec, &["updatePolicy", "updateMode"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("Auto");
                let (color, short_mode) = match mode {
                    "Off" => (colors.text_muted, "Off"),
                    "Initial" => (colors.warning, "Init"),
                    "Recreate" => (colors.primary, "Recr"),
                    "Auto" => (colors.success, "Auto"),
                    _ => (colors.text_secondary, mode),
                };
                cell.text_color(color)
                    .font_weight(FontWeight::MEDIUM)
                    .child(short_mode.to_string())
            }
            "CPU Rec." => {
                // Get CPU recommendation from first container
                let recommendation = get_vpa_recommendation(resource, "cpu");
                let color = if recommendation.contains('-') {
                    colors.text_muted
                } else {
                    colors.text_secondary
                };
                cell.text_color(color)
                    .text_size(px(12.0))
                    .child(recommendation)
            }
            "Mem Rec." => {
                // Get Memory recommendation from first container
                let recommendation = get_vpa_recommendation(resource, "memory");
                let color = if recommendation.contains('-') {
                    colors.text_muted
                } else {
                    colors.text_secondary
                };
                cell.text_color(color)
                    .text_size(px(12.0))
                    .child(recommendation)
            }
            "Status" => {
                let (status, label) = get_vpa_status(resource);
                let status_color = status.color(colors);
                cell.flex()
                    .items_center()
                    .child(render_status_pill(status_color, label))
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn render_actions_cell(
        &self,
        cell: Div,
        colors: &ThemeColors,
        resource: &Resource,
        cx: &Context<'_, Self>,
    ) -> Div {
        let issue = get_resource_issue_status(resource);
        match issue {
            Some(status) => {
                let accent = status.color(colors);
                let resource_for_action = resource.clone();
                cell.child(
                    div()
                        .id(ElementId::Name(
                            format!("ai-action-{}", resource.metadata.uid).into(),
                        ))
                        .cursor_pointer()
                        .flex()
                        .items_center()
                        .justify_center()
                        .w(px(22.0))
                        .h(px(22.0))
                        .rounded(px(6.0))
                        .bg(accent.opacity(0.15))
                        .hover(|style| style.bg(accent.opacity(0.25)))
                        .child(Icon::new(IconName::AI).size(px(14.0)).color(accent))
                        .on_click(cx.listener(move |this, _event: &ClickEvent, _window, cx| {
                            this.trigger_ai_assist(resource_for_action.clone(), cx);
                        })),
                )
            }
            None => cell.child(
                Icon::new(IconName::MoreHorizontal)
                    .size(px(16.0))
                    .color(colors.text_muted),
            ),
        }
    }
}

// Helper render functions
fn render_actions(cell: Div, colors: &ThemeColors) -> Div {
    cell.child(
        Icon::new(IconName::MoreHorizontal)
            .size(px(16.0))
            .color(colors.text_muted),
    )
}

fn render_checkbox_visual(checked: bool, indeterminate: bool, colors: &ThemeColors) -> Div {
    let bg = if checked || indeterminate {
        colors.primary
    } else {
        gpui::transparent_black()
    };
    let border = if checked || indeterminate {
        colors.primary
    } else {
        colors.border
    };

    let mut checkbox = div()
        .w(px(16.0))
        .h(px(16.0))
        .rounded(px(3.0))
        .border_1()
        .border_color(border)
        .bg(bg)
        .flex()
        .items_center()
        .justify_center();

    if checked {
        checkbox = checkbox.child(
            Icon::new(IconName::Check)
                .size(px(12.0))
                .color(colors.background),
        );
    } else if indeterminate {
        checkbox = checkbox.child(
            Icon::new(IconName::Minus)
                .size(px(12.0))
                .color(colors.background),
        );
    }

    checkbox
}

fn render_row_checkbox_visual(
    checked: bool,
    _selected_row: bool,
    row_group: &str,
    colors: &ThemeColors,
) -> Div {
    let mut checkbox = render_checkbox_visual(checked, false, colors);
    if !checked {
        checkbox = checkbox.group_hover(row_group.to_string(), |style| {
            style
                .border_color(colors.text_secondary.opacity(0.95))
                .bg(colors.surface_elevated.opacity(0.4))
        });
    }
    checkbox
}

fn render_checkbox(cell: Div, colors: &ThemeColors) -> Div {
    cell.child(render_checkbox_visual(false, false, colors))
}

fn render_name_with_icon(
    cell: Div,
    resource: &Resource,
    icon: IconName,
    colors: &ThemeColors,
) -> Div {
    let status = get_resource_status(resource);
    let icon_color = status.color(colors);
    cell.flex()
        .items_center()
        .gap(px(8.0))
        .child(Icon::new(icon).size(px(14.0)).color(icon_color))
        .child(
            div()
                .text_ellipsis()
                .overflow_hidden()
                .child(resource.metadata.name.clone()),
        )
}

fn render_namespace(cell: Div, resource: &Resource, colors: &ThemeColors) -> Div {
    cell.text_color(colors.text_secondary).child(
        resource
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "-".to_string()),
    )
}

fn render_age(cell: Div, resource: &Resource, colors: &ThemeColors) -> Div {
    let age = format_age(&resource.metadata.creation_timestamp);
    cell.text_color(colors.text_secondary).child(age)
}

/// Render a pill-shaped status badge with translucent colored background
fn render_status_pill(status_color: Hsla, label: &str) -> Div {
    let theme = ui::Theme::default();
    div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .px(px(10.0))
        .py(px(4.0))
        .rounded(theme.border_radius_full)
        .bg(status_color.opacity(0.12))
        .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(status_color))
        .child(
            div()
                .text_size(px(12.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(status_color)
                .child(label.to_string()),
        )
}
