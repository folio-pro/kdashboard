use crate::app_state::{app_state, ActiveView};
use gpui::*;
use gpui::prelude::FluentBuilder;
use k8s_client::ResourceType;
use ui::{theme, Icon, IconName, ThemeColors};

// Actions for sidebar clicks
actions!(sidebar, [ToggleCollapse]);

/// Sidebar section categories
#[derive(Clone, Copy, PartialEq, Eq)]
enum SidebarSection {
    Workloads,
    Network,
    Configuration,
    Scaling,
    Cluster,
}

impl SidebarSection {
    fn label(&self) -> &'static str {
        match self {
            SidebarSection::Workloads => "WORKLOADS",
            SidebarSection::Network => "NETWORK",
            SidebarSection::Configuration => "CONFIGURATION",
            SidebarSection::Scaling => "SCALING",
            SidebarSection::Cluster => "CLUSTER",
        }
    }

    fn resource_types(&self) -> &'static [ResourceType] {
        match self {
            SidebarSection::Workloads => &[
                ResourceType::Pods,
                ResourceType::Deployments,
                ResourceType::ReplicaSets,
                ResourceType::StatefulSets,
                ResourceType::DaemonSets,
                ResourceType::Jobs,
                ResourceType::CronJobs,
            ],
            SidebarSection::Network => &[
                ResourceType::Services,
                ResourceType::Ingresses,
            ],
            SidebarSection::Configuration => &[
                ResourceType::ConfigMaps,
                ResourceType::Secrets,
            ],
            SidebarSection::Scaling => &[
                ResourceType::HorizontalPodAutoscalers,
                ResourceType::VerticalPodAutoscalers,
            ],
            SidebarSection::Cluster => &[
                ResourceType::Nodes,
                ResourceType::Namespaces,
            ],
        }
    }
}

pub struct Sidebar {
    collapsed: bool,
    resource_count: Option<usize>,
}

impl Sidebar {
    pub fn new(collapsed: bool) -> Self {
        Self {
            collapsed,
            resource_count: None,
        }
    }

    pub fn set_resource_count(&mut self, count: usize) {
        self.resource_count = Some(count);
    }
}

impl Render for Sidebar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let state = app_state(cx);
        let selected_type = state.selected_type;
        let active_view = state.active_view.clone();
        let pf_count = state.port_forwards.len();

        // Width: 220px expanded, 44px collapsed
        let width = if self.collapsed { px(44.0) } else { px(220.0) };

        div()
            .h_full()
            .w(width)
            .bg(colors.surface)
            .border_r_1()
            .border_color(colors.border)
            .flex()
            .flex_col()
            .child(self.render_header(cx))
            .child(self.render_nav_section(cx, selected_type, &active_view, pf_count))
    }
}

impl Sidebar {
    /// Render the sidebar header with logo
    fn render_header(&self, cx: &Context<'_, Self>) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let mut header = div()
            .w_full()
            .px(px(16.0))
            .py(px(12.0))
            .flex()
            .items_center()
            .gap(px(8.0));

        // Logo icon - cyan accent
        header = header.child(
            Icon::new(IconName::Hexagon)
                .size(px(22.0))
                .color(colors.primary)
        );

        // Title text (only when not collapsed)
        if !self.collapsed {
            header = header.child(
                div()
                    .font_family(theme.font_family_ui.clone())
                    .text_size(px(14.0))
                    .font_weight(FontWeight::BOLD)
                    .text_color(colors.text)
                    .child("K8S MANAGER")
            );
        }

        header
    }

