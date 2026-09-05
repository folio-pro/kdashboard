// Unit tests for Agent Profile invocation building (bun test).

import { describe, expect, test } from 'bun:test';

import { getAgentProfile, getAgentProfiles } from './profiles';

const INPUT = {
  prompt: 'analyze this pod',
  mcpUrl: 'http://127.0.0.1:52345/mcp',
  mcpToken: 'deadbeef',
};

describe('claude profile', () => {
  test('builds a self-contained strict MCP invocation with pre-approved tools', () => {
    const { args, env } = getAgentProfile('claude').buildInvocation(INPUT);
    expect(args[0]).toBe('--strict-mcp-config');
    expect(args[1]).toBe('--mcp-config');
    const config = JSON.parse(args[2]) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    expect(config.mcpServers.kdashboard.type).toBe('http');
    expect(config.mcpServers.kdashboard.url).toBe(INPUT.mcpUrl);
    // The token travels via env, not argv: claude expands `${VAR}` at load.
    expect(config.mcpServers.kdashboard.headers.Authorization).toBe('Bearer ${KDASHBOARD_MCP_TOKEN}');
    expect(args[2]).not.toContain('deadbeef');
    expect(args[3]).toBe('--allowedTools');
    expect(args[4]).toBe('mcp__kdashboard');
    // `--` is required: --allowedTools is variadic and would otherwise eat the
    // prompt, leaving the session sitting on an empty input box.
    expect(args[5]).toBe('--');
    expect(args[6]).toBe(INPUT.prompt);
    expect(env).toEqual({ KDASHBOARD_MCP_TOKEN: 'deadbeef' });
  });

  test('omits the prompt argument when there is no prompt', () => {
    const { args } = getAgentProfile('claude').buildInvocation({ ...INPUT, prompt: undefined });
    expect(args.at(-1)).toBe('mcp__kdashboard');
  });
});

describe('codex profile', () => {
  test('builds -c overrides with a token env var', () => {
    const { args, env } = getAgentProfile('codex').buildInvocation(INPUT);
    expect(args).toEqual([
      '-c',
      `mcp_servers.kdashboard.url="${INPUT.mcpUrl}"`,
      '-c',
      'mcp_servers.kdashboard.bearer_token_env_var="KDASHBOARD_MCP_TOKEN"',
      '-c',
      'mcp_servers.kdashboard.default_tools_approval_mode="approve"',
      INPUT.prompt,
    ]);
    expect(env.KDASHBOARD_MCP_TOKEN).toBe('deadbeef');
  });

  test('warns on a pre-HTTP-MCP version and accepts a recent one', () => {
    const codex = getAgentProfile('codex');
    expect(codex.versionWarning?.('codex-cli 0.45.1')).toMatch(/too old/);
    expect(codex.versionWarning?.('codex-cli 0.146.0')).toBeNull();
    expect(codex.versionWarning?.('1.2.0')).toBeNull();
  });
});

describe('fake profile', () => {
  test('only exists when KDASH_AGENT_FAKE_BIN is set', () => {
    const prev = process.env.KDASH_AGENT_FAKE_BIN;
    try {
      delete process.env.KDASH_AGENT_FAKE_BIN;
      expect(getAgentProfiles().map((p) => p.id)).toEqual(['claude', 'codex']);
      process.env.KDASH_AGENT_FAKE_BIN = '/tmp/fake-agent.sh';
      const ids = getAgentProfiles().map((p) => p.id);
      expect(ids).toContain('fake');
      const { env } = getAgentProfile('fake').buildInvocation(INPUT);
      expect(env.KDASH_MCP_URL).toBe(INPUT.mcpUrl);
      expect(env.KDASH_MCP_TOKEN).toBe(INPUT.mcpToken);
    } finally {
      if (prev === undefined) delete process.env.KDASH_AGENT_FAKE_BIN;
      else process.env.KDASH_AGENT_FAKE_BIN = prev;
    }
  });
});
