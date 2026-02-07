use gpui::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum IconName {
    Pods,
    Deployments,
    Services,
    ConfigMaps,
    Secrets,
    Ingresses,
    StatefulSets,
    DaemonSets,
    Jobs,
    CronJobs,
    ReplicaSets,
    Nodes,
    Namespaces,
    Terminal,
    Logs,
    Refresh,
    Settings,
    Search,
    Filter,
    Close,
    ChevronRight,
    ChevronDown,
    ChevronLeft,
    ChevronUp,
    ChevronsUpDown,
    Plus,
    Minus,
    Edit,
    Delete,
    Scale,
    AI,
    Check,
    Warning,
    Error,
    Info,
    MoreHorizontal,
    Cloud,
    Layers,
    HardDrive,
    FileText,
    Key,
    Network,
    Box,
    Copy,
    WrapText,
    Download,
    Trash,
    Hexagon,
    ArrowLeft,
    Play,
    Power,
    Clipboard,
    Maximize,
}

impl IconName {
    /// Returns the SVG file path for this icon
    pub fn path(&self) -> &'static str {
        match self {
            IconName::Pods | IconName::Box => "icons/box.svg",
            IconName::Deployments | IconName::Layers => "icons/layers.svg",
            IconName::Services | IconName::Network => "icons/network.svg",
            IconName::ConfigMaps | IconName::FileText => "icons/file-text.svg",
            IconName::Secrets | IconName::Key => "icons/key.svg",
            IconName::Ingresses => "icons/arrow-right-left.svg",
            IconName::StatefulSets => "icons/database.svg",
            IconName::DaemonSets => "icons/copy.svg",
            IconName::Jobs => "icons/play.svg",
            IconName::CronJobs => "icons/clock.svg",
            IconName::ReplicaSets | IconName::Copy => "icons/copy.svg",
            IconName::Nodes => "icons/circle.svg",
            IconName::Namespaces => "icons/folder.svg",
            IconName::Terminal => "icons/terminal.svg",
            IconName::Logs => "icons/scroll-text.svg",
            IconName::Refresh => "icons/refresh-cw.svg",
            IconName::Settings => "icons/settings.svg",
            IconName::Search => "icons/search.svg",
            IconName::Filter => "icons/filter.svg",
            IconName::Close | IconName::Delete => "icons/x.svg",
            IconName::ChevronRight => "icons/chevron-right.svg",
            IconName::ChevronDown => "icons/chevron-down.svg",
            IconName::ChevronLeft => "icons/chevron-left.svg",
            IconName::ChevronUp => "icons/chevron-up.svg",
            IconName::ChevronsUpDown => "icons/chevrons-up-down.svg",
            IconName::Plus => "icons/plus.svg",
            IconName::Minus => "icons/minus.svg",
            IconName::Edit => "icons/pencil.svg",
            IconName::Scale => "icons/scale.svg",
            IconName::AI => "icons/sparkles.svg",
            IconName::Check => "icons/check.svg",
            IconName::Warning => "icons/alert-triangle.svg",
            IconName::Error => "icons/x-circle.svg",
            IconName::Info => "icons/info.svg",
            IconName::MoreHorizontal => "icons/more-horizontal.svg",
            IconName::Cloud => "icons/cloud.svg",
            IconName::HardDrive => "icons/hard-drive.svg",
            IconName::WrapText => "icons/wrap-text.svg",
            IconName::Download => "icons/download.svg",
            IconName::Trash => "icons/trash-2.svg",
            IconName::Hexagon => "icons/hexagon.svg",
            IconName::ArrowLeft => "icons/arrow-left.svg",
            IconName::Play => "icons/play.svg",
            IconName::Power => "icons/power.svg",
            IconName::Clipboard => "icons/clipboard.svg",
            IconName::Maximize => "icons/maximize-2.svg",
        }
    }
}

#[derive(IntoElement)]
pub struct Icon {
    name: IconName,
    size: Pixels,
    color: Option<Hsla>,
}

impl Icon {
    pub fn new(name: IconName) -> Self {
        Self {
            name,
            size: px(16.0),
            color: None,
        }
    }

    pub fn size(mut self, size: Pixels) -> Self {
        self.size = size;
        self
    }

    pub fn color(mut self, color: Hsla) -> Self {
        self.color = Some(color);
        self
    }
}

impl RenderOnce for Icon {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = crate::theme::theme(cx);
        let color = self.color.unwrap_or(theme.colors.text);

        svg()
            .path(self.name.path())
            .size(self.size)
            .text_color(color)
    }
}

/// Allow ui::IconName to be used with gpui-component's Button::icon() and other components
/// that accept `impl Into<gpui_component::Icon>`.
impl From<IconName> for gpui_component::Icon {
    fn from(name: IconName) -> gpui_component::Icon {
        gpui_component::Icon::default().path(name.path())
    }
}
