# MCP server lives in the Electron main process, served over loopback HTTP

The embedded AI agent feature gives agent CLIs (claude, codex) tool access to the cluster via MCP. All cluster knowledge — kubeconfig loading, active context, custom TLS (CA/mTLS/skipTLSVerify via the global undici dispatcher), auth-header caching — lives in the main process (`electron/k8s/client.ts`). We therefore run the MCP server inside the main process and expose it as a streamable-HTTP endpoint bound to `127.0.0.1` with a per-session bearer token, instead of shipping a standalone stdio MCP server.

## Considered Options

- **Standalone stdio MCP server**: would duplicate kubeconfig/TLS/auth logic and could silently point at a different context than the UI. Rejected.
- **Thin stdio bridge into main**: same as the HTTP option plus an extra moving part. Rejected.
- **HTTP in main (chosen)**: agent and UI always share one view of the cluster; both claude and codex speak streamable HTTP natively (claude via `--mcp-config`/`--strict-mcp-config`, codex via `-c 'mcp_servers.*'` overrides), so no bridge process is needed.

## Consequences

- The app runs a local HTTP listener (previously it had none). The per-session endpoint is only alive while an Agent Session is and requires the session token on every request. A second, opt-in external endpoint (Settings → AI Agent) listens on a fixed loopback port with a persisted token for other MCP clients; it follows the active context and lives from enablement until quit, with the same Mutation Approval gate.
- Codex needs a reasonably recent version for native streamable-HTTP MCP; the app should detect and warn.
