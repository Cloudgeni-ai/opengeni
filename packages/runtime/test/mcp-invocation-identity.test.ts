import { expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { testSettings } from "@opengeni/testing";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { z } from "zod";
import { buildOpenGeniAgent, PrefixedMcpServer, prepareAgentTools } from "../src/index";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

async function fixture(sandboxBackend: "none" | "docker", withAttempt = true) {
  const calls: Array<{ value: string; operationId: unknown }> = [];
  const observations: Array<{
    value: string;
    operationId: string;
    sourceCallId: string | undefined;
  }> = [];
  const executions: Array<{ operationId: string; sourceCallId: string | undefined }> = [];
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const server = new McpServer({ name: "identity-provider", version: "1.0.0" });
      server.registerTool(
        "echo",
        {
          inputSchema: {
            value: z.string(),
            operationId: z.string().optional(),
            sourceCallId: z.string().optional(),
          },
        },
        async (input, extra) => {
          await Promise.resolve();
          calls.push({ value: input.value, operationId: extra._meta?.opengeniOperationId });
          return { content: [{ type: "text" as const, text: input.value }] };
        },
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      transports.push(transport);
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  const settings = testSettings({
    sandboxBackend,
    mcpServers: [{ id: "identity", url: `http://127.0.0.1:${provider.port}/mcp` }],
  });
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "identity" }]);
  const remote = prepared.mcpServers[0];
  if (!(remote instanceof PrefixedMcpServer)) throw new Error("Prefixed MCP server missing");
  if (withAttempt) {
    const [descriptor] = await remote.listTools();
    if (!descriptor) throw new Error("MCP descriptor missing");
    remote.bindAttemptToolEnvironment(
      createAttemptToolEnvironment({
        scope,
        generation: 1,
        definitions: [
          {
            identity: { serverId: "identity", toolName: "echo" },
            modelName: "identity__echo",
            inputSchema: descriptor.inputSchema,
            source: "mcp",
            approval: "none",
            lifecycle: {
              prepare: async ({ call, context }) => {
                await Promise.resolve();
                observations.push({
                  value: String(call.arguments.value),
                  operationId: call.operationId,
                  sourceCallId: context.sourceCallId,
                });
              },
            },
            execute: async (args, context) => {
              executions.push({
                operationId: context.operationId,
                sourceCallId: context.sourceCallId,
              });
              return await remote.executeCatalogTool("echo", args, {
                ...(context.transportMeta ?? {}),
                opengeniOperationId: context.operationId,
              });
            },
          },
        ],
      }),
      "identity-test",
    );
  }
  const agent = buildOpenGeniAgent(settings, [], { mcpServers: prepared.mcpServers });
  return {
    agent,
    prepared,
    calls,
    observations,
    executions,
    async close() {
      await prepared.close();
      for (const transport of transports) await transport.close();
      provider.stop(true);
    },
  };
}

for (const backend of ["none", "docker"] as const) {
  for (const cloneDepth of [0, 2]) {
    test(`${backend}, clone depth ${cloneDepth}: parallel unapproved SDK calls retain exact identity`, async () => {
      const f = await fixture(backend);
      try {
        let agent = f.agent;
        for (let i = 0; i < cloneDepth; i++) agent = agent.clone({});
        const tool = (await agent.getMcpTools(new RunContext())).find(
          (candidate) => candidate.type === "function" && candidate.name === "identity__echo",
        );
        if (!tool || tool.type !== "function") throw new Error("MCP tool missing");
        expect(await tool.needsApproval(new RunContext(), { value: "a" }, "call-a")).toBe(false);
        await Promise.all(
          ["a", "b"].map((value) =>
            tool.invoke(
              new RunContext(),
              JSON.stringify({
                value,
                operationId: "argument-is-not-authority",
                sourceCallId: "argument-is-not-authority",
              }),
              { toolCall: { callId: `call-${value}` } } as never,
            ),
          ),
        );
        expect(f.observations.sort((a, b) => a.value.localeCompare(b.value))).toEqual([
          { value: "a", operationId: expect.any(String), sourceCallId: "call-a" },
          { value: "b", operationId: expect.any(String), sourceCallId: "call-b" },
        ]);
        expect(new Set(f.observations.map((row) => row.operationId)).size).toBe(2);
        for (const row of f.observations) {
          expect(row.operationId).toMatch(/^[0-9a-f-]{36}$/);
          expect(f.calls).toContainEqual({ value: row.value, operationId: row.operationId });
          expect(f.executions).toContainEqual({
            operationId: row.operationId,
            sourceCallId: row.sourceCallId,
          });
        }
        await f.prepared.mcpServers[0]!.callTool(
          "identity__echo",
          {
            value: "programmatic",
            sourceCallId: "argument-is-not-authority",
          },
          { sourceCallId: "metadata-is-not-authority" },
        );
        expect(f.calls[2]?.operationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(f.observations[2]?.sourceCallId).toBeUndefined();
        await tool.invoke(new RunContext(), JSON.stringify({ value: "no-details" }));
        expect(f.observations[3]?.sourceCallId).toBeUndefined();
        expect(f.observations[3]?.operationId).toMatch(/^[0-9a-f-]{36}$/);
      } finally {
        await f.close();
      }
    });
  }
}

test("ordinary SDK calls without an attempt gateway still execute without approval context", async () => {
  const f = await fixture("none", false);
  try {
    const tool = (await f.agent.getMcpTools(new RunContext())).find(
      (candidate) => candidate.type === "function" && candidate.name === "identity__echo",
    );
    if (!tool || tool.type !== "function") throw new Error("MCP tool missing");
    await tool.invoke(new RunContext(), JSON.stringify({ value: "ordinary" }), {
      toolCall: { callId: "call-ordinary" },
    } as never);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.value).toBe("ordinary");
  } finally {
    await f.close();
  }
});

test("local model MCP projection carries SDK correlation to its existing lifecycle", async () => {
  const observations: Array<{ operationId: string; sourceCallId: string | undefined }> = [];
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [] });
  const prepared = await prepareAgentTools(settings, [], {
    ...scope,
    attemptToolDefinitions: [
      {
        identity: { serverId: "local", toolName: "echo" },
        modelName: "local_echo",
        inputSchema: { type: "object", additionalProperties: false },
        source: "mcp",
        approval: "none",
        lifecycle: {
          prepare: ({ call, context }) => {
            observations.push({
              operationId: call.operationId,
              sourceCallId: context.sourceCallId,
            });
          },
        },
        execute: async () => ({ content: [{ type: "text", text: "done" }] }),
      },
    ],
  });
  try {
    const agent = buildOpenGeniAgent(settings, [], { mcpServers: prepared.mcpServers }).clone({});
    const tool = (await agent.getMcpTools(new RunContext())).find(
      (candidate) => candidate.type === "function" && candidate.name === "local_echo",
    );
    if (!tool || tool.type !== "function") throw new Error("Local MCP tool missing");
    await tool.invoke(new RunContext(), "{}", { toolCall: { callId: "call-local" } } as never);
    expect(observations).toEqual([{ operationId: expect.any(String), sourceCallId: "call-local" }]);
    expect(observations[0]?.operationId).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    await prepared.close();
  }
});
