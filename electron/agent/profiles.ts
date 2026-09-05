// Agent Profiles — the description of each supported agent CLI: how to find
// it, how to hand it the MCP endpoint and an initial prompt, and how to warn
// when the installed version cannot do what we need.
//
// Built-ins: claude (Claude Code), codex (OpenAI Codex CLI), and a test-only
// `fake` profile (any script path via KDASH_AGENT_FAKE_BIN) that is the test
// seam for the whole session subsystem — CI needs no real CLI or API keys.
//
// CLI facts verified 2026-08-16 (see .scratch/ai-agent/SPEC.md):
//  - claude: `--strict-mcp-config --mcp-config <json>` for a fully
//    self-contained MCP config (`${VAR}` in headers expands from the env);
//    `--allowedTools mcp__<server>` pre-approves all tools of that server; a
//    positional prompt after `--` starts interactive with it (the `--` is
//    required: --allowedTools is variadic).
//  - codex: native streamable-HTTP MCP via `mcp_servers.<name>.url` +
//    `bearer_token_env_var`, injectable per-invocation with `-c` overrides
//    (merge over the user's config.toml — accepted limitation);
//    `default_tools_approval_mode="approve"` pre-approves the server's tools;
//    positional prompt starts the TUI with it.

import { execFile } from 'node:child_process';

export interface AgentInvocationInput {
  prompt?: string;
  mcpUrl: string;
  mcpToken: string;
}

export interface AgentInvocation {
  args: string[];
  /** Extra env vars merged over the user's environment. */
  env: Record<string, string>;
}

export interface AgentProfile {
  id: string;
  displayName: string;
  /** Binary name resolved on PATH (or an absolute path for the fake profile). */
  binary: string;
  installUrl: string;
  buildInvocation(input: AgentInvocationInput): AgentInvocation;
  /** Warning for an installed-but-unusable version, or null. */
  versionWarning?(version: string): string | null;
}

/** MCP server key the agent sees; tool names become mcp__kdashboard__<tool>. */
const MCP_SERVER_NAME = 'kdashboard';

/**
 * Env var carrying the bearer token. Both CLIs read it from the environment
 * (codex: bearer_token_env_var; claude: `${VAR}` expansion inside the MCP
 * config, verified 2026-09-05 on claude 2.1.261) so the token never appears
 * in argv, where any local process could read it from `ps`.
 */
const TOKEN_ENV = 'KDASHBOARD_MCP_TOKEN';

// Codex gained native streamable-HTTP MCP in late 2025 (verified working at
// 0.146.0; earlier builds gated it behind experimental_use_rmcp_client). The
// exact introducing release is not documented, so this is a conservative floor.
const CODEX_MIN_MAJOR_MINOR: [number, number] = [0, 100];

const claudeProfile: AgentProfile = {
  id: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  installUrl: 'https://code.claude.com/docs/en/overview',
  buildInvocation({ prompt, mcpUrl, mcpToken }): AgentInvocation {
    const mcpConfig = {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: mcpUrl,
          // Literal `${...}`: claude expands it from the env at load time.
          headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
        },
      },
    };
    return {
      args: [
        '--strict-mcp-config',
        '--mcp-config',
        JSON.stringify(mcpConfig),
        '--allowedTools',
        `mcp__${MCP_SERVER_NAME}`,
        // `--` terminates the option list. Without it the variadic
        // `--allowedTools <tools...>` swallows the positional prompt, the
        // session opens on an empty input box and the Quick Action is lost.
        ...(prompt ? ['--', prompt] : []),
      ],
      env: { [TOKEN_ENV]: mcpToken },
    };
  },
};

const codexProfile: AgentProfile = {
  id: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',
  installUrl: 'https://developers.openai.com/codex/cli',
  buildInvocation({ prompt, mcpUrl, mcpToken }): AgentInvocation {
    return {
      args: [
        '-c',
        `mcp_servers.${MCP_SERVER_NAME}.url="${mcpUrl}"`,
        '-c',
        `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var="${TOKEN_ENV}"`,
        // Pre-approve every kdashboard tool inside codex (verified 2026-09-05
        // on codex 0.149.1). The default mode ("auto") still prompts for any
        // tool without a readOnlyHint, so codex's own approval popped on top
        // of kdashboard's Mutation Approval and `codex exec` refused the call
        // outright. "approve" never prompts; mutations stay gated by
        // kdashboard's own approval dialog.
        '-c',
        `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
        ...(prompt ? [prompt] : []),
      ],
      env: { [TOKEN_ENV]: mcpToken },
    };
  },
  versionWarning(version: string): string | null {
    const match = /(\d+)\.(\d+)/.exec(version);
    if (!match) return null;
    const [major, minor] = [Number(match[1]), Number(match[2])];
    const [minMajor, minMinor] = CODEX_MIN_MAJOR_MINOR;
    if (major > minMajor || (major === minMajor && minor >= minMinor)) return null;
    return (
      `codex ${version} may be too old for MCP over HTTP ` +
      `(needs roughly ${minMajor}.${minMinor}+). Update with: npm i -g @openai/codex`
    );
  },
};

/**
 * Test/dev-only profile: KDASH_AGENT_FAKE_BIN points at any executable, which
 * receives the prompt as argv[1] and the endpoint via env. This is the test
 * seam for the session subsystem.
 */
function fakeProfile(): AgentProfile | null {
  const bin = process.env.KDASH_AGENT_FAKE_BIN;
  if (!bin) return null;
  return {
    id: 'fake',
    displayName: 'Fake agent (test)',
    binary: bin,
    installUrl: '',
    buildInvocation({ prompt, mcpUrl, mcpToken }): AgentInvocation {
      return {
        args: prompt ? [prompt] : [],
        env: { KDASH_MCP_URL: mcpUrl, KDASH_MCP_TOKEN: mcpToken },
      };
    },
  };
}

export function getAgentProfiles(): AgentProfile[] {
  const fake = fakeProfile();
  return [claudeProfile, codexProfile, ...(fake ? [fake] : [])];
}

export function getAgentProfile(id: string): AgentProfile {
  const profile = getAgentProfiles().find((p) => p.id === id);
  if (!profile) throw new Error(`Unknown agent profile: ${id}`);
  return profile;
}

export interface AgentProfileStatus {
  id: string;
  displayName: string;
  available: boolean;
  version?: string;
  warning?: string;
  installUrl: string;
}

/** `<binary> --version` with a timeout; null when not runnable (not installed). */
function probeVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 5_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/** Availability + version + warning per profile, for the renderer's picker. */
export async function getAgentProfileStatuses(): Promise<AgentProfileStatus[]> {
  return Promise.all(
    getAgentProfiles().map(async (profile) => {
      // The fake profile is a script we control; probing --version is wrong.
      if (profile.id === 'fake') {
        return {
          id: profile.id,
          displayName: profile.displayName,
          available: true,
          installUrl: profile.installUrl,
        };
      }
      const version = await probeVersion(profile.binary);
      if (version === null) {
        return {
          id: profile.id,
          displayName: profile.displayName,
          available: false,
          installUrl: profile.installUrl,
        };
      }
      const warning = profile.versionWarning?.(version) ?? undefined;
      return {
        id: profile.id,
        displayName: profile.displayName,
        available: true,
        version,
        warning,
        installUrl: profile.installUrl,
      };
    }),
  );
}
