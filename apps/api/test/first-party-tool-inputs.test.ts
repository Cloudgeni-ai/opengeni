import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FIRST_PARTY_MCP_TOOL_NAMES,
  Permission,
  CreateScheduledTaskRequest,
  type AccessGrant,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createWorkspaceToolGateway,
  ToolGatewayInputValidationError,
} from "@opengeni/tool-gateway";
import * as z from "zod/v4";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { assertDescribedToolInput, contractToolInput } from "../src/mcp/contract-input";

const grant: AccessGrant = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "tool-input-test",
  principalKind: "agent_attempt",
  permissions: [...Permission.options],
  metadata: {
    sessionId: "33333333-3333-4333-8333-333333333333",
    firstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
  },
};

async function withClient<T>(run: (client: Client) => Promise<T>) {
  const server = buildOpenGeniMcpServer(
    {
      settings: testSettings({
        sandboxBackend: "none",
        allowedFirstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
      }),
      db: new Proxy(
        {},
        {
          get() {
            throw new Error("invalid input reached storage");
          },
        },
      ),
      bus: new MemoryEventBus(),
      workflowClient: {},
      objectStorage: null,
      githubStateSecret: "test",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("invalid input reached documents");
      },
    } as unknown as ApiRouteDeps,
    grant,
  );
  return withServer(server, run);
}

async function withServer<T>(server: McpServer, run: (client: Client) => Promise<T>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-input-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("first-party tool input discovery and validation", () => {
  test("publishes the interval cadence through real MCP discovery", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const schema = tools.find((tool) => tool.name === "scheduled_tasks_create")!.inputSchema;
      expect(JSON.stringify(schema)).toContain("everySeconds");
      expect(schema.required).toEqual(["name", "schedule", "agentConfig"]);
      expect(JSON.stringify(schema)).not.toContain("slackBotChannelId");
      expect(schema.properties).not.toHaveProperty("agentLearning");
      expect(schema.properties).not.toHaveProperty("connectionAuthorities");
    });
  });

  test("checks every advertised first-party input, including nested contract fields", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(50);
      for (const tool of tools) assertDescribedToolInput(tool.inputSchema, tool.name);
      const schemas = new Map(tools.map((tool) => [tool.name, JSON.stringify(tool.inputSchema)]));
      expect(schemas.get("scheduled_tasks_update")).toContain("everySeconds");
      expect(schemas.get("session_create")).toContain("allowedTools");
      expect(schemas.get("session_create")).toContain("fileId");
      expect(schemas.get("session_send_message")).toContain("headers");
      expect(schemas.get("session_human_input_respond")).toContain("questionId");
    });
  });

  test("the advertised schedule is accepted and rejected by the shared gateway before execution", async () => {
    await withClient(async (client) => {
      const tool = (await client.listTools()).tools.find(
        (item) => item.name === "scheduled_tasks_create",
      )!;
      let executions = 0;
      const { gateway } = createWorkspaceToolGateway({
        accountId: grant.accountId!,
        workspaceId: grant.workspaceId!,
        generation: 1,
        definitions: [
          {
            identity: { serverId: "opengeni", toolName: tool.name },
            modelName: tool.name,
            source: "mcp",
            approval: "none",
            inputSchema: tool.inputSchema,
            execute: async (args) => {
              executions++;
              return { content: [{ type: "text", text: JSON.stringify(args) }] };
            },
          },
        ],
      });
      const args = {
        name: "Activity monitor",
        schedule: { type: "interval", everySeconds: 7200 },
        agentConfig: { prompt: "Report activity" },
      };
      const request = { modelName: tool.name, arguments: args, subjectId: grant.subjectId };
      await gateway.callModel(request);
      expect(executions).toBe(1);
      try {
        await gateway.callModel({
          ...request,
          arguments: { ...args, schedule: { type: "interval" } },
        });
        throw new Error("invalid cadence was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(ToolGatewayInputValidationError);
        expect((error as Error).message).toContain("everySeconds");
        expect((error as Error).message).not.toContain("knowledge_source_sync");
      }
      expect(executions).toBe(1);
    });
  });

  test("rejects a missing interval cadence before storage with applicable errors", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "scheduled_tasks_create",
        arguments: {
          name: "Activity monitor",
          schedule: { type: "interval" },
          agentConfig: { prompt: "Report activity" },
        },
      });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("everySeconds");
      expect(text).not.toContain("knowledge_source_sync");
      expect(text).not.toContain('\\"action\\"');
      expect(text).not.toContain("invalid input reached storage");
    });
  });

  test.each([
    ["session_create", { initialMessage: "Work", reasoningEffort: "invalid" }, "reasoningEffort"],
    ["session_create", { initialMessage: "Work", sandboxBackend: "invalid" }, "sandboxBackend"],
    [
      "session_create",
      { initialMessage: "Work", firstPartyMcpPermissions: ["invalid"] },
      "firstPartyMcpPermissions",
    ],
    [
      "scheduled_tasks_create",
      { name: "Activity monitor", schedule: { type: "cron" }, agentConfig: { prompt: "Report" } },
      "type",
    ],
    [
      "scheduled_tasks_create",
      {
        name: "Activity monitor",
        schedule: { type: "interval", everySeconds: 7200 },
        agentConfig: {},
      },
      "prompt",
    ],
    [
      "scheduled_tasks_update",
      { id: grant.metadata!.sessionId, agentConfigPatch: { reasoningEffort: "invalid" } },
      "reasoningEffort",
    ],
    ["session_create", { initialMessage: "Work", resources: [{ kind: "file" }] }, "fileId"],
    ["session_create", { initialMessage: "Work", tools: [{ kind: "mcp" }] }, "id"],
    ["session_create", { initialMessage: "Work", mcpServers: [{ id: "test" }] }, "url"],
    [
      "session_send_message",
      {
        sessionId: grant.metadata!.sessionId,
        text: "Work",
        idempotencyKey: grant.metadata!.sessionId,
        mcpCredentialUpdates: [{ id: "test" }],
      },
      "headers",
    ],
    [
      "session_human_input_respond",
      {
        sessionId: grant.metadata!.sessionId,
        requestId: grant.metadata!.sessionId,
        idempotencyKey: grant.metadata!.sessionId,
        response: { outcome: "answered" },
      },
      "answers",
    ],
  ])("rejects malformed %s inputs before application work", async (name, args, field) => {
    await withClient(async (client) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(field);
      expect(JSON.stringify(result.content)).not.toContain("invalid input reached storage");
    });
  });
});

