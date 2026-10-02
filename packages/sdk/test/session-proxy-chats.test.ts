import { describe, expect, test } from "bun:test";
import { OpenGeni } from "../src/chat";
import type { Chats } from "../src/chats";
import { OpenGeniEmbeddingClient } from "../src/embedding-client";
import { OpenGeniApiError, OpenGeniSetupError } from "../src/errors";
import { createSessionProxyHandler } from "../src/session-proxy";
import { createWorkspaceIdResolver } from "../src/tenant-workspaces";
import type { CreateSessionRequest } from "../src/types";
import { SESSION_ID, WORKSPACE_ID } from "./helpers";

const API = "https://api.example.test";
const ORGANIZATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fakeApi() {
  const requests: { path: string; headers: Headers; body: Record<string, unknown> }[] = [];
  let failure: { code: string; message: string; status: number } | undefined;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body =
      request.method === "GET" ? {} : ((await request.json()) as Record<string, unknown>);
    requests.push({ path, headers: request.headers, body });
    if (failure)
      return Response.json(
        { code: failure.code, message: failure.message },
        { status: failure.status },
      );
    if (path === "/v1/workspaces/external") {
      return Response.json({
        workspace: { id: body.externalId === "acme" ? WORKSPACE_ID : body.externalId },
      });
    }
    return Response.json({ session: { id: SESSION_ID } });
  };
  const client = new OpenGeniEmbeddingClient({ baseUrl: API, apiKey: "og_test", fetch });
  const og = new OpenGeni({
    organizationId: ORGANIZATION_ID,
    apiKey: "og_test",
    baseUrl: API,
    fetch,
  });
  return {
    requests,
    client,
    og,
    fetch,
    fail: (error: typeof failure) => {
      failure = error;
    },
  };
}

