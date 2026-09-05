/**
 * AI Agent panel smoke — mocked IPC (see fixtures/mocked-cluster.ts): the
 * renderer-only e2e server has no Electron main process, so this covers panel
 * chrome, profile detection states and the start round-trip, not the PTY.
 * The PTY/MCP path is covered by electron/integration/agent-*.itest.ts.
 */

import { test, expect, clusterBootMock } from "./fixtures/mocked-cluster";

const PROFILES_AVAILABLE = `(cmd, args) => {
  // The command palette iterates CRD groups on open; the boot mock alone
  // leaves them null.
  if (cmd === "discover_crds") return [];
  if (cmd === "list_resources") return { resource_type: args.resourceType, items: [] };
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

test("hiding the panel keeps the session running; ⌘J brings it back", async ({ page, mockInvoke }) => {
  await mockInvoke(clusterBootMock(PROFILES_AVAILABLE));
  await page.goto("/");

  await page.getByTitle("AI agent").click();
  const panel = page.getByTestId("agent-panel");
  await panel.getByRole("button", { name: "Start" }).click();
  await expect(panel.getByText("RUNNING")).toBeVisible();

  await panel.getByRole("button", { name: "Hide agent panel" }).click();
  await expect(panel).toBeHidden();
  // The status bar still advertises the live session.
  await expect(page.getByTitle("AI agent (running, hidden)")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("agent-panel")).toBeVisible();
  await expect(page.getByTestId("agent-panel").getByText("RUNNING")).toBeVisible();
});

test("the command palette lists the agent toggle", async ({ page, mockInvoke }) => {
  await mockInvoke(clusterBootMock(PROFILES_AVAILABLE));
  await page.goto("/");

  // Give the document focus first: synthetic key events need a target.
  await page.getByTitle("AI agent").waitFor();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator('[data-testid="command-input"]').fill("Open AI Agent");
  await page.locator('[data-testid="command-item"]', { hasText: "Open AI Agent" }).click();
  await expect(page.getByTestId("agent-panel")).toBeVisible();
});
