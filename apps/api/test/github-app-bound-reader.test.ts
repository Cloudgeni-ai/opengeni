import { expect, mock, test } from "bun:test";

// The readiness check reads the GitHub App through this reader. When GitHub
// can't be reached it says "couldn't check" (null), so readiness falls back
// to the stored binding and an outage never blocks a connected workspace.
let stored: unknown[] = [];
const actualDb = await import("@opengeni/db");
mock.module("@opengeni/db", () => ({
  ...actualDb,
  listGitHubInstallationAccessForWorkspace: async () => stored,
  hasAuditableGitHubInstallationAuthority: () => true,
  hasGitHubInstallationOwnerAuthority: () => true,
}));
const { githubAppBoundReader } = await import("../src/github-access");

const settings = {
  githubAppId: "1",
  githubClientId: "client",
  githubClientSecret: "secret",
  githubAppSlug: "opengeni",
  githubAppPrivateKey: "key",
};
const installation = {
  installationId: 7,
  githubAccountId: 42,
  repositoryIds: [1],
};

function reader(getInstallation: () => Promise<unknown>, appSettings: object = settings) {
  return githubAppBoundReader({
    db: {},
    settings: appSettings,
    githubAppApi: { getInstallation },
  } as never);
}

test("active, suspended, none, and GitHub unreachable", async () => {
  stored = [installation];
  const active = async () => ({ installationId: 7, accountId: 42, suspended: false });
  expect(await reader(active)("ws")).toBe(true);
  expect(
    await reader(async () => ({ installationId: 7, accountId: 42, suspended: true }))("ws"),
  ).toBe(false);
  // GitHub down: couldn't check, not "not connected".
  expect(
    await reader(async () => {
      throw new Error("GitHub 502");
    })("ws"),
  ).toBeNull();
  // Nothing stored, or the App not fully set up: not connected.
  expect(await reader(active, { ...settings, githubAppSlug: "" })("ws")).toBe(false);
  stored = [];
  expect(await reader(active)("ws")).toBe(false);
});