function createRequest(workspaceId = WORKSPACE_ID) {
  return new Request(`https://product.test/api/opengeni/v1/workspaces/${workspaceId}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initialMessage: "hello" }),
  });
}

describe("session proxy chats", () => {
  test.each([
    [undefined, "private", "session", "user"],
    ["private", "private", "session", "user"],
    ["shared", "workspace", "workspace", "workspace"],
  ] as const)(
    "maps %s exactly using the public visibility wire values",
    async (chats, visibility, agentAccess, memoryScope) => {
      const api = fakeApi();
      const handler = createSessionProxyHandler(api.client, {
        chats,
        resolve: () => ({ workspaceId: WORKSPACE_ID, user: "alice", source: "app" }),
        createSession: (input) => ({ ...input, agent: { identity: "Acme", renderer: "opengeni" } }),
      });
      expect((await handler(createRequest())).status).toBe(200);
      expect(api.requests[0]!.body).toEqual({
        initialMessage: "hello",
        visibility,
        agentAccess,
        memoryScope,
        agent: { identity: "Acme", renderer: "opengeni" },
      });
      expect(
        JSON.parse(decodeURIComponent(api.requests[0]!.headers.get("x-opengeni-external-actor")!)),
      ).toEqual({
        mode: "external",
        identity: { externalId: "alice", source: "app" },
      });
    },
  );

  test.each(["private", "shared"] as Chats[])(
    "explicit hook fields override %s, including undefined omissions",
    async (chats) => {
      const api = fakeApi();
      const handler = createSessionProxyHandler(api.client, {
        chats,
        resolve: () => ({ workspaceId: WORKSPACE_ID, user: "alice" }),
        createSession: (input) => ({
          ...input,
          visibility: "workspace",
          agentAccess: "user",
          memoryScope: "off",
        }),
      });
      await handler(createRequest());
      expect(api.requests[0]!.body).toMatchObject({
        visibility: "workspace",
        agentAccess: "user",
        memoryScope: "off",
      });
      const omissions = createSessionProxyHandler(api.client, {
        chats,
        resolve: () => ({ workspaceId: WORKSPACE_ID, user: "alice" }),
        createSession: (input) => ({
          ...input,
          visibility: undefined,
          agentAccess: undefined,
          memoryScope: undefined,
        }),
      });
      await omissions(createRequest());
      expect(api.requests[1]!.body.memoryScope).toBe(chats === "shared" ? "workspace" : "user");
    },
  );

  test("isolated maps users and sources to separate workspaces, provisioning once with stable member keys", async () => {
    const api = fakeApi();
    const alice = await api.og.workspaceIdFor(
      { tenant: "acme", user: "alice" },
      { isolation: "user" },
    );
    const bob = await api.og.workspaceIdFor({ tenant: "acme", user: "bob" }, { isolation: "user" });
    expect(alice).not.toBe(bob);
    const handler = createSessionProxyHandler(api.og, {
      chats: "isolated",
      resolve: (request) => ({ tenant: "acme", user: request.headers.get("user") ?? "alice" }),
      createSession: (input) => input,
    });
    expect((await handler(createRequest(alice))).status).toBe(200);
    const bobRequest = createRequest(bob);
    bobRequest.headers.set("user", "bob");
    expect((await handler(bobRequest)).status).toBe(200);
    expect((await handler(createRequest(bob))).status).toBe(403);
    const creates = api.requests.filter((request) => request.path.endsWith("/sessions"));
    expect(creates.map((request) => request.path)).toEqual([
      `/v1/workspaces/${alice}/sessions`,
      `/v1/workspaces/${bob}/sessions`,
    ]);
    expect(creates[0]!.body).toEqual({
      initialMessage: "hello",
      visibility: "private",
      agentAccess: "session",
      memoryScope: "user",
    });
    const members = api.requests.filter((request) => request.path.endsWith("/external-members"));
    expect(members).toHaveLength(2);
    expect(members.map((request) => request.body.identity)).toEqual([
      { source: "app", externalId: "alice" },
      { source: "app", externalId: "bob" },
    ]);
    expect(members[0]!.body.permissions).toEqual([
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
      "files:upload",
      "files:read",
      "mcp_servers:attach",
    ]);
    const again = createWorkspaceIdResolver(api.client, {
      organizationId: ORGANIZATION_ID,
      source: "app",
    });
    expect(await again({ tenant: "acme", user: "alice" }, { isolation: "user" })).toBe(alice);
    expect(api.requests.at(-1)!.body.operationId).toBe(members[0]!.body.operationId);
    expect(
      await api.og.workspaceIdFor(
        { tenant: "acme", user: "alice", source: "other" },
        { isolation: "user" },
      ),
    ).not.toBe(alice);
    expect(await api.og.workspaceId({ tenant: "acme" })).not.toBe(alice);
    const otherProduct = createWorkspaceIdResolver(api.client, {
      organizationId: ORGANIZATION_ID,
      source: "other-product",
    });
    expect(
      await otherProduct({ tenant: "acme", user: "alice", source: "app" }, { isolation: "user" }),
    ).not.toBe(alice);
  });

  test("custom member permissions replace defaults and are copied at resolver creation", async () => {
    const api = fakeApi();
    const permissions = ["workspace:read", "sessions:read"];
    const resolver = createWorkspaceIdResolver(api.client, {
      organizationId: ORGANIZATION_ID,
      source: "app",
      memberPermissions: permissions,
    });
    permissions.push("workspace:admin");
    await resolver({ tenant: "acme", user: "alice" }, { isolation: "user" });
    expect(api.requests.at(-1)!.body.permissions).toEqual(["workspace:read", "sessions:read"]);
    await resolver({ tenant: "acme" }, { isolation: "tenant" });
    expect(
      api.requests.filter((request) => request.path.endsWith("/external-members")),
    ).toHaveLength(1);
  });

  test("the chat facade forwards custom isolated member permissions", async () => {
    const api = fakeApi();
    const og = new OpenGeni({
      organizationId: ORGANIZATION_ID,
      apiKey: "og_test",
      baseUrl: API,
      fetch: api.fetch,
      memberPermissions: ["workspace:read", "sessions:create", "sessions:read", "sessions:control"],
    });
    await og.workspaceIdFor({ tenant: "acme", user: "alice" }, { isolation: "user" });
    expect(api.requests.at(-1)!.body.permissions).toEqual([
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
    ]);
  });

  test("a definitive onboarding conflict returns only the address without retrying the grant", async () => {
    const api = fakeApi();
    let grants = 0;
    const resolver = createWorkspaceIdResolver(
      {
        ensureWorkspace: (request) => api.client.ensureWorkspace(request),
        addExternalWorkspaceMember: async () => {
          grants++;
          throw new OpenGeniApiError(
            409,
            "External membership operation changed or was cancelled",
            { code: "conflict" },
          );
        },
      },
      { organizationId: ORGANIZATION_ID, source: "app" },
    );
    const workspaceId = await resolver({ tenant: "acme", user: "alice" }, { isolation: "user" });
    expect(workspaceId).toBe(api.requests[0]!.body.externalId as string);
    expect(await resolver({ tenant: "acme", user: "alice" }, { isolation: "user" })).toBe(
      workspaceId,
    );
    expect(grants).toBe(1);
  });

  test.each([
    new OpenGeniApiError(403, "membership exceeds key authority"),
    new OpenGeniApiError(409, "unknown outcome", { code: "conflict", outcomeUnknown: true }),
    new OpenGeniApiError(409, "contract changed", { code: "API_CONTRACT_CHANGED" }),
    new OpenGeniSetupError(new OpenGeniApiError(409, "private chats require setup")),
    new OpenGeniApiError(503, "unavailable"),
  ])(
    "other or uncertain onboarding failures propagate and evict the cache (%s)",
    async (failure) => {
      const api = fakeApi();
      let grants = 0;
      const resolver = createWorkspaceIdResolver(
        {
          ensureWorkspace: (request) => api.client.ensureWorkspace(request),
          addExternalWorkspaceMember: async () => {
            grants++;
            throw failure;
          },
        },
        { organizationId: ORGANIZATION_ID, source: "app" },
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          resolver({ tenant: "acme", user: "alice" }, { isolation: "user" }),
        ).rejects.toBe(failure);
      }
      expect(grants).toBe(2);
    },
  );

  test("rejected mutations never provision isolated workspaces or members", async () => {
    const api = fakeApi();
    const handler = createSessionProxyHandler(api.og, {
      chats: "isolated",
      resolve: () => ({ tenant: "acme", user: "alice" }),
      authorizeMutation: () => false,
      createSession: (input) => input,
    });
    expect((await handler(createRequest())).status).toBe(403);
    expect(api.requests).toHaveLength(0);
  });

  test("a product using the SDK isolation source cannot alias its shared tenant workspace", async () => {
    const api = fakeApi();
    const resolver = createWorkspaceIdResolver(api.client, {
      organizationId: ORGANIZATION_ID,
      source: "opengeni-sdk:user-isolation",
    });
    await resolver({ tenant: "acme", user: "alice" }, { isolation: "user" });
    const isolated = api.requests[0]!.body;
    await resolver({ tenant: isolated.externalId as string }, { isolation: "tenant" });
    const shared = api.requests.at(-1)!.body;
    expect(shared.externalId).toBe(isolated.externalId);
    expect(shared.externalSource).not.toBe(isolated.externalSource);
  });

  test("isolated rejects an explicit workspace or missing user rather than silently sharing", async () => {
    const api = fakeApi();
    const handler = createSessionProxyHandler(api.client, {
      chats: "isolated",
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "alice" }),
    });
    expect((await handler(createRequest())).status).toBe(500);
    await expect(api.og.workspaceIdFor({ tenant: "acme" }, { isolation: "user" })).rejects.toThrow(
      "authenticated",
    );
    expect(api.requests).toHaveLength(0);
  });

  test("setup error is actionable through both the direct client and the proxy's browser client", async () => {
    const api = fakeApi();
    api.fail({
      code: "SESSION_TENANCY_NOT_ACTIVATED",
      message: "Private sessions are not enabled for this organization.",
      status: 409,
    });
    const handler = createSessionProxyHandler(api.client, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "alice" }),
      createSession: (input) => input,
    });
    const browser = new OpenGeniEmbeddingClient({
      baseUrl: "https://product.test/api/opengeni",
      fetch: (input, init) => handler(new Request(input, init)),
    });
    for (const client of [api.client, browser]) {
      try {
        await client.createSession(WORKSPACE_ID, { initialMessage: "x" });
        throw new Error("Expected setup error");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenGeniSetupError);
        expect(error).toBeInstanceOf(OpenGeniApiError);
        expect(error).toMatchObject({
          status: 409,
          code: "OPENGENI_SETUP_REQUIRED",
          retryable: false,
        });
        for (const text of [
          "organization_private_session_settings.enabled",
          "owner or admin",
          "web app",
          "updateOrganizationPrivateSessionSettings",
          "PATCH /v1/organizations",
          "expectedVersion",
          "operationId",
        ]) {
          expect((error as Error).message).toContain(text);
        }
      }
    }
  });

  test("unrelated forbidden and server errors are not misclassified as setup errors", async () => {
    const api = fakeApi();
    for (const failure of [
      { code: "SESSION_CREATE_FORBIDDEN", message: "Forbidden.", status: 403 },
      { code: "SESSION_TENANCY_NOT_ACTIVATED", message: "Failure.", status: 500 },
    ]) {
      api.fail(failure);
      const result = api.client.createSession(WORKSPACE_ID, {} as CreateSessionRequest);
      await expect(result).rejects.toBeInstanceOf(OpenGeniApiError);
      await expect(result).rejects.not.toBeInstanceOf(OpenGeniSetupError);
    }
  });
});
