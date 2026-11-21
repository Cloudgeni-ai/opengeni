import { describe, expect, test } from "bun:test";
import { resolveWorkspaceGitHubRepository } from "../src/integrations/session-link-status";

// The workspace's App installations, changed between reads below.
let installations: {
  installationId: number;
  accountLogin: string;
  repositoryScope: "all" | "selected";
  repositoryIds: number[];
}[] = [];
let repositoryLookups = 0;
const io = {
  listInstallations: (async () => installations) as never,
  lookupRepository: (async () => {
    repositoryLookups += 1;
    return { id: 101, fullName: "Acme/API" };
  }) as never,
};
const deps = {
  db: {},
  settings: {
    githubAppId: "1",
    githubClientId: "client",
    githubClientSecret: "secret",
    githubAppSlug: "opengeni",
    githubAppPrivateKey: "key",
  },
} as never;

describe("reading a linked repository through the workspace's GitHub App", () => {
  test("canonical name, and the workspace's repository choice checked on every read", async () => {
    installations = [
      {
        installationId: 1,
        accountLogin: "Acme",
        repositoryScope: "selected",
        repositoryIds: [101],
      },
    ];
    expect(await resolveWorkspaceGitHubRepository(deps, "ws-1", "acme", "api", io)).toEqual({
      installationId: 1,
      repositoryId: 101,
      fullName: "Acme/API",
    });
    // The workspace drops the repository: the next read refuses at once.
    installations = [
      { installationId: 1, accountLogin: "Acme", repositoryScope: "selected", repositoryIds: [] },
    ];
    expect(await resolveWorkspaceGitHubRepository(deps, "ws-1", "acme", "api", io)).toBeNull();
    // And the App removed altogether.
    installations = [];
    expect(await resolveWorkspaceGitHubRepository(deps, "ws-1", "acme", "api", io)).toBeNull();
    // Repository metadata was looked up once and reused.
    expect(repositoryLookups).toBe(1);
  });
});
