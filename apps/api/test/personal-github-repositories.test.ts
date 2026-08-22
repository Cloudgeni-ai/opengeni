import { describe, expect, test } from "bun:test";

import {
  personalGitHubRepositoryCanRead,
  personalGitHubRepositoryCanWrite,
  parsePersonalGitHubProviderJson,
  parsePersonalGitHubRepository,
  requirePersonalGitHubRepositoryConnection,
} from "../src/integrations/personal-github-repositories";

const none = { pull: false, triage: false, push: false, maintain: false, admin: false };

describe("personal GitHub repository capabilities", () => {
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
