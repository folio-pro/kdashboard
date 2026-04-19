pub mod app_commands;
pub mod k8s_commands;

/// Extension trait to convert `Result<T, E: Display>` to `Result<T, String>`.
/// Replaces the verbose `.map_err(|e| e.to_string())` pattern across command files.
pub(crate) trait StrErr<T> {
    fn str_err(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> StrErr<T> for Result<T, E> {
    fn str_err(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}
