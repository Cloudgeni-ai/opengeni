import { describe, expect, test } from "bun:test";

import {
  PrReviewProviderRepositoryError,
  verifyPrReviewProviderRepository,
} from "../src/integrations/pr-review-provider";

const testNetworkSettings = {
  environment: "test",
  integrationsAllowPrivateNetworkTargets: false,
};

describe("PrReview provider repository verification", () => {
  test("canonicalizes an accessible GitLab project from provider metadata", async () => {
    let request: Request | null = null;
    const verified = await verifyPrReviewProviderRepository({
      provider: "gitlab",
      providerBaseUrl: "https://gitlab.example.com",
      providerRepositoryId: "42",
      token: "gitlab-token",
      username: null,
      settings: testNetworkSettings,
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          id: 42,
          path_with_namespace: "group/repository",
          http_url_to_repo: "https://gitlab.example.com/group/repository.git",
        });
      },
    });
    expect(request?.url).toBe("https://gitlab.example.com/api/v4/projects/42");
    expect(request?.headers.get("authorization")).toBe("Bearer gitlab-token");
    expect(verified).toEqual({
      repositoryUri: "https://gitlab.example.com/group/repository.git",
      repositoryFullName: "group/repository",
      providerRepositoryId: "42",
      projectId: "42",
    });
  });

  test("canonicalizes an exact Azure repository and sends PAT Basic auth", async () => {
    let request: Request | null = null;
    const verified = await verifyPrReviewProviderRepository({
      provider: "azure_devops",
      providerBaseUrl: "https://dev.azure.com/example",
      providerRepositoryId: "repo-guid",
      projectId: "project-guid",
      token: "azure-token",
      username: "prReview-hook",
      settings: testNetworkSettings,
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          id: "repo-guid",
          name: "repository",
          remoteUrl: "https://dev.azure.com/example/project/_git/repository",
          project: { id: "project-guid", name: "project" },
        });
      },
    });
    expect(request?.url).toBe(
      "https://dev.azure.com/example/project-guid/_apis/git/repositories/repo-guid?api-version=7.1",
    );
    expect(request?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("prReview-hook:azure-token").toString("base64")}`,
    );
    expect(verified).toEqual({
      repositoryUri: "https://dev.azure.com/example/project/_git/repository",
      repositoryFullName: "project/repository",
      providerRepositoryId: "repo-guid",
      projectId: "project-guid",
    });
  });

  test("fails closed on denied access or mismatched provider identity", async () => {
    await expect(
      verifyPrReviewProviderRepository({
        provider: "gitlab",
        providerBaseUrl: "https://gitlab.com",
        providerRepositoryId: "42",
        token: "denied-token",
        username: null,
        settings: testNetworkSettings,
        fetchImpl: async () => new Response(null, { status: 403 }),
      }),
    ).rejects.toMatchObject({ reason: "denied" });

    await expect(
      verifyPrReviewProviderRepository({
        provider: "azure_devops",
        providerBaseUrl: "https://dev.azure.com/example",
        providerRepositoryId: "expected-repo",
        projectId: "expected-project",
        token: "azure-token",
        username: "prReview-hook",
        settings: testNetworkSettings,
        fetchImpl: async () =>
          Response.json({
            id: "other-repo",
            name: "repository",
            remoteUrl: "https://dev.azure.com/example/project/_git/repository",
            project: { id: "expected-project", name: "project" },
          }),
      }),
    ).rejects.toBeInstanceOf(PrReviewProviderRepositoryError);
  });

  test("blocks private provider destinations on the production transport", async () => {
    await expect(
      verifyPrReviewProviderRepository({
        provider: "gitlab",
        providerBaseUrl: "https://127.0.0.1",
        providerRepositoryId: "42",
        token: "gitlab-token",
        username: null,
        settings: {
          environment: "production",
          integrationsAllowPrivateNetworkTargets: false,
        },
      }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
});
