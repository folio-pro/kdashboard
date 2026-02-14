use crate::app_state::{app_state, ActiveView};
use gpui::prelude::FluentBuilder;
use gpui::*;
use k8s_client::ResourceType;
use std::collections::HashSet;
use ui::gpui_component::tooltip::Tooltip;
use ui::{theme, Icon, IconName, ThemeColors};

// Actions for sidebar clicks
actions!(sidebar, [ToggleCollapse]);

/// Sidebar section categories
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
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
            SidebarSection::Workloads => "Workloads",
            SidebarSection::Network => "Network",
            SidebarSection::Configuration => "Configuration",
            SidebarSection::Scaling => "Scaling",
            SidebarSection::Cluster => "Cluster",
        }
    }

    fn key(&self) -> &'static str {
        match self {
            SidebarSection::Workloads => "workloads",
            SidebarSection::Network => "network",
            SidebarSection::Configuration => "configuration",
            SidebarSection::Scaling => "scaling",
            SidebarSection::Cluster => "cluster",
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
            SidebarSection::Network => &[ResourceType::Services, ResourceType::Ingresses],
            SidebarSection::Configuration => &[ResourceType::ConfigMaps, ResourceType::Secrets],
            SidebarSection::Scaling => &[
                ResourceType::HorizontalPodAutoscalers,
                ResourceType::VerticalPodAutoscalers,
            ],
            SidebarSection::Cluster => &[ResourceType::Nodes, ResourceType::Namespaces],
        }
    }

    fn contains(&self, resource_type: ResourceType) -> bool {
        self.resource_types().contains(&resource_type)
    }
}

pub struct Sidebar {
    collapsed: bool,
    resource_count: Option<usize>,
    expanded_sections: HashSet<SidebarSection>,
}

impl Sidebar {
    pub fn new(collapsed: bool) -> Self {
        Self {
            collapsed,
            resource_count: None,
            expanded_sections: HashSet::from([SidebarSection::Workloads]),
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
        let current_context = state.context.clone();
        let contexts = state.contexts.clone();

        // Width: 220px expanded, 44px collapsed
        let width = if self.collapsed { px(44.0) } else { px(248.0) };

        if self.collapsed {
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
        } else {
            div()
                .h_full()
                .w(width)
                .bg(colors.surface)
                .border_r_1()
                .border_color(colors.border)
                .flex()
                .flex_row()
                .child(self.render_cluster_rail(cx, current_context, contexts))
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(self.render_header(cx))
                        .child(self.render_nav_section(cx, selected_type, &active_view, pf_count)),
                )
        }
    }
}

impl Sidebar {
    fn color_for_context(context_name: &str, colors: &ThemeColors, is_dark_theme: bool) -> Hsla {
        let normalized = context_name.trim().to_ascii_lowercase();
        let mut hash: u64 = 1469598103934665603;
        for byte in normalized.as_bytes() {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(1099511628211);
        }

        let palette = [
            colors.primary,
            colors.info,
            colors.success,
            colors.warning,
            colors.text_accent,
        ];
        let tone = palette[(hash as usize) % palette.len()];

        if is_dark_theme {
            tone
        } else {
            tone.opacity(0.92)
        }
    }

