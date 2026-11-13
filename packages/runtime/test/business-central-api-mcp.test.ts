import { describe, expect, test } from "bun:test";
import { mcpToolRecommendsApproval, type McpServerConnectionRef } from "@opengeni/contracts";
import {
  BUSINESS_CENTRAL_API_MCP_BRIDGE_ADAPTER,
  BusinessCentralApiMcpServer,
  isBusinessCentralApiConfig,
  parseMetadata,
} from "../src/business-central-api-mcp";

const TENANT = "017dcee4-abab-4d45-9546-a26f65d15431";
const ROOT = `https://api.businesscentral.dynamics.com/v2.0/${TENANT}/Production/api/v2.0`;
const API = `${ROOT}/`;
const COMPANY = "11111111-2222-3333-4444-555555555555";
const OTHER = "66666666-7777-8888-9999-000000000000";
const REF: McpServerConnectionRef = {
  kind: "oauth2",
  providerDomain: "api.businesscentral.dynamics.com",
  subjectScope: "subject",
} as McpServerConnectionRef;

const METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
<edmx:DataServices><Schema Namespace="Microsoft.NAV" xmlns="http://docs.oasis-open.org/odata/ns/edm">
<EnumType Name="contactType"><Member Name="Company" Value="0"/><Member Name="Person" Value="1"/></EnumType>
<EntityType Name="customer"><Key><PropertyRef Name="id"/></Key>
<Property Name="id" Type="Edm.Guid" Nullable="false"/>
<Property Name="displayName" Type="Edm.String" MaxLength="100"><Annotation Term="Core.Description" String="x"/></Property>
<Property Name="type" Type="Microsoft.NAV.contactType"/>
<NavigationProperty Name="currency" Type="Microsoft.NAV.currency"/>
</EntityType>
<EntityType Name="salesInvoice"><Key><PropertyRef Name="id"/></Key>
<Property Name="id" Type="Edm.Guid" Nullable="false"/>
<NavigationProperty Name="salesInvoiceLines" Type="Collection(Microsoft.NAV.salesInvoiceLine)"/>
</EntityType>
<Action Name="unbound"/>
<Action Name="post" IsBound="true"><Parameter Name="bindingParameter" Type="Microsoft.NAV.salesInvoice"/></Action>
<Action Name="send" IsBound="true"><Parameter Name="bindingParameter" Type="Microsoft.NAV.salesInvoice"/></Action>
<EntityContainer Name="NAV"><EntitySet Name="companies" EntityType="Microsoft.NAV.company"/>
<EntitySet Name="customers" EntityType="Microsoft.NAV.customer"/>
<EntitySet Name="salesInvoices" EntityType="Microsoft.NAV.salesInvoice"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

type Call = { url: string; init: RequestInit };

function server(
  respond: (call: Call) => Response | Promise<Response>,
  companies: { id: string; name: string }[] = [{ id: COMPANY, name: "CRONUS NO" }],
) {
  const calls: Call[] = [];
  const destinations: string[] = [];
  const authNeeded: unknown[] = [];
  const instance = new BusinessCentralApiMcpServer({
    workspaceId: "ws",
    subjectId: "subject",
    serverId: "dynamics",
    mcpUrl: ROOT,
    connectionRef: REF,
    resolveCredential: async (input) => {
      destinations.push(input.destinationUrl);
      return { status: "ok", headers: { authorization: "Bearer token" }, connectionId: "conn-1" };
    },
    onAuthNeeded: (payload) => {
      authNeeded.push(payload);
    },
    fetchImpl: async (input, init) => {
      const call = { url: String(input), init: init ?? {} };
      if (call.url.startsWith(`${API}companies?$select=`))
        return Response.json({ value: companies.map((entry) => ({ ...entry, displayName: "" })) });
      calls.push(call);
      return await respond(call);
    },
  });
  return { instance, calls, destinations, authNeeded };
}

const text = (result: any) => result.content[0].text as string;

