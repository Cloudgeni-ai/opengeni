import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  OPENGENI_API_CONTRACT_HEADER,
  organizationAccessPresetPermissions,
  type OrganizationAccessPolicy,
} from "@opengeni/contracts";
import { verifiedDelegatedHumanAuthorizationForRequest } from "@opengeni/core";

import surface from "../../../scripts/public-api/surface.gen.json";
import {
  ACTION_CATALOG_BROWSER_ONLY,
  buildActionCatalog,
  isActionCatalogExempt,
  registeredApiRoutes,
  type ActionCatalogEntry,
} from "../../../scripts/public-api/action-catalog";
import { ACTION_CATALOG } from "../src/mcp/action-catalog.gen";
import {
  buildOrganizationMcpServer,
  organizationMcpIcons,
  READ_ONLY_POST_ACTIONS,
  type OrganizationMcpCaller,
  searchActions,
} from "../src/organization-mcp";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const subjectId = "user:33333333-3333-4333-8333-333333333333";
const insightsRoutes = [
  "/v1/organizations/:accountId/insights/calls",
  "/v1/organizations/:accountId/insights/usage",
  "/v1/workspaces/:workspaceId/insights/calls",
  "/v1/workspaces/:workspaceId/insights/usage",
] as const;

function routeKey(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

function catalogByRoute(entries: readonly ActionCatalogEntry[]) {
  const routes = new Map<string, ActionCatalogEntry>();
  const ids = new Set<string>();
  const duplicateRoutes = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const entry of entries) {
    const key = routeKey(entry);
    if (routes.has(key)) duplicateRoutes.add(key);
    if (ids.has(entry.id)) duplicateIds.add(entry.id);
    ids.add(entry.id);
    routes.set(key, {
      ...entry,
      request: [...entry.request].sort(),
      response: [...entry.response].sort(),
    });
  }
  expect(duplicateRoutes).toEqual(new Set());
  expect(duplicateIds).toEqual(new Set());
  return routes;
}

function assertCatalogMatches(
  actual: readonly ActionCatalogEntry[],
  expected: readonly ActionCatalogEntry[],
): void {
  expect(catalogByRoute(actual)).toEqual(catalogByRoute(expected));
}

const full: OrganizationAccessPolicy = {
  preset: "full",
  permissions: organizationAccessPresetPermissions("full"),
  workspaceScope: { kind: "all" },
};
const readOnly: OrganizationAccessPolicy = {
  preset: "read_only",
  permissions: organizationAccessPresetPermissions("read_only"),
  workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
};

function person(access: OrganizationAccessPolicy): OrganizationMcpCaller {
  return { kind: "person", accountId: organizationId, subjectId, access };
}

