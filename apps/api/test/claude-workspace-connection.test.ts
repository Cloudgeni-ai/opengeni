import { expect, test } from "bun:test";
import { assertClaudeWorkspaceCredential } from "../src/claude-workspace-connection";

const identity = { accountUuid: "11111111-1111-4111-8111-111111111111", deviceId: "a".repeat(64) };
const connection = (role: "anthropic" | "claude_subscription") => ({
  subjectId: null,
  providerDomain: "api.anthropic.com",
  kind: "api_key",
  metadata: { credentialRole: role },
  credential: {
    apiKey:
      role === "anthropic"
        ? "sk-ant-api03-test-key"
        : JSON.stringify({ version: 1, token: "sk-ant-oat01-test-token", identity }),
  },
});
test("subscription is disabled by deployment flag while API keys remain available", () => {
  expect(() =>
    assertClaudeWorkspaceCredential({ claudeSubscriptionEnabled: false }, connection("anthropic")),
  ).not.toThrow();
  expect(() =>
    assertClaudeWorkspaceCredential(
      { claudeSubscriptionEnabled: false },
      connection("claude_subscription"),
    ),
  ).toThrow("not enabled");
  expect(() =>
    assertClaudeWorkspaceCredential(
      { claudeSubscriptionEnabled: true },
      connection("claude_subscription"),
    ),
  ).not.toThrow();
});
test("Claude credentials cannot enter the model lane under a personal owner or different endpoint", () => {
  for (const role of ["anthropic", "claude_subscription"] as const) {
    for (const change of [
      { subjectId: "person" },
      { providerDomain: "evil.example" },
      { kind: "oauth2" },
    ])
      expect(() =>
        assertClaudeWorkspaceCredential(
          { claudeSubscriptionEnabled: true },
          { ...connection(role), ...change },
        ),
      ).toThrow("must belong");
  }
});
test("keys and subscription tokens are not interchangeable and identity is required", () => {
  for (const [role, value] of [
    ["anthropic", "sk-ant-oat01-token"],
    ["claude_subscription", "sk-ant-api03-key"],
    ["claude_subscription", JSON.stringify({ version: 1, token: "sk-ant-oat01-token" })],
  ] as const)
    expect(() =>
      assertClaudeWorkspaceCredential(
        { claudeSubscriptionEnabled: true },
        { ...connection(role), credential: { apiKey: value } },
      ),
    ).toThrow();
});
test("other providers remain outside Claude-specific validation", () => {
  expect(() =>
    assertClaudeWorkspaceCredential(
      { claudeSubscriptionEnabled: false },
      { ...connection("anthropic"), metadata: { credentialRole: "openrouter" }, credential: {} },
    ),
  ).not.toThrow();
});
