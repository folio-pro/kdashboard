# Contributing to kdashboard

Thanks for your interest. kdashboard is developed in the open, and outside
contributions are welcome. This document describes how to contribute and what
to expect from the process.

## Before you start

- Read our [Code of Conduct](CODE_OF_CONDUCT.md). All interactions in the
  project, whether in issues, pull requests, discussions, or chat, are
  governed by it.
- Read the [License](LICENSE.md) and [Trademark Policy](TRADEMARK.md).
  kdashboard is source-available under FSL-1.1-Apache-2.0; contributions
  must be compatible with that licensing model.
- For non-trivial changes, open an issue first to discuss the approach
  before writing the code. This avoids wasted effort on PRs that do not
  align with project direction.

## Contributor License Agreement

Before your first pull request is merged, you will be asked to sign our
Contributor License Agreement (CLA) via [cla-assistant.io](https://cla-assistant.io).
The CLA grants Folio Innova S.L. the rights necessary to distribute your
contribution as part of the project and to maintain licensing flexibility as
the project evolves.

The CLA does not transfer ownership of your contribution. You keep the
copyright on everything you write.

## Development setup

kdashboard is a Tauri 2 desktop application with a Rust backend and a Svelte 5
frontend.

Requirements:

- Rust stable (see `rust-toolchain.toml` if present; otherwise current stable)
- Node.js 20 or later, plus [Bun](https://bun.sh)
- Platform build dependencies per the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

Setup:

```bash
git clone https://github.com/folio-pro/kdashboard.git
cd kdashboard
bun install
cargo fetch --manifest-path src-tauri/Cargo.toml
bun run tauri dev
```

Tests:

```bash
bun test                  # Frontend unit tests
cargo test --manifest-path src-tauri/Cargo.toml
```

Before submitting a pull request, run both test suites locally and verify
that a release build completes:

```bash
bun run build
cargo build --manifest-path src-tauri/Cargo.toml --release
```

## Licensing

The project is licensed as a whole under the terms in [LICENSE.md](LICENSE.md).
Individual source files do not need a per-file SPDX header; the repo-level
license applies to every file unless a file explicitly states otherwise.

## Pull request process

1. Fork the repository and create a topic branch from `main`.
2. Make your change. Keep the diff focused — one logical change per pull
   request. Unrelated cleanups should be separate PRs.
3. Add or update tests. New behavior requires new tests. A PR that changes
   behavior without test coverage will be asked to add tests before review.
4. Run the full test suite locally and make sure it passes.
5. Update documentation if your change affects user-facing behavior or
   developer workflow.
6. Push your branch and open a pull request against `main`. Fill in the PR
   template fully.
7. Sign the CLA if this is your first contribution.
8. Address review feedback. We aim for an initial response within five
   working days; depth reviews may take longer for complex changes.

## Commit messages

We use Conventional Commits with a short, imperative subject:

```
feat: add pod log filtering by regex
fix(topology): handle deployments without replicas
docs: clarify kubeconfig lookup order
refactor(k8s): split resources.rs into per-domain modules
test: add integration coverage for cost enricher
chore: bump kube to 0.98
```

Valid types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
Subject line under 72 characters, no trailing period. Body wrapped at 80
columns, explains the why rather than the what.

## Scope

kdashboard is a lightweight desktop IDE for Kubernetes operations. In scope:

- Multi-context and multi-namespace resource management
- Resource topology, cost visibility, security overview, diagnostics
- Log streaming, exec, and port-forwarding for pods
- Performance on large clusters (thousands of resources)
- Accessibility, keyboard navigation, and responsive UX
- Cross-platform support (macOS, Linux, Windows)

Out of scope:

- Cluster provisioning, deployment pipelines, or CI/CD integration
- Application deployment tooling beyond what kubectl already provides
- Telemetry that reports user activity to third parties

For anything in the grey zone, open a discussion before writing code.

## Reporting security issues

Do not file security issues in the public tracker. See [SECURITY.md](SECURITY.md)
for responsible disclosure instructions.

## Questions

- General questions: [GitHub Discussions](https://github.com/folio-pro/kdashboard/discussions)
- Bug reports and feature proposals: [Issues](https://github.com/folio-pro/kdashboard/issues)
- Anything sensitive: `maintainers@kdashboard.io`

Thanks for contributing.
