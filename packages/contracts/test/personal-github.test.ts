import { describe, expect, test } from "bun:test";

import {
  GITHUB_OWNER_LOGIN_PATTERN,
  ListPersonalGitHubRepositoriesResponse,
  PersonalGitHubRepository,
  personalGitHubAccessCovers,
  personalGitHubAllRepositoriesEffectiveAccess,
  personalGitHubConnectionNeedsReconnect,
  ReplacePersonalGitHubRepositorySelectionsRequest,
} from "../src/personal-github";
import { McpPersonalConnectionDelegation } from "../src";

const repository = {
  repositoryId: "1234567890123456",
  fullName: "Cloudgeni-ai/opengeni",
  canonicalUrl: "https://github.com/Cloudgeni-ai/opengeni",
  defaultBranch: "main",
  visibility: "private" as const,
  private: true,
  archived: false,
  disabled: false,
  permissions: { pull: true, push: true, admin: false, maintain: true, triage: true },
};

describe("personal GitHub repository contracts", () => {
  test("requires positive digit-string IDs and server-derived canonical URLs", () => {
    expect(PersonalGitHubRepository.parse(repository).repositoryId).toBe(repository.repositoryId);
    expect(PersonalGitHubRepository.safeParse({ ...repository, repositoryId: "0" }).success).toBe(
      false,
    );
    expect(PersonalGitHubRepository.safeParse({ ...repository, repositoryId: 123 }).success).toBe(
      false,
    );
    expect(
      PersonalGitHubRepository.safeParse({
        ...repository,
        canonicalUrl: "https://attacker.example/repository",
      }).success,
    ).toBe(false);
  });

  test("owners may be enterprise managed users, whose logins carry an underscore", () => {
    const managed = {
      ...repository,
      fullName: "octocat_acme/tools",
      canonicalUrl: "https://github.com/octocat_acme/tools",
    };
    expect(PersonalGitHubRepository.parse(managed).fullName).toBe("octocat_acme/tools");
    for (const login of ["octocat_acme", "Octo-Cat_acme", "a", "a".repeat(39)]) {
      expect(GITHUB_OWNER_LOGIN_PATTERN.test(login)).toBe(true);
    }
    for (const login of ["_octocat", "-octocat", "a".repeat(40), "octo.cat", "octo/cat", ""]) {
      expect(GITHUB_OWNER_LOGIN_PATTERN.test(login)).toBe(false);
    }
    for (const fullName of ["_octocat/tools", `${"a".repeat(40)}/tools`]) {
      expect(
        PersonalGitHubRepository.safeParse({
          ...repository,
          fullName,
          canonicalUrl: `https://github.com/${fullName}`,
        }).success,
      ).toBe(false);
    }
  });

  test("bounds and deduplicates full replacement selections", () => {
    const request = {
      expectedConnectionAuthorityGeneration: 4,
      expectedSelectionGeneration: 0,
      idempotencyKey: "select-repositories-1",
      repositories: [
        {
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          access: "write" as const,
        },
      ],
    };
    expect(ReplacePersonalGitHubRepositorySelectionsRequest.parse(request)).toEqual(request);
    expect(
      ReplacePersonalGitHubRepositorySelectionsRequest.safeParse({
        ...request,
        repositories: [...request.repositories, { ...request.repositories[0] }],
      }).success,
    ).toBe(false);
    expect(
      ReplacePersonalGitHubRepositorySelectionsRequest.safeParse({
        ...request,
        repositories: Array.from({ length: 101 }, (_, index) => ({
          repositoryId: String(index + 1),
          fullName: `owner/repository-${index}`,
          access: "read",
        })),
      }).success,
    ).toBe(false);
  });

  test("bounds the live catalog and carries exact selection generations", () => {
    expect(
      ListPersonalGitHubRepositoriesResponse.parse({
        repositories: [{ ...repository, selectedAccess: "write" }],
        nextCursor: 2,
        selection: {
          connectionAuthorityGeneration: 4,
          credentialBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          providerPrincipalId: "123456",
          selectionGeneration: 1,
          repositories: [
            {
              ...repository,
              selectedAccess: "write",
              selectionGeneration: 1,
              selectedAt: "2026-08-21T08:00:00.000Z",
              lastVerifiedAt: "2026-08-21T08:00:00.000Z",
            },
          ],
        },
      }).repositories,
    ).toHaveLength(1);
  });

  test("binds durable personal delegations to one canonical repository snapshot", () => {
    const delegation = {
      serverId: "github:personal",
      connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      originWorkspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ownerSubjectId: "user:owner",
      providerDomain: "github.com",
      kind: "oauth2" as const,
      connectionType: "github_personal" as const,
      userDelegation: {
        organizationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        authorityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        authorityGeneration: 2,
        workspaceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        sessionId: null,
        action: "connection.use" as const,
        mode: "always" as const,
        context: "workspace_shared" as const,
        authorityEpoch: null,
        grantId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        grantGeneration: 3,
      },
      personalGitHubRepositorySelection: {
        credentialBindingId: "11111111-1111-4111-8111-111111111111",
        connectionAuthorityGeneration: 2,
        selectionGeneration: 4,
        repositories: [
          {
            repositoryId: repository.repositoryId,
            fullName: repository.fullName,
            canonicalUrl: repository.canonicalUrl,
            ref: repository.defaultBranch,
            access: "write" as const,
            selectionGeneration: 4,
          },
        ],
      },
    };
    expect(McpPersonalConnectionDelegation.parse(delegation)).toEqual(delegation);
    expect(
      McpPersonalConnectionDelegation.safeParse({
        ...delegation,
        providerDomain: "GitHub.com",
      }).success,
    ).toBe(false);
    expect(
      McpPersonalConnectionDelegation.safeParse({
        ...delegation,
        personalGitHubRepositorySelection: undefined,
      }).success,
    ).toBe(false);
    expect(
      McpPersonalConnectionDelegation.safeParse({
        ...delegation,
        personalGitHubRepositorySelection: {
          ...delegation.personalGitHubRepositorySelection,
          repositories: [
            {
              ...delegation.personalGitHubRepositorySelection.repositories[0]!,
              canonicalUrl: "https://github.com/octocat/different-repository",
            },
          ],
        },
      }).success,
    ).toBe(false);
    // All my repositories may carry no attached repository; without it, one is required.
    const allMode = {
      ...delegation,
      personalGitHubRepositorySelection: {
        ...delegation.personalGitHubRepositorySelection,
        allRepositoriesAccess: "read" as const,
        repositories: [],
      },
    };
    expect(McpPersonalConnectionDelegation.parse(allMode)).toEqual(allMode);
    // An enterprise managed user's own repository.
    const managedOwner = {
      ...delegation,
      personalGitHubRepositorySelection: {
        ...delegation.personalGitHubRepositorySelection,
        repositories: [
          {
            ...delegation.personalGitHubRepositorySelection.repositories[0]!,
            fullName: "octocat_acme/tools",
            canonicalUrl: "https://github.com/octocat_acme/tools",
          },
        ],
      },
    };
    expect(McpPersonalConnectionDelegation.parse(managedOwner)).toEqual(managedOwner);
    expect(
      McpPersonalConnectionDelegation.safeParse({
        ...delegation,
        personalGitHubRepositorySelection: {
          ...delegation.personalGitHubRepositorySelection,
          repositories: [],
        },
      }).success,
    ).toBe(false);
  });
});

