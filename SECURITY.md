# Security Policy

kdashboard is a desktop application that talks to Kubernetes API servers with
the credentials in your kubeconfig. A vulnerability in it can therefore expose
cluster credentials or let an attacker act on a cluster with your permissions.
We take reports seriously and appreciate responsible disclosure.

## Supported versions

Only the latest release receives security fixes. Older builds are not patched;
update through Homebrew on macOS or the in-app updater on Linux and Windows.

| Version | Supported |
| --- | --- |
| Latest release on the [Releases page](https://github.com/folio-pro/kdashboard/releases/latest) | Yes |
| Anything older | No |

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security
problem.**

Email `maintainers@kdashboard.io` with:

- A description of the issue and its impact.
- Steps to reproduce, a proof of concept, or the affected code path.
- The kdashboard version and your operating system.
- Whether the issue needs a malicious cluster, a malicious extension, a
  malicious kubeconfig, or only local access.

If you prefer to encrypt the report, say so in a first plain email and we will
exchange keys.

## What to expect

- Acknowledgement within 3 business days.
- An initial assessment and severity within 7 days.
- A fix or mitigation for confirmed issues in the next release, typically
  within 30 days for high-severity problems. We will keep you informed and
  agree a disclosure date with you before publishing details.
- Credit in the release notes, unless you ask to stay anonymous.

## Scope

In scope:

- The Electron main process, the preload bridge and the renderer in this
  repository.
- The IPC surface between renderer and main (`k8s:invoke` and the event
  channels).
- Handling of kubeconfigs, tokens, exec credential plugins and TLS.
- Data written to disk by the app (settings, caches, session state).
- The extension loader and the privileges an extension receives.
- The release pipeline and update mechanism.

Out of scope:

- Vulnerabilities in Kubernetes itself, in `kubectl`, or in third-party
  scanners such as `trivy` and `grype` that kdashboard shells out to.
- Issues that require a malicious extension the user chose to install.
  Extensions run in the renderer with the app's privileges; this is
  documented in [docs/extensions.md](docs/extensions.md).
- Missing hardening in developer-only builds (`bun run dev`,
  `bun run dev:electron`) that is present in packaged releases.
- Denial of service against your own local machine.

## Security design notes

- kdashboard runs no in-cluster agent and no HTTP server on the host. All
  cluster traffic goes from the Electron main process straight to the API
  server using your existing credentials and RBAC.
- The renderer is sandboxed with context isolation on and node integration
  off. It reaches the main process only through the preload contextBridge.
- Resource contents live in memory only. What the app writes to disk is its
  settings file, the session state needed to restore tabs (view type,
  resource name, namespace, filter), the pricing dataset and a cache of the
  cluster's OpenAPI schema used for YAML linting. Secret values are decoded
  in the detail view only when you reveal them.
- The app sends no telemetry. The only outbound connections are to your
  clusters, to the update endpoint when checking for a new version, and to a
  Prometheus URL if you configure one.

## Safe harbour

We will not pursue legal action against researchers who act in good faith,
avoid privacy violations and data destruction, do not exploit an issue beyond
what is needed to demonstrate it, and give us reasonable time to fix it before
disclosure.
