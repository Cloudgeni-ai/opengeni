import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { ScriptedModel, functionCall } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import type { McpAccountRouteLabel, ToolRef } from "@opengeni/contracts";
import { buildOpenGeniAgent, prepareAgentTools, runAgentStream } from "../src/index";
import { lazyToolRuntimeForAgent } from "../src/lazy-tool-transport";
import {
  mcpServerNamespace,
  mcpWireToolNames,
  prefixedMcpToolName,
} from "../src/mcp-model-tool-name";

// A connected account's registry ID (`account-<sha256>`) is too long to prefix
// a tool name, so tools used to be named `mcp_<digest of server and tool>__tool`:
// a different prefix on every tool, which a model cannot guess for a sibling it
// knows it needs. These tests drive the real prepared MCP server and the SDK
// runner. A tool's wire name is `<connector>_<account tag>__<tool>`, decided by
// its identity alone: siblings share one readable prefix, and a name never
// comes to mean another account's or connector's tool. tool_search loads every
// tool asked for by name whatever its limit, a miss suggests the closest
// tools, and a name from older history says which name to call instead.

const ACCOUNT = `account-${"c".repeat(64)}`;
const OTHER_ACCOUNT = `account-${"d".repeat(64)}`;
const URL_BASE = "http://127.0.0.1:9877/";
const TRANSPORTS = ["generic_dispatch", "openai_native", "codex_native"] as const;
const SIBLINGS = ["orders_get_line_item", "orders_swap_item", "orders_get_hierarchy"] as const;
const LONG = `orders_get_line_item_${"price_history_".repeat(4)}by_month`;
const TOOLS = [...SIBLINGS, "projects.search", LONG];
const PREFIX = "orders_cccccc__";

function label(connector: string): McpAccountRouteLabel {
  return { model: `${connector} account`, connector, providerDomain: "orders.example.com" };
}

type ToolCallRecord = { server: string; name: string; args: unknown };

