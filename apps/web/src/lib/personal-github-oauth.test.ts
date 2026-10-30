import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { personalGitHubSetupPath } from "@opengeni/contracts/personal-github";

import {
  markPersonalGitHubRepositoryChooser,
  personalGitHubOAuthFailureMessage,
  personalGitHubOAuthReturn,
  personalGitHubSetupLink,
  takePersonalGitHubRepositoryChooser,
} from "./personal-github-oauth";

describe("personal GitHub OAuth return", () => {
  test("consumes only its callback fields and preserves the capabilities location", () => {
    expect(
      personalGitHubOAuthReturn(
        "?tab=apps&github_personal_oauth=success&connectionId=connection-1",
      ),
    ).toEqual({ outcome: "success", reason: null, cleanedSearch: "?tab=apps" });
    expect(personalGitHubOAuthReturn("?tab=apps")).toBeNull();
  });

  test("turns provider reasons into short retry guidance", () => {
    expect(personalGitHubOAuthFailureMessage("provider_denied")).toBe(
      "GitHub authorization was cancelled.",
    );
    expect(personalGitHubOAuthFailureMessage("state_replayed")).toContain("expired");
    expect(personalGitHubOAuthFailureMessage("unexpected")).toContain("changed");
  });
});

describe("Your GitHub setup link", () => {
  test("the agent's link opens the GitHub sheet on Your GitHub and the marker is removable", () => {
    const path = personalGitHubSetupPath("ws 1");
    expect(path).toBe("/workspaces/ws%201/plugins?open=integration%3Agithub&github=personal");
    const search = new URL(path, "https://app.example.test").search;
    expect(personalGitHubSetupLink(search)).toEqual({
      cleanedSearch: "?open=integration%3Agithub",
    });
    expect(personalGitHubSetupLink("?github=personal")).toEqual({ cleanedSearch: "" });
    expect(personalGitHubSetupLink("?open=integration%3Agithub")).toBeNull();
  });
});

describe("repository chooser after connecting", () => {
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => GlobalRegistrator.unregister());

  test("is taken once, per workspace, and only soon after connecting", () => {
    const now = 1_000_000;
    markPersonalGitHubRepositoryChooser("a", now);
    expect(takePersonalGitHubRepositoryChooser("b", now)).toBe(false);
    expect(takePersonalGitHubRepositoryChooser("a", now + 1_000)).toBe(true);
    expect(takePersonalGitHubRepositoryChooser("a", now + 2_000)).toBe(false);
    markPersonalGitHubRepositoryChooser("a", now);
    expect(takePersonalGitHubRepositoryChooser("a", now + 31 * 60_000)).toBe(false);
  });
});
