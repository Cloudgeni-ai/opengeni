import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { sandboxEnvironmentForRun } from "../src/activities/environment";
import type { GitCredentialsRequest, ResourceRef } from "@opengeni/contracts";

const scope = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};

describe("sandbox git credentials", () => {
  test("keeps GitHub host credential legacy fields unchanged and adds repositoryRefs", async () => {
    const calls: GitCredentialsRequest[] = [];
    const result = await sandboxEnvironmentForRun(
      testSettings(),
      [{
        kind: "repository",
        uri: "https://github.com/acme/private.git",
        ref: "main",
        provider: "github",
        githubInstallationId: 123,
        githubRepositoryId: 456,
        connectionId: "github-connection",
      }],
      {},
      {
        scope,
        gitCredentials: async (input) => {
          calls.push(input);
          return { token: "ghs_brokered", workspaceId: input.workspaceId };
        },
      },
    );

    expect(calls).toEqual([{
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      installationId: 123,
      repositoryIds: [456],
      repositoryRefs: [{
        provider: "github",
        uri: "https://github.com/acme/private.git",
        ref: "main",
        repositoryId: 456,
        installationId: 123,
        connectionId: "github-connection",
      }],
    }]);
    expect(result.gitToken).toBe("ghs_brokered");
    expect(result.gitTokens).toEqual({ github: "ghs_brokered" });
    expect(Object.values(result.environment)).not.toContain("ghs_brokered");
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
      testSettings(),
      resources,
      {},
      {
        scope,
        gitCredentials: async (input) => {
          calls.push(input);
          return { token: `${input.provider}-token`, workspaceId: input.workspaceId };
        },
      },
    );

    expect(calls).toEqual([
      {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        provider: "gitlab",
        installationId: 0,
        repositoryIds: [],
        repositoryRefs: [{
          provider: "gitlab",
          uri: "https://gitlab.com/acme/private.git",
          ref: "main",
          repositoryId: "gl-456",
          connectionId: "gitlab-connection",
        }],
      },
      {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        provider: "azure_devops",
        installationId: 0,
        repositoryIds: [],
        repositoryRefs: [{
          provider: "azure_devops",
          uri: "https://dev.azure.com/acme/project/_git/private",
          ref: "main",
          repositoryId: "az-repo-789",
          projectId: "project",
          connectionId: "ado-connection",
        }],
      },
    ]);
    expect(result.gitToken).toBeUndefined();
    expect(result.gitTokens).toEqual({
      gitlab: "gitlab-token",
      azure_devops: "azure_devops-token",
    });
    expect(result.environment.GIT_ASKPASS).toBe("/workspace/.opengeni/askpass");
    expect(result.environment.OPENGENI_GIT_CREDENTIALS_DIR).toBe("/workspace/.opengeni/git-credentials");
    expect(Object.values(result.environment)).not.toContain("gitlab-token");
    expect(Object.values(result.environment)).not.toContain("azure_devops-token");
  });
});
