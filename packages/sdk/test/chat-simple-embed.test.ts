// The simple embedding path: the host speaks only its own ids (user, tenant).
// Workspaces are created on first use, the organization comes from the key,
// and membership is left to the API (no client-side external-member calls).
import { describe, expect, test } from "bun:test";
import { Opengeni } from "../src/chat";
import { createSessionProxyHandler } from "../src/session-proxy";

const API = "https://api.example.test";
const ORGANIZATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWN_WORKSPACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Recorded = { method: string; path: string; headers: Headers; body: Record<string, unknown> };

function fakeApi(
  credential: Record<string, unknown> | null = {
    kind: "organization_api_key",
    accountId: ORGANIZATION_ID,
    workspaceId: null,
    effectiveWorkspacePermissions: [],
    note: "",
  },
) {
  const requests: Recorded[] = [];
  const workspaces = new Map<string, string>();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? {}
        : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
    requests.push({ method: request.method, path, headers: request.headers, body });
    if (path === "/v1/access/me") {
      return Response.json({
        mode: "configured",
        subjectId: "api_key:fixture",
        accountGrants: [],
        workspaceGrants: [],
        defaultAccountId: credential ? ORGANIZATION_ID : null,
        defaultWorkspaceId: null,
        ...(credential ? { credential } : {}),
      });
    }
    if (request.method === "PUT" && path === "/v1/workspaces/external") {
      const key = `${String(body.externalSource)}\u0000${String(body.externalId)}`;
      if (!workspaces.has(key)) workspaces.set(key, `ws${workspaces.size + 1}`);
      return Response.json({
        workspace: { id: workspaces.get(key), accountId: body.accountId, name: body.name },
      });
    }
    if (request.method === "GET" && /\/sessions\/[^/]+$/.test(path)) {
      return Response.json({ message: "session not found" }, { status: 404 });
    }
    if (request.method === "POST" && path.endsWith("/sessions")) {
      return Response.json({ id: "session-1", initialMessage: body.initialMessage });
    }
    return Response.json({});
  };
  return {
    requests,
    fetch,
    ensures: () => requests.filter((request) => request.path === "/v1/workspaces/external"),
    memberCalls: () => requests.filter((request) => request.path.includes("external-members")),
  };
}

function actorOf(request: Recorded): unknown {
  const header = request.headers.get("x-opengeni-external-actor");
  return header ? JSON.parse(decodeURIComponent(header)) : null;
}

