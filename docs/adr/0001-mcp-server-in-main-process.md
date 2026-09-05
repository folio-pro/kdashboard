# MCP server lives in the Electron main process, served over loopback HTTP

The embedded AI agent feature gives agent CLIs (claude, codex) tool access to the cluster via MCP. All cluster knowledge — kubeconfig loading, active context, custom TLS (CA/mTLS/skipTLSVerify via the global undici dispatcher), auth-header caching — lives in the main process (`electron/k8s/client.ts`). We therefore run the MCP server inside the main process and expose it as a streamable-HTTP endpoint bound to `127.0.0.1` with a per-session bearer token, instead of shipping a standalone stdio MCP server.

## Considered Options

- **Standalone stdio MCP server**: would duplicate kubeconfig/TLS/auth logic and could silently point at a different context than the UI. Rejected.
- **Thin stdio bridge into main**: same as the HTTP option plus an extra moving part. Rejected.
- **HTTP in main (chosen)**: agent and UI always share one view of the cluster; both claude and codex speak streamable HTTP natively (claude via `--mcp-config`/`--strict-mcp-config`, codex via `-c 'mcp_servers.*'` overrides), so no bridge process is needed.

## Consequences

- The app runs a local HTTP listener (previously it had none); it must only be alive while an Agent Session is, and must require the session token on every request.
- Codex needs a reasonably recent version for native streamable-HTTP MCP; the app should detect and warn.
