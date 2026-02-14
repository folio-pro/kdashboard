use std::sync::OnceLock;
use tokio::runtime::Runtime;

static TOKIO_RUNTIME: OnceLock<Runtime> = OnceLock::new();

pub fn tokio_runtime() -> &'static Runtime {
    TOKIO_RUNTIME.get_or_init(|| Runtime::new().expect("Failed to create Tokio runtime"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokio_runtime_is_singleton() {
        let a = tokio_runtime() as *const Runtime;
        let b = tokio_runtime() as *const Runtime;
        assert_eq!(a, b);
    }

    #[test]
    fn tokio_runtime_executes_async_work() {
        let value = tokio_runtime().block_on(async { 2 + 3 });
        assert_eq!(value, 5);
    }
}
