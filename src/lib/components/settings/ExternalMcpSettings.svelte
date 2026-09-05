<script lang="ts">
  // Settings → AI Agent → "Expose to external AI tools": kdashboard as the
  // Kubernetes MCP server for Claude Desktop / Claude Code / Cursor / Codex.
  // Owns the toggle, port, token and the copy-paste client configs; main
  // (electron/agent/external.ts) follows the saved settings.
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Button, Input } from "$lib/components/ui";
  import { Copy, RefreshCw } from "lucide-svelte";
  import { invoke } from "$lib/ipc/core";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { onMount } from "svelte";

  const EXTERNAL_MCP_DEFAULT_PORT = 47831;
  interface ExternalMcpStatus {
    enabled: boolean;
    running: boolean;
    url?: string;
    error?: string;
  }
  let mcpStatus = $state<ExternalMcpStatus | null>(null);
  let mcpPort = $state(String(settingsStore.settings.agent_external_mcp_port ?? EXTERNAL_MCP_DEFAULT_PORT));
  let tokenVisible = $state(false);
  const mcpEnabled = $derived(settingsStore.settings.agent_external_mcp_enabled === true);
  const mcpToken = $derived(settingsStore.settings.agent_external_mcp_token ?? "");
  const mcpUrl = $derived(`http://127.0.0.1:${settingsStore.settings.agent_external_mcp_port ?? EXTERNAL_MCP_DEFAULT_PORT}/mcp`);

  function newToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function refreshMcpStatus(): Promise<void> {
    try {
      // Main restarts the listener right after save_settings; give it a beat.
      await new Promise((r) => setTimeout(r, 300));
      mcpStatus = await invoke<ExternalMcpStatus>("get_external_mcp_status");
    } catch {
      mcpStatus = null;
    }
  }

  function saveMcp(patch: Partial<typeof settingsStore.settings>): void {
    Object.assign(settingsStore.settings, patch);
    settingsStore.saveSettings();
    void refreshMcpStatus();
  }

  function setMcpEnabled(enabled: boolean): void {
    saveMcp({
      agent_external_mcp_enabled: enabled,
      ...(enabled && !mcpToken ? { agent_external_mcp_token: newToken() } : {}),
    });
  }

  function commitPort(): void {
    const port = Number.parseInt(mcpPort, 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      toastStore.error("Invalid port", "Use a port between 1024 and 65535.");
      mcpPort = String(settingsStore.settings.agent_external_mcp_port ?? EXTERNAL_MCP_DEFAULT_PORT);
      return;
    }
    saveMcp({ agent_external_mcp_port: port });
  }

  async function copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toastStore.success("Copied", what);
    } catch {
      toastStore.error("Copy failed", "Clipboard is not available.");
    }
  }

  const claudeCodeCommand = $derived(
    `claude mcp add --transport http kdashboard ${mcpUrl} --header "Authorization: Bearer ${mcpToken}"`,
  );
  const jsonConfig = $derived(
    JSON.stringify(
      { mcpServers: { kdashboard: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } } } },
      null,
      2,
    ),
  );
  const codexConfig = $derived(
    `[mcp_servers.kdashboard]\nurl = "${mcpUrl}"\nbearer_token_env_var = "KDASHBOARD_MCP_TOKEN"\n# export KDASHBOARD_MCP_TOKEN=${mcpToken}`,
  );

  onMount(() => {
    void refreshMcpStatus();
  });

</script>

<div class="mt-6 border-t border-[var(--border-color)] pt-5">
    <h3 class="text-[12px] font-semibold text-[var(--text-primary)]">Expose to external AI tools (MCP server)</h3>
    <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
      Serve kdashboard's cluster tools to Claude Desktop, Claude Code, Cursor, Codex or any MCP client on this machine.
      Clients see the context active in kdashboard, use your kubeconfig credentials, and every mutation still goes through
      the Approve / Deny dialog above. Loopback only, bearer token required.
    </p>

    <label class="mt-4 flex cursor-pointer items-start gap-2.5">
      <Checkbox checked={mcpEnabled} onCheckedChange={(checked) => setMcpEnabled(checked === true)} class="mt-0.5" data-testid="external-mcp-toggle" />
      <span class="flex flex-col">
        <span class="text-[12px] font-medium text-[var(--text-primary)]">Enable external MCP endpoint</span>
        <span class="text-[11px] leading-relaxed text-[var(--text-muted)]">
          {#if mcpStatus?.running}
            Listening on <span class="font-mono">{mcpStatus.url}</span>
          {:else if mcpStatus?.error}
            <span class="text-[var(--status-failed)]">Not running: {mcpStatus.error}</span>
          {:else if mcpEnabled}
            Starting…
          {:else}
            Off. The Agent Session's own endpoint is unaffected by this setting.
          {/if}
        </span>
      </span>
    </label>

    {#if mcpEnabled}
      <div class="mt-4 flex flex-col gap-3 pl-6">
        <div class="flex items-center gap-2">
          <span class="w-14 text-[11px] text-[var(--text-secondary)]">Port</span>
          <Input size="sm" mono class="w-24" bind:value={mcpPort} onblur={commitPort} onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter") commitPort(); }} />
        </div>
        <div class="flex items-center gap-2">
          <span class="w-14 text-[11px] text-[var(--text-secondary)]">Token</span>
          <span class="max-w-[360px] truncate font-mono text-[11px] text-[var(--text-primary)]" title={tokenVisible ? mcpToken : "hidden"}>
            {tokenVisible ? mcpToken : "•".repeat(24)}
          </span>
          <Button size="xs" variant="outline" onclick={() => (tokenVisible = !tokenVisible)}>{tokenVisible ? "Hide" : "Show"}</Button>
          <Button size="xs" variant="outline" title="Copy token" onclick={() => copy(mcpToken, "Token")}><Copy class="h-3 w-3" /></Button>
          <Button size="xs" variant="outline" title="Regenerate — existing clients stop working" onclick={() => saveMcp({ agent_external_mcp_token: newToken() })}><RefreshCw class="h-3 w-3" /></Button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="w-14 text-[11px] text-[var(--text-secondary)]">Connect</span>
          <Button size="xs" variant="outline" onclick={() => copy(claudeCodeCommand, "Claude Code command")}>Copy Claude Code command</Button>
          <Button size="xs" variant="outline" onclick={() => copy(jsonConfig, "JSON config (Claude Desktop, Cursor)")}>Copy JSON config</Button>
          <Button size="xs" variant="outline" onclick={() => copy(codexConfig, "Codex config.toml snippet")}>Copy Codex config</Button>
        </div>
        <p class="text-[11px] leading-relaxed text-[var(--text-muted)]">
          The token is stored in kdashboard's settings file. Anyone who can read it can drive your cluster through this
          endpoint with your permissions while kdashboard is open — regenerate it if in doubt.
        </p>
      </div>
    {/if}
  </div>