describe("contract input projection", () => {
  test("rejects fields outside a projection before preserving the original input", () => {
    const input = contractToolInput(z.object({ name: z.string() }));
    expect(input.safeParse({ name: "Report", hiddenControl: true }).success).toBe(false);
    expect(z.toJSONSchema(input, { io: "input" }).additionalProperties).toBe(false);
  });
  test("MCP discovery and invocation preserve omitted defaults and exact nested input", async () => {
    const projection = z
      .object(CreateScheduledTaskRequest.options[1].out.shape)
      .omit({ agentLearning: true, connectionAuthorities: true });
    const input = contractToolInput(projection, CreateScheduledTaskRequest.options[1]);
    const args = {
      name: "  Keep original text  ",
      schedule: { type: "interval", everySeconds: 7200 },
      agentConfig: { prompt: "Report", metadata: { arbitrary: { nested: [1, null] } } },
    };
    let received: unknown;
    const server = new McpServer({ name: "contract-test", version: "1" });
    server.registerTool("probe", { inputSchema: input }, async (value) => {
      received = value;
      return { content: [{ type: "text", text: "ok" }] };
    });
    await withServer(server, async (client) => {
      const tool = (await client.listTools()).tools[0]!;
      expect(JSON.stringify(tool.inputSchema)).toContain("everySeconds");
      expect((await client.callTool({ name: "probe", arguments: args })).isError).not.toBe(true);
    });
    expect(received).toEqual(args);
    expect(received).not.toHaveProperty("action");
    expect(received).not.toHaveProperty("agentConfig.tools");
    expect(received).not.toHaveProperty("agentConfig.resources");
    expect(CreateScheduledTaskRequest.parse(args)).toHaveProperty("agentConfig.tools", []);
  });

  test("retains full contract cross-field checks beyond the structural projection", () => {
    const contract = CreateScheduledTaskRequest.options[1];
    const input = contractToolInput(
      z.object(contract.out.shape).omit({ agentLearning: true, connectionAuthorities: true }),
      contract,
    );
    const result = input.safeParse({
      name: "Report",
      schedule: { type: "interval", everySeconds: 7200 },
      agentConfig: { prompt: "Report" },
      runMode: "existing_session",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["targetSessionId"]);
      expect(result.error.issues[0]?.message).toBe(
        "targetSessionId is required when runMode=existing_session",
      );
    }
  });

  test("invalid discriminator errors name the field once and publish its allowed formats", () => {
    const contract = CreateScheduledTaskRequest.options[1];
    const input = contractToolInput(
      z.object(contract.out.shape).omit({ agentLearning: true, connectionAuthorities: true }),
      contract,
    );
    const result = input.safeParse({
      name: "Report",
      schedule: { type: "cron" },
      agentConfig: { prompt: "Report" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["schedule", "type"]);
      expect(result.error.issues[0]?.message).toContain("interval");
      expect(result.error.issues[0]?.message).toContain("calendar");
    }
  });

  test.each([
    { type: "object", properties: { input: {} } },
    { type: "object", properties: { inputs: { type: "array", items: {} } } },
    { type: "object", properties: { inputs: { type: "array" } } },
    { type: "object", properties: { input: { anyOf: [{ type: "string" }, {}] } } },
    {
      type: "object",
      properties: { input: { $ref: "#/definitions/opaque" } },
      definitions: { opaque: {} },
    },
    {
      type: "object",
      properties: {
        input: {
          type: "object",
          additionalProperties: { type: "object", properties: { hidden: {} } },
        },
      },
    },
    { type: "object", properties: { input: true } },
    {
      type: "object",
      properties: { input: { type: "array", items: [{ type: "string" }], additionalItems: {} } },
    },
    { type: "object", properties: { input: { type: "array", prefixItems: [{ type: "string" }] } } },
  ])("refuses opaque structured inputs %#", (schema) => {
    expect(() => assertDescribedToolInput(schema, "probe")).toThrow();
  });

  test("allows intentional arbitrary metadata and recursive declared inputs", () => {
    expect(() =>
      assertDescribedToolInput({
        type: "object",
        properties: {
          metadata: { type: "object", additionalProperties: {} },
          tree: { $ref: "#/definitions/tree" },
        },
        definitions: {
          tree: { type: "object", properties: { child: { $ref: "#/definitions/tree" } } },
        },
      }),
    ).not.toThrow();
  });
});
