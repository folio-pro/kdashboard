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
pub use settings::{load_settings, save_settings, UserSettings};
pub use sidebar::*;
pub use title_bar::*;

use gpui::*;

pub fn init(cx: &mut App) {
    app_state::init(cx);
}