async function fixture(
  ids: readonly string[] = [ACCOUNT],
  connectors: Readonly<Record<string, string>> = { [ACCOUNT]: "Orders", [OTHER_ACCOUNT]: "Orders" },
) {
  const calls: ToolCallRecord[] = [];
  const settings = testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    lazyToolSearchEnabled: true,
    codexToolSearchEnabled: true,
    integrationsAllowPrivateNetworkTargets: true,
    mcpServers: ids.map((id) => ({ id, url: `${URL_BASE}${id}`, cacheToolsList: false })),
  });
  const refs: ToolRef[] = ids.map((id) => ({ kind: "mcp", id }));
  const prepared = await prepareAgentTools(settings, refs, {
    mcpAccountLabels: new Map(
      ids.filter((id) => connectors[id]).map((id) => [id, label(connectors[id]!)]),
    ),
    mcpFetchImpl: async (url, init) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const server = String(url).slice(URL_BASE.length);
      const request = JSON.parse(String(init.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "orders", version: "1" },
          };
          break;
        case "tools/list":
          result = {
            tools: TOOLS.map((name) => ({
              name,
              description: `${name.replace(/[._]/g, " ")} fixture tool`,
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                additionalProperties: false,
              },
            })),
          };
          break;
        case "tools/call":
          calls.push({ server, name: request.params.name, args: request.params.arguments });
          result = { content: [{ type: "text", text: `${server}:${request.params.name} ran` }] };
          break;
        default:
          throw new Error(`Unexpected MCP method: ${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    },
  });
  await prepared.ready;
  const listed = async (index = 0) =>
    (await prepared.mcpServers[index]!.listTools()).map((tool) => tool.name);
  return { settings, prepared, calls, listed };
}

async function preparedRuntime(
  f: Awaited<ReturnType<typeof fixture>>,
  transport: (typeof TRANSPORTS)[number],
  model?: ScriptedModel,
) {
  const agent = buildOpenGeniAgent(f.settings, [], {
    ...(model ? { model } : {}),
    lazyToolTransport: transport,
    mcpServers: f.prepared.mcpServers,
  });
  const runtime = lazyToolRuntimeForAgent(agent)!;
  await agent.getAllTools(new RunContext());
  await runtime.ensurePrepared();
  return { agent, runtime };
}

describe("MCP wire names depend only on the tool's identity", () => {
  test("a connector's namespace: its name and a tag of the account, or a configured server's id", () => {
    expect(mcpServerNamespace(ACCOUNT, "Orders")).toEqual({
      namespace: "orders_cccccc",
      base: "orders",
    });
    expect(mcpServerNamespace(ACCOUNT)).toEqual({ namespace: "account_cccccc", base: "account" });
    expect(mcpServerNamespace("records").namespace).toBe("records");
    // An id that is not a readable slug gets a digest of the id, nothing else.
    const odd = mcpServerNamespace("customer-records").namespace;
    expect(odd).toMatch(/^customer_records_[0-9a-f]{6}$/);
    expect(mcpServerNamespace("customer-records").namespace).toBe(odd);
    // Opengeni's own servers keep their names.
    expect(mcpServerNamespace("opengeni").namespace).toBe("opengeni");
    expect(mcpWireToolNames("opengeni", "opengeni", ["goal_set"]).get("goal_set")).toBe(
      "opengeni__goal_set",
    );
  });

  test("a tool's wire name never depends on the rest of the catalog", () => {
    const alone = mcpWireToolNames(ACCOUNT, "orders_cccccc", ["send_message"]);
    const beside = mcpWireToolNames(ACCOUNT, "orders_cccccc", [
      "send_message",
      "read_messages",
      "goal_set",
    ]);
    expect(alone.get("send_message")).toBe("orders_cccccc__send_message");
    expect(beside.get("send_message")).toBe(alone.get("send_message"));
    // A built-in's name is never taken: every connector tool carries its namespace.
    expect(beside.get("goal_set")).toBe("orders_cccccc__goal_set");
    // Two published names with one wire spelling, within one server, both end in a digest.
    const spelled = mcpWireToolNames("records", "records", ["a.b", "a_b", "c"]);
    expect(spelled.get("a.b")).toMatch(/^records__a_b_[0-9a-f]{8}$/);
    expect(spelled.get("a_b")).toMatch(/^records__a_b_[0-9a-f]{8}$/);
    expect(spelled.get("a.b")).not.toBe(spelled.get("a_b"));
    expect(spelled.get("c")).toBe("records__c");
  });

  test("a connected account's tools share one readable prefix", async () => {
    const f = await fixture();
    try {
      const names = await f.listed();
      expect(names.slice(0, 4)).toEqual(
        [...SIBLINGS, "projects_search"].map((tool) => `${PREFIX}${tool}`),
      );
      // A name over the provider limit is shortened and ends in a digest.
      expect(names[4]!.length).toBe(64);
      expect(names[4]).toStartWith(`${PREFIX}${LONG.slice(0, 30)}`);
      expect(names[4]).toMatch(/_[0-9a-f]{8}$/);
      for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_]{1,64}$/);
    } finally {
      await f.prepared.close();
    }
  });

  test("the same account gets the same names whatever else the turn has", async () => {
    const alone = await fixture([ACCOUNT]);
    const beside = await fixture([OTHER_ACCOUNT, ACCOUNT], {
      [ACCOUNT]: "Orders",
      [OTHER_ACCOUNT]: "Shop",
    });
    try {
      expect(await beside.listed(1)).toEqual(await alone.listed(0));
    } finally {
      await alone.prepared.close();
      await beside.prepared.close();
    }
  });

  test("a replacement account of the same connector gets other names", async () => {
    const before = await fixture([ACCOUNT]);
    const after = await fixture([OTHER_ACCOUNT]);
    try {
      const old = await before.listed();
      const replacement = await after.listed();
      expect(replacement.slice(0, 3)).toEqual(SIBLINGS.map((tool) => `orders_dddddd__${tool}`));
      for (const name of replacement) expect(old).not.toContain(name);
    } finally {
      await before.prepared.close();
      await after.prepared.close();
    }
  });

  test("another connector publishing the same tool names never takes their names", async () => {
    const f = await fixture([ACCOUNT, OTHER_ACCOUNT], {
      [ACCOUNT]: "Orders",
      [OTHER_ACCOUNT]: "Shop",
    });
    try {
      const orders = await f.listed(0);
      const shop = await f.listed(1);
      expect(shop.slice(0, 3)).toEqual(SIBLINGS.map((tool) => `shop_dddddd__${tool}`));
      for (const name of shop) {
        expect(orders).not.toContain(name);
        expect(SIBLINGS as readonly string[]).not.toContain(name);
      }
    } finally {
      await f.prepared.close();
    }
  });

  for (const transport of TRANSPORTS) {
    test(`${transport}: reference names load every requested tool whatever the limit`, async () => {
      const f = await fixture();
      try {
        const { runtime } = await preparedRuntime(f, transport);
        const result = await runtime.prepareSearch({
          query: "",
          limit: 1,
          names: [
            // The server's id with the published name, its readable namespace
            // with `__`, and a plain name only one tool has.
            `${ACCOUNT}.orders_get_line_item`,
            "orders__orders_swap_item",
            "orders_get_hierarchy",
            "projects.search",
          ],
        });
        expect(result.tools?.map((tool) => tool.name)).toEqual(
          [...SIBLINGS, "projects_search"].map((tool) => `${PREFIX}${tool}`),
        );
        expect(JSON.parse(result.output).unavailable).toEqual([]);
      } finally {
        await f.prepared.close();
      }
    });

    test(`${transport}: a query naming more tools than its limit loads every named tool`, async () => {
      const f = await fixture();
      try {
        const { runtime } = await preparedRuntime(f, transport);
        for (const query of [SIBLINGS.join(" "), `load ${SIBLINGS.join(", ")}`]) {
          const result = await runtime.prepareSearch({ query, limit: 2 });
          expect(result.tools?.map((tool) => tool.name)).toEqual(
            SIBLINGS.map((tool) => `${PREFIX}${tool}`),
          );
        }
      } finally {
        await f.prepared.close();
      }
    });

    test(`${transport}: a name that matches no tool suggests the closest ones`, async () => {
      const f = await fixture();
      try {
        const { runtime } = await preparedRuntime(f, transport);
        const result = await runtime.prepareSearch({ query: "", names: ["orders_get_line"] });
        const output = JSON.parse(result.output);
        expect(output.unavailable).toEqual(["orders_get_line"]);
        expect(output.suggestions.map((tool: { name: string }) => tool.name)).toContain(
          `${PREFIX}orders_get_line_item`,
        );
      } finally {
        await f.prepared.close();
      }
    });

    test(`${transport}: a name that is not in this turn's catalog runs nothing`, async () => {
      // The turn before had account c; now only its replacement d is connected.
      // Neither c's name from history nor the bare tool name reaches d.
      const f = await fixture([OTHER_ACCOUNT]);
      try {
        const scripted = new ScriptedModel([
          {
            output: [
              functionCall(`${PREFIX}orders_swap_item`, { id: "line-1" }, "call-gone-1"),
              functionCall("orders_swap_item", { id: "line-2" }, "call-bare-1"),
            ],
          },
          { outputText: "done" },
        ]);
        const { agent } = await preparedRuntime(f, transport, scripted);
        const stream = await runAgentStream(agent, "swap the item", f.settings);
        for await (const _event of stream) {
          // drain
        }
        await stream.completed;
        expect(f.calls).toEqual([]);
        const followUp = JSON.stringify(scripted.requests[1]!.input);
        expect(followUp).toContain("call-gone-1");
        expect(followUp).toContain("call-bare-1");
        expect(followUp).not.toContain(`${OTHER_ACCOUNT}:`);
      } finally {
        await f.prepared.close();
      }
    });

    test(`${transport}: a call by a tool's former name runs nothing and names the current one`, async () => {
      const f = await fixture();
      try {
        const former = prefixedMcpToolName(ACCOUNT, "orders_swap_item");
        expect(former).toMatch(/^mcp_[0-9a-f]{24}__orders_swap_item$/);
        const scripted = new ScriptedModel([
          { output: [functionCall(former, { id: "line-1" }, "call-former-1")] },
          { outputText: "done" },
        ]);
        const { agent } = await preparedRuntime(f, transport, scripted);
        const stream = await runAgentStream(agent, "swap the item", f.settings);
        for await (const _event of stream) {
          // drain
        }
        await stream.completed;
        expect(f.calls).toEqual([]);
        const followUp = scripted.requests[1]!.input as Record<string, unknown>[];
        // History keeps the name the model wrote; nothing earlier is rewritten.
        expect(
          followUp.find((item) => item.type === "function_call" && item.callId === "call-former-1")
            ?.name,
        ).toBe(former);
        expect(JSON.stringify(followUp)).toContain(
          `Nothing ran: ${former} is this tool's former name. Call it as ${PREFIX}orders_swap_item.`,
        );
      } finally {
        await f.prepared.close();
      }
    });
  }

  test("generic tool_invoke with a former name runs nothing and names the current tool", async () => {
    const f = await fixture();
    try {
      const former = prefixedMcpToolName(ACCOUNT, "orders_get_hierarchy");
      const scripted = new ScriptedModel([
        {
          output: [
            functionCall(
              "tool_invoke",
              { name: former, arguments: { id: "root" } },
              "call-invoke-former-1",
            ),
          ],
        },
        { outputText: "done" },
      ]);
      const agent = buildOpenGeniAgent(f.settings, [], {
        model: scripted,
        lazyToolTransport: "generic_dispatch",
        mcpServers: f.prepared.mcpServers,
      });
      const stream = await runAgentStream(agent, "show the hierarchy", f.settings);
      for await (const _event of stream) {
        // drain
      }
      await stream.completed;
      expect(f.calls).toEqual([]);
      const output = JSON.stringify(scripted.requests[1]!.input);
      expect(output).toContain("tool_renamed");
      expect(output).toContain(`${PREFIX}orders_get_hierarchy`);
    } finally {
      await f.prepared.close();
    }
  });
});
