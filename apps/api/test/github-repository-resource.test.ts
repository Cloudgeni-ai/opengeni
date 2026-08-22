// The MCP `github_repositories_list` tool returns the resource an agent or a
// scheduled task attaches. Every listed repository is in the workspace's GitHub
// App allowlist, so the projected resource must carry the stable ids for
// public and private repositories alike: a bare URI clones anonymously and can
// never push or use `gh`.

import { describe, expect, test } from "bun:test";
import type { GitHubRepository } from "@opengeni/contracts";
import { repositoryWithScheduledTaskResource } from "../src/mcp/server";

function githubRepository(patch: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    id: 456,
    installationId: 123,
    fullName: "example/public",
    name: "public",
    private: false,
    htmlUrl: "https://github.com/example/public",
    cloneUrl: "https://github.com/example/public.git",
    defaultBranch: "main",
    accountLogin: "example",
    accountType: "Organization",
    ...patch,
  };
}

describe("repositoryWithScheduledTaskResource", () => {
  test("attaches installation and repository ids to a bound public repository", () => {
    expect(repositoryWithScheduledTaskResource(githubRepository()).resource).toEqual({
      kind: "repository",
      uri: "https://github.com/example/public.git",
      ref: "main",
      provider: "github",
      mountPath: "repos/github.com/example/public",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    });
  });

  test("projects a private repository identically", () => {
    const projected = repositoryWithScheduledTaskResource(
      githubRepository({
        id: 789,
        installationId: 124,
        private: true,
        fullName: "Example/Private",
        cloneUrl: "https://GitHub.com/Example/Private.git",
        defaultBranch: "develop",
      }),
    );
    expect(projected.resource).toEqual({
      kind: "repository",
      uri: "https://github.com/Example/Private.git",
      ref: "develop",
      provider: "github",
      mountPath: "repos/github.com/Example/Private",
      githubInstallationId: 124,
      githubRepositoryId: 789,
    });
    expect(projected.private).toBe(true);
  });
});
