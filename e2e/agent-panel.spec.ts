/**
 * AI Agent panel smoke — mocked IPC (see fixtures/mocked-cluster.ts): the
 * renderer-only e2e server has no Electron main process, so this covers panel
 * chrome, profile detection states and the start round-trip, not the PTY.
 * The PTY/MCP path is covered by electron/integration/agent-*.itest.ts.
 */

import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const PROFILES_AVAILABLE = `(cmd, args) => {
  if (cmd === "get_agent_profiles") {
    return [
      { id: "claude", displayName: "Claude Code", available: true, version: "2.1.0", installUrl: "https://code.claude.com" },
      { id: "codex", displayName: "Codex CLI", available: false, installUrl: "https://developers.openai.com/codex/cli" },
    ];
  }
  if (cmd === "start_agent_session") {
    window.__startedAgent = args;
    return { sessionId: "e2e-session" };
  }
  return undefined;
}`;

const PROFILES_MISSING = `(cmd) => {
  if (cmd === "get_agent_profiles") {
    return [
      { id: "claude", displayName: "Claude Code", available: false, installUrl: "https://code.claude.com" },
      { id: "codex", displayName: "Codex CLI", available: false, installUrl: "https://developers.openai.com/codex/cli" },
    ];
  }
  return undefined;
}`;

test("status bar button opens the agent panel", async ({ page, mockInvoke }) => {
  await mockInvoke(clusterBootMock(PROFILES_AVAILABLE));
  await page.goto("/");

  await page.getByTitle("AI agent").click();
  const panel = page.getByTestId("agent-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("AI Agent")).toBeVisible();
  await expect(panel.getByText("Start a session", { exact: false })).toBeVisible();
});

test("start launches the selected profile over IPC", async ({ page, mockInvoke }) => {
  await mockInvoke(clusterBootMock(PROFILES_AVAILABLE));
  await page.goto("/");

  await page.getByTitle("AI agent").click();
  const panel = page.getByTestId("agent-panel");
  await panel.getByRole("button", { name: "Start" }).click();

  await expect(panel.getByText("RUNNING")).toBeVisible();
  const started = await page.evaluate(() => (window as unknown as { __startedAgent: unknown }).__startedAgent);
  expect(started).toMatchObject({ profileId: "claude" });
});

test("missing CLIs show the install guidance", async ({ page, mockInvoke }) => {
  await mockInvoke(clusterBootMock(PROFILES_MISSING));
  await page.goto("/");

  await page.getByTitle("AI agent").click();
  const panel = page.getByTestId("agent-panel");
  await expect(panel.getByText("No agent CLI found", { exact: false })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Start" })).toBeDisabled();
});
