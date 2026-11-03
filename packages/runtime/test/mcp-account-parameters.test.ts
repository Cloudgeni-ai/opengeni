import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { PrefixedMcpServer } from "../src/index";
import {
  MCP_ACCOUNT_PARAMETER_NOTE,
  accountChoicesFromResult,
  accountParameterUnset,
  mcpAccountParametersFor,
  withAccountParameterDefaults,
  type McpAccountParameter,
} from "../src/mcp-account-parameters";

const SITE: McpAccountParameter = {
  name: "siteId",
  resolver: { toolName: "listSites", arguments: {} },
  valueField: "id",
  labelFields: ["name", "url"],
};

const siteSchema = (required = ["siteId", "query"]) => ({
  type: "object",
  properties: {
    siteId: { type: "string", description: "Site id. If unknown, list sites." },
    query: { type: "string" },
  },
  required,
});

const textResult = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];

type FakeServerOptions = {
  sites?: unknown;
  resolverFails?: boolean;
  listResolver?: boolean;
};

function fakeServer(options: FakeServerOptions = {}) {
  const calls: { name: string; args: Record<string, unknown> | null }[] = [];
  const inner = {
    cacheToolsList: false,
    name: "sites",
    connect: async () => {},
    close: async () => {},
    listTools: async () => [
      { name: "search", description: "Search", inputSchema: siteSchema() },
      {
        name: "fetch",
        description: "Fetch",
        inputSchema: siteSchema(["query"]),
      },
      ...(options.listResolver === false
        ? []
        : [{ name: "listSites", inputSchema: { type: "object", properties: {} } }]),
    ],
    callTool: async (name: string, args: Record<string, unknown> | null) => {
      calls.push({ name, args });
      if (name === "listSites") {
        if (options.resolverFails) throw new Error("upstream unavailable");
        return textResult(
          options.sites ?? [{ id: "site-1", name: "Acme", url: "https://acme.example" }],
        );
      }
      return textResult({ ok: true, args });
    },
  } as unknown as MCPServer;
  const server = new PrefixedMcpServer(
    inner,
    "sites",
    undefined,
    true,
    undefined,
    "sites",
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    [SITE],
  );
  const providerCalls = () => calls.filter((call) => call.name !== "listSites");
  const lookups = () => calls.filter((call) => call.name === "listSites").length;
  return { server, calls, providerCalls, lookups };
}

