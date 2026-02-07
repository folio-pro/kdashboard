use gpui::*;
use k8s_client::{Resource, ResourceType};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashMap;
use ui::{theme, Tag, Icon, IconName, ThemeColors};

/// Status type for resources
#[derive(Clone, Copy, PartialEq, Eq)]
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
#[derive(Clone, Copy, PartialEq, Eq, Default)]
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

pub struct ResourceTable {
    resources: Vec<Resource>,
    resource_type: ResourceType,
    selected_index: Option<usize>,
    scroll_handle: ScrollHandle,
    on_select: Option<Box<dyn Fn(usize, &Resource, &mut Context<'_, Self>) + 'static>>,
    on_open: Option<Box<dyn Fn(&Resource, &mut Context<'_, Self>) + 'static>>,
    /// Custom column widths (column name -> width in pixels)
    column_widths: HashMap<String, f32>,
    /// Current sort state
    sort_state: SortState,
    /// Column being resized
    resizing_column: Option<String>,
    /// Starting X position for resize drag
    resize_start_x: f32,
    /// Starting width for resize drag
    resize_start_width: f32,
}

impl ResourceTable {
    pub fn new(resources: Vec<Resource>, resource_type: ResourceType) -> Self {
        Self {
            resources,
            resource_type,
            selected_index: None,
            scroll_handle: ScrollHandle::new(),
            on_select: None,
            on_open: None,
            column_widths: HashMap::new(),
            sort_state: SortState::default(),
            resizing_column: None,
            resize_start_x: 0.0,
            resize_start_width: 0.0,
        }
    }

    pub fn set_resources(&mut self, resources: Vec<Resource>) {
        self.resources = resources;
    }

    pub fn set_resource_type(&mut self, resource_type: ResourceType) {
        self.resource_type = resource_type;
        self.selected_index = None;
    }

    pub fn set_selected(&mut self, index: Option<usize>) {
        self.selected_index = index;
    }

    pub fn on_select(mut self, handler: impl Fn(usize, &Resource, &mut Context<'_, Self>) + 'static) -> Self {
        self.on_select = Some(Box::new(handler));
        self
    }

    pub fn set_on_open(&mut self, handler: impl Fn(&Resource, &mut Context<'_, Self>) + 'static) {
        self.on_open = Some(Box::new(handler));
    }

    fn open_row(&mut self, index: usize, cx: &mut Context<'_, Self>) {
        if let Some(resource) = self.resources.get(index).cloned() {
            if let Some(on_open) = &self.on_open {
                on_open(&resource, cx);
            }
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

    /// End resizing
    fn end_resize(&mut self) {
        self.resizing_column = None;
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
        let content_width = self.resources.iter()
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
            "Namespace" => {
                resource.metadata.namespace.as_ref()
                    .map(|s| s.len() as f32 * char_width)
                    .unwrap_or(char_width)
            }
            "Status" => {
                let status = get_resource_status(resource);
                (status.label().len() as f32 * char_width) + 36.0 // pill padding + dot + gap
            }
            "Restarts" => {
                let restarts = get_pod_restarts(resource);
                (restarts.to_string().len() as f32 * char_width).max(30.0)
            }
            "Age" => 50.0, // ages are short like "5d", "12h"
            "Type" => {
                get_json_value(&resource.spec, &["type"])
                    .and_then(|v| v.as_str())
                    .map(|s| s.len() as f32 * char_width)
                    .unwrap_or(60.0)
            }
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
            "Version" => {
                get_json_value(&resource.status, &["nodeInfo", "kubeletVersion"])
                    .and_then(|v| v.as_str())
                    .map(|s| s.len() as f32 * char_width)
                    .unwrap_or(80.0)
            }
            "Node" => {
                get_json_value(&resource.spec, &["nodeName"])
                    .and_then(|v| v.as_str())
                    .map(|s| s.len() as f32 * char_width)
                    .unwrap_or(60.0)
            }
            _ => 80.0,
        };

        text
    }

    /// Sort resources based on current sort state
    fn get_sorted_resources(&self) -> Vec<(usize, Resource)> {
        let mut indexed: Vec<(usize, Resource)> = self.resources
            .iter()
            .enumerate()
            .map(|(i, r)| (i, r.clone()))
            .collect();

        if let Some(ref col) = self.sort_state.column {
            let direction = self.sort_state.direction;
            let resource_type = self.resource_type;

            indexed.sort_by(|(_, a), (_, b)| {
                let cmp = compare_resources_by_column(a, b, col, resource_type);
                match direction {
                    SortDirection::Ascending => cmp,
                    SortDirection::Descending => cmp.reverse(),
                }
            });
        }

        indexed
    }

    fn get_columns(&self) -> Vec<ColumnDef> {
        match self.resource_type {
            ResourceType::Pods => vec![
                ColumnDef::new("Name", 280.0).with_icon(),
                ColumnDef::new("Namespace", 120.0),
                ColumnDef::new("Status", 120.0).status_dot(),
                ColumnDef::new("Restarts", 100.0),
                ColumnDef::new("Age", 80.0),
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
                ColumnDef::new("Actions", 40.0).center().actions(),
            ],
            ResourceType::ReplicaSets => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 280.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Desired", 70.0).right(),
                ColumnDef::new("Current", 70.0).right(),
                ColumnDef::new("Ready", 70.0).right(),
                ColumnDef::new("Age", 70.0).right(),
                ColumnDef::new("Actions", 40.0).center().actions(),
            ],
            ResourceType::StatefulSets => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 240.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Ready", 80.0).center(),
                ColumnDef::new("Age", 70.0).right(),
                ColumnDef::new("Actions", 40.0).center().actions(),
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
                ColumnDef::new("Actions", 40.0).center().actions(),
            ],
            ResourceType::Jobs => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 280.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Completions", 100.0).center(),
                ColumnDef::new("Duration", 80.0).right(),
                ColumnDef::new("Age", 70.0).right(),
                ColumnDef::new("Actions", 40.0).center().actions(),
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
                ColumnDef::new("Actions", 40.0).center().actions(),
            ],
            ResourceType::Services => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 200.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Type", 100.0),
                ColumnDef::new("Cluster-IP", 120.0),
                ColumnDef::new("Ports", 140.0),
                ColumnDef::new("Age", 70.0).right(),
                ColumnDef::new("Actions", 40.0).center().actions(),
            ],
            ResourceType::Ingresses => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 200.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Class", 100.0),
                ColumnDef::new("Hosts", 200.0),
                ColumnDef::new("Address", 120.0),
                ColumnDef::new("Age", 70.0).right(),
                ColumnDef::new("Actions", 40.0).center().actions(),
            ],
            ResourceType::ConfigMaps => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 280.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Data", 60.0).right(),
                ColumnDef::new("Age", 70.0).right(),
                ColumnDef::new("Actions", 40.0).center().actions(),
            ],
            ResourceType::Secrets => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 280.0).with_icon(),
                ColumnDef::new("Namespace", 100.0),
                ColumnDef::new("Type", 180.0),
                ColumnDef::new("Data", 60.0).right(),
                ColumnDef::new("Age", 70.0).right(),
                ColumnDef::new("Actions", 40.0).center().actions(),
            ],
            ResourceType::Nodes => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 200.0).with_icon(),
                ColumnDef::new("Status", 100.0).status_dot(),
                ColumnDef::new("Roles", 120.0),
                ColumnDef::new("Version", 120.0),
                ColumnDef::new("Age", 70.0).right(),
                ColumnDef::new("Actions", 40.0).center().actions(),
            ],
            ResourceType::Namespaces => vec![
                ColumnDef::new("Checkbox", 32.0).checkbox(),
                ColumnDef::new("Name", 280.0).with_icon(),
                ColumnDef::new("Status", 100.0).status_dot(),
                ColumnDef::new("Age", 70.0).right(),
                ColumnDef::new("Actions", 40.0).center().actions(),
            ],
        }
    }

    fn select_row(&mut self, index: usize, cx: &mut Context<'_, Self>) {
        self.selected_index = Some(index);
        if let Some(on_select) = &self.on_select {
            if let Some(resource) = self.resources.get(index) {
                let resource = resource.clone();
                on_select(index, &resource, cx);
            }
        }
        cx.notify();
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

/// Empty view for drag preview
struct EmptyView {}

impl Render for EmptyView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<'_, Self>) -> impl IntoElement {
        div().size(px(0.0))
    }
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

    fn not_sortable(mut self) -> Self {
        self.sortable = false;
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
        let theme = theme(cx);
        let colors = &theme.colors;
        let columns = self.get_columns();
        let selected_index = self.selected_index;
        let resource_type = self.resource_type;
        let sort_state = self.sort_state.clone();

        // Get sorted resources with original indices
        let sorted_resources = self.get_sorted_resources();
        let resources: Vec<_> = sorted_resources.iter().map(|(original_idx, r)| {
            (*original_idx, r.clone(), selected_index == Some(*original_idx))
        }).collect();

        let is_empty = resources.is_empty();

        let mut container = div()
            .size_full()
            .flex()
            .flex_col()
            .bg(colors.surface)
            .rounded(px(12.0))
            .border_1()
            .border_color(colors.border)
            .overflow_hidden();

        // Header row (fixed, not scrollable)
        container = container.child(self.render_header(cx, &columns, &sort_state));

        // Table body - scrollable
        if is_empty {
            container = container.child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .py(px(40.0))
                    .child(
                        div()
                            .text_size(theme.font_size)
                            .text_color(colors.text_muted)
                            .font_weight(FontWeight::MEDIUM)
                            .child("No resources found")
                    )
                    .child(
                        div()
                            .text_size(theme.font_size_small)
                            .text_color(colors.text_muted)
                            .child("Connect to a cluster to view resources")
                    )
            );
        } else {
            // Scrollable body container
            let rows: Vec<_> = resources.into_iter().map(|(idx, resource, selected)| {
                self.render_row(cx, &columns, idx, resource, selected, resource_type)
            }).collect();

            container = container.child(
                div()
                    .id("table-body")
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll_handle)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .children(rows)
                    )
            );
        }

        container
    }
}