    /// Render the navigation section with resource types grouped by category
    fn render_nav_section(
        &self,
        cx: &Context<'_, Self>,
        selected_type: ResourceType,
        active_view: &ActiveView,
        pf_count: usize,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;

        let sections = [
            SidebarSection::Workloads,
            SidebarSection::Network,
            SidebarSection::Configuration,
            SidebarSection::Scaling,
            SidebarSection::Cluster,
        ];

        let is_pf_view = *active_view == ActiveView::PortForwards;
        let is_settings_view = *active_view == ActiveView::Settings;

        let mut nav = div()
            .id("sidebar-nav")
            .flex_1()
            .overflow_y_scroll()
            .pt(px(8.0))
            .px(px(12.0))
            .pb(px(8.0))
            .flex()
            .flex_col()
            .gap(px(4.0));

        for section in sections {
            // Section label
            if !self.collapsed && !section.resource_types().is_empty() {
                nav = nav.child(
                    div()
                        .px(px(12.0))
                        .pt(px(6.0))
                        .pb(px(2.0))
                        .font_family(theme.font_family_ui.clone())
                        .text_size(px(10.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(colors.text_muted)
                        .child(section.label())
                );
            }

            // Resource items in this section
            for rt in section.resource_types() {
                let selected = *rt == selected_type && !is_pf_view;
                nav = nav.child(
                    self.render_resource_item(cx, *rt, selected, colors)
                );
            }
        }

        // TOOLS section
        if !self.collapsed {
            nav = nav.child(
                div()
                    .px(px(12.0))
                    .pt(px(6.0))
                    .pb(px(2.0))
                    .font_family(theme.font_family_ui.clone())
                    .text_size(px(10.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(colors.text_muted)
                    .child("TOOLS")
            );
        }

        nav = nav.child(self.render_port_forward_item(cx, is_pf_view, pf_count, colors));
        nav = nav.child(self.render_settings_item(cx, is_settings_view, colors));

        nav
    }

    fn render_port_forward_item(
        &self,
        cx: &Context<'_, Self>,
        selected: bool,
        pf_count: usize,
        colors: &ThemeColors,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let icon_color = if selected { colors.background } else { colors.text_muted };
        let text_color = if selected { colors.background } else { colors.text_secondary };
        let bg = if selected { colors.primary } else { gpui::transparent_black() };
        let hover_bg = if selected { colors.primary_hover } else { colors.selection_hover };

        let label = if pf_count > 0 {
            format!("Port Forwards ({})", pf_count)
        } else {
            "Port Forwards".to_string()
        };

        if self.collapsed {
            div()
                .id("port-forwards-nav")
                .w_full()
                .px(px(8.0))
                .py(px(6.0))
                .rounded(theme.border_radius_md)
                .bg(bg)
                .cursor_pointer()
                .hover(|style| style.bg(hover_bg))
                .flex()
                .items_center()
                .justify_center()
                .child(Icon::new(IconName::PortForward).size(px(16.0)).color(icon_color))
                .on_click(cx.listener(|this, _event, _window, cx| {
                    this.on_port_forwards_selected(cx);
                }))
        } else {
            div()
                .id("port-forwards-nav")
                .w_full()
                .px(px(12.0))
                .py(px(6.0))
                .rounded(theme.border_radius_md)
                .bg(bg)
                .cursor_pointer()
                .hover(|style| style.bg(hover_bg))
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(Icon::new(IconName::PortForward).size(px(16.0)).color(icon_color))
                .child(
                    div()
                        .flex_1()
                        .font_family(theme.font_family_ui.clone())
                        .text_size(px(13.0))
                        .font_weight(if selected { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                        .text_color(text_color)
                        .child(label)
                )
                .when(pf_count > 0 && !selected, |el| {
                    el.child(
                        div()
                            .px(px(6.0))
                            .py(px(1.0))
                            .rounded(theme.border_radius_full)
                            .bg(colors.primary.opacity(0.2))
                            .text_size(px(10.0))
                            .text_color(colors.primary)
                            .font_weight(FontWeight::BOLD)
                            .child(pf_count.to_string())
                    )
                })
                .on_click(cx.listener(|this, _event, _window, cx| {
                    this.on_port_forwards_selected(cx);
                }))
        }
    }

    fn render_settings_item(
        &self,
        cx: &Context<'_, Self>,
        selected: bool,
        colors: &ThemeColors,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let icon_color = if selected { colors.background } else { colors.text_muted };
        let text_color = if selected { colors.background } else { colors.text_secondary };
        let bg = if selected { colors.primary } else { gpui::transparent_black() };
        let hover_bg = if selected { colors.primary_hover } else { colors.selection_hover };

        if self.collapsed {
            div()
                .id("settings-nav")
                .w_full()
                .px(px(8.0))
                .py(px(6.0))
                .rounded(theme.border_radius_md)
                .bg(bg)
                .cursor_pointer()
                .hover(|style| style.bg(hover_bg))
                .flex()
                .items_center()
                .justify_center()
                .child(Icon::new(IconName::Settings).size(px(16.0)).color(icon_color))
                .on_click(cx.listener(|this, _event, _window, cx| {
                    this.on_settings_selected(cx);
                }))
        } else {
            div()
                .id("settings-nav")
                .w_full()
                .px(px(12.0))
                .py(px(6.0))
                .rounded(theme.border_radius_md)
                .bg(bg)
                .cursor_pointer()
                .hover(|style| style.bg(hover_bg))
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(Icon::new(IconName::Settings).size(px(16.0)).color(icon_color))
                .child(
                    div()
                        .flex_1()
                        .font_family(theme.font_family_ui.clone())
                        .text_size(px(13.0))
                        .font_weight(if selected { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                        .text_color(text_color)
                        .child("Settings")
                )
                .on_click(cx.listener(|this, _event, _window, cx| {
                    this.on_settings_selected(cx);
                }))
        }
    }

    fn on_port_forwards_selected(&mut self, cx: &mut Context<'_, Self>) {
        cx.update_global::<crate::app_state::AppState, _>(|state, _cx| {
            state.active_view = ActiveView::PortForwards;
            state.set_selected_resource(None);
        });
        cx.notify();
    }

    fn on_settings_selected(&mut self, cx: &mut Context<'_, Self>) {
        cx.update_global::<crate::app_state::AppState, _>(|state, _cx| {
            state.active_view = ActiveView::Settings;
            state.set_selected_resource(None);
        });
        cx.notify();
    }

    /// Get the icon name for a resource type
    fn get_icon_for_resource_type(resource_type: ResourceType) -> IconName {
        match resource_type {
            ResourceType::Pods => IconName::Box,
            ResourceType::Deployments => IconName::Layers,
            ResourceType::Services => IconName::Network,
            ResourceType::ConfigMaps => IconName::FileText,
            ResourceType::Secrets => IconName::Key,
            ResourceType::Ingresses => IconName::Network,
            ResourceType::StatefulSets => IconName::Layers,
            ResourceType::DaemonSets => IconName::Layers,
            ResourceType::Jobs => IconName::Box,
            ResourceType::CronJobs => IconName::Box,
            ResourceType::ReplicaSets => IconName::Copy,
            ResourceType::Nodes => IconName::HardDrive,
            ResourceType::Namespaces => IconName::Layers,
            ResourceType::HorizontalPodAutoscalers => IconName::Scale,
            ResourceType::VerticalPodAutoscalers => IconName::Scale,
        }
    }

    /// Render a single resource type item
    fn render_resource_item(
        &self,
        cx: &Context<'_, Self>,
        resource_type: ResourceType,
        selected: bool,
        colors: &ThemeColors,
    ) -> impl IntoElement {
        let theme = theme(cx);
        // Pencil design: active = cyan bg with dark text, inactive = muted slate text
        let icon_color = if selected {
            colors.background  // dark icon on cyan bg
        } else {
            colors.text_muted  // #64748B
        };

        let text_color = if selected {
            colors.background  // dark text on cyan bg
        } else {
            colors.text_secondary  // #94A3B8
        };

        // Background: selected = cyan accent, inactive = transparent
        let bg = if selected {
            colors.primary  // #22D3EE
        } else {
            gpui::transparent_black()
        };

        let hover_bg = if selected {
            colors.primary_hover  // #06B6D4
        } else {
            colors.selection_hover
        };

        let element_id = ElementId::Name(resource_type.display_name().into());
        let icon_name = Self::get_icon_for_resource_type(resource_type);

        if self.collapsed {
            // Collapsed mode: just show icon
            div()
                .id(element_id)
                .w_full()
                .px(px(8.0))
                .py(px(6.0))
                .rounded(theme.border_radius_md)
                .bg(bg)
                .cursor_pointer()
                .hover(|style| style.bg(hover_bg))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    Icon::new(icon_name)
                        .size(px(16.0))
                        .color(icon_color)
                )
                .on_click(cx.listener(move |this, _event, _window, cx| {
                    this.on_resource_type_selected(resource_type, cx);
                }))
        } else {
            // Expanded mode: show icon + label (Pencil design)
            let item = div()
                .id(element_id)
                .w_full()
                .px(px(12.0))
                .py(px(6.0))
                .rounded(theme.border_radius_md)
                .bg(bg)
                .cursor_pointer()
                .hover(|style| style.bg(hover_bg))
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    Icon::new(icon_name)
                        .size(px(16.0))
                        .color(icon_color)
                )
                .child(
                    // Label
                    div()
                        .flex_1()
                        .font_family(theme.font_family_ui.clone())
                        .text_size(px(13.0))
                        .font_weight(if selected { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                        .text_color(text_color)
                        .child(resource_type.display_name())
                );

            item.on_click(cx.listener(move |this, _event, _window, cx| {
                this.on_resource_type_selected(resource_type, cx);
            }))
        }
    }

    fn on_resource_type_selected(&mut self, resource_type: ResourceType, cx: &mut Context<'_, Self>) {
        tracing::info!("Selected resource type: {:?}", resource_type);

        // Get current namespace before updating state
        let namespace = cx.global::<crate::app_state::AppState>().namespace.clone();

        // Update global state
        cx.update_global::<crate::app_state::AppState, _>(|state, _cx| {
            state.set_selected_type(resource_type);
            state.active_view = ActiveView::ResourceTable;
        });

        // Reload resources with the new resource type
        crate::load_resources(cx, resource_type, namespace);

        // Request UI refresh
        cx.notify();
    }
}
