import { describe, expect, test } from "bun:test";

import { resolveGitHubReleaseState, type GitHubReleaseApi } from "./resolve-github-release-state";

const repository = "Cloudgeni-ai/opengeni";
const tag = `opengeni-release-${"a".repeat(40)}`;
const sha = "a".repeat(40);

function api(responses: Record<string, { status: number; body?: unknown }>): GitHubReleaseApi {
  return {
    async get(path) {
      const response = responses[path];
      if (!response) throw new Error(`unexpected path: ${path}`);
      return { status: response.status, body: response.body ?? null };
    },
  };
}

const releasePath = `/repos/${repository}/releases/tags/${tag}`;
const commitPath = `/repos/${repository}/commits/${tag}`;

describe("GitHub release state resolution", () => {
  test("distinguishes an absent release and tag from an immutable existing release", async () => {
    await expect(
      resolveGitHubReleaseState({
        repository,
        tag,
        api: api({
          [releasePath]: { status: 404 },
          [commitPath]: { status: 404 },
        }),
      }),
    ).resolves.toEqual({ releaseExists: false, tagSha: null });

    await expect(
      resolveGitHubReleaseState({
        repository,
        tag,
        api: api({
          [releasePath]: { status: 200, body: { tag_name: tag } },
          [commitPath]: { status: 200, body: { sha } },
        }),
      }),
    ).resolves.toEqual({ releaseExists: true, tagSha: sha });
  });

  test("retains an existing tag even when no GitHub release exists", async () => {
    await expect(
      resolveGitHubReleaseState({
        repository,
        tag,
        api: api({
          [releasePath]: { status: 404 },
          [commitPath]: { status: 200, body: { sha } },
        }),
      }),
    ).resolves.toEqual({ releaseExists: false, tagSha: sha });
  });

  test("accepts only GitHub's exact 422 missing-ref response as an absent tag", async () => {
    const exactMissing = {
      message: `No commit found for SHA: ${tag}`,
      status: "422",
    };
    await expect(
      resolveGitHubReleaseState({
        repository,
        tag,
        api: api({
          [releasePath]: { status: 404 },
          [commitPath]: { status: 422, body: exactMissing },
        }),
      }),
    ).resolves.toEqual({ releaseExists: false, tagSha: null });

    for (const body of [
      { ...exactMissing, message: "Validation Failed" },
      { ...exactMissing, message: "No commit found for SHA: another-tag" },
      { ...exactMissing, status: 422 },
    ]) {
      await expect(
        resolveGitHubReleaseState({
          repository,
          tag,
          api: api({
            [releasePath]: { status: 404 },
            [commitPath]: { status: 422, body },
          }),
        }),
      ).rejects.toThrow("HTTP 422");
    }
  });

  test("fails closed on authorization, transport-shaped status, and malformed authority", async () => {
    for (const status of [401, 403, 429, 500]) {
      await expect(
        resolveGitHubReleaseState({
          repository,
          tag,
          api: api({
            [releasePath]: { status },
          }),
        }),
      ).rejects.toThrow(`HTTP ${status}`);
    }

    await expect(
      resolveGitHubReleaseState({
        repository,
        tag,
        api: api({
          [releasePath]: { status: 200, body: { tag_name: "different" } },
        }),
      }),
    ).rejects.toThrow("does not match");
    await expect(
      resolveGitHubReleaseState({
        repository: "not a repository",
        tag,
        api: api({}),
      }),
    ).rejects.toThrow("owner/name");
  });

  test("rejects an existing release whose tag cannot resolve to an exact commit", async () => {
    for (const commit of [
      { status: 404 },
      {
        status: 422,
        body: {
          message: `No commit found for SHA: ${tag}`,
          status: "422",
        },
      },
    ]) {
      await expect(
        resolveGitHubReleaseState({
          repository,
          tag,
          api: api({
            [releasePath]: { status: 200, body: { tag_name: tag } },
            [commitPath]: commit,
          }),
        }),
      ).rejects.toThrow("without a resolvable tag commit");
    }
  });
});
