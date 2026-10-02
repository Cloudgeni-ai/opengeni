import { describe, expect, test } from "bun:test";

import {
  codingAgentSetupPrompt,
  deploymentApiOrigin,
  developerSetupModelContext,
  formatCreditAmount,
} from "./onboarding-use-case";

const facts = {
  apiBaseUrl: "https://app.opengeni.ai",
  organizationId: "22222222-2222-4222-8222-222222222222",
  organizationName: "Acme",
};

describe("onboarding use case text", () => {
  test("the coding-agent prompt carries the key once, with how to keep it safe", () => {
    const prompt = codingAgentSetupPrompt({ ...facts, apiKey: "ogk_secret_value" });
    expect(prompt.split("ogk_secret_value")).toHaveLength(2);
    expect(prompt).toContain("Opengeni API: https://app.opengeni.ai");
    expect(prompt).toContain("Organization: Acme (ID 22222222-2222-4222-8222-222222222222)");
    expect(prompt).toContain("server-only .env");
    expect(prompt).toContain("Never print, log, commit or repeat it");
    for (const host of ["Claude Code:", "Codex:", "Cursor:", "Anything else:"]) {
      expect(prompt).toContain(host);
    }
  });

  test("the setup chat context names where the key is, never a key", () => {
    const withKey = developerSetupModelContext({ ...facts, keyInSandbox: true });
    expect(withKey).toContain("DEVELOPER_SETUP_API_KEY environment variable");
    expect(withKey).toContain("never write it into this chat");
    expect(withKey).toContain("builtin:opengeni-client");
    expect(withKey).not.toMatch(/ogk_/);
    const withoutKey = developerSetupModelContext({ ...facts, keyInSandbox: false });
    expect(withoutKey).toContain("No API key is attached to this chat.");
    expect(withoutKey).not.toContain("DEVELOPER_SETUP_API_KEY");
    // Model context is bounded by the create-session contract.
    expect(withKey.length).toBeLessThan(32_768);
  });

  test("credit amounts drop cents only when there are none", () => {
    expect(formatCreditAmount(10_000_000, "usd")).toBe("$10");
    expect(formatCreditAmount(7_250_000, "usd")).toBe("$7.25");
  });

  test("the API origin follows the configured base URL, else this page", () => {
    const location = { origin: "https://app.example.test", href: "https://app.example.test/x" };
    expect(deploymentApiOrigin("", location)).toBe("https://app.example.test");
    expect(deploymentApiOrigin("https://api.example.test/base", location)).toBe(
      "https://api.example.test",
    );
  });
});
