# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KDashboard is a native Kubernetes dashboard desktop application built with Rust. It uses GPUI (a GPU-accelerated UI framework) for rendering and `kube-rs` for Kubernetes API interaction.

## Build Commands

```bash
cargo build              # Dev build (opt-level 1, deps at opt-level 3)
cargo build --release    # Release build (LTO, strip, opt-level 3, panic=abort)
cargo run                # Run the application
cargo check              # Type-check without building
cargo fmt                # Format all crates
cargo clippy             # Lint all crates
cargo test               # Run tests
```

Requires **Rust nightly** toolchain (configured in `rust-toolchain.toml`).

**Important**: Always run `cargo test` after making any code change to verify nothing is broken.

## Architecture

### Workspace Structure (8 crates)

```
crates/
├── app/           # Binary entry point — initializes Tokio runtime, GPUI app, assets, window
├── workspace/     # Core application shell — AppState, AppView, sidebar, header, title bar, resource loader
├── ui/            # Shared UI primitives — theme, icons, re-exports from gpui-component
├── k8s/           # Kubernetes client — context/namespace management, resource listing, pod exec
├── resources/     # Resource views — table view, details panel, pod details
├── terminal/      # Terminal emulation — wraps alacritty_terminal for pod exec
├── logs/          # Log viewing — pod log streaming views
└── ai_assistant/  # AI assistant panel (framework in place)
```

### Dependency Graph

`app` → `workspace` → `{ui, k8s, resources, terminal, logs, ai_assistant}`
Feature crates (`resources`, `terminal`, `logs`, `ai_assistant`) depend on `ui` + `k8s`.
`ui` and `k8s` are self-contained leaf crates.

### Key Patterns

- **Global state**: `AppState` is stored as a GPUI global entity. All views subscribe to it and re-render on change.
- **Background threading**: Tokio runtime (initialized once via `OnceLock`) handles async K8s operations. Results are sent to the GPUI thread via `mpsc` channels as `K8sUpdate` enum variants.
- **Component model**: Each UI element (sidebar, header, resource table, etc.) is a GPUI entity with its own render lifecycle.
- **Resource dispatch**: `ResourceType` enum drives which K8s API call to make and how to display columns/rows in the table.

### Data Flow

1. User interaction or initial load triggers a `ResourceLoader` request
2. ResourceLoader spawns a Tokio task that calls `k8s::resources::list_resources()`
3. Results come back as `K8sUpdate` variants through an mpsc channel
4. AppState is updated in the GPUI context, triggering automatic re-renders

### Supported K8s Resources

Workloads: Pods, Deployments, ReplicaSets, StatefulSets, DaemonSets, Jobs, CronJobs
Network: Services, Ingresses
Config: ConfigMaps, Secrets
Cluster: Nodes, Namespaces

### Key Dependencies

- **gpui** / **gpui-component**: GPU-accelerated UI framework and component library
- **kube** + **k8s-openapi**: Kubernetes client with WebSocket and runtime support
- **alacritty_terminal**: Terminal emulation for pod exec
- **tokio**: Async runtime (full features)
- **anyhow** / **thiserror**: Error handling
- **tracing**: Structured logging

### Assets

UI assets (icons) live in `crates/ui/assets/icons/`. The `app` crate loads them via a custom `Assets` struct implementing GPUI's `AssetSource` trait, with a fallback path to `crates/ui/assets`.
