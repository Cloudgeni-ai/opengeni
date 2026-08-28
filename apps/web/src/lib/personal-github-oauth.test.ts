import { describe, expect, test } from "bun:test";

import {
  personalGitHubOAuthFailureMessage,
  personalGitHubOAuthReturn,
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
