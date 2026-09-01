import { describe, expect, test } from "bun:test";

import {
  GitHubRepositoryBranchesResponse,
  ListGitHubRepositoryBranchesQuery,
  ResourceRef,
} from "../src";

describe("GitHub repository branch contracts", () => {
  test("defaults to one bounded provider page", () => {
    expect(ListGitHubRepositoryBranchesQuery.parse({})).toEqual({ cursor: 1, limit: 100 });
    expect(ListGitHubRepositoryBranchesQuery.parse({ cursor: "3", limit: "25" })).toEqual({
      cursor: 3,
      limit: 25,
    });
    expect(ListGitHubRepositoryBranchesQuery.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListGitHubRepositoryBranchesQuery.safeParse({ cursor: 10_001 }).success).toBe(false);
  });

  test("returns unique branch suggestions with at most one default marker", () => {
    const response = {
      branches: [
        { name: "feature/repository-picker", isDefault: false },
        { name: "main", isDefault: true },
      ],
      nextCursor: null,
    };
    expect(GitHubRepositoryBranchesResponse.parse(response)).toEqual(response);
    expect(
      GitHubRepositoryBranchesResponse.safeParse({
        ...response,
        branches: [...response.branches, response.branches[0]],
      }).success,
    ).toBe(false);
    expect(
      GitHubRepositoryBranchesResponse.safeParse({
        ...response,
        branches: response.branches.map((branch) => ({ ...branch, isDefault: true })),
      }).success,
    ).toBe(false);
  });

  test("does not narrow arbitrary repository refs at the product boundary", () => {
    const resource = {
      kind: "repository" as const,
      uri: "https://github.com/Cloudgeni-ai/opengeni",
      ref: "refs/pull/2095/merge^{commit}",
    };
    expect(ResourceRef.parse(resource)).toEqual(resource);
  });
});