async function connect(
  caller: OrganizationMcpCaller,
  respond: (request: Request) => Response = () => Response.json({ ok: true }),
) {
  const seen: Request[] = [];
  const server = buildOrganizationMcpServer({
    caller,
    origin: "https://app.example.test",
    dispatch: async (request) => {
      seen.push(request);
      return respond(request);
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Plain-text errors stay text.
    }
    return { isError: result.isError === true, value };
  };
  return { client, call, seen };
}

describe("organization MCP action catalog", () => {
  test("covers every registered route except the listed exemptions, and is current", () => {
    const registered = registeredApiRoutes();
    // Regenerate with `bun scripts/public-api/action-catalog.ts --write`.
    assertCatalogMatches(ACTION_CATALOG, buildActionCatalog(registered));
    const listed = new Set(ACTION_CATALOG.map(routeKey));
    // Independently require the complete route union, not only generator parity.
    const callable = new Set(
      [...registered, ...surface.routes]
        .filter((route) => !isActionCatalogExempt(route.path))
        .map(routeKey),
    );
    expect(listed).toEqual(callable);
    // Every read-only POST exception names a real POST action.
    for (const path of READ_ONLY_POST_ACTIONS) expect(listed.has(`POST ${path}`)).toBe(true);
    // UI actions that live outside the SDK are included too.
    for (const key of [
      "PATCH /v1/organizations/:organizationId/codex/settings",
      "POST /v1/workspaces/:workspaceId/codex/accounts/:accountId/reset-credits/redeem",
      "POST /v1/workspaces/:workspaceId/integrations/slack/user-links",
    ])
      expect(listed.has(key)).toBe(true);
    // The browser-only boundary stays out.
    for (const key of [
      "POST /v1/mcp-connections/requests/:request",
      "PATCH /v1/organizations/:organizationId/mcp-connections/:connectionId",
      "POST /v1/identity/login-bindings/:bindingId/recovery",
    ])
      expect(listed.has(key)).toBe(false);
  });

  test("marks exactly the actions that need the person's own browser session", () => {
    const browserOnly = ACTION_CATALOG.filter((entry) => entry.browserOnly);
    // A change here is deliberate: each one is refused for every MCP caller.
    expect(browserOnly.map(routeKey).sort()).toEqual(
      [
        "GET /v1/inbox",
        "GET /v1/inbox/settings",
        "PATCH /v1/inbox/items/:itemId",
        "PATCH /v1/organizations/:organizationId/agent-admin-access",
        "PUT /v1/inbox/settings",
        "GET /v1/workspaces/:workspaceId/sessions/:sessionId/inbox-mute",
        "PUT /v1/workspaces/:workspaceId/sessions/:sessionId/inbox-mute",
        "POST /v1/organizations",
        "POST /v1/organizations/additional",
        "GET /v1/organization-memberships",
        "GET /v1/organization-invitations",
        "POST /v1/organization-invitations/:invitationId/accept",
        "GET /v1/organizations/:organizationId/recovery",
        "PUT /v1/organizations/:organizationId/recovery/policy",
        "PUT /v1/workspaces/:workspaceId/sessions/:sessionId/admin-access",
        "POST /v1/organizations/:organizationId/recovery/policy/accept",
        "POST /v1/organizations/:organizationId/recovery/policy/disable",
        "POST /v1/organizations/:organizationId/recovery/operations",
        "POST /v1/organizations/:organizationId/recovery/operations/:recoveryOperationId/approve",
        "POST /v1/organizations/:organizationId/recovery/operations/:recoveryOperationId/cancel",
        "POST /v1/organizations/:organizationId/recovery/operations/:recoveryOperationId/execute",
        "GET /v1/workspaces/:workspaceId/identity-links",
        "POST /v1/workspaces/:workspaceId/identity-links",
        "GET /v1/workspaces/:workspaceId/identity-links/:linkId",
        "POST /v1/workspaces/:workspaceId/identity-links/:linkId",
        "GET /v1/workspaces/:workspaceId/identity-links/:linkId/:operation",
        "POST /v1/workspaces/:workspaceId/identity-links/:linkId/:operation",
      ].sort(),
    );
    // Every rule still names a real action.
    for (const rule of ACTION_CATALOG_BROWSER_ONLY)
      expect(ACTION_CATALOG.some((entry) => rule.pattern.test(routeKey(entry)))).toBe(true);
  });

  test("catalog parity is order-independent but rejects missing, extra and ambiguous actions", () => {
    const expected: ActionCatalogEntry[] = [
      {
        id: "readFixture",
        method: "GET",
        path: "/v1/fixture",
        request: [],
        response: ["Fixture", "FixtureError"],
      },
      {
        id: "createFixture",
        method: "POST",
        path: "/v1/fixture",
        request: ["CreateFixture", "FixtureOptions"],
        response: ["Fixture"],
      },
    ];
    const reordered = [...expected].reverse().map((entry) => ({
      ...entry,
      request: [...entry.request].reverse(),
      response: [...entry.response].reverse(),
    }));
    assertCatalogMatches(reordered, expected);
    const [read, create] = expected as [ActionCatalogEntry, ActionCatalogEntry];
    for (const invalid of [
      [read],
      [...expected, { ...read, id: "extraFixture", path: "/v1/fixture/extra" }],
      [read, { ...create, method: "DELETE" }],
      [read, { ...create, request: [] }],
      [read, { ...create, response: [] }],
      [read, { ...create, id: "wrongAction" }],
      [read, { ...create, id: read.id }],
      [...expected, { ...read, id: "shadowFixture" }],
    ]) {
      expect(() => assertCatalogMatches(invalid, expected)).toThrow();
    }
  });
});

describe("organization MCP server", () => {
  test("advertises the brand icons in serverInfo", async () => {
    const { client } = await connect(person(readOnly));
    try {
      const info = client.getServerVersion()!;
      expect(info.name).toBe("opengeni");
      expect(info.title).toBe("Opengeni");
      expect(info.icons?.map(({ mimeType, sizes, theme }) => ({ mimeType, sizes, theme }))).toEqual(
        [
          { mimeType: "image/svg+xml", sizes: ["any"], theme: "light" },
          { mimeType: "image/svg+xml", sizes: ["any"], theme: "dark" },
        ],
      );
      const marks = info.icons!.map(({ src }) => {
        expect(src.startsWith("data:image/svg+xml;base64,")).toBe(true);
        return Buffer.from(src.slice(src.indexOf(",") + 1), "base64").toString("utf8");
      });
      expect(marks[0]).toContain('fill="#111111"');
      expect(marks[1]).toContain('fill="#FFFFFF"');
    } finally {
      await client.close();
    }
    expect(organizationMcpIcons("https://app.example.test").at(-1)).toEqual({
      src: "https://app.example.test/icon-512.png",
      mimeType: "image/png",
      sizes: ["512x512"],
      theme: "light",
    });
  });

  test.each(insightsRoutes)(
    "discovers, describes and dispatches %s with the original read-only person proof",
    async (path) => {
      const { client, call, seen } = await connect(person(readOnly));
      try {
        // Generated ids follow the SDK method name when one maps the route.
        const id = ACTION_CATALOG.find(
          (entry) => entry.method === "GET" && entry.path === path,
        )!.id;
        const found = (await call("opengeni_actions_search", { query: "insights", limit: 50 }))
          .value as { actions: Array<{ id: string; method: string; path: string }> };
        expect(found.actions).toContainEqual({ id, method: "GET", path });
        const parameter = path.includes(":accountId") ? "accountId" : "workspaceId";
        const value = parameter === "accountId" ? organizationId : workspaceId;
        const described = (await call("opengeni_action_describe", { id })).value as {
          method: string;
          path: string;
          pathParameters: string[];
        };
        expect(described).toMatchObject({ method: "GET", path, pathParameters: [parameter] });
        const result = await call("opengeni_action_call", {
          id,
          pathParameters: { [parameter]: value },
          query: { range: "week", provider: ["anthropic", "openai"] },
          // GET action input cannot manufacture another actor or a write body.
          body: { subjectId: "user:spoofed", permissions: ["workspace:admin"] },
        });
        expect(result).toEqual({ isError: false, value: { status: 200, body: { ok: true } } });
        expect(seen).toHaveLength(1);
        const request = seen[0]!;
        const url = new URL(request.url);
        expect(request.method).toBe("GET");
        expect(url.pathname).toBe(path.replace(`:${parameter}`, value));
        expect(url.origin).toBe("https://app.example.test");
        expect([...url.searchParams.entries()]).toEqual([
          ["range", "week"],
          ["provider", "anthropic"],
          ["provider", "openai"],
        ]);
        expect(request.body).toBeNull();
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("cookie")).toBeNull();
        expect(verifiedDelegatedHumanAuthorizationForRequest(request)).toEqual({
          organizationId,
          subjectId,
          permissions: readOnly.permissions,
          workspaceScope: readOnly.workspaceScope,
        });
      } finally {
        await client.close();
      }
    },
  );

  test.each(insightsRoutes)(
    "%s forwards route denial without substituting the requested scope for caller authority",
    async (path) => {
      const { client, call, seen } = await connect(person(readOnly), () =>
        Response.json({ message: "scope permission denied" }, { status: 403 }),
      );
      try {
        const parameter = path.includes(":accountId") ? "accountId" : "workspaceId";
        const otherScope = "44444444-4444-4444-8444-444444444444";
        const result = await call("opengeni_action_call", {
          id: `GET ${path}`,
          pathParameters: { [parameter]: otherScope },
          query: { range: "week" },
        });
        expect(result).toEqual({
          isError: true,
          value: { status: 403, body: { message: "scope permission denied" } },
        });
        expect(seen).toHaveLength(1);
        expect(new URL(seen[0]!.url).pathname).toBe(path.replace(`:${parameter}`, otherScope));
        expect(verifiedDelegatedHumanAuthorizationForRequest(seen[0]!)).toEqual({
          organizationId,
          subjectId,
          permissions: readOnly.permissions,
          workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
        });
      } finally {
        await client.close();
      }
    },
  );

  test("lists find, describe and run, and finds actions by words", async () => {
    const { client, call } = await connect(person(full));
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "opengeni_actions_search",
      "opengeni_action_describe",
      "opengeni_action_call",
    ]);
    const found = (await call("opengeni_actions_search", { query: "create session" })).value as {
      actions: Array<{ id: string }>;
    };
    expect(found.actions[0]!.id).toBe("createSession");
    const everything = (await call("opengeni_actions_search", { limit: 5 })).value as {
      total: number;
      actions: unknown[];
    };
    expect(everything.total).toBe(ACTION_CATALOG.filter((entry) => !entry.browserOnly).length);
    expect(everything.actions).toHaveLength(5);
    const described = (await call("opengeni_action_describe", { id: "createSession" })).value as {
      method: string;
      pathParameters: string[];
      input: Array<{ in: string; schema: unknown }>;
    };
    expect(described.method).toBe("POST");
    expect(described.pathParameters).toEqual(["workspaceId"]);
    expect(described.input[0]!.in).toBe("body");
    expect(described.input[0]!.schema).toMatchObject({ type: "object" });
  });

  test("a person's call runs the route in process with the verified proof and nothing else", async () => {
    const { call, seen } = await connect(person(full), () =>
      Response.json({ id: "session" }, { status: 201 }),
    );
    const result = await call("opengeni_action_call", {
      id: "createSession",
      pathParameters: { workspaceId },
      body: { initialMessage: "Hello" },
    });
    expect(result).toEqual({ isError: false, value: { status: 201, body: { id: "session" } } });
    const request = seen[0]!;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(`/v1/workspaces/${workspaceId}/sessions`);
    expect(new URL(request.url).origin).toBe("https://app.example.test");
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("cookie")).toBeNull();
    expect(request.headers.get(OPENGENI_API_CONTRACT_HEADER)).not.toBeNull();
    expect(await request.json()).toEqual({ initialMessage: "Hello" });
    expect(verifiedDelegatedHumanAuthorizationForRequest(request)).toMatchObject({
      organizationId,
      subjectId,
      workspaceScope: { kind: "all" },
    });
  });

  test("read only refuses changes before anything runs; reads still work", async () => {
    const { call, seen } = await connect(person(readOnly));
    const refused = await call("opengeni_action_call", {
      id: "createSession",
      pathParameters: { workspaceId },
      body: {},
    });
    expect(refused.isError).toBe(true);
    expect(String(refused.value)).toContain("read only");
    expect(seen).toHaveLength(0);
    const read = await call("opengeni_action_call", {
      id: "listSessionPage",
      pathParameters: { workspaceId },
      query: { limit: 5 },
    });
    expect(read.isError).toBe(false);
    expect(new URL(seen[0]!.url).search).toBe("?limit=5");
    expect(verifiedDelegatedHumanAuthorizationForRequest(seen[0]!)?.workspaceScope).toEqual({
      kind: "selected",
      workspaceIds: [workspaceId],
    });
    // Searching sends the query as a POST body, but only reads: it runs.
    const search = await call("opengeni_action_call", {
      id: "POST /v1/workspaces/:workspaceId/knowledge/search",
      pathParameters: { workspaceId },
      body: { query: "release notes" },
    });
    expect(search.isError).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.method).toBe("POST");
  });

  test("an organization API key forwards its own credential and carries no person proof", async () => {
    const { call, seen } = await connect({
      kind: "key",
      authorization: "Bearer ogk_fixture",
      accessKey: null,
    });
    await call("opengeni_action_call", { id: "getAccessContext" });
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer ogk_fixture");
    expect(verifiedDelegatedHumanAuthorizationForRequest(seen[0]!)).toBeNull();
  });

  test("missing parameters, unknown actions, redirects and browser-only refusals read clearly", async () => {
    const { call } = await connect(person(full), (request) =>
      new URL(request.url).pathname === "/v1/access/me"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://provider.example/consent" },
          })
        : Response.json({ message: "managed human session required" }, { status: 403 }),
    );
    expect((await call("opengeni_action_call", { id: "createSession", body: {} })).value).toContain(
      "Missing path parameter workspaceId",
    );
    for (const dots of [".", ".."]) {
      const escaped = await call("opengeni_action_call", {
        id: "listSessionPage",
        pathParameters: { workspaceId: dots },
      });
      expect(escaped).toEqual({ isError: true, value: "Invalid path parameter workspaceId." });
    }
    expect((await call("opengeni_action_call", { id: "nope" })).isError).toBe(true);
    expect((await call("opengeni_action_call", { id: "getAccessContext" })).value).toMatchObject({
      status: 302,
      openInBrowser: "https://provider.example/consent",
    });
    const refused = await call("opengeni_action_call", {
      id: "listSessionPage",
      pathParameters: { workspaceId },
    });
    expect(refused.isError).toBe(true);
    expect(refused.value).toMatchObject({ status: 403, hint: expect.stringContaining("browser") });
  });
});

