import { describe, expect, test } from "bun:test";
import { ScriptedModel, functionCall, testSettings } from "@opengeni/testing";
import type { FirstPartyMcpToolName, ToolRef } from "@opengeni/contracts";
import { buildOpenGeniAgent, prepareAgentTools, runAgentStream } from "../src/index";

// Claude has called first-party tools by the bare names the agent instructions
// use (`command_wait` instead of `opengeni__command_wait`). These tests drive
// the real prepared MCP servers and the SDK runner's dispatch: the bare name
// must reach the first-party tool when exactly one tool answers to it, and must
// stay unresolved when another server also lists that name.

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
const TRANSPORTS = ["generic_dispatch", "openai_native", "codex_native"] as const;

const FIRST_PARTY_CATALOG = [
  "session_create",
  "knowledge_search",
  "wait_for_input",
  "command_read",
  "command_wait",
] as const satisfies readonly FirstPartyMcpToolName[];

type ToolCallRecord = { server: string; name: string; args: unknown };

async function fixture(externalTools: readonly string[]) {
  const calls: ToolCallRecord[] = [];
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
  const prepared = await prepareAgentTools(settings, refs, {
    ...attemptScope,
    firstPartyTools: [...FIRST_PARTY_CATALOG],
    mcpFetchImpl: async (url, init) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const server = String(url).startsWith(EXTERNAL_URL) ? "external" : "opengeni";
      const request = JSON.parse(String(init.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: server, version: "1" },
          };
          break;
        case "tools/list":
          result = {
            tools: (server === "external" ? externalTools : FIRST_PARTY_CATALOG).map((name) => ({
              name,
              description: `${name} fixture tool`,
              inputSchema: {
                type: "object",
                properties: { commandId: { type: "string" }, limit: { type: "integer" } },
                additionalProperties: false,
              },
            })),
          };
          break;
        case "tools/call":
          calls.push({ server, name: request.params.name, args: request.params.arguments });
          result = {
            content: [{ type: "text", text: `${server}:${request.params.name} ran` }],
          };
          break;
        default:
          throw new Error(`Unexpected MCP method: ${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    },
  });
  await prepared.ready;
  return { settings, prepared, calls };
}

type RequestItem = Record<string, unknown>;

async function runCall(
  f: Awaited<ReturnType<typeof fixture>>,
  transport: (typeof TRANSPORTS)[number] | undefined,
  name: string,
  args: Record<string, unknown> = { commandId: "cmd-1" },
) {
  const model = new ScriptedModel([
    { output: [functionCall(name, args, "call-bare-1")] },
    { outputText: "done" },
  ]);
  const agent = buildOpenGeniAgent(f.settings, [], {
    model,
    ...(transport ? { lazyToolTransport: transport } : {}),
    mcpServers: f.prepared.mcpServers,
    inputWaitYield: f.prepared.inputWaitYield,
  });
  const stream = await runAgentStream(agent, "wait for the command", f.settings);
  const toolCallNames: string[] = [];
  for await (const event of stream) {
    const item = (event as { type?: string; item?: { type?: string; rawItem?: RequestItem } }).item;
    if (event.type === "run_item_stream_event" && item?.type === "tool_call_item") {
      toolCallNames.push(String(item.rawItem?.name));
    }
  }
  await stream.completed;
  expect(model.calls).toBe(2);
  const followUp = model.requests[1]!.input as RequestItem[];
  const call = followUp.find(
    (item) => item.type === "function_call" && item.callId === "call-bare-1",
  );
  const result = followUp.find(
    (item) => item.type === "function_call_result" && item.callId === "call-bare-1",
  );
  return {
    toolCallNames,
    historyCallName: call?.name,
    historyCallArguments: JSON.parse(String(call?.arguments ?? "null")) as unknown,
    resultText: JSON.stringify(result?.output ?? null),
  };
}

describe("bare first-party tool names at dispatch", () => {
  for (const transport of TRANSPORTS) {
    test(`a bare harness tool name runs the first-party tool (${transport})`, async () => {
      const f = await fixture(["lookup"]);
      try {
        const run = await runCall(f, transport, "command_wait");
        expect(run.resultText).not.toContain("not found");
        expect(run.resultText).toContain("opengeni:command_wait ran");
        expect(f.calls).toEqual([
          { server: "opengeni", name: "command_wait", args: { commandId: "cmd-1" } },
        ]);
        // The call is recorded under its canonical model-facing name, so
        // history, events, and display see the tool the model actually ran.
        expect(run.toolCallNames).toEqual(["opengeni__command_wait"]);
        expect(run.historyCallName).toBe("opengeni__command_wait");
      } finally {
        await f.prepared.close();
      }
    });

    test(`a bare deferred first-party tool name also binds (${transport})`, async () => {
      const f = await fixture(["lookup"]);
      try {
        const run = await runCall(f, transport, "knowledge_search");
        expect(run.resultText).toContain("opengeni:knowledge_search ran");
        expect(f.calls.map((call) => `${call.server}:${call.name}`)).toEqual([
          "opengeni:knowledge_search",
        ]);
        expect(run.historyCallName).toBe("opengeni__knowledge_search");
      } finally {
        await f.prepared.close();
      }
    });

    test(`a bare deferred tool call gets its argument types restored (${transport})`, async () => {
      const f = await fixture(["lookup"]);
      try {
        const run = await runCall(f, transport, "knowledge_search", {
          commandId: "cmd-1",
          limit: "5",
        });
        expect(run.resultText).toContain("opengeni:knowledge_search ran");
        expect(f.calls).toEqual([
          { server: "opengeni", name: "knowledge_search", args: { commandId: "cmd-1", limit: 5 } },
        ]);
        // Stored history carries the declared types, as for an exact-name call.
        expect(run.historyCallArguments).toEqual({ commandId: "cmd-1", limit: 5 });
      } finally {
        await f.prepared.close();
      }
    });

    test(`a bare name another server also lists stays unresolved (${transport})`, async () => {
      const f = await fixture(["command_wait", "lookup"]);
      try {
        const run = await runCall(f, transport, "command_wait");
        expect(run.resultText).toContain("Tool 'command_wait' not found.");
        expect(f.calls).toEqual([]);
        expect(run.historyCallName).toBe("command_wait");
      } finally {
        await f.prepared.close();
      }
    });

    test(`a bare name served only by a non-first-party server is not aliased (${transport})`, async () => {
      const f = await fixture(["lookup"]);
      try {
        const run = await runCall(f, transport, "lookup");
        expect(run.resultText).toContain("Tool 'lookup' not found.");
        expect(f.calls).toEqual([]);
      } finally {
        await f.prepared.close();
      }
    });
  }

  // Without progressive disclosure the SDK raises on an unknown tool and the
  // whole turn fails, so the bare name matters even more there.
  test("a bare harness tool name runs without progressive disclosure", async () => {
    const f = await fixture(["lookup"]);
    try {
      const run = await runCall(f, undefined, "command_wait");
      expect(run.resultText).toContain("opengeni:command_wait ran");
      expect(run.historyCallName).toBe("opengeni__command_wait");
    } finally {
      await f.prepared.close();
    }
  });

  test("an ambiguous bare name still fails without progressive disclosure", async () => {
    const f = await fixture(["command_wait"]);
    try {
      await expect(runCall(f, undefined, "command_wait")).rejects.toThrow(
        "Tool command_wait not found",
      );
      expect(f.calls).toEqual([]);
    } finally {
      await f.prepared.close();
    }
  });
});
