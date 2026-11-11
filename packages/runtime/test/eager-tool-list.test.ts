import { describe, expect, test } from "bun:test";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import type { ToolRef } from "@opengeni/contracts";
import { buildOpenGeniAgent, prepareAgentTools, runAgentStream } from "../src/index";
import { lazyToolRuntimeForAgent } from "../src/lazy-tool-transport";

const attemptScope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

const PRODUCT_URL = "http://127.0.0.1:9877/product";
const OTHER_URL = "http://127.0.0.1:9878/other";
const TRANSPORTS = ["codex_native", "openai_native", "generic_dispatch"] as const;
// Listing order interleaves everyday and long-tail tools so order is observable.
const PRODUCT_CATALOG = [
  "export_report",
  "search_records",
  "archive_record",
  "get_record",
  "merge_records",
] as const;

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Real prepareAgentTools over a fake product server selected with `productRef`
 * plus a slow unrelated server whose connection stays pending until released.
 */
async function fixture(productRef: ToolRef) {
  const listed: string[] = [];
  let releaseOther!: () => void;
  const otherGate = new Promise<void>((resolve) => {
    releaseOther = resolve;
  });
  const settings = testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    lazyToolSearchEnabled: true,
    codexToolSearchEnabled: true,
    integrationsAllowPrivateNetworkTargets: true,
    mcpServers: [
      { id: "product", url: PRODUCT_URL, cacheToolsList: false },
      { id: "other", url: OTHER_URL, cacheToolsList: false },
    ],
  });
  const refs: ToolRef[] = [productRef, { kind: "mcp", id: "other" }];
  const preparing = prepareAgentTools(settings, refs, {
    ...attemptScope,
    firstPartyTools: [],
    deferNonEagerUntilToolDemand: true,
    mcpFetchImpl: async (url, init) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const other = String(url).startsWith(OTHER_URL);
      const request = JSON.parse(String(init.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      if (other) await otherGate;
      let result: unknown;
      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: other ? "other" : "product", version: "1" },
          };
          break;
        case "tools/list":
          listed.push(other ? "other" : "product");
          result = {
            tools: (other ? ["search_records", "lookup"] : PRODUCT_CATALOG).map((name) => ({
              name,
              description: `${name} fixture tool`,
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            })),
          };
          break;
        default:
          throw new Error(`Unexpected MCP method: ${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    },
  });
  const prepared = await Promise.race([
    preparing,
    Bun.sleep(2_000).then(() => {
      throw new Error("first-request preparation blocked on an unrelated deferred server");
    }),
  ]);
  return { settings, prepared, listed, releaseOther };
}

async function firstRequest(f: Fixture, transport: (typeof TRANSPORTS)[number]) {
  const model = new ScriptedModel("ok");
  const agent = buildOpenGeniAgent(f.settings, [], {
    model,
    lazyToolTransport: transport,
    mcpServers: f.prepared.mcpServers,
    ...(f.prepared.ready ? { toolPreparationReady: f.prepared.ready.then(() => undefined) } : {}),
  });
  const stream = await runAgentStream(agent, "hello", f.settings);
  for await (const _event of stream) {
    /* drain the real SDK stream */
  }
  await stream.completed;
  expect(model.calls).toBe(1);
  return {
    agent,
    names: model.requests[0]!.tools.flatMap((entry) =>
      entry.type === "function" ? [entry.name] : [],
    ),
  };
}

const productNames = (names: string[]) => names.filter((name) => name.startsWith("product__"));

describe("ToolRef.eager tool list", () => {
  for (const transport of TRANSPORTS) {
    test(`exactly the listed tools are in the first request; the rest stay searchable (${transport})`, async () => {
      const f = await fixture({
        kind: "mcp",
        id: "product",
        eager: ["get_record", "search_records", "not_listed_by_server"],
      });
      try {
        // The product server joined the first-request barrier; the unrelated
        // server is still pending.
        expect(f.listed).toEqual(["product"]);

        const first = await firstRequest(f, transport);
        // The server's listing order, not the eager list's order; an unknown
        // name grants nothing.
        expect(productNames(first.names)).toEqual([
          "product__search_records",
          "product__get_record",
        ]);
        expect(first.names).not.toContain("other__search_records");

        f.releaseOther();
        await f.prepared.ready;
        // Background preparation does not change the first-request tool block.
        const second = await firstRequest(f, transport);
        expect(second.names).toEqual(first.names);

        const runtime = lazyToolRuntimeForAgent(second.agent)!;
        await runtime.ensurePrepared();
        const searchable = runtime.inspectSearchableTools().map((tool) => tool.name);
        expect(searchable).toContain("product__export_report");
        expect(searchable).toContain("product__archive_record");
        expect(searchable).toContain("product__merge_records");
        // A same-named tool on another server stays behind search.
        expect(searchable).toContain("other__search_records");
        expect(searchable).not.toContain("product__search_records");
        expect(searchable).not.toContain("product__get_record");
      } finally {
        f.releaseOther();
        await f.prepared.close();
      }
    });
  }

  test("an eager list never widens the server's allowed tools", async () => {
    const f = await fixture({
      kind: "mcp",
      id: "product",
      allowedTools: ["search_records", "export_report"],
      eager: ["search_records", "get_record"],
    });
    try {
      const { names, agent } = await firstRequest(f, "openai_native");
      expect(productNames(names)).toEqual(["product__search_records"]);
      const runtime = lazyToolRuntimeForAgent(agent)!;
      f.releaseOther();
      await runtime.ensurePrepared();
      const searchable = runtime.inspectSearchableTools().map((tool) => tool.name);
      expect(searchable).toContain("product__export_report");
      expect(searchable).not.toContain("product__get_record");
    } finally {
      f.releaseOther();
      await f.prepared.close();
    }
  });

  test("eager: true still puts every tool in the first request", async () => {
    const f = await fixture({ kind: "mcp", id: "product", eager: true });
    try {
      const { names } = await firstRequest(f, "codex_native");
      expect(productNames(names)).toEqual(PRODUCT_CATALOG.map((name) => `product__${name}`));
    } finally {
      f.releaseOther();
      await f.prepared.close();
    }
  });

  test("without an eager marker the product server prepares in the background", async () => {
    const f = await fixture({ kind: "mcp", id: "product" });
    try {
      expect(f.listed).toEqual([]);
      const { names } = await firstRequest(f, "codex_native");
      expect(productNames(names)).toEqual([]);
    } finally {
      f.releaseOther();
      await f.prepared.close();
    }
  });

  test("an empty eager list means none", async () => {
    const f = await fixture({ kind: "mcp", id: "product", eager: [] });
    try {
      expect(f.listed).toEqual([]);
      const { names } = await firstRequest(f, "openai_native");
      expect(productNames(names)).toEqual([]);
    } finally {
      f.releaseOther();
      await f.prepared.close();
    }
  });
});