describe("All my repositories", () => {
  const permissions = { pull: true, push: false, admin: false, maintain: false, triage: false };
  test("access is the chosen access lowered to GitHub's permission", () => {
    const read = { permissions, archived: false, disabled: false };
    const write = { permissions: { ...permissions, push: true }, archived: false, disabled: false };
    expect(personalGitHubAllRepositoriesEffectiveAccess("write", read)).toBe("read");
    expect(personalGitHubAllRepositoriesEffectiveAccess("write", write)).toBe("write");
    expect(personalGitHubAllRepositoriesEffectiveAccess("read", write)).toBe("read");
    expect(
      personalGitHubAllRepositoriesEffectiveAccess("write", { ...write, archived: true }),
    ).toBe("read");
    expect(
      personalGitHubAllRepositoriesEffectiveAccess("write", { ...write, disabled: true }),
    ).toBeNull();
    expect(
      personalGitHubAllRepositoriesEffectiveAccess("read", {
        permissions: { ...permissions, pull: false },
        archived: false,
        disabled: false,
      }),
    ).toBeNull();
    expect(personalGitHubAccessCovers("write", "read")).toBe(true);
    expect(personalGitHubAccessCovers("read", "write")).toBe(false);
    expect(personalGitHubAccessCovers(null, "read")).toBe(false);
  });

  test("the mode is optional on save and on older selection states", () => {
    const base = {
      expectedConnectionAuthorityGeneration: 1,
      expectedSelectionGeneration: 1,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      repositories: [],
    };
    expect(ReplacePersonalGitHubRepositorySelectionsRequest.parse(base)).toEqual(base);
    expect(
      ReplacePersonalGitHubRepositorySelectionsRequest.parse({
        ...base,
        allRepositoriesAccess: "write",
      }).allRepositoriesAccess,
    ).toBe("write");
    expect(
      ReplacePersonalGitHubRepositorySelectionsRequest.parse({
        ...base,
        allRepositoriesAccess: null,
      }).allRepositoriesAccess,
    ).toBeNull();
    expect(
      ReplacePersonalGitHubRepositorySelectionsRequest.safeParse({
        ...base,
        allRepositoriesAccess: "admin",
      }).success,
    ).toBe(false);
  });
});

describe("personal GitHub reconnect state", () => {
  const personal = {
    providerDomain: "github.com",
    kind: "oauth2" as const,
    metadata: {
      credentialRole: "opengeni_github_personal",
      providerFamily: "github",
      providerPrincipalId: "59779138",
      githubUserId: "59779138",
      githubLogin: "benyhh",
      oauthEnvironment: "staging",
      oauthClientMarker: "a".repeat(32),
      credentialBindingId: "6acc52e1-2952-4da4-9e0e-f45872f661b2",
      connectedAt: "2026-11-02T09:19:18.000Z",
      lastVerifiedAt: "2026-11-02T09:19:18.000Z",
    },
  };

  test("only a refused grant on the person's own GitHub needs reconnecting", () => {
    expect(personalGitHubConnectionNeedsReconnect({ ...personal, status: "needs_reauth" })).toBe(
      true,
    );
    expect(personalGitHubConnectionNeedsReconnect({ ...personal, status: "error" })).toBe(true);
    expect(personalGitHubConnectionNeedsReconnect({ ...personal, status: "active" })).toBe(false);
    expect(personalGitHubConnectionNeedsReconnect({ ...personal, status: "revoked" })).toBe(false);
    expect(
      personalGitHubConnectionNeedsReconnect({
        ...personal,
        status: "needs_reauth",
        metadata: { credentialRole: "test_oauth" },
      }),
    ).toBe(false);
  });
});
