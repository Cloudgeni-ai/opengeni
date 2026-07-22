import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  gitCredentialAuthorityForTurn,
  mintRunGitCredentials,
  resolveRunGitIdentity,
  sandboxEnvironmentForRun,
} from "../src/activities/environment";
import type { GitCredentialsRequest, ResourceRef } from "@opengeni/contracts";

const scope = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};

const authority = {
  sessionId: "00000000-0000-4000-8000-000000000003",
  rootSessionId: "00000000-0000-4000-8000-000000000004",
  turnId: "00000000-0000-4000-8000-000000000005",
  attemptId: "00000000-0000-4000-8000-000000000006",
  executionGeneration: 7,
  initiator: { kind: "subject" as const, subjectId: "host:user:42", label: "Operator" },
  initiatorContext: { source: "embedded-host", delegatedBy: "host:user:7" },
};

const provisionedSettings = () => testSettings({ sandboxBackend: "docker" });

describe("sandbox git credentials", () => {
  test("derives child-session and root-session lineage from the admitted turn", () => {
    const derived = gitCredentialAuthorityForTurn({
      sessionId: authority.sessionId,
      rootSessionId: authority.rootSessionId,
      attemptId: authority.attemptId,
      turn: {
        id: authority.turnId,
        executionGeneration: authority.executionGeneration,
        initiator: authority.initiator,
        initiatorContext: authority.initiatorContext,
      },
    });

    expect(derived).toEqual(authority);
    expect(derived.sessionId).not.toBe(derived.rootSessionId);
  });

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
      authority,
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
          authority,
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
        authority,
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
        ...authority,
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
          authority,
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
        authority,
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
        ...authority,
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
        ...authority,
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

  test("fails closed before calling a host broker when immutable authority is missing", async () => {
    let brokerCalled = false;

    await expect(
      mintRunGitCredentials(
        provisionedSettings(),
        [
          {
            kind: "repository",
            uri: "https://gitlab.com/acme/private.git",
            ref: "main",
            provider: "gitlab",
            repositoryId: "gl-456",
            connectionId: "gitlab-connection",
          },
        ],
        {
          scope,
          gitCredentials: async (input) => {
            brokerCalled = true;
            return { token: "must-not-be-minted", workspaceId: input.workspaceId };
          },
        },
      ),
    ).rejects.toThrow("host git credential resolution requires immutable session turn authority");
    expect(brokerCalled).toBe(false);
  });

  test("uses the same immutable authority for deferred identity and later token minting", async () => {
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
    ];
    const gitCredentials = async (input: GitCredentialsRequest) => {
      calls.push(input);
      return {
        workspaceId: input.workspaceId,
        ...(input.purpose === "token" ? { token: "gl-token" } : {}),
        identity: { name: "Host Bot", email: "host-bot@example.com" },
      };
    };

    await resolveRunGitIdentity(provisionedSettings(), resources, {
      scope,
      authority,
      gitCredentials,
    });
    await mintRunGitCredentials(provisionedSettings(), resources, {
      scope,
      authority,
      gitCredentials,
    });

    expect(
      calls.map(({ purpose, ...requestAuthority }) => ({ purpose, requestAuthority })),
    ).toEqual([
      {
        purpose: "identity",
        requestAuthority: {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          ...authority,
          provider: "gitlab",
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
      },
      {
        purpose: "token",
        requestAuthority: {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          ...authority,
          provider: "gitlab",
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
      },
    ]);
  });
});
