import { describe, expect, test } from "bun:test";

import {
  listGitHubRepositoryBranches,
  listPersonalGitHubRepositoryBranches,
  verifyPublicGitHubRepositoryRef,
} from "../src/github-repositories";

describe("focused GitHub repository SDK", () => {
  test("uses the exact public verification and authenticated branch routes", async () => {
    const requests: Array<{
      method: string;
      path: string;
      body: unknown;
      query: Record<string, string> | undefined;
    }> = [];
    const client = {
      requestJson: async <T>(
        method: string,
        path: string,
        body?: unknown,
        query?: Record<string, string>,
      ): Promise<T> => {
        requests.push({ method, path, body, query });
        return {} as T;
      },
    };
    const workspaceId = "11111111-1111-4111-8111-111111111111";

    await verifyPublicGitHubRepositoryRef(client, workspaceId, {
      url: "https://github.com/acme/public",
      ref: "main",
    });
    await listGitHubRepositoryBranches(client, workspaceId, 123, 456, {
      cursor: 3,
      limit: 40,
    });
    await listPersonalGitHubRepositoryBranches(client, workspaceId, "connection-1", "repo/1", {
      cursor: 2,
      limit: 25,
    });

    expect(requests).toEqual([
      {
        method: "POST",
        path: `/v1/workspaces/${workspaceId}/github/public-repositories/verify`,
        body: { url: "https://github.com/acme/public", ref: "main" },
        query: undefined,
      },
      {
        method: "GET",
        path: `/v1/workspaces/${workspaceId}/github/installations/123/repositories/456/branches`,
        body: undefined,
        query: { cursor: "3", limit: "40" },
      },
      {
        method: "GET",
        path: `/v1/workspaces/${workspaceId}/connections/connection-1/github/repositories/repo%2F1/branches`,
        body: undefined,
        query: { cursor: "2", limit: "25" },
      },
    ]);
  });
});
