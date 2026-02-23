pub mod container_icon;
mod buttons;
mod icon;
mod theme;

// Custom K8s-specific components
pub use buttons::*;
pub use icon::*;
pub use theme::*;

// Re-export gpui-component types for convenience
pub use gpui_component;
pub use gpui_component::Sizable;
pub use gpui_component::Size;
pub use gpui_component::button::Button;
pub use gpui_component::button::ButtonVariant;
pub use gpui_component::button::ButtonVariants;
pub use gpui_component::label::Label;
pub use gpui_component::list::List;
pub use gpui_component::list::ListItem;
pub use gpui_component::menu::DropdownMenu;
pub use gpui_component::menu::PopupMenu;
pub use gpui_component::menu::PopupMenuItem;
pub use gpui_component::spinner::Spinner;
pub use gpui_component::tag::Tag;
pub use gpui_component::tag::TagVariant;

use gpui::*;

pub fn init(cx: &mut App) {
    theme::init(cx);
}
