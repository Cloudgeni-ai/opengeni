import { describe, expect, test } from "bun:test";

import {
  codingAgentSetupPrompt,
  deploymentApiOrigin,
  developerSetupKeyRequest,
  developerSetupModelContext,
  formatCreditAmount,
  storeOnboardingUseCase,
  storedOnboardingUseCase,
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
    expect(prompt).toContain("If it isn't there yet, ask me for it.");
    expect(prompt).toContain("Opengeni API: https://app.opengeni.ai");
    expect(prompt).toContain("Organization: Acme (ID 22222222-2222-4222-8222-222222222222)");
    expect(prompt).toContain("used only by the server (never in browser code)");
    for (const host of ["Claude Code:", "Codex:", "Cursor:", "Anything else:"]) {
      expect(prompt).toContain(host);
    }
    expect(prompt).toContain("one server route plus the OpenGeniChat component");
    expect(prompt).not.toContain("OPENGENI_ORGANIZATION_ID");
    // The SDK defaults to Opengeni Cloud; only other deployments name their origin.
    expect(prompt).not.toContain("OPENGENI_API_BASE_URL");
    expect(
      codingAgentSetupPrompt({ ...facts, apiBaseUrl: "https://opengeni.example.com" }),
    ).toContain("OPENGENI_API_BASE_URL=https://opengeni.example.com");
  });

  test("the setup chat context names where the key is, never a key", () => {
    const withKey = developerSetupModelContext({ ...facts, keyInSandbox: true });
    expect(withKey).toContain("DEVELOPER_SETUP_API_KEY environment variable");
    expect(withKey).toContain("builtin:opengeni-client");
    expect(withKey).toContain("one /api/opengeni server route plus the OpenGeniChat component");
    // Connecting GitHub gives the setup chat no Git credentials: the person
    // attaches a repository with the card's Use button and the chat implements
    // there; a repository-attached worker is only the fallback.
    expect(withKey).toContain('"Use" button');
    expect(withKey).toContain("don't ask me again in a separate question");
    // A person's reply does not supersede an agent wait, so waiting for the
    // repository choice with wait_for_input left a days-long wait behind.
    expect(withKey).toContain("Don't call wait_for_input for my answer");
    expect(withKey).not.toContain("then wait,");
    expect(withKey).toContain("call github_repositories_list");
    expect(withKey).toContain("session_create, passing that repository's returned resource");
    expect(withKey).toContain("give me the worker's pull request link");
    expect(withKey).toContain("the card still appears and lists my repositories");
    expect(withKey).toContain("tell me in one short line what it is building");
    // Text written before tool calls folds into the step list, so the final
    // message must carry the setup question.
    expect(withKey).toContain(
      "End the turn with one short final message that repeats the question",
    );
    // No GitHub App access must never dead-end the setup.
    expect(withKey).toContain("If I can't connect GitHub");
    expect(withKey).toContain("upload a zip of my project");
    expect(withKey).toContain("publish it with sandbox_file_publish");
    expect(withKey).toContain("stop every dev server and background command you started");
    expect(withKey).toContain("my own Git credentials for the repository");
    expect(withKey).toContain("use my own coding agent instead");
    // An attached project zip is the code: never send the person back to GitHub.
    expect(withKey).toContain("that is my code: work from them right away");
    expect(withKey).not.toMatch(/ogk_/);
    const withoutKey = developerSetupModelContext({ ...facts, keyInSandbox: false });
    expect(withoutKey).toContain("No API key is attached to this chat.");
    expect(withoutKey).not.toContain("DEVELOPER_SETUP_API_KEY");
    // Model context is bounded by the create-session contract.
    expect(withKey.length).toBeLessThan(32_768);
  });

  test("the signup setup key has full access, lasts 30 days, and the copy says so", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    expect(developerSetupKeyRequest(now)).toEqual({
      name: "Setup (full access)",
      description: "Created at signup so an agent can set up Opengeni in your product end to end.",
      access: "full",
      expiresAt: "2026-11-02T12:00:00.000Z",
    });
    expect(codingAgentSetupPrompt(facts)).toContain("expires in 30 days");
    expect(developerSetupModelContext({ ...facts, keyInSandbox: true })).toContain(
      "It expires in 30 days",
    );
  });

  test("the use-case answer survives a reload until it is cleared", () => {
    const store = new Map<string, string>();
    const sessionStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    const hadWindow = "window" in globalThis;
    if (!hadWindow) Object.assign(globalThis, { window: { sessionStorage } });
    storeOnboardingUseCase(null);
    expect(storedOnboardingUseCase()).toBeNull();
    storeOnboardingUseCase("embed");
    expect(storedOnboardingUseCase()).toBe("embed");
    window.sessionStorage.setItem("opengeni.onboardingUseCase.v1", "bogus");
    expect(storedOnboardingUseCase()).toBeNull();
    storeOnboardingUseCase(null);
    expect(storedOnboardingUseCase()).toBeNull();
    if (!hadWindow) delete (globalThis as { window?: unknown }).window;
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
