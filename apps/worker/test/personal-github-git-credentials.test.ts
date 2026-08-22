import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { buildPersonalGitHubGitCredentials } from "../src/personal-github-git-credentials";

describe("personal GitHub Git credential consumer", () => {
  test("is absent by default and cannot affect the GitHub App lane", () => {
    expect(
      buildPersonalGitHubGitCredentials(
        {} as never,
        testSettings({
          githubPersonalOauthEnabled: false,
        }),
      ),
    ).toBeNull();
  });

  test("requires one HTTPS credential-free public broker origin when enabled", () => {
    expect(() =>
      buildPersonalGitHubGitCredentials(
        {} as never,
        testSettings({
          githubPersonalOauthEnabled: true,
          integrationsStateSecret: "broker-secret",
          publicBaseUrl: "http://api.internal.test",
        }),
      ),
    ).toThrow("personal GitHub Git broker configuration is unavailable");
  });
});
