import { describe, expect, test } from "bun:test";

import {
  ListPersonalGitHubRepositoriesResponse,
  PersonalGitHubRepository,
  ReplacePersonalGitHubRepositorySelectionsRequest,
} from "../src/personal-github";

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
});
