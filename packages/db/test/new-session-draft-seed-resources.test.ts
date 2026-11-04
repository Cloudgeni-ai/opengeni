import { describe, expect, test } from "bun:test";

import { reusableNewSessionRepositoryResource } from "../src/new-session-drafts";

describe("the next new-session draft keeps each repository's selection", () => {
  test("a personal GitHub selection stays an As-you selection, not a bare URL", () => {
    expect(
      reusableNewSessionRepositoryResource({
        kind: "repository",
        uri: "https://github.com/Cloudgeni-ai/opengeni-identity-test",
        ref: "main",
        mountPath: "repos/github.com/Cloudgeni-ai/opengeni-identity-test",
        provider: "github",
        connectionType: "github_personal",
        credentialBindingId: "7f0c8f5e-2a51-4f40-9d8e-1c3e7b9a6d21",
        repositoryId: "1093247711",
        access: "write",
      }),
    ).toEqual({
      kind: "repository",
      uri: "https://github.com/Cloudgeni-ai/opengeni-identity-test",
      ref: "main",
      mountPath: "repos/github.com/Cloudgeni-ai/opengeni-identity-test",
      provider: "github",
      connectionType: "github_personal",
      credentialBindingId: "7f0c8f5e-2a51-4f40-9d8e-1c3e7b9a6d21",
      repositoryId: "1093247711",
      access: "write",
    });
  });

  test("a GitHub App selection keeps only its stable GitHub identity", () => {
    expect(
      reusableNewSessionRepositoryResource({
        kind: "repository",
        uri: "https://github.com/benyhh/grocery-bot.git",
        ref: "main",
        mountPath: "repos/github.com/benyhh/grocery-bot.git",
        provider: "github",
        credentialBindingId: "github-installation:456",
        access: "write",
        connectionId: "secret-connection",
        githubRepositoryId: 789,
        githubInstallationId: 456,
      }),
    ).toEqual({
      kind: "repository",
      uri: "https://github.com/benyhh/grocery-bot.git",
      ref: "main",
      mountPath: "repos/github.com/benyhh/grocery-bot.git",
      githubRepositoryId: 789,
      githubInstallationId: 456,
    });
  });

  test("an incomplete personal lane is not kept as a personal selection", () => {
    expect(
      reusableNewSessionRepositoryResource({
        kind: "repository",
        uri: "https://github.com/Cloudgeni-ai/opengeni-identity-test",
        ref: "main",
        provider: "github",
        connectionType: "github_personal",
        repositoryId: "1093247711",
      }),
    ).toEqual({
      kind: "repository",
      uri: "https://github.com/Cloudgeni-ai/opengeni-identity-test",
      ref: "main",
    });
  });
});
