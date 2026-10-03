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
  buildActionCatalog,
  isActionCatalogExempt,
  registeredApiRoutes,
  type ActionCatalogEntry,
} from "../../../scripts/public-api/action-catalog";
import { ACTION_CATALOG } from "../src/mcp/action-catalog.gen";
import { buildOrganizationMcpServer, type OrganizationMcpCaller } from "../src/organization-mcp";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const subjectId = "user:33333333-3333-4333-8333-333333333333";

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
    expect(everything.total).toBe(ACTION_CATALOG.length);
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