describe("Business Central API bridge", () => {
  test("matches only Business Central API roots connected through their own host", () => {
    expect(isBusinessCentralApiConfig(ROOT, REF)).toBe(true);
    expect(isBusinessCentralApiConfig(ROOT, { ...REF, providerDomain: "example.com" })).toBe(false);
    expect(isBusinessCentralApiConfig(ROOT, undefined)).toBe(false);
    expect(isBusinessCentralApiConfig("https://mcp.businesscentral.dynamics.com", REF)).toBe(false);
    expect(BUSINESS_CENTRAL_API_MCP_BRIDGE_ADAPTER.matches({ url: ROOT, connectionRef: REF })).toBe(
      true,
    );
  });

  test("lists a generic tool set naming the environment; changes recommend Ask first", async () => {
    const { instance, destinations } = server(() => new Response(null, { status: 500 }));
    const tools = await instance.listTools();
    expect(tools.map((entry) => entry.name)).toEqual([
      "business_central_list_companies",
      "business_central_list_entities",
      "business_central_describe_entity",
      "business_central_query",
      "business_central_create_record",
      "business_central_update_record",
      "business_central_delete_record",
      "business_central_run_action",
    ]);
    expect(tools.filter((entry) => mcpToolRecommendsApproval(entry)).map((e) => e.name)).toEqual([
      "business_central_create_record",
      "business_central_update_record",
      "business_central_delete_record",
      "business_central_run_action",
    ]);
    for (const entry of tools)
      expect(entry.description).toEndWith(
        ` Business Central environment: Production (tenant ${TENANT}).`,
      );
    expect(destinations).toEqual([`${API}companies`]);
    expect(instance.bridge.destinations).toEqual([
      {
        origin: "https://api.businesscentral.dynamics.com",
        pathPrefix: `/v2.0/${TENANT}/Production/api/v2.0/`,
      },
    ]);
  });

  test("queries the only company and returns the next page as a path", async () => {
    const { instance, calls } = server(() =>
      Response.json({
        "@odata.context": "ignored",
        value: [{ "@odata.etag": 'W/"1"', number: "10000", displayName: "Kontorcentralen AS" }],
        "@odata.nextLink": `${API}companies(${COMPANY})/customers?$skiptoken=abc`,
      }),
    );
    const result = await instance.callToolResult("business_central_query", {
      path: "customers?$select=number,displayName&$filter=displayName eq 'Kontorcentralen AS'",
      pageSize: 20,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      rows: [{ number: "10000", displayName: "Kontorcentralen AS" }],
      nextLink: `companies(${COMPANY})/customers?$skiptoken=abc`,
    });
    expect(calls[0]!.url).toBe(
      `${API}companies(${COMPANY})/customers?$select=number,displayName&$filter=displayName%20eq%20'Kontorcentralen%20AS'`,
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token");
    expect(headers.prefer).toBe("odata.maxpagesize=20");
    // A returned nextLink is used as it is.
    await instance.callToolResult("business_central_query", {
      path: `companies(${COMPANY})/customers?$skiptoken=abc`,
    });
    expect(calls[1]!.url).toBe(`${API}companies(${COMPANY})/customers?$skiptoken=abc`);
  });

  test("picks a company by name or id and asks for one when there are several", async () => {
    const companies = [
      { id: COMPANY, name: "CRONUS NO" },
      { id: OTHER, name: "My Company" },
    ];
    const { instance, calls } = server(() => Response.json({ value: [] }), companies);
    const missing = await instance.callToolResult("business_central_query", { path: "items" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("CRONUS NO, My Company");
    await instance.callToolResult("business_central_query", {
      company: "cronus no",
      path: "items",
    });
    await instance.callToolResult("business_central_query", { company: OTHER, path: "items" });
    expect(calls.map((call) => call.url)).toEqual([
      `${API}companies(${COMPANY})/items`,
      `${API}companies(${OTHER})/items`,
    ]);
    const unknown = await instance.callToolResult("business_central_query", {
      company: "Nope",
      path: "items",
    });
    expect(text(unknown)).toContain("No company named Nope");
  });

  test("refuses paths outside the environment's API", async () => {
    const { instance, calls } = server(() => Response.json({ value: [] }));
    for (const path of [
      "https://evil.example/v2.0/x",
      "../../x",
      "customers/%2e%2e/%2E%2E/x",
      "$batch",
    ]) {
      const result = await instance.callToolResult("business_central_query", { path });
      expect(result.isError).toBe(true);
    }
    const create = await instance.callToolResult("business_central_create_record", {
      entity: "customers/../x",
      record: { displayName: "x" },
    });
    expect(create.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("creates, updates, deletes and runs actions in the company", async () => {
    const { instance, calls } = server((call) =>
      call.init.method === "DELETE" || call.url.includes("Microsoft.NAV.")
        ? new Response(null, { status: 204 })
        : Response.json({ "@odata.etag": 'W/"2"', id: OTHER, displayName: "Halcyon" }),
    );
    const created = await instance.callToolResult("business_central_create_record", {
      entity: "customers",
      record: { displayName: "Halcyon" },
    });
    expect(created.structuredContent).toEqual({ record: { id: OTHER, displayName: "Halcyon" } });
    await instance.callToolResult("business_central_update_record", {
      entity: `salesOrders(${OTHER})/salesOrderLines`,
      id: OTHER,
      record: { quantity: 2 },
    });
    await instance.callToolResult("business_central_delete_record", {
      entity: "customers",
      id: OTHER,
    });
    const posted = await instance.callToolResult("business_central_run_action", {
      entity: "salesInvoices",
      id: OTHER,
      action: "post",
    });
    expect(posted.structuredContent).toEqual({
      done: true,
      entity: "salesInvoices",
      id: OTHER,
      action: "post",
    });
    const prefix = `${API}companies(${COMPANY})`;
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["POST", `${prefix}/customers`],
      ["PATCH", `${prefix}/salesOrders(${OTHER})/salesOrderLines(${OTHER})`],
      ["DELETE", `${prefix}/customers(${OTHER})`],
      ["POST", `${prefix}/salesInvoices(${OTHER})/Microsoft.NAV.post`],
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ displayName: "Halcyon" });
    expect((calls[1]!.init.headers as Record<string, string>)["if-match"]).toBe("*");
    expect((calls[2]!.init.headers as Record<string, string>)["if-match"]).toBe("*");
  });

  test("a write whose outcome is unknown is reported as uncertain, not as an error result", async () => {
    const { instance } = server(() => new Response("{}", { status: 502 }));
    await expect(
      instance.callToolResult("business_central_create_record", {
        entity: "customers",
        record: { displayName: "x" },
      }),
    ).rejects.toThrow("may or may not have been applied");
  });

  test("retries a 401 once, then explains a refusal without asking to reconnect", async () => {
    let attempts = 0;
    const { instance, authNeeded } = server(() => {
      attempts += 1;
      return Response.json(
        { error: { code: "Authentication_InvalidCredentials", message: "No licence." } },
        { status: 401 },
      );
    });
    const result = await instance.callToolResult("business_central_query", { path: "items" });
    expect(attempts).toBe(2);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Business Central returned 401: No licence.");
    expect(text(result)).toContain("no Business Central licence");
    expect(authNeeded).toHaveLength(0);
  });

  test("describes entities from the API's metadata", async () => {
    const { instance, calls } = server(
      () => new Response(METADATA, { headers: { "content-type": "application/xml" } }),
    );
    const listed = await instance.callToolResult("business_central_list_entities", {
      search: "INVOICE",
    });
    expect(listed.structuredContent).toEqual({ entities: ["salesInvoices"] });
    const described = await instance.callToolResult("business_central_describe_entity", {
      entity: "customers",
    });
    expect(described.structuredContent).toEqual({
      entity: "customers",
      key: ["id"],
      properties: [
        { name: "id", type: "Guid", required: true },
        { name: "displayName", type: "String", maxLength: 100 },
        { name: "type", type: "contactType", choices: ["Company", "Person"] },
      ],
      navigation: [{ name: "currency", target: "currency" }],
    });
    const invoices = await instance.callToolResult("business_central_describe_entity", {
      entity: "salesInvoices",
    });
    expect(invoices.structuredContent.actions).toEqual(["post", "send"]);
    expect(invoices.structuredContent.navigation).toEqual([
      { name: "salesInvoiceLines", target: "salesInvoiceLine[]" },
    ]);
    // The metadata is read once per server.
    expect(calls.map((call) => call.url)).toEqual([`${API}$metadata`]);
    expect(parseMetadata(METADATA).actions.get("salesInvoice")).toEqual(["post", "send"]);
  });
});
