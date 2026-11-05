import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";
import { PrefixedMcpServer, mcpToolErrorOutput, toolPreflightFailureOutput } from "../src/index";
import {
  MCP_ACCOUNT_PARAMETER_NOTE,
  McpAccountParameterChoiceError,
  accountChoicesFromResult,
  accountParameterChoiceText,
  accountParameterUnset,
  mcpAccountParametersFor,
  withAccountParameterDefaults,
  type McpAccountParameter,
} from "../src/mcp-account-parameters";
import { runRecoverableMcpOperation } from "../src/mcp-operation-dispatch";

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
  /** The lookup never answers (until aborted, if the transport honours it). */
  resolverHangs?: boolean;
  listResolver?: boolean;
};

const TWO_SITES = [
  { id: "site-1", name: "Acme" },
  { id: "site-2", name: "Beta Corp" },
];

afterEach(() => {
  // Restore Date.now after a test that moves time.
  (Date.now as unknown as { mockRestore?: () => void }).mockRestore?.();
});

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
        if (options.resolverHangs) return await new Promise(() => {});
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
      "https://mcp.atlassian.com/v1/mcp/authv2",
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

  test("the shallowest list wins over a nested one", () => {
    const payload = {
      user: { accounts: [{ id: "account-1", name: "Me" }] },
      resources: [{ id: "site-1", name: "Acme" }],
    };
    expect(accountChoicesFromResult(SITE, { content: textResult(payload) })).toEqual([
      { value: "site-1", label: "Acme" },
    ]);
  });

  test("a long choice list says how many it leaves out", () => {
    const choices = Array.from({ length: 30 }, (_, index) => ({ value: `site-${index}` }));
    const text = accountParameterChoiceText("siteId", choices);
    expect(text).toContain("site-24");
    expect(text).not.toContain("site-25,");
    expect(text).toContain("and 5 more.");
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
    for (const value of [
      "site-1",
      " site-1 ",
      "acme.atlassian.net",
      "https://acme.atlassian.net",
      7,
    ])
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
    const { server, providerCalls } = fakeServer({ sites: TWO_SITES });
    const search = await toolNamed(server, "search");
    const error = await server.callTool(search.name, { query: "q" }).catch((reason) => reason);
    expect(error).toBeInstanceOf(McpAccountParameterChoiceError);
    // Nothing was sent, so a connector action settles as not executed.
    expect((error as McpAccountParameterChoiceError).connectorActionOutcome).toBe("not_executed");
    const rendered = mcpToolErrorOutput(error);
    expect(rendered.isError).toBe(true);
    const text = errorText(rendered);
    expect(text).toBe(
      accountParameterChoiceText("siteId", (error as McpAccountParameterChoiceError).choices),
    );
    expect(text).toContain('"Acme" (site-1)');
    expect(text).toContain('"Beta Corp" (site-2)');
    expect(providerCalls()).toEqual([]);
    // Naming one of them by its label picks it.
    await server.callTool(search.name, { query: "q", siteId: "beta corp" });
    expect(providerCalls()[0]?.args).toEqual({ query: "q", siteId: "site-2" });
  });

  test("approval hooks learn about the choice before anyone is asked", async () => {
    const { server, providerCalls } = fakeServer({ sites: TWO_SITES });
    await server.listTools();
    const choice = await server.accountParameterChoice("search", { query: "q" });
    expect(choice).toBeInstanceOf(McpAccountParameterChoiceError);
    // The preflight containment shows the choice text itself.
    expect(toolPreflightFailureOutput(choice)).toEqual({
      isError: true,
      content: [{ type: "text", text: choice!.message }],
    });
    expect(await server.accountParameterChoice("search", { query: "q", siteId: "site-1" })).toBe(
      undefined,
    );
    expect(await server.accountParameterChoice("fetch", { query: "q" })).toBe(undefined);
    expect(providerCalls()).toEqual([]);
  });

  test("a value only padded with whitespace is sent as it is", async () => {
    const { server, providerCalls } = fakeServer({ sites: TWO_SITES });
    const search = await toolNamed(server, "search");
    await server.callTool(search.name, { query: "q", siteId: " site-2 " });
    expect(providerCalls()[0]?.args).toEqual({ query: "q", siteId: " site-2 " });
  });

  test("concurrent calls share one lookup", async () => {
    const { server, providerCalls, lookups } = fakeServer();
    const search = await toolNamed(server, "search");
    await Promise.all([1, 2, 3].map(() => server.callTool(search.name, { query: "q" })));
    expect(lookups()).toBe(1);
    expect(providerCalls().every((call) => call.args?.siteId === "site-1")).toBe(true);
  });

  test("the caller's abort ends a call waiting on the lookup, and nothing is sent", async () => {
    const { server, providerCalls } = fakeServer({ resolverHangs: true });
    await server.listTools();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const startedAt = performance.now();
    const result = await server
      .executeCatalogTool("search", { query: "q" }, null, { signal: controller.signal })
      .catch((reason: unknown) => reason);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(providerCalls()).toEqual([]);
  });

  test("a recoverable operation is never filled", async () => {
    const { server, providerCalls, lookups } = fakeServer();
    const search = await toolNamed(server, "search");
    await runRecoverableMcpOperation(
      {
        operationId: crypto.randomUUID(),
        serverId: "sites",
        originalTool: "search",
        observerTool: "search",
        destinationDigest: "0".repeat(64),
        argumentDigest: "0".repeat(64),
      },
      { capture: async () => "created", settleOriginal: async () => {} },
      async () => (await server.callTool(search.name, { query: "q" })) as never,
    ).catch(() => undefined);
    expect(providerCalls()[0]?.args).toEqual({ query: "q" });
    expect(lookups()).toBe(0);
  });

  test("a failed lookup sends calls on unchanged and is retried after a pause", async () => {
    const { server, providerCalls, lookups } = fakeServer({ resolverFails: true });
    const search = await toolNamed(server, "search");
    await server.callTool(search.name, { query: "q", siteId: "list sites" });
    await server.callTool(search.name, { query: "q" });
    expect(providerCalls().map((call) => call.args)).toEqual([
      { query: "q", siteId: "list sites" },
      { query: "q" },
    ]);
    expect(lookups()).toBe(1);
    const now = Date.now();
    spyOn(Date, "now").mockReturnValue(now + 61_000);
    await server.callTool(search.name, { query: "q" });
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

  test("the tool gateway validates the relaxed schema, fills, and settles a choice as not executed", async () => {
    for (const sites of [undefined, TWO_SITES]) {
      const { server, providerCalls } = fakeServer(sites ? { sites } : {});
      const search = await toolNamed(server, "search");
      const settlements: unknown[] = [];
      const { gateway } = createWorkspaceToolGateway({
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        generation: 1,
        definitions: [
          {
            identity: { serverId: "sites", toolName: "search" },
            modelName: search.name,
            inputSchema: search.inputSchema as Record<string, unknown>,
            source: "mcp",
            approval: "none",
            lifecycle: {
              prepare: async () => ({
                complete: async (settlement) => {
                  settlements.push(settlement);
                },
              }),
            },
            execute: async (args) => await server.executeCatalogTool("search", args),
          },
        ],
      });
      const outcome = await gateway
        .callModel({ modelName: search.name, arguments: { query: "q" }, subjectId: "agent:test" })
        .catch((reason: unknown) => reason);
      if (!sites) {
        expect((outcome as { isError?: boolean }).isError).not.toBe(true);
        expect(providerCalls()[0]?.args).toEqual({ query: "q", siteId: "site-1" });
        expect(settlements).toMatchObject([{ outcome: "completed" }]);
      } else {
        expect(outcome).toBeInstanceOf(McpAccountParameterChoiceError);
        expect(providerCalls()).toEqual([]);
        expect(settlements).toMatchObject([
          { outcome: "failed", error: { connectorActionOutcome: "not_executed" } },
        ]);
      }
    }
  });
});
