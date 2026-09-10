import { describe, expect, test } from "bun:test";

import { ResourceRef } from "../src";
import {
  GitHubRepositoryBranchesResponse,
  ListGitHubRepositoryBranchesQuery,
  VerifyPublicGitHubRepositoryRefRequest,
} from "../src/github-repository-contracts";
import { parseCanonicalGitHubRepositoryUrl } from "../src/github-repository";

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

  test("accepts only exact canonical github.com repository URLs", () => {
    expect(
      parseCanonicalGitHubRepositoryUrl("https://github.com/Cloudgeni-ai/opengeni.git"),
    ).toEqual({
      owner: "Cloudgeni-ai",
      name: "opengeni",
      fullName: "Cloudgeni-ai/opengeni",
      canonicalUrl: "https://github.com/Cloudgeni-ai/opengeni",
      cloneUrl: "https://github.com/Cloudgeni-ai/opengeni.git",
    });
    for (const value of [
      "http://github.com/acme/repo",
      "https://www.github.com/acme/repo",
      "https://user@github.com/acme/repo",
      "https://github.com:443/acme/repo",
      "https://github.com/acme/repo/issues",
      "https://github.com/acme/repo?tab=readme",
      "https://github.com/acme/repo#readme",
      "https://github.com/acme%2frepo/other",
    ]) {
      expect(() => parseCanonicalGitHubRepositoryUrl(value)).toThrow();
    }
  });

  test("requires one explicit non-control public GitHub ref", () => {
    expect(
      VerifyPublicGitHubRepositoryRefRequest.parse({
        url: "https://github.com/Cloudgeni-ai/opengeni",
        ref: "refs/tags/v1.0.0^{commit}",
      }),
    ).toEqual({
      url: "https://github.com/Cloudgeni-ai/opengeni",
      ref: "refs/tags/v1.0.0^{commit}",
    });
    expect(
      VerifyPublicGitHubRepositoryRefRequest.safeParse({
        url: "https://github.com/Cloudgeni-ai/opengeni",
        ref: " ",
      }).success,
    ).toBe(false);
  });
});
