use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum MetricsKind {
    Pods,
    Nodes,
}

struct State {
    unavailable_until: Option<Instant>,
    consecutive_failures: u32,
}

const fn empty_state() -> State {
    State {
        unavailable_until: None,
        consecutive_failures: 0,
    }
}

static PODS_STATE: Mutex<State> = Mutex::new(empty_state());
static NODES_STATE: Mutex<State> = Mutex::new(empty_state());

const BACKOFF_STEPS_SECS: &[u64] = &[30, 60, 120, 300];

fn slot(kind: MetricsKind) -> &'static Mutex<State> {
    match kind {
        MetricsKind::Pods => &PODS_STATE,
        MetricsKind::Nodes => &NODES_STATE,
    }
}

pub(super) fn is_available(kind: MetricsKind) -> bool {
    let guard = slot(kind).lock().unwrap_or_else(|e| e.into_inner());
    match guard.unavailable_until {
        Some(until) => Instant::now() >= until,
        None => true,
    }
}

pub(super) fn mark_available(kind: MetricsKind) {
    let mut guard = slot(kind).lock().unwrap_or_else(|e| e.into_inner());
    if guard.consecutive_failures > 0 {
        tracing::info!(endpoint = ?kind, "metrics-server endpoint recovered");
    }
    guard.unavailable_until = None;
    guard.consecutive_failures = 0;
}

pub(super) fn mark_unavailable(kind: MetricsKind) -> Duration {
    let mut guard = slot(kind).lock().unwrap_or_else(|e| e.into_inner());
    let step = (guard.consecutive_failures as usize).min(BACKOFF_STEPS_SECS.len() - 1);
    let secs = BACKOFF_STEPS_SECS[step];
    guard.consecutive_failures = guard.consecutive_failures.saturating_add(1);
    let dur = Duration::from_secs(secs);
    guard.unavailable_until = Some(Instant::now() + dur);
    dur
}

/// Call on context switch / kubeconfig change so a new cluster is probed fresh
/// instead of inheriting the previous cluster's availability state.
pub fn reset() {
    for s in [&PODS_STATE, &NODES_STATE] {
        let mut g = s.lock().unwrap_or_else(|e| e.into_inner());
        g.unavailable_until = None;
        g.consecutive_failures = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    // Tests share global state — run them sequentially.
    static TEST_LOCK: StdMutex<()> = StdMutex::new(());

    fn clear() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        guard
    }

    #[test]
    fn starts_available() {
        let _g = clear();
        assert!(is_available(MetricsKind::Pods));
        assert!(is_available(MetricsKind::Nodes));
    }

    #[test]
    fn marks_unavailable_with_growing_backoff() {
        let _g = clear();
        let first = mark_unavailable(MetricsKind::Pods);
        let second = mark_unavailable(MetricsKind::Pods);
        let third = mark_unavailable(MetricsKind::Pods);
        assert_eq!(first, Duration::from_secs(30));
        assert_eq!(second, Duration::from_secs(60));
        assert_eq!(third, Duration::from_secs(120));
        assert!(!is_available(MetricsKind::Pods));
        assert!(is_available(MetricsKind::Nodes));
    }

    #[test]
    fn recovery_resets_backoff() {
        let _g = clear();
        mark_unavailable(MetricsKind::Nodes);
        mark_unavailable(MetricsKind::Nodes);
        mark_available(MetricsKind::Nodes);
        // After recovery, the next failure should restart at the first backoff step.
        let next = mark_unavailable(MetricsKind::Nodes);
        assert_eq!(next, Duration::from_secs(30));
    }
}
