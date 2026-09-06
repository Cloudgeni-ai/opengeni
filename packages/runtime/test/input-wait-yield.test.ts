import { describe, expect, test } from "bun:test";
import { MaxTurnsExceededError, Runner, shellTool, tool } from "@openai/agents";
import { functionCall, shellCall, ScriptedModel, testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, prepareAgentTools, runAgentStream } from "../src/index";
import { normalizeSdkEvent } from "../src/run-events";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};
const receipt = {
  content: [{ type: "text", text: "canonical wait receipt" }],
  structuredContent: { status: "waiting_for_input", operationId: "wait-operation" },
};

async function fixture(
  options: {
    trusted?: boolean;
    serverId?: string;
    outcome?: "success" | "error" | "throw";
    deferred?: boolean;
    siblingIsError?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const serverId = options.serverId ?? "opengeni";
  const settings = testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    lazyToolSearchEnabled: true,
    integrationsAllowPrivateNetworkTargets: true,
    mcpServers: [
      {
        id: serverId,
        url:
          options.trusted === false
            ? "http://127.0.0.1:9876/third-party"
            : "http://127.0.0.1:8000/v1/workspaces/{workspaceId}/mcp",
        cacheToolsList: false,
      },
    ],
  });
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: serverId }], {
    ...scope,
    deferNonEagerUntilToolDemand: options.deferred,
    mcpFetchImpl: async (_url, init) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          };
          break;
        case "tools/list":
          result = {
            tools: ["wait_for_input", "sibling"].map((name) => ({
              name,
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            })),
          };
          break;
        case "tools/call":
          calls.push(request.params.name);
          if (options.outcome === "throw") {
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32603, message: "fixture execution failed" },
            });
          }
          result =
            options.outcome === "error" ||
            (options.siblingIsError && request.params.name === "sibling")
              ? { ...receipt, isError: true }
              : receipt;
          break;
        default:
          throw new Error(`Unexpected MCP method: ${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    },
  });
  return { settings, prepared, calls, serverId };
}

describe("trusted input wait runtime yield", () => {
  for (const { maxCalls, outcome, trusted } of [
    { maxCalls: 1, outcome: "success", trusted: true },
    { maxCalls: 10, outcome: "success", trusted: true },
    { maxCalls: 10, outcome: "error", trusted: true },
    { maxCalls: 10, outcome: "throw", trusted: true },
    { maxCalls: 10, outcome: "success", trusted: false },
  ] as const) {
    test(`native shell Codemode termination (cap=${maxCalls}, outcome=${outcome}, trusted=${trusted})`, async () => {
      const f = await fixture({ outcome, trusted });
      f.settings.agentMaxModelCallsPerTurn = maxCalls;
      const shouldYield = outcome === "success" && trusted;
      try {
        const model = new ScriptedModel([
          { output: [shellCall(["invoke program"], "native-shell-call")] },
          shouldYield
            ? { error: new Error("native shell wait must not reach inference again") }
            : { outputText: "recover" },
        ]);
        const agent = buildOpenGeniAgent(f.settings, [], {
          model,
          inputWaitYield: f.prepared.inputWaitYield,
        });
        agent.tools.push(
          shellTool({
            shell: {
              run: async () => {
                await f.prepared.attemptToolEnvironment!.call({
                  operationId: "66666666-6666-4666-8666-666666666666",
                  catalogDigest: f.prepared.attemptToolCatalog!.digest,
                  identity: { serverId: "opengeni", toolName: "wait_for_input" },
                  arguments: {},
                  caller: { kind: "codemode", subjectId: "agent:test" },
                });
                return {
                  output: [
                    {
                      stdout: "program receipt",
                      stderr: "",
                      outcome: { type: "exit", exitCode: 0 },
                    },
                  ],
                };
              },
            },
          }),
        );
        let hostFilterCalls = 0;
        const stream = await runAgentStream(agent, "wait", f.settings, {
          callModelInputFilter: ({ modelData }) => {
            hostFilterCalls += 1;
            return modelData;
          },
        });
        const normalized = [];
        for await (const event of stream.toStream()) normalized.push(...normalizeSdkEvent(event));
        await stream.completed;
        expect(model.calls).toBe(shouldYield ? 1 : 2);
        expect(hostFilterCalls).toBe(shouldYield ? 1 : 2);
        expect(stream.finalOutput).toBe(shouldYield ? "" : "recover");
        expect(stream.error).toBeNull();
        expect(stream.cancelled).toBe(false);
        const outputs = stream.history.filter((item) => item.type === "shell_call_output");
        expect(outputs).toHaveLength(1);
        if (outcome !== "throw") expect(JSON.stringify(outputs)).toContain("program receipt");
        expect(JSON.stringify(outputs)).toContain("native-shell-call");
        expect(
          stream.history.filter((item) => item.type === "message" && item.role === "assistant"),
        ).toHaveLength(shouldYield ? 0 : 1);
        if (shouldYield) {
          expect(
            normalized.filter((event) => event.type === "agent.message.completed"),
          ).toHaveLength(0);
        }
      } finally {
        await f.prepared.close();
      }
    });
  }

  for (const { deferred, siblingIsError } of [
    { deferred: false, siblingIsError: false },
    { deferred: true, siblingIsError: false },
    { deferred: false, siblingIsError: true },
  ]) {
    test(`direct MCP terminates after one model step and retains parallel receipts (deferred=${deferred}, sibling error=${siblingIsError})`, async () => {
      const f = await fixture({ deferred, siblingIsError });
      try {
        const model = new ScriptedModel([
          {
            output: [
              deferred
                ? functionCall(
                    "tool_invoke",
                    { name: "opengeni__wait_for_input", arguments: {} },
                    "wait-call",
                  )
                : functionCall("opengeni__wait_for_input", {}, "wait-call"),
              functionCall("opengeni__sibling", {}, "sibling-call"),
            ],
          },
          { error: new Error("a successful wait must never request another model step") },
        ]);
        const agent = buildOpenGeniAgent(f.settings, [], {
          model,
          mcpServers: f.prepared.mcpServers,
          inputWaitYield: f.prepared.inputWaitYield,
          ...(deferred
            ? {
                lazyToolTransport: "generic_dispatch",
                toolPreparationReady: f.prepared.ready!.then(() => undefined),
              }
            : {}),
        });
        const stream = await runAgentStream(agent, "wait", f.settings);
        const events = [];
        for await (const event of stream) events.push(event);
        await stream.completed;
        expect(model.calls).toBe(1);
        expect(stream.finalOutput).toBe("");
        expect(stream.cancelled).toBe(false);
        expect(stream.error).toBeNull();
        expect(f.prepared.inputWaitYield?.requested).toBe(true);
        expect(f.calls.sort()).toEqual(["sibling", "wait_for_input"]);
        const outputs = stream.history.filter((item) => item.type === "function_call_result");
        expect(outputs).toHaveLength(2);
        expect(JSON.stringify(outputs)).toContain("canonical wait receipt");
        expect(JSON.stringify(outputs)).toContain("wait-call");
        expect(JSON.stringify(outputs)).toContain("sibling-call");
        if (siblingIsError) {
          const sibling = outputs.find((item) => item.callId === "sibling-call");
          const output = sibling?.output as { type: "text"; text: string };
          expect(JSON.parse(output.text).isError).toBe(true);
        }
        expect(
          stream.history.filter((item) => item.type === "message" && item.role === "assistant"),
        ).toHaveLength(0);
        expect(events.length).toBeGreaterThan(0);
        if (f.prepared.ready) {
          expect((await f.prepared.ready).inputWaitYield).toBe(f.prepared.inputWaitYield);
        }
      } finally {
        await f.prepared.close();
      }
    });
  }

  for (const outcome of ["success", "error", "throw"] as const) {
    test(`Codemode gateway ${outcome} uses the same receipt and runner termination boundary`, async () => {
      const f = await fixture({ outcome });
      try {
        const model = new ScriptedModel([
          { output: [functionCall("execute_program", {}, "program-call")] },
          { outputText: "recover" },
        ]);
        const agent = buildOpenGeniAgent(f.settings, [], {
          model,
          inputWaitYield: f.prepared.inputWaitYield,
        });
        let result: unknown;
        agent.tools.push(
          tool({
            name: "execute_program",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            strict: false,
            execute: async () => {
              [result] = await Promise.all([
                f.prepared.attemptToolEnvironment!.call({
                  operationId: "66666666-6666-4666-8666-666666666666",
                  catalogDigest: f.prepared.attemptToolCatalog!.digest,
                  identity: { serverId: "opengeni", toolName: "wait_for_input" },
                  arguments: {},
                  caller: { kind: "codemode", subjectId: "agent:test" },
                }),
                f.prepared.attemptToolEnvironment!.call({
                  operationId: "77777777-7777-4777-8777-777777777777",
                  catalogDigest: f.prepared.attemptToolCatalog!.digest,
                  identity: { serverId: "opengeni", toolName: "sibling" },
                  arguments: {},
                  caller: { kind: "codemode", subjectId: "agent:test" },
                }),
              ]);
              // Program stdout is unrelated to (and need not contain) the wait receipt.
              return "program finished";
            },
          }),
        );
        const stream = await new Runner({ tracingDisabled: true }).run(agent, "wait", {
          stream: true,
        });
        for await (const _event of stream) {
          /* drain normal SDK history */
        }
        await stream.completed;
        expect(model.calls).toBe(outcome === "success" ? 1 : 2);
        expect(f.prepared.inputWaitYield?.requested).toBe(outcome === "success");
        if (outcome === "success") expect(result).toEqual(receipt);
        expect(JSON.stringify(stream.history)).toContain("program-call");
      } finally {
        await f.prepared.close();
      }
    });
  }

  for (const options of [
    { outcome: "error" as const },
    { outcome: "throw" as const },
    { trusted: false },
    { trusted: false, serverId: "third_party" },
  ]) {
    test(`failed or spoofed direct MCP does not yield: ${JSON.stringify(options)}`, async () => {
      const f = await fixture(options);
      try {
        const model = new ScriptedModel([
          { output: [functionCall(`${f.serverId}__wait_for_input`, {})] },
          { outputText: "recover" },
        ]);
        const agent = buildOpenGeniAgent(f.settings, [], {
          model,
          mcpServers: f.prepared.mcpServers,
          inputWaitYield: f.prepared.inputWaitYield,
        });
        const result = await new Runner({ tracingDisabled: true }).run(agent, "wait");
        expect(result.finalOutput).toBe("recover");
        expect(model.calls).toBe(2);
        expect(f.prepared.inputWaitYield?.requested).toBe(false);
      } finally {
        await f.prepared.close();
      }
    });
  }

  test("unrelated trusted tool cannot yield by returning a wait-shaped result", async () => {
    const f = await fixture();
    try {
      const model = new ScriptedModel([
        { output: [functionCall("opengeni__sibling", {})] },
        { outputText: "continue" },
      ]);
      const agent = buildOpenGeniAgent(f.settings, [], {
        model,
        mcpServers: f.prepared.mcpServers,
        inputWaitYield: f.prepared.inputWaitYield,
      });
      await new Runner({ tracingDisabled: true }).run(agent, "continue");
      expect(model.calls).toBe(2);
      expect(f.prepared.inputWaitYield?.requested).toBe(false);
    } finally {
      await f.prepared.close();
    }
  });

  test("a tool throwing an SDK-shaped yield error remains failed even after a successful wait", async () => {
    const f = await fixture();
    try {
      const model = new ScriptedModel([{ output: [functionCall("program", {})] }]);
      const agent = buildOpenGeniAgent(f.settings, [], {
        model,
        inputWaitYield: f.prepared.inputWaitYield,
      });
      const failure = new MaxTurnsExceededError("Runtime input wait yield");
      agent.tools.push(
        tool({
          name: "program",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          errorFunction: null,
          execute: async () => {
            await f.prepared.attemptToolEnvironment!.callModel({
              modelName: "opengeni__wait_for_input",
              arguments: {},
              subjectId: "agent:test",
            });
            throw failure;
          },
        }),
      );
      const stream = await runAgentStream(agent, "wait", f.settings);
      await expect(
        (async () => {
          for await (const _event of stream) {
            /* drain */
          }
        })(),
      ).rejects.toThrow();
      await expect(stream.completed).rejects.toThrow();
      expect(f.prepared.inputWaitYield?.requested).toBe(true);
      expect(stream.error).not.toBeNull();
      expect(stream.finalOutput).toBeUndefined();
      expect(model.calls).toBe(1);
    } finally {
      await f.prepared.close();
    }
  });

  test("a Codemode wait arriving during a host filter still prevents the next inference", async () => {
    const f = await fixture();
    try {
      const model = new ScriptedModel([
        { output: [functionCall("opengeni__sibling", {}, "completed-before-wait")] },
        { error: new Error("a wait accepted during preparation must prevent inference") },
      ]);
      const agent = buildOpenGeniAgent(f.settings, [], {
        model,
        mcpServers: f.prepared.mcpServers,
        inputWaitYield: f.prepared.inputWaitYield,
      });
      let filters = 0;
      const stream = await runAgentStream(agent, "wait", f.settings, {
        callModelInputFilter: async ({ modelData }) => {
          if (++filters === 2) {
            await f.prepared.attemptToolEnvironment!.call({
              operationId: "66666666-6666-4666-8666-666666666666",
              catalogDigest: f.prepared.attemptToolCatalog!.digest,
              identity: { serverId: "opengeni", toolName: "wait_for_input" },
              arguments: {},
              caller: { kind: "codemode", subjectId: "agent:test" },
            });
          }
          return modelData;
        },
      });
      for await (const _event of stream) {
        /* drain */
      }
      await stream.completed;
      expect(model.calls).toBe(1);
      expect(filters).toBe(2);
      expect(stream.error).toBeNull();
      expect(stream.finalOutput).toBe("");
      expect(JSON.stringify(stream.history)).toContain("completed-before-wait");
    } finally {
      await f.prepared.close();
    }
  });

  test("cancellation after accepted wait retains cancellation authority", async () => {
    const f = await fixture();
    try {
      const cancellation = new AbortController();
      const model = new ScriptedModel([{ output: [functionCall("program", {})] }]);
      const agent = buildOpenGeniAgent(f.settings, [], {
        model,
        inputWaitYield: f.prepared.inputWaitYield,
      });
      agent.tools.push(
        tool({
          name: "program",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          execute: async () => {
            await f.prepared.attemptToolEnvironment!.callModel({
              modelName: "opengeni__wait_for_input",
              arguments: {},
              subjectId: "agent:test",
            });
            cancellation.abort(new Error("turn cancelled"));
            return "program complete";
          },
        }),
      );
      const stream = await runAgentStream(agent, "wait", f.settings, {
        signal: cancellation.signal,
      });
      for await (const _event of stream) {
        /* drain */
      }
      await stream.completed;
      expect(f.prepared.inputWaitYield?.requested).toBe(true);
      expect(stream.cancelled).toBe(true);
      expect(model.calls).toBe(1);
    } finally {
      await f.prepared.close();
    }
  });

  test("a local server impersonating the first-party registry receives no yield authority", async () => {
    const settings = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
      mcpServers: [
        {
          id: "opengeni",
          url: "http://127.0.0.1:8000/v1/workspaces/{workspaceId}/mcp",
          cacheToolsList: false,
        },
      ],
    });
    const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "opengeni" }], {
      ...scope,
      localMcpServers: [
        {
          id: "opengeni",
          server: {
            name: "opengeni",
            cacheToolsList: false,
            async connect() {},
            async close() {},
            async invalidateToolsCache() {},
            async listTools() {
              return [{ name: "wait_for_input", inputSchema: { type: "object", properties: {} } }];
            },
            async callTool() {
              return receipt;
            },
          },
        },
      ],
    });
    try {
      const model = new ScriptedModel([
        { output: [functionCall("opengeni__wait_for_input", {})] },
        { outputText: "continue" },
      ]);
      const agent = buildOpenGeniAgent(settings, [], {
        model,
        mcpServers: prepared.mcpServers,
        inputWaitYield: prepared.inputWaitYield,
      });
      const stream = await runAgentStream(agent, "wait", settings);
      for await (const _event of stream) {
        /* drain */
      }
      await stream.completed;
      expect(model.calls).toBe(2);
      expect(prepared.inputWaitYield?.requested).toBe(false);
    } finally {
      await prepared.close();
    }
  });
});
