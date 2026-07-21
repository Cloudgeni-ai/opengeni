import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { mintRunGitCredentials, sandboxEnvironmentForRun } from "../src/activities/environment";
import type { GitCredentialsRequest, ResourceRef } from "@opengeni/contracts";

const scope = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};

const provisionedSettings = () => testSettings({ sandboxBackend: "docker" });

describe("sandbox git credentials", () => {
  test("rechecks GitHub workspace authorization immediately before every direct token mint", async () => {
    const events: string[] = [];
    const resources: ResourceRef[] = [
      {
        kind: "repository",
        uri: "https://github.com/acme/private.git",
        ref: "main",
        provider: "github",
        githubInstallationId: 123,
        githubRepositoryId: 456,
      },
    ];

    const result = await mintRunGitCredentials(provisionedSettings(), resources, {
      scope,
      authorizeGitHubTokenMint: async (selection) => {
        events.push("authorize");
        expect(selection).toEqual({ installationId: 123, repositoryIds: [456] });
      },
      gitCredentials: async (input) => {
        events.push("mint");
        return { token: "ghs_renewed", workspaceId: input.workspaceId };
      },
    });

    expect(events).toEqual(["authorize", "mint"]);
    expect(result?.gitTokens).toEqual({ github: "ghs_renewed" });
  });

  test("does not call the credential broker when the current GitHub binding is rejected", async () => {
    let brokerCalled = false;
    await expect(
      mintRunGitCredentials(
        provisionedSettings(),
        [
          {
            kind: "repository",
            uri: "https://github.com/acme/private.git",
            ref: "main",
            provider: "github",
            githubInstallationId: 123,
            githubRepositoryId: 456,
          },
        ],
        {
          scope,
          authorizeGitHubTokenMint: async () => {
            throw new Error("workspace binding revoked");
          },
          gitCredentials: async (input) => {
            brokerCalled = true;
            return { token: "must-not-be-minted", workspaceId: input.workspaceId };
          },
        },
      ),
    ).rejects.toThrow("workspace binding revoked");
    expect(brokerCalled).toBe(false);
  });

  test("keeps GitHub host credential legacy fields unchanged and adds repositoryRefs", async () => {
    const calls: GitCredentialsRequest[] = [];
    const result = await sandboxEnvironmentForRun(
      provisionedSettings(),
      [
        {
          kind: "repository",
          uri: "https://github.com/acme/private.git",
          ref: "main",
          provider: "github",
          githubInstallationId: 123,
          githubRepositoryId: 456,
          connectionId: "github-connection",
        },
      ],
      {},
      {
        scope,
        gitCredentials: async (input) => {
          calls.push(input);
          return {
            token: "ghs_brokered",
            workspaceId: input.workspaceId,
            expiresAt: "2026-07-14T11:00:00Z",
          };
        },
      },
    );

    expect(calls).toEqual([
      {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        purpose: "token",
        installationId: 123,
        repositoryIds: [456],
        repositoryRefs: [
          {
            provider: "github",
            uri: "https://github.com/acme/private.git",
            ref: "main",
            repositoryId: 456,
            installationId: 123,
            connectionId: "github-connection",
          },
        ],
      },
    ]);
    expect(result.gitToken).toBe("ghs_brokered");
    expect(result.gitTokens).toEqual({ github: "ghs_brokered" });
    expect(result.gitTokenExpiresAt).toEqual({ github: "2026-07-14T11:00:00.000Z" });
    expect(Object.values(result.environment)).not.toContain("ghs_brokered");
  });

  test("rejects invalid broker expiry metadata before any token reaches the sandbox", async () => {
    await expect(
      sandboxEnvironmentForRun(
        provisionedSettings(),
        [
          {
            kind: "repository",
            uri: "https://github.com/acme/private.git",
            ref: "main",
            provider: "github",
            githubInstallationId: 123,
            githubRepositoryId: 456,
          },
        ],
        {},
        {
          scope,
          gitCredentials: async (input) => ({
            token: "must-not-be-returned",
            workspaceId: input.workspaceId,
            expiresAt: "not-a-date",
          }),
        },
      ),
    ).rejects.toThrow("connection-credential provider (github) returned an invalid expiresAt");
  });

  test("marshals non-GitHub provider credential requests with repositoryRefs", async () => {
    const calls: GitCredentialsRequest[] = [];
    const resources: ResourceRef[] = [
      {
        kind: "repository",
        uri: "https://gitlab.com/acme/private.git",
        ref: "main",
        provider: "gitlab",
        repositoryId: "gl-456",
        connectionId: "gitlab-connection",
      },
      {
        kind: "repository",
        uri: "https://dev.azure.com/acme/project/_git/private",
        ref: "main",
        provider: "azure_devops",
        repositoryId: "az-repo-789",
        projectId: "project",
        connectionId: "ado-connection",
      },
    ];

    const result = await sandboxEnvironmentForRun(
      provisionedSettings(),
      resources,
      {},
      {
        scope,
        gitCredentials: async (input) => {
          calls.push(input);
          return {
            token: `${input.provider}-token`,
            workspaceId: input.workspaceId,
            ...(input.provider === "gitlab"
              ? { identity: { name: "GitLab Bot", email: "gitlab-bot@example.com" } }
              : {}),
          };
        },
      },
    );

    expect(calls).toEqual([
      {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        provider: "gitlab",
        purpose: "token",
        installationId: 0,
        repositoryIds: [],
        repositoryRefs: [
          {
            provider: "gitlab",
            uri: "https://gitlab.com/acme/private.git",
            ref: "main",
            repositoryId: "gl-456",
            connectionId: "gitlab-connection",
          },
        ],
      },
      {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        provider: "azure_devops",
        purpose: "token",
        installationId: 0,
        repositoryIds: [],
        repositoryRefs: [
          {
            provider: "azure_devops",
            uri: "https://dev.azure.com/acme/project/_git/private",
            ref: "main",
            repositoryId: "az-repo-789",
            projectId: "project",
            connectionId: "ado-connection",
          },
        ],
      },
    ]);
    expect(result.gitToken).toBeUndefined();
    expect(result.gitTokens).toEqual({
      gitlab: "gitlab-token",
      azure_devops: "azure_devops-token",
    });
    expect(result.environment.GIT_AUTHOR_NAME).toBe("GitLab Bot");
    expect(result.environment.GIT_AUTHOR_EMAIL).toBe("gitlab-bot@example.com");
    expect(result.environment.GIT_COMMITTER_NAME).toBe("GitLab Bot");
    expect(result.environment.GIT_COMMITTER_EMAIL).toBe("gitlab-bot@example.com");
    expect(result.environment.GIT_ASKPASS).toBe("/workspace/.opengeni/askpass");
    expect(result.environment.OPENGENI_GIT_CREDENTIALS_DIR).toBe(
      "/workspace/.opengeni/git-credentials",
    );
    expect(Object.values(result.environment)).not.toContain("gitlab-token");
    expect(Object.values(result.environment)).not.toContain("azure_devops-token");
  });
});
