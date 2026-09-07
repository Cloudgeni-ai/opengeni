import { expect, test } from "bun:test";
import type { AttemptToolResult } from "@opengeni/contracts";
import { executeCommandReadWithRefresh } from "../src/command-read-refresh";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { PrefixedMcpServer } from "../src/index";
import type { MCPServer } from "@openai/agents";

const commandId = "6cfa95ae-29cc-48cb-9ab1-2613d15f1dde";
const receipt = (terminal = false, chunks: unknown[] = []): AttemptToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ commandId, terminal, chunks }) }],
});

test("model and Codemode share the first-party catalog refresh executor", async () => {
  let refreshes = 0;
  let apiReads = 0;
  const inner: MCPServer = {
    name: "first-party-test",
    cacheToolsList: false,
    connect: async () => {},
    close: async () => {},
    listTools: async () => [],
    callTool: async () => {
      apiReads++;
      return receipt(apiReads % 2 === 0).content;
    },
  };
  const server = new PrefixedMcpServer(
    inner,
    "opengeni",
    ["command_read"],
    false,
    undefined,
    "opengeni",
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    async () => {
      refreshes++;
      return true;
    },
  );
  const environment = createAttemptToolEnvironment({
    scope: {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
    },
    generation: 1,
    definitions: [
      {
        identity: { serverId: "opengeni", toolName: "command_read" },
        modelName: "opengeni__command_read",
        codemodePath: ["opengeni", "command_read"],
        source: "opengeni",
        approval: "none",
        inputSchema: {
          type: "object",
          properties: { commandId: { type: "string" } },
          required: ["commandId"],
          additionalProperties: false,
        },
        execute: async (args) => await server.executeCatalogTool("command_read", args),
      },
    ],
  });
  await environment.callModel({
    modelName: "opengeni__command_read",
    arguments: { commandId },
    subjectId: "model:test",
  });
  await environment.call({
    operationId: crypto.randomUUID(),
    catalogDigest: environment.catalog.digest,
    identity: { serverId: "opengeni", toolName: "command_read" },
    arguments: { commandId },
    caller: { kind: "codemode", subjectId: "agent:test" },
  });
  expect(refreshes).toBe(2);
  expect(apiReads).toBe(4);
});

test("owner refresh persists before the API terminal read; never refreshes before authorization", async () => {
  const calls: string[] = [];
  let terminal = false;
  const result = await executeCommandReadWithRefresh({
    toolName: "command_read",
    args: { commandId },
    call: async () => {
      calls.push("api");
      return receipt(terminal, terminal ? ["tail"] : []);
    },
    refresh: async (id) => {
      expect(id).toBe(commandId);
      calls.push("control");
      terminal = true;
      return true;
    },
  });
  expect(calls).toEqual(["api", "control", "api"]);
  expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
    terminal: true,
    chunks: ["tail"],
  });
});

test("command_wait refreshes throughout the bounded API wait", async () => {
  let refreshes = 0;
  const waits: unknown[] = [];
  await executeCommandReadWithRefresh({
    toolName: "command_wait",
    args: { commandId, waitSeconds: 5 },
    call: async (args) => {
      waits.push(args.waitSeconds);
      return receipt(refreshes === 3);
    },
    refresh: async () => {
      refreshes++;
      return true;
    },
  });
  expect(refreshes).toBe(3);
  expect(waits).toEqual([0, 0, 1, 0, 1, 0]);
});

test("API rejection and malformed receipts cannot trigger provider reads", async () => {
  for (const result of [
    { content: [], isError: true },
    { content: [] },
  ] satisfies AttemptToolResult[]) {
    let refreshes = 0;
    expect(
      await executeCommandReadWithRefresh({
        toolName: "command_read",
        args: { commandId },
        call: async () => result,
        refresh: async () => {
          refreshes++;
          return true;
        },
      }),
    ).toBe(result);
    expect(refreshes).toBe(0);
  }
});

test("non-owning runtime preserves API-only waiting", async () => {
  const waits: unknown[] = [];
  await executeCommandReadWithRefresh({
    toolName: "command_wait",
    args: { commandId, waitSeconds: 8 },
    call: async (args) => {
      waits.push(args.waitSeconds);
      return receipt();
    },
    refresh: async () => false,
  });
  expect(waits).toEqual([0, 8]);
});
