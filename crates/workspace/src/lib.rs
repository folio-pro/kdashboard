mod app_state;
mod app_view;
mod header;
mod resource_loader;
pub mod settings;
mod sidebar;
mod title_bar;

pub use app_state::*;
pub use app_view::*;
pub use header::*;
pub use resource_loader::*;
pub use settings::{UserSettings, load_settings, save_settings};
pub use sidebar::*;
pub use title_bar::*;

use gpui::*;

pub fn init(cx: &mut App) {
    app_state::init(cx);

    cx.bind_keys([
        KeyBinding::new("secondary-k", app_view::OpenCommandMode, None),
        KeyBinding::new("secondary-p", app_view::OpenCommandMode, None),
        KeyBinding::new(":", app_view::OpenCommandMode, None),
        KeyBinding::new("shift-;", app_view::OpenCommandMode, None),
        KeyBinding::new("/", app_view::OpenSearchMode, None),
        KeyBinding::new("escape", app_view::CloseCommandBar, Some("CommandBar")),
        KeyBinding::new("enter", app_view::ExecuteCommandBar, Some("CommandBar")),
        KeyBinding::new("tab", app_view::CommandBarTab, Some("CommandBar")),
        KeyBinding::new("shift-tab", app_view::CommandBarTab, Some("CommandBar")),
        KeyBinding::new("ctrl-i", app_view::CommandBarTab, Some("CommandBar")),
    ]);
}
