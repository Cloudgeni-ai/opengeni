import { describe, expect, test } from "bun:test";
import { mcpToolRecommendsApproval, type McpServerConnectionRef } from "@opengeni/contracts";
import {
  DATAVERSE_WEB_API_MCP_BRIDGE_ADAPTER,
  DataverseWebApiMcpServer,
  encodeQueryPath,
  isDataverseMcpConfig,
} from "../src/dataverse-web-api-mcp";

const MCP_URL = "https://contoso.crm17.dynamics.com/api/mcp";
const API = "https://contoso.crm17.dynamics.com/api/data/v9.2/";
const REF: McpServerConnectionRef = {
  kind: "oauth2",
  providerDomain: "contoso.crm17.dynamics.com",
  subjectScope: "subject",
} as McpServerConnectionRef;

type Call = { url: string; init: RequestInit };

function server(
  respond: (call: Call) => Response | Promise<Response>,
  credential: () => Promise<any> = async () => ({
    status: "ok",
    headers: { authorization: "Bearer token" },
    connectionId: "conn-1",
  }),
) {
  const calls: Call[] = [];
  const destinations: string[] = [];
  const authNeeded: unknown[] = [];
  const instance = new DataverseWebApiMcpServer({
    workspaceId: "ws",
    subjectId: "subject",
    serverId: "dynamics",
    mcpUrl: MCP_URL,
    connectionRef: REF,
    resolveCredential: async (input) => {
      destinations.push(input.destinationUrl);
      return await credential();
    },
    onAuthNeeded: (payload) => {
      authNeeded.push(payload);
    },
    fetchImpl: async (input, init) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return await respond(call);
    },
  });
  return { instance, calls, destinations, authNeeded };
}

const text = (result: any) => result.content[0].text as string;

