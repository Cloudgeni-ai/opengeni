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
} from "../../../scripts/public-api/action-catalog";
import { ACTION_CATALOG } from "../src/mcp/action-catalog.gen";
import { buildOrganizationMcpServer, type OrganizationMcpCaller } from "../src/organization-mcp";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const subjectId = "user:33333333-3333-4333-8333-333333333333";

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
  test("covers every public route except the browser-only boundary, and matches the manifest", () => {
    expect(ACTION_CATALOG).toEqual(buildActionCatalog());
    const expected = surface.routes.filter((route) => !isActionCatalogExempt(route.path));
    // Exemptions are the browser-only boundary, nothing else.
    for (const route of surface.routes.filter((each) => isActionCatalogExempt(each.path)))
      expect(route.path).toMatch(
        /^\/v1\/(auth\/|mcp-connections\/|organizations\/:organizationId\/mcp-connections)/,
      );
    const listed = new Set(ACTION_CATALOG.map((entry) => `${entry.method} ${entry.path}`));
    for (const route of expected) expect(listed.has(`${route.method} ${route.path}`)).toBe(true);
    expect(ACTION_CATALOG).toHaveLength(expected.length);
    expect(new Set(ACTION_CATALOG.map((entry) => entry.id)).size).toBe(ACTION_CATALOG.length);
    expect(ACTION_CATALOG.some((entry) => entry.path.startsWith("/v1/auth/"))).toBe(false);
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
