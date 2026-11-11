import { describe, expect, mock, test } from "bun:test";
import type { ResourceRef } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";

const realGitHub = await import("@opengeni/github");
const realMint = realGitHub.createGitHubAppInstallationTokenWithExpiry;
// Test-only installation ids. mock.module is process-wide, so every other
// installation id keeps the real implementation for later files.
const FAKE_INSTALLATIONS = new Set([910_001, 910_002]);
mock.module("@opengeni/github", () => ({
  ...realGitHub,
  createGitHubAppInstallationTokenWithExpiry: async (
    settings: Parameters<typeof realMint>[0],
    input: Parameters<typeof realMint>[1],
  ) =>
    FAKE_INSTALLATIONS.has(input.installationId)
      ? { token: `installation-token-${input.installationId}`, expiresAt: null }
      : await realMint(settings, input),
}));

const { createStandaloneConnectionCredentialsPort } =
  await import("../src/standalone-git-credentials");
const { mintRunGitCredentials } = await import("../src/activities/environment");

const scope = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const authority = {
  sessionId: "00000000-0000-4000-8000-000000000003",
  rootSessionId: "00000000-0000-4000-8000-000000000004",
  turnId: "00000000-0000-4000-8000-000000000005",
  attemptId: "00000000-0000-4000-8000-000000000006",
  executionGeneration: 1,
  initiator: { kind: "subject" as const, subjectId: "user:1", label: "Operator" },
  initiatorContext: { source: "web" },
};

function appRepository(owner: string, installationId: number, repositoryId: number): ResourceRef {
  return {
    kind: "repository",
    uri: `https://github.com/${owner}/repo-${repositoryId}.git`,
    ref: "main",
    provider: "github",
    githubInstallationId: installationId,
    githubRepositoryId: repositoryId,
  };
}

describe("standalone GitHub App credential port", () => {
  test("mints for repositories from two installations in one session", async () => {
    const settings = testSettings({ sandboxBackend: "docker" });
    const port = createStandaloneConnectionCredentialsPort(settings);
    const minted = await mintRunGitCredentials(
      settings,
      [appRepository("org-a", 910_001, 11), appRepository("user-b", 910_002, 22)],
      { scope, authority, gitCredentials: port.gitCredentials },
    );
    expect(
      minted?.bindings.map((binding) => [binding.credentialBindingId, binding.token]).sort(),
    ).toEqual([
      ["github-installation:910001", "installation-token-910001"],
      ["github-installation:910002", "installation-token-910002"],
    ]);
  });

  test("echoes the requested binding, provider and host", async () => {
    const port = createStandaloneConnectionCredentialsPort(testSettings());
    const echoed = await port.gitCredentials!({
      ...scope,
      ...authority,
      purpose: "identity",
      installationId: 910_001,
      repositoryIds: [11],
      credentialBindingId: "github-installation:910001",
      provider: "github",
      providerHost: "github.com",
    });
    expect(echoed).toEqual({
      workspaceId: scope.workspaceId,
      credentialBindingId: "github-installation:910001",
      provider: "github",
      providerHost: "github.com",
    });
  });
});