describe("Dataverse Web API bridge", () => {
  test("matches only Dataverse endpoints connected through their own host", () => {
    expect(isDataverseMcpConfig(MCP_URL, REF)).toBe(true);
    expect(
      isDataverseMcpConfig(MCP_URL, { ...REF, providerDomain: "other.crm.dynamics.com" }),
    ).toBe(false);
    expect(isDataverseMcpConfig(MCP_URL, undefined)).toBe(false);
    expect(isDataverseMcpConfig("https://usmf.operations.dynamics.com/mcp", REF)).toBe(false);
    expect(DATAVERSE_WEB_API_MCP_BRIDGE_ADAPTER.matches({ url: MCP_URL, connectionRef: REF })).toBe(
      true,
    );
  });

  test("lists a generic tool set; changes recommend Ask first", async () => {
    const { instance } = server(() => new Response(null, { status: 500 }));
    const tools = await instance.listTools();
    const names = tools.map((entry) => entry.name);
    expect(names).toEqual([
      "dataverse_list_tables",
      "dataverse_describe_table",
      "dataverse_query",
      "dataverse_fetchxml",
      "dataverse_create_record",
      "dataverse_update_record",
      "dataverse_delete_record",
    ]);
    const asks = tools.filter((entry) => mcpToolRecommendsApproval(entry)).map((e) => e.name);
    expect(asks).toEqual([
      "dataverse_create_record",
      "dataverse_update_record",
      "dataverse_delete_record",
    ]);
    for (const entry of tools) {
      expect(entry.description).toEndWith(" Environment: contoso.crm17.dynamics.com.");
    }
    expect(instance.bridge.destinations).toEqual([
      { origin: "https://contoso.crm17.dynamics.com", pathPrefix: "/api/data/v9.2/" },
    ]);
  });

  test("queries the Web API with readable labels and returns the next page as a path", async () => {
    const { instance, calls, destinations } = server(() =>
      Response.json({
        "@odata.context": "ignored",
        value: [
          {
            "@odata.etag": 'W/"1"',
            name: "Bluefin Logistics",
            statecode: 0,
            "statecode@OData.Community.Display.V1.FormattedValue": "Active",
            "_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname": "systemuser",
          },
        ],
        "@odata.nextLink": `${API}accounts?$select=name&$skiptoken=abc`,
      }),
    );
    const result = await instance.callToolResult("dataverse_query", {
      path: "accounts?$select=name,statecode&$filter=name eq 'Bluefin Logistics'",
      pageSize: 50,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      rows: [
        {
          name: "Bluefin Logistics",
          statecode: 0,
          "statecode@label": "Active",
          "_ownerid_value@table": "systemuser",
        },
      ],
      nextLink: "accounts?$select=name&$skiptoken=abc",
    });
    expect(calls[0]!.url).toBe(
      `${API}accounts?$select=name,statecode&$filter=name%20eq%20'Bluefin%20Logistics'`,
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token");
    expect(headers.prefer).toContain("odata.maxpagesize=50");
    expect(headers.prefer).toContain("OData.Community.Display.V1.FormattedValue");
    expect(destinations.at(-1)).toBe(calls[0]!.url);
  });

  test("accepts a full nextLink from the same environment but no other host", async () => {
    const { instance, calls } = server(() => Response.json({ value: [] }));
    await instance.callToolResult("dataverse_query", {
      path: `${API}accounts?$skiptoken=abc`,
    });
    expect(calls[0]!.url).toBe(`${API}accounts?$skiptoken=abc`);
    const foreign = await instance.callToolResult("dataverse_query", {
      path: "https://evil.example/api/data/v9.2/accounts",
    });
    expect(foreign.isError).toBe(true);
    const traversal = await instance.callToolResult("dataverse_query", { path: "../../x" });
    expect(traversal.isError).toBe(true);
    const encoded = await instance.callToolResult("dataverse_query", {
      path: "accounts/%2e%2e/%2E%2E/x",
    });
    expect(encoded.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("keeps the caller's escapes and encodes only what a URL cannot carry", () => {
    expect(encodeQueryPath("accounts?$filter=name eq 'A %26 B'")).toBe(
      "accounts?$filter=name%20eq%20'A%20%26%20B'",
    );
    expect(encodeQueryPath("tasks?$filter=createdon ge 2026-01-01T00:00:00+01:00")).toBe(
      "tasks?$filter=createdon%20ge%202026-01-01T00:00:00%2B01:00",
    );
    expect(encodeQueryPath("accounts?$filter=name eq 'Bjørknes 100%'")).toBe(
      "accounts?$filter=name%20eq%20'Bj%C3%B8rknes%20100%25'",
    );
    const nextLink =
      "contacts?$select=fullname&$skiptoken=%3Ccookie%20pagenumber=%222%22%20pagingcookie=%22%253ccookie%2520page%253d%25221%2522%253e%22%20/%3E";
    expect(encodeQueryPath(nextLink)).toBe(nextLink);
  });

  test("runs FetchXML with paging details", async () => {
    const { instance, calls } = server(() =>
      Response.json({
        value: [{ total: 18000, month: 11 }],
        "@Microsoft.Dynamics.CRM.morerecords": true,
        "@Microsoft.Dynamics.CRM.fetchxmlpagingcookie":
          '<cookie pagenumber="2" pagingcookie="%253ccookie%2520page%253d%25221%2522%253e%253c%252fcookie%253e" istracking="False" />',
      }),
    );
    const fetchXml =
      '<fetch aggregate="true"><entity name="opportunity"><attribute name="estimatedvalue" alias="total" aggregate="sum" /></entity></fetch>';
    const result = await instance.callToolResult("dataverse_fetchxml", {
      table: "opportunities",
      fetchXml,
    });
    expect(calls[0]!.url).toBe(`${API}opportunities?fetchXml=${encodeURIComponent(fetchXml)}`);
    expect(result.structuredContent).toEqual({
      rows: [{ total: 18000, month: 11 }],
      moreRecords: true,
      nextPage: 2,
      pagingCookie: "&lt;cookie page=&quot;1&quot;&gt;&lt;/cookie&gt;",
    });
    expect((calls[0]!.init.headers as Record<string, string>).prefer).toContain(
      "odata.maxpagesize=",
    );
  });

  test("leaves paging to a FetchXML count", async () => {
    const { instance, calls } = server(() => Response.json({ value: [] }));
    await instance.callToolResult("dataverse_fetchxml", {
      table: "accounts",
      fetchXml: '<fetch count="5" page="2"><entity name="account" /></fetch>',
    });
    expect((calls[0]!.init.headers as Record<string, string>).prefer).not.toContain(
      "odata.maxpagesize",
    );
  });

  test("describes a table with choices and lookup bindings", async () => {
    const { instance } = server(({ url }) => {
      if (url.includes("PicklistAttributeMetadata?"))
        return Response.json({
          value: [
            {
              LogicalName: "industrycode",
              OptionSet: {
                Options: [{ Value: 1, Label: { UserLocalizedLabel: { Label: "Accounting" } } }],
              },
            },
          ],
        });
      if (url.includes("AttributeMetadata?")) return Response.json({ value: [] });
      if (url.includes("ManyToOneRelationships"))
        return Response.json({
          value: [
            {
              ReferencingAttribute: "primarycontactid",
              ReferencedEntity: "contact",
              ReferencingEntityNavigationPropertyName: "primarycontactid",
            },
          ],
        });
      return Response.json({
        LogicalName: "account",
        EntitySetName: "accounts",
        PrimaryIdAttribute: "accountid",
        PrimaryNameAttribute: "name",
        DisplayName: { UserLocalizedLabel: { Label: "Account" } },
        Attributes: [
          {
            LogicalName: "name",
            AttributeType: "String",
            AttributeTypeName: { Value: "StringType" },
            DisplayName: { UserLocalizedLabel: { Label: "Account Name" } },
            RequiredLevel: { Value: "ApplicationRequired" },
          },
          {
            LogicalName: "industrycode",
            AttributeType: "Picklist",
            AttributeTypeName: { Value: "PicklistType" },
            DisplayName: { UserLocalizedLabel: { Label: "Industry" } },
            RequiredLevel: { Value: "None" },
          },
          {
            LogicalName: "primarycontactid",
            AttributeType: "Lookup",
            AttributeTypeName: { Value: "LookupType" },
            DisplayName: { UserLocalizedLabel: { Label: "Primary Contact" } },
          },
          { LogicalName: "primarycontactidname", AttributeOf: "primarycontactid" },
        ],
      });
    });
    const result = await instance.callToolResult("dataverse_describe_table", { table: "account" });
    expect(result.structuredContent).toMatchObject({
      table: "account",
      entitySet: "accounts",
      primaryName: "name",
      columns: [
        { column: "industrycode", type: "Picklist", choices: [{ value: 1, label: "Accounting" }] },
        { column: "name", type: "String", label: "Account Name", required: true },
        {
          column: "primarycontactid",
          lookup: [{ table: "contact", bind: "primarycontactid@odata.bind" }],
        },
      ],
    });
    expect(result.structuredContent.columns).toHaveLength(3);
  });

  test("creates and updates with representation; update never upserts", async () => {
    const { instance, calls } = server(({ init }) =>
      Response.json({
        accountid: "00000000-0000-0000-0000-000000000001",
        ...JSON.parse(String(init.body)),
      }),
    );
    const created = await instance.callToolResult("dataverse_create_record", {
      table: "accounts",
      record: { name: "Halcyon eval" },
    });
    expect(created.structuredContent.record.name).toBe("Halcyon eval");
    expect(calls[0]!.init.method).toBe("POST");
    await instance.callToolResult("dataverse_update_record", {
      table: "accounts",
      id: "00000000-0000-0000-0000-000000000001",
      record: { name: "Renamed" },
    });
    const update = calls[1]!;
    expect(update.url).toBe(`${API}accounts(00000000-0000-0000-0000-000000000001)`);
    expect(update.init.method).toBe("PATCH");
    expect((update.init.headers as Record<string, string>)["if-match"]).toBe("*");
  });

  test("a write whose outcome is unknown is not reported as a plain failure", async () => {
    const { instance } = server(() => {
      throw new Error("socket closed");
    });
    await expect(
      instance.callToolResult("dataverse_delete_record", {
        table: "accounts",
        id: "00000000-0000-0000-0000-000000000001",
      }),
    ).rejects.toThrow(/may or may not have been applied/u);
  });

  test("Microsoft's error message reaches the agent", async () => {
    const { instance } = server(() =>
      Response.json(
        {
          error: {
            code: "0x80040220",
            message: "Principal user is missing prvReadAccount privilege.",
          },
        },
        { status: 403 },
      ),
    );
    const result = await instance.callToolResult("dataverse_query", { path: "accounts" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("missing prvReadAccount privilege");
    expect(text(result)).toContain("security roles");
    // Typed for hosts: Microsoft refused it for this account; nothing ran.
    expect(result.structuredContent?.error).toMatchObject({
      code: "provider_permission_denied",
      outcomeUnknown: false,
    });
  });

  test("a write rejected for its sign-in is retried once with a refreshed one", async () => {
    let attempt = 0;
    const { instance, calls } = server(() =>
      ++attempt === 1
        ? new Response(null, { status: 401 })
        : Response.json({ accountid: "00000000-0000-0000-0000-000000000001", name: "A" }),
    );
    const result = await instance.callToolResult("dataverse_create_record", {
      table: "accounts",
      record: { name: "A" },
    });
    expect(calls).toHaveLength(2);
    expect(result.isError).toBeFalsy();
  });

  test("a rejected token is refreshed once, then asks to reconnect", async () => {
    const { instance, calls, authNeeded } = server(() => new Response(null, { status: 401 }));
    const result = await instance.callToolResult("dataverse_query", { path: "accounts" });
    expect(calls).toHaveLength(2);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Reconnect");
    expect(result.structuredContent?.error?.code).toBe("connection_auth_needed");
    expect(authNeeded).toHaveLength(1);
  });

  test("a fresh sign-in Dataverse still refuses with its own error explains access, not reconnect", async () => {
    const { instance, calls, authNeeded } = server(() =>
      Response.json(
        { error: { code: "0x80072560", message: "The user is not a member of the organization." } },
        { status: 401 },
      ),
    );
    const result = await instance.callToolResult("dataverse_query", { path: "accounts" });
    expect(calls).toHaveLength(2);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not a member of the organization");
    expect(text(result)).toContain("may not have access to this Dynamics environment");
    expect(result.structuredContent?.error?.code).toBe("provider_permission_denied");
    expect(authNeeded).toHaveLength(0);
  });

  test("a missing connection surfaces the connect card", async () => {
    const { instance, authNeeded } = server(
      () => Response.json({}),
      async () => ({
        status: "auth_needed",
        reason: "missing_connection",
        providerDomain: "contoso.crm17.dynamics.com",
      }),
    );
    await expect(instance.listTools()).rejects.toThrow(/Reconnect/u);
    expect(authNeeded).toHaveLength(1);
  });
});
