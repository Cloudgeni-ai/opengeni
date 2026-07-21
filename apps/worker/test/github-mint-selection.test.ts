// The worker-side revocation recheck (assertGitHubResourcesRemainAuthorized in
// agent-turn.ts) must cover EXACTLY the ids the git-credential mint would use,
// or an unlink/rescope leaves a mintable hole. gitHubTokenMintSelection is that
// shared extraction; these tests pin the ref shapes the mint path accepts —
// including legacy string-typed provider ids, which an earlier guard variant
// silently skipped.

import { describe, expect, test } from "bun:test";
import type { ResourceRef } from "@opengeni/contracts";
import { gitHubTokenMintSelection } from "../src/activities/environment";

const repo = (overrides: Record<string, unknown>): ResourceRef =>
  ({
    kind: "repository",
    uri: "github.com/acme/repo",
    ref: "main",
    ...overrides,
  }) as ResourceRef;

describe("gitHubTokenMintSelection", () => {
  test("selects explicit githubInstallationId/githubRepositoryId refs", () => {
    expect(
      gitHubTokenMintSelection([repo({ githubInstallationId: 123, githubRepositoryId: 456 })]),
    ).toEqual({ installationId: 123, repositoryIds: [456] });
  });

  test("selects legacy string-typed provider ids exactly as the mint path coerces them", () => {
    expect(
      gitHubTokenMintSelection([
        repo({ provider: "github", installationId: "123", repositoryId: "456" }),
      ]),
    ).toEqual({ installationId: 123, repositoryIds: [456] });
  });

  test("merges mixed ref shapes for one installation", () => {
    expect(
      gitHubTokenMintSelection([
        repo({ githubInstallationId: 123, githubRepositoryId: 456 }),
        repo({ provider: "github", installationId: "123", repositoryId: "789" }),
      ]),
    ).toEqual({ installationId: 123, repositoryIds: [456, 789] });
  });

  test("returns null when no resource would mint a GitHub token", () => {
    expect(gitHubTokenMintSelection([])).toBeNull();
    expect(gitHubTokenMintSelection([repo({})])).toBeNull();
    expect(gitHubTokenMintSelection([{ kind: "file", fileId: crypto.randomUUID() }])).toBeNull();
    // Provider-less legacy ids are not inferred as GitHub by the mint path.
    expect(gitHubTokenMintSelection([repo({ installationId: 123, repositoryId: 456 })])).toBeNull();
  });

  test("throws on refs spanning two installations, matching the mint path", () => {
    expect(() =>
      gitHubTokenMintSelection([
        repo({ githubInstallationId: 123, githubRepositoryId: 456 }),
        repo({ githubInstallationId: 124, githubRepositoryId: 789 }),
      ]),
    ).toThrow("GitHub App repository resources must belong to one installation");
  });
});