describe("simple embed path", () => {
  test("organizationId is optional and derived once from the key", async () => {
    const api = fakeApi();
    const og = new Opengeni({ apiKey: "og_test", baseUrl: API, fetch: api.fetch });
    expect(og.organizationId).toBe("");
    const [a, b] = await Promise.all([
      og.workspaceId({ tenant: "acme" }),
      og.workspaceId({ tenant: "globex" }),
    ]);
    expect(a).not.toBe(b);
    expect(api.requests.filter((request) => request.path === "/v1/access/me")).toHaveLength(1);
    expect(api.ensures().map((request) => request.body.accountId)).toEqual([
      ORGANIZATION_ID,
      ORGANIZATION_ID,
    ]);
    expect(og.organizationId).toBe(ORGANIZATION_ID);
    expect(await og.resolveOrganizationId()).toBe(ORGANIZATION_ID);
  });

  test("an explicit organizationId skips the lookup", async () => {
    const api = fakeApi();
    const og = new Opengeni({
      apiKey: "og_test",
      organizationId: ORGANIZATION_ID,
      baseUrl: API,
      fetch: api.fetch,
    });
    await og.workspaceId({ user: "alice" });
    expect(api.requests.some((request) => request.path === "/v1/access/me")).toBe(false);
  });

  test("a workspace key cannot derive an organization", async () => {
    const api = fakeApi({
      kind: "workspace_api_key",
      accountId: ORGANIZATION_ID,
      workspaceId: OWN_WORKSPACE_ID,
      effectiveWorkspacePermissions: [],
      note: "",
    });
    const og = new Opengeni({ apiKey: "og_test", baseUrl: API, fetch: api.fetch });
    await expect(og.workspaceId({ tenant: "acme" })).rejects.toThrow("organization API key");
    expect(api.ensures()).toHaveLength(0);
  });

  test("blank env values fall back to the hosted API and the key's organization", async () => {
    const seen: string[] = [];
    const og = new Opengeni({
      apiKey: "og_test",
      // What `process.env.X` yields for `OPENGENI_API_BASE_URL=` in a copied .env.example.
      baseUrl: "",
      organizationId: "  ",
      fetch: async (input) => {
        seen.push(String(input instanceof Request ? input.url : input));
        return new Response(JSON.stringify({ error: { message: "stop" } }), { status: 500 });
      },
    });
    expect(og.organizationId).toBe("");
    await og.resolveOrganizationId().catch(() => undefined);
    expect(seen[0]?.startsWith("https://app.opengeni.ai/")).toBe(true);
  });

  test("workspaceId translates tenant, user and explicit ids; only per-user workspaces add their owner", async () => {
    const api = fakeApi();
    const og = new Opengeni({ apiKey: "og_test", baseUrl: API, fetch: api.fetch });
    const tenant = await og.workspaceId({ tenant: "acme" });
    const alice = await og.workspaceId({ user: "alice" });
    const bob = await og.workspaceId({ user: "bob" });
    expect(new Set([tenant, alice, bob]).size).toBe(3);
    // Cached and stable per instance.
    expect(await og.workspaceId({ user: "alice" })).toBe(alice);
    expect(await og.workspaceId({ tenant: "acme" })).toBe(tenant);
    expect(api.ensures()).toHaveLength(3);
    // Explicit ids pass through; workspaceId wins, then tenant, then user.
    expect(await og.workspaceId({ workspaceId: OWN_WORKSPACE_ID })).toBe(OWN_WORKSPACE_ID);
    expect(await og.workspaceId({ tenant: "acme", user: "alice" })).toBe(tenant);
    // A per-user workspace never aliases a tenant called like the user.
    expect(await og.workspaceId({ tenant: "alice" })).not.toBe(alice);
    // Tenant workspaces rely on first-use membership; a per-user workspace is
    // single-user, so the SDK adds exactly its owner (the API never auto-admits there).
    expect(api.memberCalls().map((request) => [request.path, request.body.identity])).toEqual([
      [`/v1/workspaces/${alice}/external-members`, { source: "app", externalId: "alice" }],
      [`/v1/workspaces/${bob}/external-members`, { source: "app", externalId: "bob" }],
    ]);
    await expect(og.workspaceId({})).rejects.toThrow("tenant, user, or workspaceId");
    // A tenant/workspaceId key without a value never falls back to the user's workspace.
    await expect(og.workspaceId({ tenant: undefined, user: "alice" })).rejects.toThrow("undefined");
    await expect(og.workspaceId({ tenant: "", user: "alice" })).rejects.toThrow("non-empty");
    await expect(og.workspaceId({ workspaceId: "", user: "alice" })).rejects.toThrow("non-empty");
  });

  test.each([
    ["{ user, tenant }", { tenant: "acme" }, 0],
    ["{ user }", {}, 1],
    ["{ user, workspaceId }", { workspaceId: OWN_WORKSPACE_ID }, 0],
  ] as const)(
    "chat() with %s acts as the user in the mapped workspace",
    async (_label, target, owners) => {
      const api = fakeApi();
      const og = new Opengeni({ apiKey: "og_test", baseUrl: API, fetch: api.fetch });
      const expected = await og.workspaceId({ ...target, user: "alice" });
      const chat = await og.chat({ ...target, user: "alice", conversation: "c1" });
      expect(chat.workspaceId).toBe(expected);
      const lookup = api.requests.find((request) => /\/sessions\/[^/]+$/.test(request.path))!;
      expect(lookup.path.startsWith(`/v1/workspaces/${expected}/sessions/`)).toBe(true);
      expect(actorOf(lookup)).toEqual({
        mode: "external",
        identity: { externalId: "alice", source: "app" },
      });
      expect(api.memberCalls()).toHaveLength(owners);
    },
  );

  test("the proxy's client config names the resolved workspace for a baseUrl-only browser", async () => {
    const api = fakeApi();
    const og = new Opengeni({ apiKey: "og_test", baseUrl: API, fetch: api.fetch });
    const handler = createSessionProxyHandler(og, { resolve: () => ({ user: "alice" }) });
    const response = await handler(
      new Request("https://product.test/api/opengeni/v1/config/client"),
    );
    expect(response.status).toBe(200);
    const config = (await response.json()) as { workspaceId?: string };
    expect(config.workspaceId).toBe(await og.workspaceId({ user: "alice" }));
  });

  test("chat() without tenant, workspaceId or user is refused", async () => {
    const api = fakeApi();
    const og = new Opengeni({ apiKey: "og_test", baseUrl: API, fetch: api.fetch });
    // The type requires user, tenant or workspaceId; check the runtime guard too.
    await expect(og.chat({ conversation: "c1" } as never)).rejects.toThrow(
      "tenant, user, or workspaceId",
    );
  });

  test.each([
    ["{ user, tenant }", { tenant: "acme" }, 0],
    ["{ user }", {}, 1],
    ["{ user, workspaceId }", { workspaceId: OWN_WORKSPACE_ID }, 0],
  ] as const)(
    "the session proxy resolves %s to the same workspace as og.workspaceId",
    async (_label, target, owners) => {
      const api = fakeApi();
      const og = new Opengeni({ apiKey: "og_test", baseUrl: API, fetch: api.fetch });
      const handler = createSessionProxyHandler(og, {
        resolve: () => ({ ...target, user: "alice" }),
        createSession: (input) => input,
      });
      const workspaceId = await og.workspaceId({ ...target, user: "alice" });
      const response = await handler(
        new Request(`https://product.test/api/opengeni/v1/workspaces/${workspaceId}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initialMessage: "hello" }),
        }),
      );
      expect(response.status).toBe(200);
      const create = api.requests.find(
        (request) => request.method === "POST" && request.path.endsWith("/sessions"),
      )!;
      expect(create.path).toBe(`/v1/workspaces/${workspaceId}/sessions`);
      expect(create.body).toMatchObject({ initialMessage: "hello", visibility: "private" });
      expect(actorOf(create)).toEqual({
        mode: "external",
        identity: { externalId: "alice", source: "app" },
      });
      expect(api.memberCalls()).toHaveLength(owners);
    },
  );

  test.each([
    ["undefined tenant", { tenant: undefined }],
    ["undefined workspaceId", { workspaceId: undefined }],
    ["empty tenant", { tenant: "" }],
    ["empty workspaceId", { workspaceId: "" }],
  ] as const)("the session proxy refuses a resolve with an %s", async (_label, target) => {
    const api = fakeApi();
    const og = new Opengeni({ apiKey: "og_test", baseUrl: API, fetch: api.fetch });
    const handler = createSessionProxyHandler(og, {
      resolve: () => ({ ...target, user: "alice" }) as never,
    });
    const outcome = await handler(
      new Request("https://product.test/api/opengeni/v1/config/client"),
    ).catch((error: unknown) => error);
    if (outcome instanceof Response) expect(outcome.status).toBeGreaterThanOrEqual(500);
    else expect(String(outcome)).toContain("empty tenant or workspaceId");
    expect(api.ensures()).toHaveLength(0);
  });
});