impl ResourceTable {
    fn render_header(&self, cx: &Context<'_, Self>, columns: &[ColumnDef], sort_state: &SortState) -> impl IntoElement {
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

                let mut elements: Vec<AnyElement> = Vec::new();

                // Create the header cell
                let cell = self.render_header_cell(
                    cx, col_name, width, is_sorted, sort_direction, is_sortable, column_type, align, colors
                );
                elements.push(cell.into_any_element());

                // Add resize handle between columns (except after last column and not for checkbox/actions)
                if !is_last && column_type != ColumnType::Checkbox && column_type != ColumnType::Actions {
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
        colors: &ThemeColors,
    ) -> impl IntoElement {
        // Create the header cell content
        let cell_content: Div = match column_type {
            ColumnType::Checkbox => {
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .w(px(16.0))
                            .h(px(16.0))
                            .rounded(px(3.0))
                            .border_1()
                            .border_color(colors.border)
                    )
            }
            ColumnType::Actions => {
                div()
            }
            _ => {
                let mut content = div()
                    .flex()
                    .items_center()
                    .gap(px(4.0));

                content = match align {
                    Align::Left => content,
                    Align::Center => content.justify_center(),
                    Align::Right => content.flex_row_reverse(),
                };

                content = content.child(
                    div()
                        .child(col_name.to_uppercase())
                );

                // Add sort indicator if sorted
                if is_sorted {
                    let icon = match sort_direction {
                        SortDirection::Ascending => IconName::ChevronUp,
                        SortDirection::Descending => IconName::ChevronDown,
                    };
                    content = content.child(
                        Icon::new(icon)
                            .size(px(12.0))
                            .color(colors.text)
                    );
                } else if is_sortable {
                    content = content.child(
                        Icon::new(IconName::ChevronsUpDown)
                            .size(px(12.0))
                            .color(colors.text_muted.opacity(0.5))
                    );
                }

                content
            }
        };

        // Create the cell wrapper
        let theme = theme(cx);
        let cell = div()
            .id(ElementId::Name(format!("header-{}", col_name).into()))
            .w(px(width))
            .h_full()
            .flex()
            .items_center()
            .font_family(theme.font_family_ui.clone())
            .text_size(px(11.0))
            .text_color(colors.text_muted)
            .font_weight(FontWeight::SEMIBOLD)
            .child(cell_content);

        if is_sortable {
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
            .child(
                div()
                    .w(px(1.0))
                    .h(px(20.0))
                    .bg(border_color.opacity(0.5))
            )
            .hover(|style| style.bg(primary_color.opacity(0.1)))
            .on_click(cx.listener(move |this, event: &ClickEvent, _window, cx| {
                // Double-click to auto-fit column width
                if event.click_count() == 2 {
                    this.auto_fit_column(&resize_col_name_click, cx);
                }
            }))
            .on_drag(
                DragValue { column: resize_col_name.clone(), start_width: current_width },
                |_drag, _position, _window, cx| cx.new(|_| EmptyView)
            )
            .on_drag_move(cx.listener(move |this, event: &DragMoveEvent<DragValue>, _window, cx| {
                let drag_value = event.drag(cx);
                if this.resizing_column.is_none() {
                    let x: f32 = event.event.position.x.into();
                    this.start_resize(&drag_value.column, x, drag_value.start_width);
                }
                let x: f32 = event.event.position.x.into();
                this.update_resize(x, cx);
            }))
    }

    fn render_row(
        &self,
        cx: &Context<'_, Self>,
        columns: &[ColumnDef],
        index: usize,
        resource: Resource,
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
        let cells = self.get_row_cells(cx, columns, &resource, resource_type);

        // Build row with cells and spacers to match header (for resize handles)
        let mut row_children: Vec<Div> = Vec::new();
        for (i, cell) in cells.into_iter().enumerate() {
            row_children.push(cell);
            // Add spacer to match resize handle width
            if i < columns.len() - 1 {
                let col = &columns[i];
                if col.column_type != ColumnType::Checkbox && col.column_type != ColumnType::Actions {
                    row_children.push(div().w(px(8.0)));
                }
            }
        }

        div()
            .id(ElementId::NamedInteger("row".into(), index as u64))
            .w_full()
            .px(px(20.0))
            .py(px(14.0))
            .flex()
            .items_center()
            .gap(px(0.0))
            .bg(bg)
            .border_b_1()
            .border_color(colors.border)
            .cursor_pointer()
            .hover(|style| style.bg(hover_bg))
            .on_click(cx.listener(move |this, event: &ClickEvent, _window, cx| {
                // Single click = select, Double click = open details
                if event.click_count() == 2 {
                    this.open_row(index, cx);
                } else {
                    this.select_row(index, cx);
                }
            }))
            .children(row_children)
    }

    fn get_row_cells(
        &self,
        cx: &Context<'_, Self>,
        columns: &[ColumnDef],
        resource: &Resource,
        resource_type: ResourceType,
    ) -> Vec<Div> {
        let theme = theme(cx);
        let colors = &theme.colors;

        columns.iter().enumerate().map(|(_i, col)| {
            let width = self.get_column_width(col.name, col.default_width);
            let mut cell = div()
                .w(px(width))
                .text_size(px(13.0))
                .text_color(colors.text)
                .overflow_hidden()
                .text_ellipsis();

            cell = match col.align {
                Align::Left => cell,
                Align::Center => cell.flex().justify_center(),
                Align::Right => cell.flex().justify_end(),
            };

            // Get value based on column and resource type
            match resource_type {
                ResourceType::Pods => self.get_pod_cell_value(cell, col.name, resource, colors),
                ResourceType::Deployments => self.get_deployment_cell_value(cell, col.name, resource, colors),
                ResourceType::ReplicaSets => self.get_replicaset_cell_value(cell, col.name, resource, colors),
                ResourceType::StatefulSets => self.get_statefulset_cell_value(cell, col.name, resource, colors),
                ResourceType::DaemonSets => self.get_daemonset_cell_value(cell, col.name, resource, colors),
                ResourceType::Jobs => self.get_job_cell_value(cell, col.name, resource, colors),
                ResourceType::CronJobs => self.get_cronjob_cell_value(cell, col.name, resource, colors),
                ResourceType::Services => self.get_service_cell_value(cell, col.name, resource, colors),
                ResourceType::Ingresses => self.get_ingress_cell_value(cell, col.name, resource, colors),
                ResourceType::ConfigMaps => self.get_configmap_cell_value(cell, col.name, resource, colors),
                ResourceType::Secrets => self.get_secret_cell_value(cell, col.name, resource, colors),
                ResourceType::Nodes => self.get_node_cell_value(cell, col.name, resource, colors),
                ResourceType::Namespaces => self.get_namespace_cell_value(cell, col.name, resource, colors),
            }
        }).collect()
    }

    fn get_pod_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
        match column {
            "Name" => {
                cell.flex()
                    .items_center()
                    .child(
                        div()
                            .text_ellipsis()
                            .overflow_hidden()
                            .text_color(colors.text)
                            .child(resource.metadata.name.clone())
                    )
            }
            "Namespace" => {
                cell.text_color(colors.text_secondary)
                    .child(resource.metadata.namespace.clone().unwrap_or_else(|| "-".to_string()))
            }
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
                        .bg(status_color.opacity(0.125))
                        .child(
                            // Status dot
                            div()
                                .w(px(6.0))
                                .h(px(6.0))
                                .rounded_full()
                                .bg(status_color)
                        )
                        .child(
                            div()
                                .text_size(px(12.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(status_color)
                                .child(status.label())
                        )
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
                cell.text_color(text_color)
                    .child(restarts.to_string())
            }
            "Age" => {
                let age = format_age(&resource.metadata.creation_timestamp);
                cell.text_color(colors.text_secondary)
                    .child(age)
            }
            "Node" => {
                let node = get_json_value(&resource.spec, &["nodeName"])
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "\u{2014}".to_string());
                let text_color = if node == "\u{2014}" { colors.text_muted } else { colors.text_secondary };
                cell.text_color(text_color)
                    .child(node)
            }
            _ => cell.child("-"),
        }
    }

