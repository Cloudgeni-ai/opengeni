import { describe, expect, test } from "bun:test";
import { ScriptedModel, testSettings } from "@opengeni/testing";
import type { FirstPartyMcpToolName, ToolRef } from "@opengeni/contracts";
import { buildOpenGeniAgent, prepareAgentTools, runAgentStream } from "../src/index";
import { lazyToolRuntimeForAgent } from "../src/lazy-tool-transport";
import { HARNESS_CONTROL_FIRST_PARTY_TOOLS } from "../src/codex-tool-search";

const attemptScope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

const FIRST_PARTY_URL = "http://127.0.0.1:8000/v1/workspaces/{workspaceId}/mcp";
const EXTERNAL_URL = "http://127.0.0.1:9876/external";
const TRANSPORTS = ["codex_native", "openai_native", "generic_dispatch"] as const;

// Listing order of the fake first-party server, interleaving harness and
// ordinary tools so order stability is observable.
const FIRST_PARTY_CATALOG = [
  "session_create",
  "goal_set",
  "goal_update",
  "knowledge_search",
  "goal_complete",
  "goal_pause",
  "goal_resume",
  "wait_for_input",
  "command_read",
  "command_wait",
] as const satisfies readonly FirstPartyMcpToolName[];

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Real prepareAgentTools over a fake first-party server (which, like the API,
 * lists only the selected tools) plus a slow unrelated external server whose
 * connection stays pending until released.
 */
async function fixture(selected: readonly FirstPartyMcpToolName[]) {
  const listed: string[] = [];
  let releaseExternal!: () => void;
  const externalGate = new Promise<void>((resolve) => {
    releaseExternal = resolve;
  });
  const settings = testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    lazyToolSearchEnabled: true,
    codexToolSearchEnabled: true,
    integrationsAllowPrivateNetworkTargets: true,
    mcpServers: [
      { id: "opengeni", url: FIRST_PARTY_URL, cacheToolsList: false },
      { id: "external", url: EXTERNAL_URL, cacheToolsList: false },
    ],
  });
  const refs: ToolRef[] = [
    { kind: "mcp", id: "opengeni" },
    { kind: "mcp", id: "external" },
  ];
  const preparing = prepareAgentTools(settings, refs, {
    ...attemptScope,
    firstPartyTools: [...selected],
    deferNonEagerUntilToolDemand: true,
    mcpFetchImpl: async (url, init) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const external = String(url).startsWith(EXTERNAL_URL);
      const request = JSON.parse(String(init.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      if (external) await externalGate;
      let result: unknown;
      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: external ? "external" : "opengeni", version: "1" },
          };
          break;
        case "tools/list":
          listed.push(external ? "external" : "opengeni");
          result = {
            tools: (external
              ? ["goal_set", "lookup"]
              : FIRST_PARTY_CATALOG.filter((name) => selected.includes(name))
            ).map((name) => ({
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
  // The external server never answers before release, so preparation can only
  // resolve here if it does not block the first request on that server.
  const prepared = await Promise.race([
    preparing,
    Bun.sleep(2_000).then(() => {
      throw new Error("first-request preparation blocked on an unrelated deferred server");
    }),
  ]);
  return { settings, prepared, listed, releaseExternal };
}

async function firstRequestToolNames(f: Fixture, transport: (typeof TRANSPORTS)[number]) {
  const model = new ScriptedModel("ok");
  const agent = buildOpenGeniAgent(f.settings, [], {
    model,
    lazyToolTransport: transport,
    mcpServers: f.prepared.mcpServers,
    inputWaitYield: f.prepared.inputWaitYield,
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

const HARNESS_MODEL_NAMES = FIRST_PARTY_CATALOG.filter((name) =>
  (HARNESS_CONTROL_FIRST_PARTY_TOOLS as readonly string[]).includes(name),
).map((name) => `opengeni__${name}`);

describe("always-visible harness control tools", () => {
  test("the harness set is exactly goal lifecycle, command polling, and wait_for_input", () => {
    expect([...HARNESS_CONTROL_FIRST_PARTY_TOOLS].sort()).toEqual(
      [
        "command_read",
        "command_wait",
        "goal_complete",
        "goal_pause",
        "goal_resume",
        "goal_set",
        "goal_update",
        "wait_for_input",
      ].sort(),
    );
  });

  for (const transport of TRANSPORTS) {
    test(`authorized harness tools are in the first request; other tools stay deferred (${transport})`, async () => {
      const f = await fixture(FIRST_PARTY_CATALOG);
      try {
        // The first-party server joined the barrier: listed before the first
        // request. The unrelated external server is still pending.
        expect(f.listed).toEqual(["opengeni"]);
        expect(f.prepared.ready).toBeDefined();

        const first = await firstRequestToolNames(f, transport);
        const firstPartyVisible = first.names.filter((name) => name.startsWith("opengeni__"));
        // Exact set, in the server's listing order.
        expect(firstPartyVisible).toEqual(HARNESS_MODEL_NAMES);
        expect(first.names).not.toContain("opengeni__session_create");
        expect(first.names).not.toContain("opengeni__knowledge_search");
        expect(first.names).not.toContain("external__goal_set");
        expect(first.names).not.toContain("external__lookup");

        f.releaseExternal();
        await f.prepared.ready;
        // After background preparation settles, the tool block is unchanged.
        const second = await firstRequestToolNames(f, transport);
        expect(second.names).toEqual(first.names);

        const runtime = lazyToolRuntimeForAgent(second.agent)!;
        await runtime.ensurePrepared();
        const searchable = runtime.inspectSearchableTools().map((tool) => tool.name);
        // Same-named tools on another server, and every non-harness first-party
        // tool, stay behind search.
        expect(searchable).toContain("opengeni__session_create");
        expect(searchable).toContain("opengeni__knowledge_search");
        expect(searchable).toContain("external__goal_set");
        for (const name of HARNESS_MODEL_NAMES) expect(searchable).not.toContain(name);
      } finally {
        f.releaseExternal();
        await f.prepared.close();
      }
    });

    test(`a disabled family stays absent (${transport})`, async () => {
      const selected = FIRST_PARTY_CATALOG.filter((name) => !name.startsWith("goal_"));
      const f = await fixture(selected);
      try {
        const { names } = await firstRequestToolNames(f, transport);
        expect(names.filter((name) => name.startsWith("opengeni__"))).toEqual([
          "opengeni__wait_for_input",
          "opengeni__command_read",
          "opengeni__command_wait",
        ]);
        for (const name of names) expect(name).not.toContain("goal_");
      } finally {
        f.releaseExternal();
        await f.prepared.close();
      }
    });
  }

  test("without any harness tool selected, the first-party server keeps preparing in the background", async () => {
    const f = await fixture(["session_create", "knowledge_search"]);
    try {
      expect(f.listed).toEqual([]);
      expect(f.prepared.ready).toBeDefined();
      const { names } = await firstRequestToolNames(f, "openai_native");
      expect(names.filter((name) => name.startsWith("opengeni__"))).toEqual([]);
    } finally {
      f.releaseExternal();
      await f.prepared.close();
    }
  });
});
