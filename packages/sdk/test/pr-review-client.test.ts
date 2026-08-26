import { describe, expect, test } from "bun:test";
import { OpenGeniCoreClient } from "../src/core";
import { OpenGeniPrReviewClient } from "../src/pr-review";

describe("OpenGeni Review Bot SDK", () => {
  test("keeps PrReview requests behind the optional client entry", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const coreClient = new OpenGeniCoreClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          method: init?.method ?? "GET",
          path: url.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        const responseBody = url.pathname.endsWith("/registrations")
          ? init?.method === "POST"
            ? { id: "registration-1" }
            : { registrations: [], repositories: [] }
          : { id: "repository-1" };
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const client = new OpenGeniPrReviewClient(coreClient);
    const workspaceId = "11111111-1111-4111-8111-111111111111";

    await client.listConfiguration(workspaceId);
    await client.getManagedGitHubSetup(workspaceId);
    await client.createAppRegistration(workspaceId, {
      name: "PrReview",
      provider: "github",
      credentialKind: "github_app",
      appId: "1",
      privateKey: "pem",
      webhookSecret: "secret",
    });
    await client.createRepositoryBinding(workspaceId, {
      registrationId: "registration-1",
      repositoryUri: "https://github.com/example/repo.git",
      repositoryFullName: "example/repo",
      providerRepositoryId: "1",
      installationId: "2",
    });
    await client.deleteAppRegistration(workspaceId, "registration/1");
    await client.deleteRepositoryBinding(workspaceId, "repository/1");

    expect(requests).toEqual([
      {
        method: "GET",
        path: `/v1/workspaces/${workspaceId}/pr-review/registrations`,
        body: undefined,
      },
      {
        method: "GET",
        path: `/v1/workspaces/${workspaceId}/pr-review/github`,
        body: undefined,
      },
      {
        method: "POST",
        path: `/v1/workspaces/${workspaceId}/pr-review/registrations`,
        body: expect.objectContaining({ provider: "github" }),
      },
      {
        method: "POST",
        path: `/v1/workspaces/${workspaceId}/pr-review/repositories`,
        body: expect.objectContaining({ repositoryFullName: "example/repo" }),
      },
      {
        method: "DELETE",
        path: `/v1/workspaces/${workspaceId}/pr-review/registrations/registration%2F1`,
        body: undefined,
      },
      {
        method: "DELETE",
        path: `/v1/workspaces/${workspaceId}/pr-review/repositories/repository%2F1`,
        body: undefined,
      },
    ]);
  });
});