    fn get_deployment_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
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
                            .color(icon_color)
                    )
                    .child(
                        div()
                            .text_ellipsis()
                            .overflow_hidden()
                            .child(resource.metadata.name.clone())
                    )
            }
            "Namespace" => {
                cell.text_color(colors.text_secondary)
                    .child(resource.metadata.namespace.clone().unwrap_or_else(|| "-".to_string()))
            }
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
                cell.text_color(colors.text_secondary)
                    .child(age)
            }
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_service_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => {
                cell.flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        Icon::new(IconName::Services)
                            .size(px(14.0))
                            .color(colors.success)
                    )
                    .child(
                        div()
                            .text_ellipsis()
                            .overflow_hidden()
                            .child(resource.metadata.name.clone())
                    )
            }
            "Namespace" => {
                cell.text_color(colors.text_secondary)
                    .child(resource.metadata.namespace.clone().unwrap_or_else(|| "-".to_string()))
            }
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
                cell.text_color(colors.text_secondary)
                    .child(cluster_ip)
            }
            "Ports" => {
                let ports = get_service_ports(resource);
                cell.text_color(colors.text_secondary)
                    .child(ports)
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_node_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => {
                let status = get_node_status(resource);
                let icon_color = status.color(colors);
                cell.flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        Icon::new(IconName::Nodes)
                            .size(px(14.0))
                            .color(icon_color)
                    )
                    .child(
                        div()
                            .text_ellipsis()
                            .overflow_hidden()
                            .child(resource.metadata.name.clone())
                    )
            }
            "Status" => {
                let status = get_node_status(resource);
                let status_color = status.color(colors);
                let label = if status == StatusType::Ready { "Ready" } else if status == StatusType::Failed { "NotReady" } else { "Unknown" };
                cell.flex().items_center().child(render_status_pill(status_color, label))
            }
            "Roles" => {
                let roles = get_node_roles(resource);
                cell.text_color(colors.text_secondary)
                    .child(roles)
            }
            "Version" => {
                let version = get_json_value(&resource.status, &["nodeInfo", "kubeletVersion"])
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "-".to_string());
                cell.text_color(colors.text_secondary)
                    .child(version)
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_generic_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Box, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Status" => {
                let status = get_resource_status(resource);
                let status_color = status.color(colors);
                cell.flex().items_center().child(render_status_pill(status_color, status.label()))
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_replicaset_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Copy, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Desired" => {
                let desired = get_json_value(&resource.spec, &["replicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary).child(desired.to_string())
            }
            "Current" => {
                let current = get_json_value(&resource.status, &["replicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary).child(current.to_string())
            }
            "Ready" => {
                let ready = get_json_value(&resource.status, &["readyReplicas"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary).child(ready.to_string())
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_statefulset_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
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

    fn get_daemonset_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Layers, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Desired" => {
                let desired = get_json_value(&resource.status, &["desiredNumberScheduled"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary).child(desired.to_string())
            }
            "Current" => {
                let current = get_json_value(&resource.status, &["currentNumberScheduled"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary).child(current.to_string())
            }
            "Ready" => {
                let ready = get_json_value(&resource.status, &["numberReady"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary).child(ready.to_string())
            }
            "Up-to-date" => {
                let updated = get_json_value(&resource.status, &["updatedNumberScheduled"])
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary).child(updated.to_string())
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_job_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
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
                let start = get_json_value(&resource.status, &["startTime"])
                    .and_then(|v| v.as_str());
                let completion = get_json_value(&resource.status, &["completionTime"])
                    .and_then(|v| v.as_str());
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

    fn get_cronjob_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Box, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Schedule" => {
                let schedule = get_json_value(&resource.spec, &["schedule"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                cell.text_color(colors.text_secondary).child(schedule.to_string())
            }
            "Suspend" => {
                let suspend = get_json_value(&resource.spec, &["suspend"])
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let text = if suspend { "Yes" } else { "No" };
                let color = if suspend { colors.warning } else { colors.text_muted };
                cell.text_color(color).child(text)
            }
            "Active" => {
                let active = get_json_value(&resource.status, &["active"])
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary).child(active.to_string())
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

    fn get_ingress_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Network, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Class" => {
                let class = get_json_value(&resource.spec, &["ingressClassName"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                cell.text_color(colors.text_secondary).child(class.to_string())
            }
            "Hosts" => {
                let hosts = get_json_value(&resource.spec, &["rules"])
                    .and_then(|v| v.as_array())
                    .map(|rules| {
                        rules.iter()
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
                        ing.get("ip").or(ing.get("hostname")).and_then(|v| v.as_str())
                    })
                    .unwrap_or("-");
                cell.text_color(colors.text_secondary).child(address.to_string())
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_configmap_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::FileText, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Data" => {
                let count = resource.data
                    .as_ref()
                    .and_then(|d| d.as_object())
                    .map(|o| o.len())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary).child(count.to_string())
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_secret_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
        match column {
            "Checkbox" => render_checkbox(cell, colors),
            "Name" => render_name_with_icon(cell, resource, IconName::Key, colors),
            "Namespace" => render_namespace(cell, resource, colors),
            "Type" => {
                let secret_type = resource.type_.as_deref().unwrap_or("Opaque");
                cell.text_color(colors.text_secondary).child(secret_type.to_string())
            }
            "Data" => {
                let count = resource.data
                    .as_ref()
                    .and_then(|d| d.as_object())
                    .map(|o| o.len())
                    .unwrap_or(0);
                cell.text_color(colors.text_secondary).child(count.to_string())
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }

    fn get_namespace_cell_value(&self, cell: Div, column: &str, resource: &Resource, colors: &ThemeColors) -> Div {
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
                cell.flex().items_center().child(render_status_pill(status_color, &phase))
            }
            "Age" => render_age(cell, resource, colors),
            "Actions" => render_actions(cell, colors),
            _ => cell.child("-"),
        }
    }
}

// Helper render functions
fn render_checkbox(cell: Div, colors: &ThemeColors) -> Div {
    cell.child(
        div()
            .w(px(16.0))
            .h(px(16.0))
            .rounded(px(3.0))
            .border_1()
            .border_color(colors.border)
    )
}

fn render_name_with_icon(cell: Div, resource: &Resource, icon: IconName, colors: &ThemeColors) -> Div {
    let status = get_resource_status(resource);
    let icon_color = status.color(colors);
    cell.flex()
        .items_center()
        .gap(px(8.0))
        .child(
            Icon::new(icon)
                .size(px(14.0))
                .color(icon_color)
        )
        .child(
            div()
                .text_ellipsis()
                .overflow_hidden()
                .child(resource.metadata.name.clone())
        )
}

fn render_namespace(cell: Div, resource: &Resource, colors: &ThemeColors) -> Div {
    cell.text_color(colors.text_secondary)
        .child(resource.metadata.namespace.clone().unwrap_or_else(|| "-".to_string()))
}

fn render_age(cell: Div, resource: &Resource, colors: &ThemeColors) -> Div {
    let age = format_age(&resource.metadata.creation_timestamp);
    cell.text_color(colors.text_secondary).child(age)
}

fn render_actions(cell: Div, colors: &ThemeColors) -> Div {
    cell.child(
        Icon::new(IconName::MoreHorizontal)
            .size(px(16.0))
            .color(colors.text_muted)
    )
}

/// Render a pill-shaped status badge with translucent colored background
fn render_status_pill(status_color: Hsla, label: &str) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .px(px(10.0))
        .py(px(4.0))
        .rounded(px(100.0))
        .bg(status_color.opacity(0.125))
        .child(
            div()
                .w(px(6.0))
                .h(px(6.0))
                .rounded_full()
                .bg(status_color)
        )
        .child(
            div()
                .text_size(px(12.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(status_color)
                .child(label.to_string())
        )
}

// Helper functions

fn get_json_value<'a>(value: &'a Option<Value>, path: &[&str]) -> Option<&'a Value> {
    let mut current = value.as_ref()?;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn get_pod_ready_count(resource: &Resource) -> (u64, u64) {
    let container_statuses = get_json_value(&resource.status, &["containerStatuses"])
        .and_then(|v| v.as_array());

    let containers = get_json_value(&resource.spec, &["containers"])
        .and_then(|v| v.as_array());

    let total = containers.map(|c| c.len() as u64).unwrap_or(1);
    let ready = container_statuses
        .map(|statuses| {
            statuses.iter().filter(|s| {
                s.get("ready").and_then(|r| r.as_bool()).unwrap_or(false)
            }).count() as u64
        })
        .unwrap_or(0);

    (ready, total)
}

fn get_pod_restarts(resource: &Resource) -> u64 {
    let container_statuses = get_json_value(&resource.status, &["containerStatuses"])
        .and_then(|v| v.as_array());

    container_statuses
        .map(|statuses| {
            statuses.iter().map(|s| {
                s.get("restartCount").and_then(|r| r.as_u64()).unwrap_or(0)
            }).sum()
        })
        .unwrap_or(0)
}

fn get_deployment_ready_count(resource: &Resource) -> (u64, u64) {
    let ready = get_json_value(&resource.status, &["readyReplicas"])
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let total = get_json_value(&resource.spec, &["replicas"])
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    (ready, total)
}

fn get_service_ports(resource: &Resource) -> String {
    let ports = get_json_value(&resource.spec, &["ports"])
        .and_then(|v| v.as_array());

    ports
        .map(|ports| {
            ports.iter().filter_map(|p| {
                let port = p.get("port").and_then(|v| v.as_u64())?;
                let protocol = p.get("protocol").and_then(|v| v.as_str()).unwrap_or("TCP");
                Some(format!("{}/{}", port, protocol))
            }).collect::<Vec<_>>().join(", ")
        })
        .unwrap_or_else(|| "-".to_string())
}

fn get_node_roles(resource: &Resource) -> String {
    let labels = &resource.metadata.labels;
    let mut roles = Vec::new();

    if let Some(labels) = labels {
        if labels.contains_key("node-role.kubernetes.io/control-plane") {
            roles.push("control-plane");
        }
        if labels.contains_key("node-role.kubernetes.io/master") {
            roles.push("master");
        }
        if labels.contains_key("node-role.kubernetes.io/worker") {
            roles.push("worker");
        }
    }

    if roles.is_empty() {
        roles.push("worker");
    }

    roles.join(", ")
}

fn get_resource_status(resource: &Resource) -> StatusType {
    let kind = resource.kind.as_str();

    match kind {
        "Pod" => {
            let phase = get_json_value(&resource.status, &["phase"])
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();

            match phase.as_str() {
                "running" => StatusType::Ready,
                "pending" => StatusType::Pending,
                "failed" | "crashloopbackoff" => StatusType::Failed,
                "succeeded" => StatusType::Ready,
                _ => StatusType::Unknown,
            }
        }
        "Deployment" => {
            let available = get_json_value(&resource.status, &["availableReplicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let desired = get_json_value(&resource.spec, &["replicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);

            if available == desired && desired > 0 {
                StatusType::Ready
            } else if available < desired {
                StatusType::Pending
            } else {
                StatusType::Unknown
            }
        }
        "Service" | "ConfigMap" | "Secret" => StatusType::Ready,
        _ => StatusType::Unknown,
    }
}

fn get_node_status(resource: &Resource) -> StatusType {
    let conditions = get_json_value(&resource.status, &["conditions"])
        .and_then(|v| v.as_array());

    if let Some(conditions) = conditions {
        for cond in conditions {
            if cond.get("type").and_then(|t| t.as_str()) == Some("Ready") {
                let status = cond.get("status").and_then(|s| s.as_str()).unwrap_or("");
                return match status {
                    "True" => StatusType::Ready,
                    "False" => StatusType::Failed,
                    _ => StatusType::Unknown,
                };
            }
        }
    }

    StatusType::Unknown
}

fn render_status_badge(status: StatusType) -> Tag {
    match status {
        StatusType::Ready => Tag::success().child(status.label()),
        StatusType::Pending => Tag::warning().child(status.label()),
        StatusType::Failed => Tag::danger().child(status.label()),
        StatusType::Unknown => Tag::info().child(status.label()),
    }
}

fn format_age(timestamp: &Option<String>) -> String {
    let Some(ts) = timestamp else {
        return "-".to_string();
    };

    // Parse ISO 8601 timestamp
    let Ok(date) = chrono::DateTime::parse_from_rfc3339(ts) else {
        return "-".to_string();
    };

    let now = chrono::Utc::now();
    let duration = now.signed_duration_since(date.with_timezone(&chrono::Utc));

    let days = duration.num_days();
    let hours = duration.num_hours() % 24;
    let minutes = duration.num_minutes() % 60;

    if days > 0 {
        format!("{}d", days)
    } else if hours > 0 {
        format!("{}h", hours)
    } else if minutes > 0 {
        format!("{}m", minutes)
    } else {
        format!("{}s", duration.num_seconds().max(0))
    }
}

/// Get age in seconds for sorting
fn get_age_seconds(timestamp: &Option<String>) -> i64 {
    let Some(ts) = timestamp else {
        return i64::MAX;
    };

    let Ok(date) = chrono::DateTime::parse_from_rfc3339(ts) else {
        return i64::MAX;
    };

    let now = chrono::Utc::now();
    now.signed_duration_since(date.with_timezone(&chrono::Utc)).num_seconds()
}

/// Compare two resources by a column
fn compare_resources_by_column(a: &Resource, b: &Resource, column: &str, resource_type: ResourceType) -> Ordering {
    match column {
        "Name" => a.metadata.name.cmp(&b.metadata.name),
        "Namespace" => {
            let ns_a = a.metadata.namespace.as_deref().unwrap_or("");
            let ns_b = b.metadata.namespace.as_deref().unwrap_or("");
            ns_a.cmp(ns_b)
        }
        "Age" => {
            let age_a = get_age_seconds(&a.metadata.creation_timestamp);
            let age_b = get_age_seconds(&b.metadata.creation_timestamp);
            age_a.cmp(&age_b)
        }
        "Status" => {
            let status_a = get_resource_status(a);
            let status_b = get_resource_status(b);
            status_order(status_a).cmp(&status_order(status_b))
        }
        "Ready" => {
            match resource_type {
                ResourceType::Pods => {
                    let (ready_a, total_a) = get_pod_ready_count(a);
                    let (ready_b, total_b) = get_pod_ready_count(b);
                    // Sort by ratio, then by ready count
                    let ratio_a = if total_a > 0 { ready_a as f64 / total_a as f64 } else { 0.0 };
                    let ratio_b = if total_b > 0 { ready_b as f64 / total_b as f64 } else { 0.0 };
                    ratio_a.partial_cmp(&ratio_b).unwrap_or(Ordering::Equal)
                }
                ResourceType::Deployments => {
                    let (ready_a, total_a) = get_deployment_ready_count(a);
                    let (ready_b, total_b) = get_deployment_ready_count(b);
                    let ratio_a = if total_a > 0 { ready_a as f64 / total_a as f64 } else { 0.0 };
                    let ratio_b = if total_b > 0 { ready_b as f64 / total_b as f64 } else { 0.0 };
                    ratio_a.partial_cmp(&ratio_b).unwrap_or(Ordering::Equal)
                }
                _ => Ordering::Equal,
            }
        }
        "Restarts" => {
            let restarts_a = get_pod_restarts(a);
            let restarts_b = get_pod_restarts(b);
            restarts_a.cmp(&restarts_b)
        }
        "Type" => {
            let type_a = get_json_value(&a.spec, &["type"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let type_b = get_json_value(&b.spec, &["type"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            type_a.cmp(type_b)
        }
        "Cluster-IP" => {
            let ip_a = get_json_value(&a.spec, &["clusterIP"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let ip_b = get_json_value(&b.spec, &["clusterIP"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            ip_a.cmp(ip_b)
        }
        "Ports" => {
            let ports_a = get_service_ports(a);
            let ports_b = get_service_ports(b);
            ports_a.cmp(&ports_b)
        }
        "Up-to-date" => {
            let updated_a = get_json_value(&a.status, &["updatedReplicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let updated_b = get_json_value(&b.status, &["updatedReplicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            updated_a.cmp(&updated_b)
        }
        "Available" => {
            let available_a = get_json_value(&a.status, &["availableReplicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let available_b = get_json_value(&b.status, &["availableReplicas"])
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            available_a.cmp(&available_b)
        }
        "Roles" => {
            let roles_a = get_node_roles(a);
            let roles_b = get_node_roles(b);
            roles_a.cmp(&roles_b)
        }
        "Version" => {
            let version_a = get_json_value(&a.status, &["nodeInfo", "kubeletVersion"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let version_b = get_json_value(&b.status, &["nodeInfo", "kubeletVersion"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            version_a.cmp(version_b)
        }
        "Node" => {
            let node_a = get_json_value(&a.spec, &["nodeName"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let node_b = get_json_value(&b.spec, &["nodeName"])
                .and_then(|v| v.as_str())
                .unwrap_or("");
            node_a.cmp(node_b)
        }
        _ => Ordering::Equal,
    }
}

/// Get ordering value for status (for sorting)
fn status_order(status: StatusType) -> u8 {
    match status {
        StatusType::Failed => 0,    // Failed first (most urgent)
        StatusType::Pending => 1,   // Then pending
        StatusType::Unknown => 2,   // Then unknown
        StatusType::Ready => 3,     // Ready last (least urgent)
    }
}