describe("organization MCP browser-only actions", () => {
  const hidden = ACTION_CATALOG.find((entry) => entry.id === "listOrganizationMemberships")!;
  const key: OrganizationMcpCaller = {
    kind: "key",
    authorization: "Bearer ogk_fixture",
    accessKey: null,
  };

  test("are never found by search, at any page", async () => {
    expect(hidden.browserOnly).toBeTruthy();
    const { client, call } = await connect(person(full));
    try {
      for (const query of ["organization memberships", "list organization memberships", ""]) {
        const ids: string[] = [];
        let total = Infinity;
        for (let offset = 0; offset < total; offset += 50) {
          const page = (await call("opengeni_actions_search", { query, limit: 50, offset }))
            .value as { total: number; actions: Array<{ id: string }> };
          total = page.total;
          ids.push(...page.actions.map((action) => action.id));
        }
        expect(ids).toHaveLength(total);
        for (const entry of ACTION_CATALOG.filter((candidate) => candidate.browserOnly))
          expect(ids).not.toContain(entry.id);
      }
    } finally {
      await client.close();
    }
  });

  test.each([
    ["a person", person(full)],
    ["an organization API key", key],
  ] as const)(
    "describe and call explain the browser requirement to %s without running anything",
    async (_label, caller) => {
      const { client, call, seen } = await connect(caller);
      try {
        for (const id of [hidden.id, `${hidden.method} ${hidden.path}`]) {
          for (const tool of ["opengeni_action_describe", "opengeni_action_call"]) {
            expect(await call(tool, { id })).toEqual({
              isError: true,
              value: `listOrganizationMemberships isn't available to connected agents or API keys: ${hidden.browserOnly}. The person has to do it in the Opengeni app in a browser.`,
            });
          }
        }
        expect(seen).toHaveLength(0);
      } finally {
        await client.close();
      }
    },
  );

  test("a route's own browser-session 401 still carries the browser hint", async () => {
    const { client, call } = await connect(person(full), () =>
      Response.json({ message: "managed human session required" }, { status: 401 }),
    );
    try {
      const result = await call("opengeni_action_call", { id: "getAccessContext" });
      expect(result.isError).toBe(true);
      expect(result.value).toMatchObject({ status: 401, hint: expect.stringContaining("browser") });
    } finally {
      await client.close();
    }
  });
});

describe("organization MCP action search", () => {
  test("ranks name matches above path matches", () => {
    const first = (query: string) => searchActions({ query, limit: 1, offset: 0 }).actions[0]?.id;
    expect(first("list workspaces")).toBe("listWorkspaces");
    expect(first("workspaces")).toBe("listWorkspaces");
    expect(first("create session")).toBe("createSession");
    expect(first("github repositories")).toBe("listGitHubRepositories");
  });
});
