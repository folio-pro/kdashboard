mod yaml_editor;
mod yaml_serializer;

pub use yaml_editor::YamlEditor;
pub use yaml_serializer::{resource_to_yaml, validate_yaml};

use gpui::*;

/// Register keybindings for the editor (Cmd+S to save).
pub fn init(cx: &mut App) {
    cx.bind_keys([KeyBinding::new(
        "cmd-s",
        yaml_editor::Save,
        Some("YamlEditor"),
    )]);
}
