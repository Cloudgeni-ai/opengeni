import { describe, expect, test } from "bun:test";

import {
  codingAgentSetupPrompt,
  deploymentApiOrigin,
  developerSetupKeyRequest,
  developerSetupModelContext,
  formatCreditAmount,
} from "./onboarding-use-case";

const facts = {
  apiBaseUrl: "https://app.opengeni.ai",
  organizationId: "22222222-2222-4222-8222-222222222222",
  organizationName: "Acme",
};

describe("onboarding use case text", () => {
  test("the coding-agent prompt names where the key goes, never a key", () => {
    const prompt = codingAgentSetupPrompt(facts);
    expect(prompt).not.toMatch(/ogk_/);
    expect(prompt).toContain("server-only .env as OPENGENI_API_KEY");
    expect(prompt).toContain("never ask me to paste it into this chat");
    expect(prompt).toContain("Opengeni API: https://app.opengeni.ai");
    expect(prompt).toContain("Organization: Acme (ID 22222222-2222-4222-8222-222222222222)");
    expect(prompt).toContain("Never print, log or commit the key");
    for (const host of ["Claude Code:", "Codex:", "Cursor:", "Anything else:"]) {
      expect(prompt).toContain(host);
    }
  });

  test("the setup chat context names where the key is, never a key", () => {
    const withKey = developerSetupModelContext({ ...facts, keyInSandbox: true });
    expect(withKey).toContain("DEVELOPER_SETUP_API_KEY environment variable");
    expect(withKey).toContain("never write it into this chat");
    expect(withKey).toContain("builtin:opengeni-client");
    // Connecting GitHub gives the setup chat no Git credentials: the person
    // attaches a repository with the card's Use button and the chat implements
    // there; a repository-attached worker is only the fallback.
    expect(withKey).toContain('"Use" button');
    expect(withKey).toContain("Don't ask me again in a separate question");
    expect(withKey).toContain("call github_repositories_list");
    expect(withKey).toContain("session_create, passing that repository's returned resource");
    expect(withKey).toContain("give me the worker's pull request link");
    expect(withKey).not.toMatch(/ogk_/);
    const withoutKey = developerSetupModelContext({ ...facts, keyInSandbox: false });
    expect(withoutKey).toContain("No API key is attached to this chat.");
    expect(withoutKey).not.toContain("DEVELOPER_SETUP_API_KEY");
    // Model context is bounded by the create-session contract.
    expect(withKey.length).toBeLessThan(32_768);
  });

  test("the signup Developer setup key lasts 30 days, and the copy says so", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    expect(developerSetupKeyRequest(now)).toEqual({
      name: "Developer setup",
      description: "Created at signup to add Opengeni agents to your product.",
      access: "developer_setup",
      expiresAt: "2026-11-02T12:00:00.000Z",
    });
    expect(codingAgentSetupPrompt(facts)).toContain("expires in 30 days");
    expect(developerSetupModelContext({ ...facts, keyInSandbox: true })).toContain(
      "It expires in 30 days",
    );
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
