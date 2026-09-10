import { describe, expect, test } from "bun:test";

import {
  listLivePersonalGitHubRepositoryBranches,
  personalGitHubRepositoryCanRead,
  personalGitHubRepositoryCanWrite,
  PersonalGitHubRepositoryProviderError,
  parsePersonalGitHubProviderJson,
  parsePersonalGitHubRepository,
  requirePersonalGitHubRepositoryConnection,
  type PersonalGitHubRepositoryBranchServices,
} from "../src/integrations/personal-github-repositories";

const none = { pull: false, triage: false, push: false, maintain: false, admin: false };

describe("personal GitHub repository capabilities", () => {
  test("lists branches only for one exact selected repository and rechecks selection", async () => {
    const repository = {
      repositoryId: "9007199254740993123",
      fullName: "octocat/private-repository",
      canonicalUrl: "https://github.com/octocat/private-repository",
      defaultBranch: "main",
      visibility: "private" as const,
      private: true,
      archived: false,
      disabled: false,
      permissions: { pull: true, push: true, admin: false, maintain: false, triage: false },
      selectedAccess: "write" as const,
      selectionGeneration: 2,
      selectedAt: "2026-09-01T10:00:00.000Z",
      lastVerifiedAt: "2026-09-01T10:00:00.000Z",
    };
    const selection = {
      connectionAuthorityGeneration: 4,
      credentialBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      providerPrincipalId: "123456",
      selectionGeneration: 2,
      repositories: [repository],
    };
    const states = [selection, selection];
    const providerInputs: unknown[] = [];
    const services: PersonalGitHubRepositoryBranchServices = {
      requireConnection: async () =>
        ({
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          accountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          workspaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        }) as never,
      getSelectionState: async () => states.shift() ?? null,
      providerJson: async (input) => {
        providerInputs.push({
          url: input.url.toString(),
          expectedConnectionAuthorityGeneration: input.expectedConnectionAuthorityGeneration,
          options: input.options,
        });
        return [{ name: "feature/picker" }, { name: "main" }];
      },
    };
    await expect(
      listLivePersonalGitHubRepositoryBranches(
        { db: {}, settings: {} } as never,
        {
          accountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          workspaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          subjectId: "user:owner",
          connectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          repositoryId: repository.repositoryId,
          query: { cursor: 2, limit: 2 },
        },
        services,
      ),
    ).resolves.toEqual({
      branches: [
        { name: "feature/picker", isDefault: false },
        { name: "main", isDefault: true },
      ],
      nextCursor: 3,
    });
    expect(providerInputs).toEqual([
      expect.objectContaining({
        url: "https://api.github.com/repos/octocat/private-repository/branches?page=2&per_page=2",
        expectedConnectionAuthorityGeneration: 4,
        options: expect.objectContaining({
          operation: "repository_branches_list",
          expectedRepositoryAuthority: {
            selectionGeneration: 2,
            repositoryId: repository.repositoryId,
            fullName: repository.fullName,
          },
        }),
      }),
    ]);
    expect(states).toHaveLength(0);
  });

  test("fails before provider use for unselected repositories and discards in-flight changes", async () => {
    const repository = {
      repositoryId: "9007199254740993123",
      fullName: "octocat/private-repository",
      canonicalUrl: "https://github.com/octocat/private-repository",
      defaultBranch: "main",
      visibility: "private" as const,
      private: true,
      archived: false,
      disabled: false,
      permissions: { pull: true, push: true, admin: false, maintain: false, triage: false },
      selectedAccess: "write" as const,
      selectionGeneration: 2,
      selectedAt: "2026-09-01T10:00:00.000Z",
      lastVerifiedAt: "2026-09-01T10:00:00.000Z",
    };
    const selection = {
      connectionAuthorityGeneration: 4,
      credentialBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      providerPrincipalId: "123456",
      selectionGeneration: 2,
      repositories: [repository],
    };
    let providerCalls = 0;
    const baseServices: PersonalGitHubRepositoryBranchServices = {
      requireConnection: async () =>
        ({
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          accountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          workspaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        }) as never,
      getSelectionState: async () => ({ ...selection, repositories: [] }),
      providerJson: async () => {
        providerCalls += 1;
        return [{ name: "main" }];
      },
    };
    const input = {
      accountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      workspaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      subjectId: "user:owner",
      connectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      repositoryId: repository.repositoryId,
      query: { cursor: 1, limit: 100 },
    };
    await expect(
      listLivePersonalGitHubRepositoryBranches(
        { db: {}, settings: {} } as never,
        input,
        baseServices,
      ),
    ).rejects.toMatchObject({ code: "repository_not_selected" });
    expect(providerCalls).toBe(0);

    const states = [selection, { ...selection, selectionGeneration: 3, repositories: [] }];
    baseServices.getSelectionState = async () => states.shift() ?? null;
    await expect(
      listLivePersonalGitHubRepositoryBranches(
        { db: {}, settings: {} } as never,
        input,
        baseServices,
      ),
    ).rejects.toBeInstanceOf(PersonalGitHubRepositoryProviderError);
    expect(providerCalls).toBe(1);
    expect(states).toHaveLength(0);
  });

  test("keeps a numeric GitHub repository ID exact above the JavaScript safe range", () => {
    const payload = parsePersonalGitHubProviderJson(`{
      "id": 9007199254740993123,
      "full_name": "octocat/private-repository",
      "default_branch": "main",
      "visibility": "private",
      "private": true,
      "archived": false,
      "disabled": false,
      "permissions": {
        "pull": true,
        "push": true,
        "admin": false,
        "maintain": false,
        "triage": false
      }
    }`);
    expect(parsePersonalGitHubRepository(payload).repositoryId).toBe("9007199254740993123");
  });

  test("fails before database or provider use when the deployment flag is off", async () => {
    let databaseUsed = false;
    await expect(
      requirePersonalGitHubRepositoryConnection(
        {
          settings: { githubPersonalOauthEnabled: false },
          db: new Proxy(
            {},
            {
              get() {
                databaseUsed = true;
                throw new Error("database must not be used");
              },
            },
          ),
        } as never,
        {
          accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          subjectId: "user:owner",
          connectionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(databaseUsed).toBe(false);
  });

  test("accepts every GitHub permission that implies repository reads", () => {
    for (const permission of ["pull", "triage", "push", "maintain", "admin"] as const) {
      expect(personalGitHubRepositoryCanRead({ ...none, [permission]: true })).toBe(true);
    }
    expect(personalGitHubRepositoryCanRead(none)).toBe(false);
  });

  test("accepts only GitHub permissions that imply repository writes", () => {
    for (const permission of ["push", "maintain", "admin"] as const) {
      expect(personalGitHubRepositoryCanWrite({ ...none, [permission]: true })).toBe(true);
    }
    expect(personalGitHubRepositoryCanWrite({ ...none, pull: true })).toBe(false);
    expect(personalGitHubRepositoryCanWrite({ ...none, triage: true })).toBe(false);
  });
});
