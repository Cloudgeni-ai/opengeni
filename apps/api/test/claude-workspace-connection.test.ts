import { expect, test } from "bun:test";
import {
  assertAnthropicApiKey,
  assertClaudeWorkspaceCredential,
  prepareClaudeSubscriptionCredential,
  prepareClaudeWorkspaceCredential,
} from "../src/claude-workspace-connection";
import { testSettings } from "@opengeni/testing/settings";

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
  ).toThrow("individual Claude subscription accounts");
});
test("Claude credentials cannot enter the model lane under a personal owner or different endpoint", () => {
  for (const role of ["anthropic"] as const) {
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
const body = "AbC_dEf-123";
test.each([
  ["Console API key", `sk-ant-api03-${body}`, `sk-ant-api03-${body}`],
  ["personal key", `sk-ant-usr-${body}`, `sk-ant-usr-${body}`],
  ["service-account key", `sk-ant-svc-${body}`, `sk-ant-svc-${body}`],
  ["future key kind", `sk-ant-xyz09-${body}`, `sk-ant-xyz09-${body}`],
  ["key without a kind", `sk-ant-${body}`, `sk-ant-${body}`],
  ["trailing newline", `sk-ant-usr-${body}\n`, `sk-ant-usr-${body}`],
  [
    "line break inside",
    `  sk-ant-api03-${body.slice(0, 5)}\r\n${body.slice(5)}  `,
    `sk-ant-api03-${body}`,
  ],
  ["env-file quotes", `"sk-ant-svc-${body}"`, `sk-ant-svc-${body}`],
  ["invisible characters", `\uFEFFsk-ant-usr-${body}\u200B`, `sk-ant-usr-${body}`],
] as const)("Anthropic API key accepted: %s", (_label, pasted, stored) => {
  expect(assertAnthropicApiKey(pasted)).toBe(stored);
  expect(() =>
    assertClaudeWorkspaceCredential(
      { claudeSubscriptionEnabled: false },
      { ...connection("anthropic"), credential: { apiKey: pasted } },
    ),
  ).not.toThrow();
  expect(
    prepareClaudeWorkspaceCredential(
      testSettings(),
      "one",
      { credentialRole: "anthropic" },
      { apiKey: pasted },
    ),
  ).toEqual({ apiKey: stored });
});
test.each([
  ["empty", "", "Use Claude subscription for setup tokens"],
  ["whitespace only", " \n ", "Use Claude subscription for setup tokens"],
  ["setup token", " sk-ant-oat01-token\n", "Use Claude subscription for setup tokens"],
  ["setup token, upper case", "SK-ANT-OAT01-token", "Use Claude subscription for setup tokens"],
  ["OAuth refresh token", "sk-ant-ort01-token", "Use Claude subscription for setup tokens"],
  ["Admin API key", "sk-ant-admin01-key", "Admin API key, which can't run models"],
] as const)("Anthropic API key refused: %s", (_label, refused, message) => {
  expect(() => assertAnthropicApiKey(refused)).toThrow(message);
  expect(() =>
    assertClaudeWorkspaceCredential(
      { claudeSubscriptionEnabled: false },
      { ...connection("anthropic"), credential: { apiKey: refused } },
    ),
  ).toThrow(message);
});
test("token-only setup creates an encrypted-bundle identity stable across retries and replacement", () => {
  const settings = testSettings({
    claudeSubscriptionEnabled: true,
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  });
  const first = prepareClaudeSubscriptionCredential(
    settings,
    "workspace:one",
    "sk-ant-oat01-token",
  );
  const bundle = JSON.parse(first);
  expect(bundle.identity.accountUuid).toBe("");
  expect(bundle.identity.deviceId).toMatch(/^[a-f0-9]{64}$/);
  expect(prepareClaudeSubscriptionCredential(settings, "workspace:one", "sk-ant-oat01-token")).toBe(
    first,
  );
  expect(
    JSON.parse(
      prepareClaudeSubscriptionCredential(settings, "workspace:one", "sk-ant-oat01-replacement"),
    ).identity,
  ).toEqual(bundle.identity);
  expect(
    JSON.parse(
      prepareClaudeSubscriptionCredential(settings, "organization:one", "sk-ant-oat01-token"),
    ).identity,
  ).not.toEqual(bundle.identity);
  expect(() =>
    prepareClaudeWorkspaceCredential(
      settings,
      "one",
      { credentialRole: "claude_subscription" },
      { apiKey: "sk-ant-oat01-token" },
    ),
  ).toThrow("individual Claude subscription accounts");
});
test("legacy explicit identity remains valid and API keys are unchanged", () => {
  const settings = testSettings({
    claudeSubscriptionEnabled: true,
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  });
  const credential = connection("claude_subscription").credential;
  expect(() =>
    prepareClaudeWorkspaceCredential(
      settings,
      "one",
      { credentialRole: "claude_subscription" },
      credential,
    ),
  ).toThrow("individual Claude subscription accounts");
  expect(
    JSON.parse(
      prepareClaudeSubscriptionCredential(
        settings,
        "organization:one",
        "sk-ant-oat01-token",
        identity,
      ),
    ).identity,
  ).toEqual(identity);
  expect(
    prepareClaudeWorkspaceCredential(
      settings,
      "one",
      { credentialRole: "anthropic" },
      { apiKey: "sk-ant-api03-key" },
    ),
  ).toEqual({ apiKey: "sk-ant-api03-key" });
  expect(() =>
    prepareClaudeSubscriptionCredential(
      { ...settings, claudeSubscriptionEnabled: false },
      "workspace:one",
      "sk-ant-oat01-token",
    ),
  ).toThrow("not enabled");
});
