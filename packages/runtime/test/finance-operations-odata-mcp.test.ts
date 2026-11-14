import { describe, expect, test } from "bun:test";
import { mcpToolRecommendsApproval, type McpServerConnectionRef } from "@opengeni/contracts";
import { DATAVERSE_WEB_API_MCP_BRIDGE_ADAPTER } from "../src/dataverse-web-api-mcp";
import {
  FINANCE_OPERATIONS_ODATA_MCP_BRIDGE_ADAPTER,
  FINANCE_OPERATIONS_ODATA_TOOLS,
  FinanceOperationsODataMcpServer,
  isFinanceOperationsMcpConfig,
} from "../src/finance-operations-odata-mcp";
import { fixedBridgeConnectorTools } from "../src/index";

const HOST = "contoso.operations.ch.dynamics.com";
const MCP_URL = `https://${HOST}/mcp`;
const DATA = `https://${HOST}/data/`;
const METADATA = `https://${HOST}/Metadata/`;
const REF: McpServerConnectionRef = {
  kind: "oauth2",
  providerDomain: HOST,
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
  const instance = new FinanceOperationsODataMcpServer({
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
const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

describe("Finance and Operations OData bridge", () => {
  test("its tools are the connector's tools outside a run, without asking the hosted MCP server", () => {
    expect(fixedBridgeConnectorTools(MCP_URL, REF)).toBe(FINANCE_OPERATIONS_ODATA_TOOLS);
    expect(fixedBridgeConnectorTools(MCP_URL, undefined)).toBeNull();
  });

  test("matches only Finance and Operations endpoints connected through their own host", () => {
    expect(isFinanceOperationsMcpConfig(MCP_URL, REF)).toBe(true);
    expect(
      isFinanceOperationsMcpConfig(MCP_URL, {
        ...REF,
        providerDomain: "other.operations.dynamics.com",
      }),
    ).toBe(false);
    expect(isFinanceOperationsMcpConfig(MCP_URL, undefined)).toBe(false);
    expect(isFinanceOperationsMcpConfig("https://contoso.crm.dynamics.com/api/mcp", REF)).toBe(
      false,
    );
    expect(
      FINANCE_OPERATIONS_ODATA_MCP_BRIDGE_ADAPTER.matches({ url: MCP_URL, connectionRef: REF }),
    ).toBe(true);
    expect(DATAVERSE_WEB_API_MCP_BRIDGE_ADAPTER.matches({ url: MCP_URL, connectionRef: REF })).toBe(
      false,
    );
  });

  test("lists a generic tool set naming the environment; changes recommend Ask first", async () => {
    const { instance, calls } = server(() => new Response(null, { status: 500 }));
    const tools = await instance.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "fno_list_entities",
      "fno_describe_entity",
      "fno_query",
      "fno_create_record",
      "fno_update_record",
      "fno_delete_record",
    ]);
    expect(
      tools.filter((tool) => mcpToolRecommendsApproval(tool)).map((tool) => tool.name),
    ).toEqual(["fno_create_record", "fno_update_record", "fno_delete_record"]);
    for (const tool of tools) expect(tool.description).toContain(`Environment: ${HOST}.`);
    // Listing tools only checks the connection; it calls nothing.
    expect(calls).toHaveLength(0);
    expect(instance.bridge.destinations.map((entry) => entry.pathPrefix)).toEqual([
      "/data/",
      "/Metadata/",
    ]);
  });

  test("queries page under the data root and return a relative nextLink", async () => {
    const { instance, calls, destinations } = server(() =>
      Response.json({
        "@odata.context": `${DATA}$metadata#CustomersV3`,
        value: [{ "@odata.etag": 'W/"1"', CustomerAccount: "US-001", dataAreaId: "usmf" }],
        "@odata.nextLink": `${DATA}CustomersV3?cross-company=true&$skip=1&$top=1`,
      }),
    );
    const result = await instance.callToolResult("fno_query", {
      path: "CustomersV3?cross-company=true&$filter=Name eq 'A & B'",
      pageSize: 1,
    });
    expect(result.structuredContent).toEqual({
      rows: [{ CustomerAccount: "US-001", dataAreaId: "usmf" }],
      nextLink: "CustomersV3?cross-company=true&$skip=1&$top=1",
    });
    expect(calls[0]!.url).toBe(
      `${DATA}CustomersV3?cross-company=true&$filter=Name%20eq%20'A%20&%20B'`,
    );
    expect(header(calls[0]!, "prefer")).toBe("odata.maxpagesize=1");
    expect(destinations).toEqual([calls[0]!.url]);
    await instance.callToolResult("fno_query", { path: `${DATA}CustomersV3?$skip=1` });
    expect(calls[1]!.url).toBe(`${DATA}CustomersV3?$skip=1`);
  });

  test("counts come back as a number", async () => {
    const { instance } = server(
      () => new Response("\ufeff417", { headers: { "content-type": "text/plain" } }),
    );
    const result = await instance.callToolResult("fno_query", { path: "CustomersV3/$count" });
    expect(result.structuredContent).toEqual({ record: { count: 417 } });
  });

  test("refuses paths outside the data entities, and $apply that would be ignored", async () => {
    const { instance, calls } = server(() => Response.json({ value: [] }));
    for (const path of [
      "$metadata",
      "$batch",
      "../api/services/x",
      "https://other.operations.dynamics.com/data/CustomersV3",
      `https://${HOST}/api/services/x`,
    ]) {
      const result = await instance.callToolResult("fno_query", { path });
      expect({ path, isError: result.isError }).toEqual({ path, isError: true });
    }
    const apply = await instance.callToolResult("fno_query", {
      path: "CustomersV3?$apply=groupby((dataAreaId),aggregate($count as n))",
    });
    expect(apply.isError).toBe(true);
    expect(text(apply)).toContain("$count");
    expect(calls).toHaveLength(0);
  });

  test("lists entities once and filters them by name", async () => {
    const { instance, calls } = server(() =>
      Response.json({
        value: [
          { Name: "CustomerV3", EntitySetName: "CustomersV3", IsReadOnly: false },
          { Name: "VendorV2", EntitySetName: "VendorsV2", IsReadOnly: false },
          { Name: "CustomerBalance", EntitySetName: "CustomerBalances", IsReadOnly: true },
        ],
      }),
    );
    const first = await instance.callToolResult("fno_list_entities", { search: "customer" });
    expect(first.structuredContent).toEqual({
      entities: [
        { entity: "CustomerBalance", entitySet: "CustomerBalances", readOnly: true },
        { entity: "CustomerV3", entitySet: "CustomersV3" },
      ],
    });
    await instance.callToolResult("fno_list_entities", { search: "vendor" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${METADATA}PublicEntities?$select=Name,EntitySetName,IsReadOnly`);
  });

  test("describes an entity with keys, requirements and enum members", async () => {
    const { instance, calls } = server(({ url }) => {
      if (url.startsWith(`${METADATA}PublicEntities?`))
        return Response.json({ value: [{ Name: "CustomerGroup" }] });
      if (url === `${METADATA}PublicEntities('CustomerGroup')`)
        return Response.json({
          Name: "CustomerGroup",
          EntitySetName: "CustomerGroups",
          IsReadOnly: false,
          Properties: [
            { Name: "dataAreaId", TypeName: "Edm.String", IsKey: true, IsMandatory: false },
            {
              Name: "CustomerGroupId",
              TypeName: "Edm.String",
              IsKey: true,
              IsMandatory: true,
              AllowEdit: false,
              AllowEditOnCreate: true,
            },
            {
              Name: "IsSalesTaxIncludedInPrice",
              TypeName: "Microsoft.Dynamics.DataEntities.NoYes",
              IsKey: false,
              IsMandatory: false,
            },
          ],
          NavigationProperties: [
            { Name: "Prospects", RelatedEntity: "Prospect", Cardinality: "Multiple" },
          ],
        });
      if (url === `${METADATA}PublicEnumerations('NoYes')`)
        return Response.json({ Name: "NoYes", Members: [{ Name: "No" }, { Name: "Yes" }] });
      return new Response(null, { status: 404 });
    });
    const result = await instance.callToolResult("fno_describe_entity", {
      entitySet: "CustomerGroups",
    });
    expect(result.structuredContent).toEqual({
      entity: "CustomerGroup",
      entitySet: "CustomerGroups",
      keys: ["dataAreaId", "CustomerGroupId"],
      fields: [
        { field: "dataAreaId", type: "String", key: true },
        {
          field: "CustomerGroupId",
          type: "String",
          key: true,
          required: true,
          setOnCreateOnly: true,
        },
        { field: "IsSalesTaxIncludedInPrice", type: "enum NoYes", values: ["No", "Yes"] },
      ],
      navigation: [{ name: "Prospects", entity: "Prospect", many: true }],
    });
    expect(decodeURIComponent(calls[0]!.url)).toBe(
      `${METADATA}PublicEntities?$filter=EntitySetName eq 'CustomerGroups'&$select=Name`,
    );
  });

  test("an unknown entity set says how to find one", async () => {
    const { instance } = server(() => Response.json({ value: [] }));
    const result = await instance.callToolResult("fno_describe_entity", { entitySet: "Nope" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("fno_list_entities");
  });

  test("creates across companies, updates by key without upserting and reads the result back", async () => {
    const { instance, calls } = server(({ init }) => {
      if (init.method === "POST")
        return Response.json(
          { "@odata.etag": 'W/"1"', ...JSON.parse(String(init.body)) },
          { status: 201 },
        );
      if (init.method === "PATCH") return new Response(null, { status: 204 });
      return Response.json({ dataAreaId: "ussi", CustomerGroupId: "O'Neil", Description: "B" });
    });
    const created = await instance.callToolResult("fno_create_record", {
      entitySet: "CustomerGroups",
      record: { dataAreaId: "ussi", CustomerGroupId: "O'Neil", Description: "A" },
    });
    expect(created.structuredContent.record).toEqual({
      dataAreaId: "ussi",
      CustomerGroupId: "O'Neil",
      Description: "A",
    });
    expect(calls[0]!.url).toBe(`${DATA}CustomerGroups?cross-company=true`);
    const updated = await instance.callToolResult("fno_update_record", {
      entitySet: "CustomerGroups",
      key: { dataAreaId: "ussi", CustomerGroupId: "O'Neil" },
      record: { Description: "B" },
    });
    const key = `${DATA}CustomerGroups(dataAreaId='ussi',CustomerGroupId='O''Neil')?cross-company=true`;
    expect(calls[1]!.url).toBe(key);
    expect(calls[1]!.init.method).toBe("PATCH");
    expect(header(calls[1]!, "if-match")).toBe("*");
    expect(calls[2]!.url).toBe(key);
    expect(calls[2]!.init.method).toBe("GET");
    // Only queries page; reading one record back sends no paging preference.
    expect(header(calls[2]!, "prefer")).toBeUndefined();
    expect(updated.structuredContent).toEqual({
      updated: true,
      record: { dataAreaId: "ussi", CustomerGroupId: "O'Neil", Description: "B" },
    });
  });

  test("rejects keys that are not plain field values", async () => {
    const { instance, calls } = server(() => new Response(null, { status: 204 }));
    for (const key of [{}, { "bad field": "x" }, { Id: { nested: true } }, "Id='x'"]) {
      const result = await instance.callToolResult("fno_delete_record", {
        entitySet: "CustomerGroups",
        key,
      });
      expect(result.isError).toBe(true);
    }
    for (const id of ["A/B", "A\\B"]) {
      const result = await instance.callToolResult("fno_update_record", {
        entitySet: "CustomerGroups",
        key: { dataAreaId: "usmf", CustomerGroupId: id },
        record: { Description: "x" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("fno_query and $filter");
    }
    expect(calls).toHaveLength(0);
  });

  test("a write whose outcome is unknown is not reported as a plain failure", async () => {
    const { instance } = server(() => {
      throw new Error("socket closed");
    });
    await expect(
      instance.callToolResult("fno_delete_record", {
        entitySet: "CustomerGroups",
        key: { dataAreaId: "usmf", CustomerGroupId: "10" },
      }),
    ).rejects.toThrow(/may or may not have been applied/u);
  });

  test("Microsoft's inner error message reaches the agent without its stack trace", async () => {
    const { instance } = server(() =>
      Response.json(
        {
          error: {
            code: "",
            message: "An error has occurred.",
            innererror: {
              message:
                "Write failed for table row of type 'CustCustomerGroupEntity'. The record already exists.",
              type: "Microsoft.Dynamics.Platform.Integration.Services.OData.AxODataWriteException",
              stacktrace: "   at Microsoft.Dynamics.Secret.Frame()",
            },
          },
        },
        { status: 400 },
      ),
    );
    const result = await instance.callToolResult("fno_create_record", {
      entitySet: "CustomerGroups",
      record: { CustomerGroupId: "10" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("The record already exists");
    expect(text(result)).not.toContain("Secret.Frame");
  });

  test("a rejected token is refreshed once, then asks to reconnect", async () => {
    const { instance, calls, authNeeded } = server(() => new Response(null, { status: 401 }));
    const result = await instance.callToolResult("fno_query", { path: "CustomersV3" });
    expect(calls).toHaveLength(2);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Reconnect");
    expect(authNeeded).toHaveLength(1);
  });

  test("a missing connection surfaces the connect card", async () => {
    const { instance, authNeeded } = server(
      () => Response.json({}),
      async () => ({ status: "auth_needed", reason: "missing_connection", providerDomain: HOST }),
    );
    await expect(instance.listTools()).rejects.toThrow(/Reconnect/u);
    expect(authNeeded).toHaveLength(1);
  });
});
