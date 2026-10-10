import { describe, expect, test } from "bun:test";
import { CreateScheduledTaskRequest } from "@opengeni/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createWorkspaceToolGateway,
  ToolGatewayInputValidationError,
} from "@opengeni/tool-gateway";
import * as z from "zod/v4";
import {
  AGENT_WAKEUPS_EXPERIMENT_FLAG,
  SESSION_SEND_MESSAGE_AGENT_WAKEUPS_GUIDANCE,
} from "../src/mcp/agent-wakeups";
import { assertDescribedToolInput, contractToolInput } from "../src/mcp/contract-input";
import {
  resolveScheduledTaskCreateInput,
  scheduledTaskCreateToolInput,
  scheduledTaskCreateToolValidation,
} from "../src/mcp/scheduled-task-input";
import {
  firstPartyToolGrant as grant,
  withFirstPartyToolClient as withClient,
  withMcpClient as withServer,
} from "./helpers/first-party-tool-client";

describe("first-party tool input discovery and validation", () => {
  test("publishes message destinations and separate-agent settings through real MCP discovery", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const schema = tools.find((tool) => tool.name === "scheduled_tasks_create")!.inputSchema;
      expect(JSON.stringify(schema)).toContain("everySeconds");
      for (const field of ["prompt", "targetSessionId", "runMode", "agentConfig"])
        expect(schema.properties).toHaveProperty(field);
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

  test("session_send_message advertises wake only behind the agent wakeups experiment", async () => {
    const sendMessageTool = () =>
      withClient(async (client) => {
        const { tools } = await client.listTools();
        return tools.find((tool) => tool.name === "session_send_message")!;
      });
    const previous = process.env[AGENT_WAKEUPS_EXPERIMENT_FLAG];
    try {
      delete process.env[AGENT_WAKEUPS_EXPERIMENT_FLAG];
      const off = await sendMessageTool();
      expect(off.inputSchema.properties).not.toHaveProperty("wake");
      expect(off.description).not.toContain("wake=deferred");
      expect(off.description).toStartWith("To continue related work");

      process.env[AGENT_WAKEUPS_EXPERIMENT_FLAG] = "1";
      const on = await sendMessageTool();
      assertDescribedToolInput(on.inputSchema, on.name);
      expect(JSON.stringify(on.inputSchema.properties?.wake)).toContain("deferred");
      expect(on.description).toStartWith(SESSION_SEND_MESSAGE_AGENT_WAKEUPS_GUIDANCE);
      // The base guidance stays word for word after the experiment's prefix.
      expect(on.description).toEndWith(off.description!);
    } finally {
      if (previous === undefined) delete process.env[AGENT_WAKEUPS_EXPERIMENT_FLAG];
      else process.env[AGENT_WAKEUPS_EXPERIMENT_FLAG] = previous;
    }
  });

  test("the advertised schedule preserves exact chat and separate-agent intent through the gateway", async () => {
    await withClient(async (client) => {
      const tool = (await client.listTools()).tools.find(
        (item) => item.name === "scheduled_tasks_create",
      )!;
      let executions = 0;
      const accepted: ReturnType<typeof resolveScheduledTaskCreateInput>[] = [];
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
            inputSchema: z.record(z.string(), z.json()).parse(tool.inputSchema),
            execute: async (args) => {
              accepted.push(
                resolveScheduledTaskCreateInput(args, String(grant.metadata!.sessionId)),
              );
              executions++;
              return { content: [{ type: "text", text: JSON.stringify(args) }] };
            },
          },
        ],
      });
      const args = {
        name: "Activity monitor",
        schedule: { type: "interval", everySeconds: 7200 },
        prompt: "Report activity",
      };
      const request = { modelName: tool.name, arguments: args, subjectId: grant.subjectId };
      await gateway.callModel(request);
      expect(executions).toBe(1);
      expect(accepted[0]).toMatchObject({
        runMode: "existing_session",
        targetSessionId: grant.metadata!.sessionId,
        agentConfig: { prompt: args.prompt },
      });

      const targetSessionId = "44444444-4444-4444-8444-444444444444";
      await gateway.callModel({
        ...request,
        arguments: { ...args, targetSessionId },
      });
      expect(accepted.at(-1)).toMatchObject({ runMode: "existing_session", targetSessionId });
      for (const runMode of ["reusable_session", "new_session_per_run"] as const) {
        await gateway.callModel({
          ...request,
          arguments: {
            name: args.name,
            schedule: args.schedule,
            runMode,
            agentConfig: { prompt: args.prompt },
          },
        });
        expect(accepted.at(-1)?.runMode).toBe(runMode);
        expect(accepted.at(-1)?.targetSessionId).toBeUndefined();
      }
      const beforeInvalid = executions;
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
      for (const field of ["name", "schedule"] as const) {
        const { [field]: omitted, ...missingRequired } = args;
        expect(omitted).toBeDefined();
        await expect(
          gateway.callModel({ ...request, arguments: missingRequired }),
        ).rejects.toBeInstanceOf(ToolGatewayInputValidationError);
      }
      await expect(
        gateway.callModel({
          ...request,
          arguments: { ...args, runMode: "reusable_session" },
        }),
      ).rejects.toThrow();
      expect(executions).toBe(beforeInvalid);
    });
  });

  test("sessionless MCP requires a destination or explicit separate-agent intent before execution", async () => {
    const server = new McpServer({ name: "sessionless-schedules", version: "1" });
    const accepted: ReturnType<typeof resolveScheduledTaskCreateInput>[] = [];
    server.registerTool(
      "scheduled_tasks_create",
      {
        inputSchema: contractToolInput(
          scheduledTaskCreateToolInput(),
          scheduledTaskCreateToolValidation(null),
        ),
      },
      async (args) => {
        accepted.push(resolveScheduledTaskCreateInput(args, null));
        return { content: [{ type: "text", text: "accepted" }] };
      },
    );
    const base = { name: "Activity monitor", schedule: { type: "interval", everySeconds: 7200 } };
    const targetSessionId = "44444444-4444-4444-8444-444444444444";
    await withServer(server, async (client) => {
      for (const args of [
        { ...base, agentConfig: { prompt: "Report activity" } },
        { ...base, prompt: "Report activity" },
      ]) {
        const result = await client.callTool({ name: "scheduled_tasks_create", arguments: args });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Choose an existing chat");
      }
      for (const args of [
        { ...base, runMode: "existing_session", prompt: "Report activity" },
        { ...base, runMode: "reusable_session", prompt: "Report activity" },
        {
          ...base,
          runMode: "new_session_per_run",
          targetSessionId,
          agentConfig: { prompt: "Report activity" },
        },
      ]) {
        const result = await client.callTool({ name: "scheduled_tasks_create", arguments: args });
        expect(result.isError).toBe(true);
      }
      expect(accepted).toHaveLength(0);

      const message = await client.callTool({
        name: "scheduled_tasks_create",
        arguments: { ...base, targetSessionId, prompt: "Report activity" },
      });
      expect(message.isError).not.toBe(true);
      expect(accepted.at(-1)).toMatchObject({ runMode: "existing_session", targetSessionId });
      for (const runMode of ["reusable_session", "new_session_per_run"] as const) {
        const result = await client.callTool({
          name: "scheduled_tasks_create",
          arguments: { ...base, runMode, agentConfig: { prompt: "Report activity" } },
        });
        expect(result.isError).not.toBe(true);
        expect(accepted.at(-1)?.runMode).toBe(runMode);
        expect(accepted.at(-1)?.targetSessionId).toBeUndefined();
      }
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