async function toolNamed(server: PrefixedMcpServer, name: string) {
  const tools = await server.listTools();
  const tool = tools.find((entry) => server.unprefixedToolName(entry.name) === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

const errorText = (result: unknown) =>
  ((result as { content?: { text?: string }[] }).content ?? []).map((block) => block.text).join("");

describe("account parameter schema", () => {
  test("a required account parameter becomes optional with the generic note", () => {
    const { inputSchema, filled } = withAccountParameterDefaults(siteSchema(), [SITE]);
    expect(filled).toEqual([SITE]);
    const schema = inputSchema as ReturnType<typeof siteSchema>;
    expect(schema.required).toEqual(["query"]);
    expect(schema.properties.siteId.description).toBe(
      `Site id. If unknown, list sites. ${MCP_ACCOUNT_PARAMETER_NOTE}`,
    );
    // The original listing is not mutated.
    expect(siteSchema().required).toEqual(["siteId", "query"]);
  });

  test("an optional or non-string parameter keeps its meaning", () => {
    expect(withAccountParameterDefaults(siteSchema(["query"]), [SITE]).filled).toEqual([]);
    const numeric = {
      type: "object",
      properties: { siteId: { type: "number" } },
      required: ["siteId"],
    };
    expect(withAccountParameterDefaults(numeric, [SITE])).toEqual({
      inputSchema: numeric,
      filled: [],
    });
  });

  test("Atlassian MCP URLs declare cloudId; other servers declare nothing", () => {
    for (const url of [
      "https://mcp.atlassian.com/v2/mcp?tools=all",
      "https://mcp.atlassian.com/v2/mcp",
      "https://mcp.atlassian.com/v1/mcp",
    ]) {
      expect(mcpAccountParametersFor(url).map((parameter) => parameter.name)).toEqual(["cloudId"]);
      expect(mcpAccountParametersFor(url)[0]?.resolver.toolName).toBe(
        "getAccessibleAtlassianResources",
      );
    }
    expect(mcpAccountParametersFor("https://mcp.linear.app/mcp")).toEqual([]);
    expect(mcpAccountParametersFor(undefined)).toEqual([]);
  });
});

describe("account choices", () => {
  test("reads a bare list, a wrapped list and structured content, without duplicates", () => {
    const sites = [
      { id: "a", name: "Acme", url: "https://acme.example" },
      { id: "a", name: "Acme (Confluence)" },
      { id: "b", url: "https://beta.example" },
      { name: "no id" },
    ];
    const expected = [
      { value: "a", label: "Acme" },
      { value: "b", label: "https://beta.example" },
    ];
    expect(accountChoicesFromResult(SITE, { content: textResult(sites) })).toEqual(expected);
    expect(accountChoicesFromResult(SITE, { content: textResult({ data: sites }) })).toEqual(
      expected,
    );
    expect(
      accountChoicesFromResult(SITE, { content: [], structuredContent: { resources: sites } }),
    ).toEqual(expected);
  });

  test("an error result or an unknown shape offers nothing", () => {
    expect(
      accountChoicesFromResult(SITE, { isError: true, content: textResult([{ id: "a" }]) }),
    ).toEqual([]);
    expect(
      accountChoicesFromResult(SITE, { content: [{ type: "text", text: "not json" }] }),
    ).toEqual([]);
    expect(accountChoicesFromResult(SITE, { content: textResult({ id: "a" }) })).toEqual([]);
  });

  test("only a missing, empty or phrase value counts as unset", () => {
    for (const value of [undefined, null, "", "  ", "list accessible resources"])
      expect(accountParameterUnset(value)).toBe(true);
    for (const value of ["site-1", "acme.atlassian.net", "https://acme.atlassian.net", 7])
      expect(accountParameterUnset(value)).toBe(false);
  });
});

describe("PrefixedMcpServer account parameters", () => {
  test("lists the parameter as optional only where the tool required it", async () => {
    const { server } = fakeServer();
    const search = await toolNamed(server, "search");
    expect((search.inputSchema as { required: string[] }).required).toEqual(["query"]);
    const fetch = await toolNamed(server, "fetch");
    expect((fetch.inputSchema as { required: string[] }).required).toEqual(["query"]);
    expect((fetch.inputSchema as ReturnType<typeof siteSchema>).properties.siteId.description).toBe(
      "Site id. If unknown, list sites.",
    );
  });

  test("leaves schemas alone when the server does not list the lookup tool", async () => {
    const { server, providerCalls, lookups } = fakeServer({ listResolver: false });
    const search = await toolNamed(server, "search");
    expect((search.inputSchema as { required: string[] }).required).toEqual(["siteId", "query"]);
    await server.callTool(search.name, { query: "q" });
    expect(lookups()).toBe(0);
    expect(providerCalls()[0]?.args).toEqual({ query: "q" });
  });

  test("fills a missing or phrase value with the account's only value, looked up once", async () => {
    const { server, providerCalls, lookups } = fakeServer();
    const search = await toolNamed(server, "search");
    await server.callTool(search.name, { query: "q" });
    await server.callTool(search.name, { query: "q", siteId: "list accessible resources" });
    expect(providerCalls().map((call) => call.args)).toEqual([
      { query: "q", siteId: "site-1" },
      { query: "q", siteId: "site-1" },
    ]);
    expect(lookups()).toBe(1);
  });

  test("never replaces a plausible supplied value or fills an optional parameter", async () => {
    const { server, providerCalls, lookups } = fakeServer();
    const search = await toolNamed(server, "search");
    const fetch = await toolNamed(server, "fetch");
    await server.callTool(search.name, { query: "q", siteId: "other.example" });
    await server.callTool(fetch.name, { query: "q" });
    expect(providerCalls().map((call) => call.args)).toEqual([
      { query: "q", siteId: "other.example" },
      { query: "q" },
    ]);
    expect(lookups()).toBe(0);
  });

  test("asks the model to choose between several values without calling the tool", async () => {
    const { server, providerCalls } = fakeServer({
      sites: [
        { id: "site-1", name: "Acme" },
        { id: "site-2", name: "Beta Corp" },
      ],
    });
    const search = await toolNamed(server, "search");
    const result = await server.callTool(search.name, { query: "q" });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = errorText(result);
    expect(text).toContain("siteId");
    expect(text).toContain('"Acme" (site-1)');
    expect(text).toContain('"Beta Corp" (site-2)');
    expect(providerCalls()).toEqual([]);
    // Naming one of them by its label picks it.
    await server.callTool(search.name, { query: "q", siteId: "beta corp" });
    expect(providerCalls()[0]?.args).toEqual({ query: "q", siteId: "site-2" });
  });

  test("a failed lookup sends the call on unchanged and is retried later", async () => {
    const { server, providerCalls, lookups } = fakeServer({ resolverFails: true });
    const search = await toolNamed(server, "search");
    await server.callTool(search.name, { query: "q", siteId: "list sites" });
    await server.callTool(search.name, { query: "q" });
    expect(providerCalls().map((call) => call.args)).toEqual([
      { query: "q", siteId: "list sites" },
      { query: "q" },
    ]);
    expect(lookups()).toBe(2);
  });

  test("a wrapping server applies the parameters only once, at the physical server", async () => {
    const { server: physical, providerCalls, lookups } = fakeServer();
    const outer = new PrefixedMcpServer(
      physical,
      "outer",
      undefined,
      true,
      undefined,
      "outer",
      false,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [SITE],
    );
    const search = await toolNamed(outer, "sites__search");
    const property = (search.inputSchema as ReturnType<typeof siteSchema>).properties.siteId;
    expect(property.description.split(MCP_ACCOUNT_PARAMETER_NOTE).length).toBe(2);
    await outer.callTool(search.name, { query: "q" });
    expect(providerCalls()[0]?.args).toEqual({ query: "q", siteId: "site-1" });
    expect(lookups()).toBe(1);
  });
});