    fn render_cluster_rail(
        &self,
        cx: &Context<'_, Self>,
        current_context: Option<String>,
        mut contexts: Vec<String>,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let colors = &theme.colors;
        let is_dark_theme = theme.mode.is_dark();

        if contexts.is_empty() {
            if let Some(ctx) = &current_context {
                contexts.push(ctx.clone());
            }
        }

        let mut rail = div()
            .h_full()
            .w(px(36.0))
            .pt(px(12.0))
            .pb(px(12.0))
            .px(px(4.0))
            .border_r_1()
            .border_color(colors.border)
            .flex()
            .flex_col()
            .items_center()
            .gap(px(6.0));

        rail = rail.child(
            Icon::new(IconName::Cloud)
                .size(px(12.0))
                .color(colors.text_muted),
        );

        for context_name in contexts {
            let cluster_color = Self::color_for_context(&context_name, colors, is_dark_theme);
            let selected = current_context.as_deref() == Some(context_name.as_str());
            let bg = if selected {
                cluster_color.opacity(0.95)
            } else {
                cluster_color.opacity(if is_dark_theme { 0.12 } else { 0.18 })
            };
            let hover_bg = if selected {
                cluster_color.opacity(0.95)
            } else {
                cluster_color.opacity(if is_dark_theme { 0.22 } else { 0.30 })
            };
            let icon_color = if selected {
                if is_dark_theme {
                    colors.background
                } else {
                    colors.surface_elevated
                }
            } else {
                cluster_color.opacity(if is_dark_theme { 0.95 } else { 0.88 })
            };
            let context_id = context_name.clone();
            let context_label = context_name.clone();
            let label = context_name
                .chars()
                .next()
                .map(|c| c.to_ascii_uppercase())
                .unwrap_or('C')
                .to_string();

            rail = rail.child(
                div()
                    .id(ElementId::Name(format!("cluster-{}", context_name).into()))
                    .relative()
                    .w(px(28.0))
                    .h(px(28.0))
                    .rounded(theme.border_radius_md)
                    .bg(bg)
                    .border_1()
                    .border_color(if selected {
                        colors.text.opacity(0.65)
                    } else {
                        cluster_color.opacity(0.45)
                    })
                    .cursor_pointer()
                    .hover(|style| style.bg(hover_bg))
                    .tooltip(move |_, cx| cx.new(|_| Tooltip::new(context_label.clone())).into())
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .font_family(theme.font_family_ui.clone())
                            .text_size(px(11.0))
                            .font_weight(FontWeight::BOLD)
                            .text_color(icon_color)
                            .child(label),
                    )
                    .when(selected, |el| {
                        el.child(
                            div()
                                .absolute()
                                .top(px(-2.0))
                                .right(px(-2.0))
                                .w(px(8.0))
                                .h(px(8.0))
                                .rounded_full()
                                .bg(colors.text)
                                .border_1()
                                .border_color(colors.surface),
                        )
                    })
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.on_context_selected(context_id.clone(), cx);
                    })),
            );
        }

        rail
    }

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
                .color(colors.primary),
        );

        // Title text (only when not collapsed)
        if !self.collapsed {
            header = header.child(
                div()
                    .flex_1()
                    .font_family(theme.font_family_ui.clone())
                    .text_size(px(14.0))
                    .font_weight(FontWeight::BOLD)
                    .text_color(colors.text)
                    .child("K8S MANAGER"),
            );
        }

        let collapse_icon = if self.collapsed {
            IconName::ChevronRight
        } else {
            IconName::ChevronLeft
        };

        header = header.child(
            div()
                .id("sidebar-toggle")
                .ml_auto()
                .w(px(22.0))
                .h(px(22.0))
                .rounded(theme.border_radius_md)
                .cursor_pointer()
                .hover(|style| style.bg(colors.selection_hover))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    Icon::new(collapse_icon)
                        .size(px(14.0))
                        .color(colors.text_muted),
                )
                .on_click(cx.listener(|this, _event, _window, cx| {
                    this.collapsed = !this.collapsed;
                    cx.update_global::<crate::app_state::AppState, _>(|state, _| {
                        state.toggle_sidebar();
                    });
                    cx.notify();
                })),
        );

        if self.collapsed {
            header = header.justify_center();
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

        if self.collapsed {
            for section in sections {
                for rt in section.resource_types() {
                    let selected = *rt == selected_type && !is_pf_view;
                    nav = nav.child(self.render_resource_item(cx, *rt, selected, colors));
                }

                if section == SidebarSection::Network {
                    nav =
                        nav.child(self.render_port_forward_item(cx, is_pf_view, pf_count, colors));
                }
            }
            return nav;
        }

        for section in sections {
            let section_expanded = self.is_section_expanded(section, selected_type, is_pf_view);
            nav = nav.child(self.render_section_header(cx, section, section_expanded, colors));

            if section_expanded {
                for rt in section.resource_types() {
                    let selected = *rt == selected_type && !is_pf_view;
                    nav = nav.child(self.render_resource_item(cx, *rt, selected, colors));
                }

                if section == SidebarSection::Network {
                    nav =
                        nav.child(self.render_port_forward_item(cx, is_pf_view, pf_count, colors));
                }
            }
        }

        nav
    }

    fn is_section_expanded(
        &self,
        section: SidebarSection,
        selected_type: ResourceType,
        is_pf_view: bool,
    ) -> bool {
        self.expanded_sections.contains(&section)
            || section.contains(selected_type)
            || (section == SidebarSection::Network && is_pf_view)
    }

    fn render_section_header(
        &self,
        cx: &Context<'_, Self>,
        section: SidebarSection,
        expanded: bool,
        colors: &ThemeColors,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let indicator = if expanded {
            IconName::ChevronDown
        } else {
            IconName::ChevronRight
        };

        div()
            .id(ElementId::Name(
                format!("section-header-{}", section.key()).into(),
            ))
            .w_full()
            .px(px(12.0))
            .py(px(6.0))
            .rounded(theme.border_radius_md)
            .cursor_pointer()
            .hover(|style| style.bg(colors.selection_hover))
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(Icon::new(indicator).size(px(13.0)).color(colors.text_muted))
            .child(
                div()
                    .flex_1()
                    .font_family(theme.font_family_ui.clone())
                    .text_size(px(12.0))
                    .font_weight(FontWeight::BOLD)
                    .text_color(colors.text)
                    .child(section.label()),
            )
            .on_click(cx.listener(move |this, _event, _window, cx| {
                this.on_section_toggled(section, cx);
            }))
    }

    fn on_section_toggled(&mut self, section: SidebarSection, cx: &mut Context<'_, Self>) {
        if self.expanded_sections.contains(&section) {
            self.expanded_sections.remove(&section);
        } else {
            self.expanded_sections.insert(section);
        }

        cx.notify();
    }

    fn render_port_forward_item(
        &self,
        cx: &Context<'_, Self>,
        selected: bool,
        pf_count: usize,
        colors: &ThemeColors,
    ) -> impl IntoElement {
        let theme = theme(cx);
        let icon_color = if selected {
            colors.background
        } else {
            colors.text_muted
        };
        let text_color = if selected {
            colors.background
        } else {
            colors.text_secondary
        };
        let bg = if selected {
            colors.primary
        } else {
            gpui::transparent_black()
        };
        let hover_bg = if selected {
            colors.primary_hover
        } else {
            colors.selection_hover
        };

        let label = if pf_count > 0 {
            format!("Port Forwards ({})", pf_count)
        } else {
            "Port Forwards".to_string()
        };

        if self.collapsed {
            let tooltip_label = label.clone();
            div()
                .id("port-forwards-nav")
                .w(px(30.0))
                .h(px(30.0))
                .mx_auto()
                .rounded(if selected {
                    theme.border_radius_full
                } else {
                    theme.border_radius_md
                })
                .bg(bg)
                .cursor_pointer()
                .hover(|style| style.bg(hover_bg))
                .tooltip(move |_, cx| cx.new(|_| Tooltip::new(tooltip_label.clone())).into())
                .flex()
                .items_center()
                .justify_center()
                .child(
                    Icon::new(IconName::PortForward)
                        .size(px(19.0))
                        .color(icon_color),
                )
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
                .child(
                    Icon::new(IconName::PortForward)
                        .size(px(16.0))
                        .color(icon_color),
                )
                .child(
                    div()
                        .flex_1()
                        .font_family(theme.font_family_ui.clone())
                        .text_size(px(13.0))
                        .font_weight(if selected {
                            FontWeight::SEMIBOLD
                        } else {
                            FontWeight::MEDIUM
                        })
                        .text_color(text_color)
                        .child(label),
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
                            .child(pf_count.to_string()),
                    )
                })
                .on_click(cx.listener(|this, _event, _window, cx| {
                    this.on_port_forwards_selected(cx);
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

    fn on_context_selected(&mut self, context_name: String, cx: &mut Context<'_, Self>) {
        let current_context = cx.global::<crate::app_state::AppState>().context.clone();
        if current_context.as_deref() == Some(context_name.as_str()) {
            return;
        }

        cx.update_global::<crate::app_state::AppState, _>(|state, _cx| {
            state.set_context(Some(context_name.clone()));
            state.active_view = ActiveView::ResourceTable;
        });

        crate::switch_context(cx, context_name);
        cx.notify();
    }

    /// Get the icon name for a resource type
    fn get_icon_for_resource_type(resource_type: ResourceType) -> IconName {
        match resource_type {
            ResourceType::Pods => IconName::Pods,
            ResourceType::Deployments => IconName::Deployments,
            ResourceType::Services => IconName::Services,
            ResourceType::ConfigMaps => IconName::ConfigMaps,
            ResourceType::Secrets => IconName::Secrets,
            ResourceType::Ingresses => IconName::Ingresses,
            ResourceType::StatefulSets => IconName::StatefulSets,
            ResourceType::DaemonSets => IconName::DaemonSets,
            ResourceType::Jobs => IconName::Jobs,
            ResourceType::CronJobs => IconName::CronJobs,
            ResourceType::ReplicaSets => IconName::ReplicaSets,
            ResourceType::Nodes => IconName::Nodes,
            ResourceType::Namespaces => IconName::Namespaces,
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
            colors.background // dark icon on cyan bg
        } else {
            colors.text_muted // #64748B
        };

        let text_color = if selected {
            colors.background // dark text on cyan bg
        } else {
            colors.text_secondary // #94A3B8
        };

        // Background: selected = cyan accent, inactive = transparent
        let bg = if selected {
            colors.primary // #22D3EE
        } else {
            gpui::transparent_black()
        };

        let hover_bg = if selected {
            colors.primary_hover // #06B6D4
        } else {
            colors.selection_hover
        };

        let element_id = ElementId::Name(resource_type.display_name().into());
        let icon_name = Self::get_icon_for_resource_type(resource_type);
        let resource_label = resource_type.display_name().to_string();

        if self.collapsed {
            // Collapsed mode: just show icon
            div()
                .id(element_id)
                .w(px(30.0))
                .h(px(30.0))
                .mx_auto()
                .rounded(if selected {
                    theme.border_radius_full
                } else {
                    theme.border_radius_md
                })
                .bg(bg)
                .cursor_pointer()
                .hover(|style| style.bg(hover_bg))
                .tooltip(move |_, cx| cx.new(|_| Tooltip::new(resource_label.clone())).into())
                .flex()
                .items_center()
                .justify_center()
                .child(Icon::new(icon_name).size(px(19.0)).color(icon_color))
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
                .child(Icon::new(icon_name).size(px(16.0)).color(icon_color))
                .child(
                    // Label
                    div()
                        .flex_1()
                        .font_family(theme.font_family_ui.clone())
                        .text_size(px(13.0))
                        .font_weight(if selected {
                            FontWeight::SEMIBOLD
                        } else {
                            FontWeight::MEDIUM
                        })
                        .text_color(text_color)
                        .child(resource_type.display_name()),
                );

            item.on_click(cx.listener(move |this, _event, _window, cx| {
                this.on_resource_type_selected(resource_type, cx);
            }))
        }
    }

    fn on_resource_type_selected(
        &mut self,
        resource_type: ResourceType,
        cx: &mut Context<'_, Self>,
    ) {
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
