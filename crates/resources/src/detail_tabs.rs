#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum DetailTab {
    #[default]
    Overview,
    Yaml,
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum EditorSubTab {
    #[default]
    Editor,
    Diff,
    History,
}
