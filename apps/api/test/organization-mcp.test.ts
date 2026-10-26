import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  OPENGENI_API_CONTRACT_HEADER,
  Permission,
  SitePublishWarningFix,
  organizationAccessPresetPermissions,
  type OrganizationAccessPolicy,
} from "@opengeni/contracts";
import {
  measureInsightsPhase,
  verifiedDelegatedHumanAuthorizationForRequest,
} from "@opengeni/core";

import surface from "../../../scripts/public-api/surface.gen.json";
import {
  ACCESS_GATE_OPERATIONS,
  ACCESS_GATE_WRAPPERS,
  ACTION_CATALOG_BROWSER_ONLY,
  buildActionCatalog,
  isActionCatalogExempt,
  registeredApiRoutes,
  routeInputs,
  ACTION_REQUEST_SCHEMAS,
  type ActionCatalogEntry,
} from "../../../scripts/public-api/action-catalog";
import * as primitives from "../../../packages/contracts/src/primitives";
import { secretValue, secretValues } from "@opengeni/contracts";
import {
  ACTION_PLAIN_STRING_MAPS,
  ACTION_SECRET_FIELD_EXCEPTIONS,
  actionFieldPaths as allFieldPaths,
  actionSecretFields,
  schemaSecretFields,
  unclassifiedStringMaps,
} from "../../../scripts/public-api/action-secrets";
import { ACTION_CATALOG, READ_ONLY_POST_ACTIONS } from "@opengeni/contracts/app-actions";
import {
  buildOrganizationMcpServer,
  organizationMcpIcons,
  type OrganizationMcpCaller,
  searchActions,
} from "../src/organization-mcp";
import { measureSessionCreatePhase } from "../src/session-create-observability";

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
  respond: (request: Request) => Response | Promise<Response> = () => Response.json({ ok: true }),
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
    // An agent with the person's full access approves sign-ins and manages
    // connected agents as them; sign-in methods and recovery stay out.
    for (const key of [
      "POST /v1/mcp-connections/requests/:request",
      "PATCH /v1/organizations/:organizationId/mcp-connections/:connectionId",
    ])
      expect(listed.has(key)).toBe(true);
    expect(listed.has("POST /v1/identity/login-bindings/:bindingId/recovery")).toBe(false);
    expect(listed.has("POST /v1/integrations/teams/messages")).toBe(false);
  });

  test("marks every action that carries a secret, from its schemas, unless an exception says why not", () => {
    // The catalog's marks are exactly what the schemas say: a new action with
    // a secret field is marked when the catalog is regenerated, and this fails
    // until it is (or until an exception in action-secrets.ts gives a reason).
    for (const entry of ACTION_CATALOG) {
      expect([entry.id, entry.secretFields ?? []]).toEqual([entry.id, actionSecretFields(entry)]);
    }
    // The rule itself, on a schema no route uses.
    const sample = z.object({
      apiKey: z.string(),
      credentialVersion: z.number(),
      hasWebhookSecret: z.boolean(),
      credential: z.object({ connectionId: z.string() }),
      bundle: z.object({ credentials: z.record(z.string(), z.string()) }),
      nested: z.array(z.object({ clientSecret: z.string().optional() })),
      references: z.object({ otp: z.string() }),
      previewToken: z.string(),
      code: z.string(),
      status: z.object({ errorCode: z.string(), code: z.string() }),
      kind: z.enum(["token", "secret"]),
    });
    expect(schemaSecretFields(sample, "request")).toEqual([
      "request.apiKey",
      "request.bundle.credentials",
      "request.code",
      "request.nested[].clientSecret",
    ]);
    expect(schemaSecretFields(sample, "response")).toEqual([
      "response.apiKey",
      "response.bundle.credentials",
      "response.nested[].clientSecret",
    ]);
    // A field marked secret in its contract counts whatever it is called; an
    // unmarked bundle with a plain name doesn't.
    const marked = z.object({
      headers: secretValue(z.record(z.string(), z.string())).optional(),
      values: z.record(z.string(), z.string()),
      items: z.array(z.object({ blob: secretValue(z.string()) })),
    });
    expect(schemaSecretFields(marked, "request")).toEqual([
      "request.headers",
      "request.items[].blob",
    ]);
    // Marks belong to one field's schema, never a shared primitive.
    for (const [name, value] of Object.entries(primitives))
      if (value instanceof z.ZodType)
        expect([name, secretValues.has(value)]).toEqual([name, false]);
    // Every open map of strings (the shape of a header or credential bundle)
    // is either marked secret or listed as plain with its reason.
    for (const entry of ACTION_CATALOG)
      for (const [side, names] of [
        ["request", entry.request],
        ["response", entry.response],
      ] as const)
        for (const name of names)
          expect([entry.id, name, unclassifiedStringMaps(name, side)]).toEqual([
            entry.id,
            name,
            [],
          ]);
    // Every exception still matches something, so none outlives its reason.
    const everyPath = ACTION_CATALOG.flatMap((entry) =>
      [
        ...entry.request.map((name) => ["request", name] as const),
        ...entry.response.map((name) => ["response", name] as const),
      ].flatMap(([side, name]) => allFieldPaths(name, side)),
    );
    for (const exception of [...ACTION_SECRET_FIELD_EXCEPTIONS, ...ACTION_PLAIN_STRING_MAPS])
      expect([exception.reason, everyPath.some((path) => exception.path.test(path))]).toEqual([
        exception.reason,
        true,
      ]);
  });

  test("marks exactly the actions no agent can do as the person", () => {
    const browserOnly = ACTION_CATALOG.filter((entry) => entry.browserOnly);
    // A change here is deliberate: each one is refused for every MCP caller.
    expect(browserOnly.map(routeKey).sort()).toEqual(
      [
        "POST /v1/organizations",
        "POST /v1/organizations/additional",
        "GET /v1/organization-memberships",
        "GET /v1/organization-invitations",
        "POST /v1/organization-invitations/:invitationId/accept",
        "GET /v1/organizations/:organizationId/recovery",
        "PUT /v1/organizations/:organizationId/recovery/policy",
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
        // Teams setup and account linking require the person's verified browser.
        "PUT /v1/workspaces/:workspaceId/integrations/teams/bot",
        "DELETE /v1/workspaces/:workspaceId/integrations/teams/bot",
        "POST /v1/workspaces/:workspaceId/integrations/teams/link",
        "DELETE /v1/workspaces/:workspaceId/integrations/teams/link",
        // a task's usage limit bounds agent spending; agents never change it.
        "PUT /v1/workspaces/:workspaceId/sessions/:sessionId/usage-limit",
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
    expect(everything.total).toBe(
      ACTION_CATALOG.filter((entry) => !entry.browserOnly && !entry.retired).length,
    );
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

  test("vault actions describe their bodies and queries", async () => {
    const { call } = await connect(person(full));
    const describeAction = async (id: string) =>
      (await call("opengeni_action_describe", { id })).value as {
        input: Array<{ name: string; in: string; schema: Record<string, any> | null }>;
      };
    const update = await describeAction("PATCH /v1/workspaces/:workspaceId/vaults/:vaultId");
    expect(update.input[0]).toMatchObject({ name: "UpdateVaultRequest", in: "body" });
    expect(update.input[0]!.schema!.required).toContain("expectedGeneration");
    const remove = await describeAction("DELETE /v1/workspaces/:workspaceId/vaults/:vaultId");
    expect(remove.input[0]).toMatchObject({ name: "DeleteVaultRequest", in: "body" });
    expect(remove.input[0]!.schema!.required).toEqual(["confirmName"]);
    const link = await describeAction("POST /v1/workspaces/:workspaceId/vaults/link");
    expect(link.input[0]).toMatchObject({ name: "LinkProviderVaultRequest", in: "body" });
    expect(link.input[0]!.schema).toMatchObject({ type: "object" });
    const items = await describeAction("GET /v1/workspaces/:workspaceId/vaults/:vaultId/items");
    expect(items.input[0]).toMatchObject({ name: "ListVaultItemsQuery", in: "query" });
    expect(Object.keys(items.input[0]!.schema!.properties)).toContain("includeArchived");
    const approval = await describeAction(
      "PUT /v1/workspaces/:workspaceId/vaults/:vaultId/items/:itemId/approval",
    );
    expect(approval.input[0]).toMatchObject({ name: "SetVaultItemApprovalRequest", in: "body" });
    expect(approval.input[0]!.schema).toMatchObject({ type: "object" });
  });

  test("publication fixes describe both required bodies and invoke the route contract", async () => {
    const id = "POST /v1/workspaces/:workspaceId/published-artifacts/:artifactId/publication/fixes";
    const { client, call, seen } = await connect(person(full), async (request) => {
      const parsed = SitePublishWarningFix.safeParse(await request.json());
      return Response.json(parsed.success ? parsed.data : { message: "invalid fix" }, {
        status: parsed.success ? 200 : 400,
      });
    });
    try {
      const described = await call("opengeni_action_describe", { id });
      expect(described.isError).toBe(false);
      expect(described.value).toMatchObject({
        method: "POST",
        pathParameters: ["workspaceId", "artifactId"],
        input: [
          {
            name: "SitePublishWarningFix",
            in: "body",
            schema: {
              oneOf: [
                {
                  required: ["kind", "collection", "guestAccess"],
                  properties: {
                    kind: { const: "site_data_guest_access" },
                    guestAccess: { enum: ["read", "append", "own"] },
                  },
                },
                {
                  required: ["kind", "query", "audience"],
                  properties: {
                    kind: { const: "site_sql_query_audience" },
                    audience: { enum: ["everyone", "signed_in"] },
                  },
                },
              ],
            },
          },
        ],
      });
      const pathParameters = { workspaceId, artifactId: "44444444-4444-4444-8444-444444444444" };
      for (const body of [
        { kind: "site_data_guest_access", collection: "deals", guestAccess: "read" },
        { kind: "site_sql_query_audience", query: "top_customers", audience: "everyone" },
      ]) {
        expect(await call("opengeni_action_call", { id, pathParameters, body })).toEqual({
          isError: false,
          value: { status: 200, body },
        });
      }
      for (const body of [{}, { kind: "site_data_guest_access", collection: "deals" }]) {
        expect(await call("opengeni_action_call", { id, pathParameters, body })).toEqual({
          isError: true,
          value: { status: 400, body: { message: "invalid fix" } },
        });
      }
      expect(seen).toHaveLength(4);
    } finally {
      await client.close();
    }
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

  test("compact session-page guidance uses ordinary query dispatch without changing defaults", async () => {
    const { call, seen } = await connect(person(readOnly));
    const compact = await call("opengeni_action_call", {
      id: "listSessionPage",
      pathParameters: { workspaceId },
      query: { view: "page", projection: "summary", limit: 50, cursor: "next-page" },
    });
    expect(compact.isError).toBe(false);
    expect(Object.fromEntries(new URL(seen[0]!.url).searchParams)).toEqual({
      view: "page",
      projection: "summary",
      limit: "50",
      cursor: "next-page",
    });
    const fullPage = await call("opengeni_action_call", {
      id: "listSessionPage",
      pathParameters: { workspaceId },
      query: { view: "page", limit: 50 },
    });
    expect(fullPage.isError).toBe(false);
    expect(new URL(seen[1]!.url).searchParams.has("projection")).toBe(false);
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
      id: "listKnowledgeEntries",
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

describe("organization MCP action inputs", () => {
  const byId = (id: string) => ACTION_CATALOG.find((entry) => entry.id === id)!;

  test("come from what each route's handler validates", () => {
    expect(byId("sendEvent").request).toEqual(["ClientSessionEvent"]);
    expect(byId("steerMessage").request).toEqual(["SteerSessionMessageRequest"]);
    expect(byId("saveWorkspaceSkill").request).toEqual(["SaveWorkspaceSkillRequest"]);
    expect(byId("removeWorkspaceSkill").request).toEqual(["RemoveWorkspaceSkillRequest"]);
    expect(byId("listScheduledTasks").query).toEqual(["limit", "offset", "sessionId"]);
    expect(byId("listWorkspaceSkills").query).toEqual(expect.arrayContaining(["cursor", "limit"]));
  });

  test("the route source reader finds body and query schemas, query names and retirement", () => {
    expect(
      routeInputs([
        `async (c) => {
          const page = c.req.query("cursor");
          const query = c.req.query();
          const { view } = c.req.query();
          const filter = parseRequestQuery(z.object({ status: z.string() }).strict(), c.req.query());
          const body = await parseRequestJson(c, SaveWorkspaceSkillRequest, { status: 422 });
          return c.json({ page, limit: query.limit, view, filter, body });
        }`,
      ]),
    ).toEqual({
      body: ["SaveWorkspaceSkillRequest"],
      query: [],
      queryParameters: ["cursor", "limit", "status", "view"],
    });
    // A schema checked against values the route assembles from its path is
    // not the body when the handler reads none.
    expect(
      routeInputs([
        `async (c) => parseRequestBody(SaveWorkspaceSkillRequest, { id: c.req.param("id") })`,
      ]).body,
    ).toEqual([]);
    expect(
      routeInputs([
        `async (c) => { throw routeRetired("POST /v1/workspaces/:workspaceId/knowledge/entries/search", "moved"); }`,
      ]).retired,
    ).toBe("POST /v1/workspaces/:workspaceId/knowledge/entries/search");
  });

  test("the route source reader names the permission a route checks before anything else", () => {
    const gate = (...sources: string[]) => routeInputs(sources).permission;
    expect(
      gate(`async (c) => {
        const workspaceId = c.req.param("workspaceId"), payload = await parseRequestJson(c, X);
        const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
        return c.json(await list(grant, payload));
      }`),
    ).toBe("sessions:read");
    // At the start of a try/finally, or returned by an awaited wrapper's
    // arrow function, as a measured phase does.
    expect(
      gate(`async (c) => {
        const startedAt = performance.now();
        try {
          const workspaceId = c.req.param("workspaceId");
          const grant = await measureInsightsPhase(observe, "auth", () =>
            requireAccessGrant(c, deps, workspaceId, "workspace:admin"),
          );
          return c.json(await read(grant));
        } finally {
          observe(performance.now() - startedAt);
        }
      }`),
    ).toBe("workspace:admin");
    // A listed helper's operation names its permission; one it doesn't list,
    // or reading one's own usage, names none.
    expect(gate(`async (c) => { const scope = await authorize(c, deps, "read"); }`)).toBe(
      "workspace:admin",
    );
    expect(gate(`async (c) => { await authorize(c, deps, "own"); }`)).toBeUndefined();
    expect(gate(`async (c) => { await authorize(c, deps, "renamed"); }`)).toBeUndefined();
    // Not when a catch could swallow the refusal.
    expect(
      gate(`async (c) => {
        try {
          await requireAccessGrant(c, deps, id, "workspace:admin");
        } catch {
          return c.json({});
        }
      }`),
    ).toBeUndefined();
    // Not when a branch, return or throw could skip the check, the checked
    // value isn't a permission, or the route's handlers disagree.
    expect(
      gate(`async (c) => {
        if (c.req.query("public")) return c.json({});
        await requireAccessGrant(c, deps, c.req.param("workspaceId"), "sessions:read");
      }`),
    ).toBeUndefined();
    expect(gate(`async (c) => { await requireAccessGrant(c, deps, id, scope); }`)).toBeUndefined();
    expect(
      gate(
        `async (c) => { await requireAccessGrant(c, deps, id, "sessions:read"); }`,
        `async (c) => { await requireAccessGrant(c, deps, id, "workspace:read"); }`,
      ),
    ).toBeUndefined();
    expect(byId("listSessionPage").permission).toBe("sessions:read");
    expect(byId("getMyUsage").permission).toBeUndefined();
    expect(byId("getWorkspaceInsights").permission).toBe("workspace:admin");
    expect(byId("createSession").permission).toBe("sessions:create");
    // Helper-gated usage routes, from the hand-named table.
    expect(byId("getUsage").permission).toBe("workspace:admin");
    expect(byId("setWorkspaceAllowance").permission).toBe("account:admin");
  });

  test("every route checked through an operation helper gets that operation's permission", async () => {
    const operations = ACCESS_GATE_OPERATIONS.authorize!;
    for (const permission of Object.values(operations))
      if (permission !== null)
        expect(Permission.safeParse(permission).success, permission).toBe(true);
    // The listed operations are exactly the helper's own, so a renamed,
    // removed or new operation fails here.
    const helper = await Bun.file(
      new URL("../src/routes/usage-allowances.ts", import.meta.url),
    ).text();
    const declared = [
      ...(/type Operation =([^;]+);/u.exec(helper)?.[1] ?? "").matchAll(/"([^"]+)"/gu),
    ].map((match) => match[1]!);
    expect(declared.sort()).toEqual(Object.keys(operations).sort());
    // Every route that calls the helper, wherever in its handler, carries its
    // operation's permission in the catalog; a route the reader can't decode
    // (the call moved behind a branch) fails here rather than being offered.
    const used = new Set<string>();
    for (const route of registeredApiRoutes()) {
      const called = (route.sources ?? []).flatMap((source) =>
        [...source.matchAll(/\bauthorize\(\s*c\s*,\s*deps\s*,\s*"([^"]+)"\s*\)/gu)].map(
          (match) => match[1]!,
        ),
      );
      if (called.length === 0) continue;
      const key = routeKey(route);
      for (const operation of called) {
        expect(Object.keys(operations), key).toContain(operation);
        used.add(operation);
      }
      const entry = ACTION_CATALOG.find((action) => routeKey(action) === key);
      expect(entry, key).toBeDefined();
      expect(entry!.permission, key).toBe(operations[called[0]!] ?? undefined);
    }
    expect([...used].sort()).toEqual(Object.keys(operations).sort());
  });

  test("every listed access-check wrapper runs its work once and passes on its refusal", async () => {
    const span = { end: async () => undefined };
    const runs: Record<string, ((work: () => Promise<string>) => Promise<string>)[]> = {
      measureInsightsPhase: [
        (work) => measureInsightsPhase(undefined, "auth", work),
        (work) => measureInsightsPhase(() => undefined, "auth", work),
      ],
      measureSessionCreatePhase: [
        (work) => measureSessionCreatePhase(null, "authorization", work),
        (work) =>
          measureSessionCreatePhase({ startSpan: () => span } as never, "authorization", work),
      ],
    };
    expect(Object.keys(runs).sort()).toEqual([...ACCESS_GATE_WRAPPERS].sort());
    for (const [name, variants] of Object.entries(runs)) {
      for (const run of variants) {
        let calls = 0;
        expect(
          await run(async () => {
            calls += 1;
            return "granted";
          }),
          name,
        ).toBe("granted");
        expect(calls, name).toBe(1);
        const refusal = new Error("missing permission");
        await expect(
          run(async () => {
            throw refusal;
          }),
          name,
        ).rejects.toBe(refusal);
      }
    }
    // An unlisted wrapper names nothing, even around a gate.
    expect(
      routeInputs([
        `async (c) => {
          const grant = await maybe(() => requireAccessGrant(c, deps, id, "workspace:admin"));
        }`,
      ]).permission,
    ).toBeUndefined();
  });

  test("every hand-named request schema is still needed", () => {
    for (const rule of ACTION_REQUEST_SCHEMAS) {
      const routes = registeredApiRoutes().filter((route) => rule.pattern.test(routeKey(route)));
      expect(routes).not.toEqual([]);
      for (const route of routes) expect(routeInputs(route.sources ?? []).body).toEqual([]);
    }
  });

  test("describe shows the body schema and the query parameters", async () => {
    const { client, call } = await connect(person(full));
    try {
      for (const id of ["sendEvent", "saveWorkspaceSkill"]) {
        const described = (await call("opengeni_action_describe", { id })).value as {
          input: Array<{ in: string; schema: { properties?: Record<string, unknown> } | null }>;
        };
        expect(described.input).toHaveLength(1);
        expect(described.input[0]!.in).toBe("body");
        expect(described.input[0]!.schema).not.toBeNull();
      }
      const skill = (await call("opengeni_action_describe", { id: "saveWorkspaceSkill" }))
        .value as {
        input: Array<{ schema: { required?: string[]; properties: Record<string, unknown> } }>;
      };
      expect(skill.input[0]!.schema.required).toContain("stableKey");
      expect(Object.keys(skill.input[0]!.schema.properties)).toContain("scope");
      const list = (await call("opengeni_action_describe", { id: "listScheduledTasks" })).value as {
        queryParameters?: string[];
      };
      expect(list.queryParameters).toEqual(["limit", "offset", "sessionId"]);
    } finally {
      await client.close();
    }
  });
});

describe("organization MCP retired actions", () => {
  const retiredEntries = ACTION_CATALOG.filter((entry) => entry.retired);

  test("are the retired search routes, never found and never run", async () => {
    expect(retiredEntries.map(routeKey).sort()).toEqual([
      "POST /v1/workspaces/:workspaceId/document-bases/:baseId/search",
      "POST /v1/workspaces/:workspaceId/knowledge/search",
    ]);
    const { client, call, seen } = await connect(person(full));
    try {
      const page = searchActions({ query: "knowledge search", limit: 50, offset: 0 });
      for (const entry of retiredEntries)
        expect(page.actions.map((action) => action.id)).not.toContain(entry.id);
      expect(page.actions.map((action) => action.id)).toContain("listKnowledgeEntries");
      for (const entry of retiredEntries) {
        for (const [tool, args] of [
          ["opengeni_action_describe", { id: entry.id }],
          ["opengeni_action_call", { id: entry.id, pathParameters: { workspaceId } }],
        ] as const) {
          expect(await call(tool, args)).toEqual({
            isError: true,
            value: `${entry.id} was removed. Use the listKnowledgeEntries action (POST /v1/workspaces/:workspaceId/knowledge/entries/search) instead; describe it for its input.`,
          });
        }
      }
      expect(seen).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});

describe("organization MCP large responses", () => {
  const item = (index: number) => ({ id: `task-${index}`, prompt: "x".repeat(4_000) });

  test("a list keeps whole items and says how to page with offset", async () => {
    const tasks = Array.from({ length: 100 }, (_, index) => item(index));
    const { client, call } = await connect(person(full), () => Response.json(tasks));
    try {
      const result = (
        await call("opengeni_action_call", {
          id: "listScheduledTasks",
          pathParameters: { workspaceId },
          query: { offset: 10 },
        })
      ).value as {
        status: number;
        body: Array<{ id: string }>;
        truncated: { returnedItems: number; totalItems: number; returnedBytes: number };
        hint: string;
      };
      const count = result.truncated.returnedItems;
      expect(result.status).toBe(200);
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(100);
      expect(result.truncated.totalItems).toBe(100);
      expect(result.body.map((task) => task.id)).toEqual(tasks.slice(0, count).map((t) => t.id));
      expect(result.hint).toBe(
        `Only the first ${count} of the 100 items in this response fit in one result. Call again with query offset=${10 + count} and limit=${count} for the next items.`,
      );
      const text = JSON.stringify(result);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
    } finally {
      await client.close();
    }
  });

  test("a cursor page trims its largest list and says how to get pages that fit", async () => {
    const items = Array.from({ length: 100 }, (_, index) => item(index));
    const { client, call } = await connect(person(full), () =>
      Response.json({ items, nextCursor: "next" }),
    );
    try {
      const result = (
        await call("opengeni_action_call", {
          id: "listWorkspaceSkills",
          pathParameters: { workspaceId },
        })
      ).value as {
        body: { items: unknown[]; nextCursor: string };
        truncated: { returnedItems: number; field: string };
        hint: string;
      };
      expect(result.truncated.field).toBe("items");
      expect(result.body.items).toHaveLength(result.truncated.returnedItems);
      expect(result.body.nextCursor).toBe("next");
      expect(result.hint).toContain(
        `Call again with query limit=${result.truncated.returnedItems}`,
      );
    } finally {
      await client.close();
    }
  });

  test("a body that is not a list keeps the byte cut", async () => {
    const { client, call } = await connect(person(full), () =>
      Response.json({ text: "x".repeat(300_000) }),
    );
    try {
      const result = (await call("opengeni_action_call", { id: "getAccessContext" })).value as {
        body: string;
        truncated: { returnedBytes: number; totalBytes: number };
      };
      expect(typeof result.body).toBe("string");
      expect(result.truncated.returnedBytes).toBe(256 * 1024);
    } finally {
      await client.close();
    }
  });
});
