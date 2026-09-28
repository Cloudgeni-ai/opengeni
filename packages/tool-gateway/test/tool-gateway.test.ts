import { describe, expect, test } from "bun:test";
import {
  TOOL_GATEWAY_INPUT_DIAGNOSTIC_MAX_CHARS,
  TOOL_GATEWAY_INPUT_ISSUES_MAX,
  ToolGatewayApprovalRequiredError,
  ToolGatewayCatalogIntegrityError,
  ToolGatewayInputValidationError,
  ToolGatewayPathCollisionError,
  createWorkspaceToolGateway,
  parseVerifiedToolGatewayCatalog,
  type ToolGatewayDefinition,
} from "../src";

const definition: ToolGatewayDefinition = {
  identity: { serverId: "docs", toolName: "search" },
  modelName: "docs__search",
  description: "Search docs",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  source: "docs",
  approval: "none",
  execute: async (argumentsValue, context) => ({
    content: [{ type: "text", text: `${context.caller.kind}:${String(argumentsValue.query)}` }],
    structuredContent: { ok: true },
  }),
};

describe("ToolGateway", () => {
  test("executes HTTP, MCP, browser, model, and Codemode callers through one core", async () => {
    const { catalog, gateway } = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      definitions: [definition],
    });
    for (const kind of ["http", "mcp", "browser", "codemode"] as const) {
      const result = await gateway.call({
        operationId: crypto.randomUUID(),
        catalogDigest: catalog.digest,
        identity: definition.identity,
        arguments: { query: kind },
        caller: { kind, subjectId: "human:test" },
      });
      expect(result.content[0]).toEqual({ type: "text", text: `${kind}:${kind}` });
    }
    const model = await gateway.callModel({
      modelName: definition.modelName,
      arguments: { query: "model" },
      subjectId: "agent:test",
    });
    expect(model.content[0]).toEqual({ type: "text", text: "model:model" });
  });

  test("validates arguments and supports adapter-owned approval decisions", async () => {
    const { catalog, gateway } = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      definitions: [{ ...definition, approval: "human" }],
      requireApproval: (entry, caller, context) =>
        entry.approval === "human" &&
        caller.kind !== "model" &&
        context.transportMeta?.approvalConfirmed !== true,
    });
    await expect(
      gateway.call({
        operationId: crypto.randomUUID(),
        catalogDigest: catalog.digest,
        identity: definition.identity,
        arguments: { query: 1 },
        caller: { kind: "model", subjectId: "agent:test" },
      }),
    ).rejects.toBeInstanceOf(ToolGatewayInputValidationError);
    await expect(
      gateway.callModel({
        modelName: definition.modelName,
        arguments: { query: "model-bypass" },
        subjectId: "agent:test",
      }),
    ).rejects.toBeInstanceOf(ToolGatewayApprovalRequiredError);
    await expect(
      gateway.call({
        operationId: crypto.randomUUID(),
        catalogDigest: catalog.digest,
        identity: definition.identity,
        arguments: { query: "blocked" },
        caller: { kind: "browser", subjectId: "human:test" },
      }),
    ).rejects.toBeInstanceOf(ToolGatewayApprovalRequiredError);
    await expect(
      gateway.call(
        {
          operationId: crypto.randomUUID(),
          catalogDigest: catalog.digest,
          identity: definition.identity,
          arguments: { query: "approved" },
          caller: { kind: "browser", subjectId: "human:test" },
        },
        { transportMeta: { approvalConfirmed: true } },
      ),
    ).resolves.toMatchObject({ structuredContent: { ok: true } });
  });

  test("owns prepare, execution-boundary begin, and terminal lifecycle settlement", async () => {
    const phases: string[] = [];
    const { catalog, gateway } = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      definitions: [
        {
          ...definition,
          lifecycle: {
            prepare: ({ call }) => {
              phases.push(`prepare:${String(call.arguments.query)}`);
              return {
                begin: () => {
                  phases.push("begin");
                },
                complete: ({ outcome }) => {
                  phases.push(`complete:${outcome}`);
                },
              };
            },
          },
          execute: async (argumentsValue, context) => {
            phases.push("execute");
            return await definition.execute(argumentsValue, context);
          },
        },
      ],
    });
    expect(catalog.entries[0]).not.toHaveProperty("lifecycle");
    const prepared = await gateway.prepareCall({
      operationId: crypto.randomUUID(),
      catalogDigest: catalog.digest,
      identity: definition.identity,
      arguments: { query: "ordered" },
      caller: { kind: "codemode", subjectId: "agent:test" },
    });
    expect(phases).toEqual(["prepare:ordered"]);
    await expect(prepared.execute()).resolves.toMatchObject({ structuredContent: { ok: true } });
    expect(phases).toEqual(["prepare:ordered", "begin", "execute", "complete:completed"]);
  });

  test("keeps approval authority private while binding prepared calls to its exact revision", async () => {
    const firstAuthority = "a".repeat(64);
    const secondAuthority = "b".repeat(64);
    const first = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      createdAt: new Date("2026-09-03T00:00:00.000Z"),
      definitions: [{ ...definition, approval: "human", approvalAuthorityDigest: firstAuthority }],
    });
    const second = createWorkspaceToolGateway({
      accountId: first.catalog.accountId,
      workspaceId: first.catalog.workspaceId,
      generation: first.catalog.generation,
      createdAt: new Date(first.catalog.createdAt),
      definitions: [{ ...definition, approval: "human", approvalAuthorityDigest: secondAuthority }],
    });
    expect(first.catalog.digest).toBe(second.catalog.digest);
    expect(first.catalog.entries[0]).not.toHaveProperty("approvalAuthorityDigest");
    const call = {
      operationId: crypto.randomUUID(),
      catalogDigest: first.catalog.digest,
      identity: definition.identity,
      arguments: { query: "authority" },
      caller: { kind: "http" as const, subjectId: "human:test" },
    };
    expect((await first.gateway.prepareCall(call)).approvalAuthorityDigest).toBe(firstAuthority);
    expect((await second.gateway.prepareCall(call)).approvalAuthorityDigest).toBe(secondAuthority);
  });

  test("fails lifecycle preparation before begin or executor dispatch", async () => {
    const phases: string[] = [];
    const { catalog, gateway } = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      definitions: [
        {
          ...definition,
          lifecycle: {
            prepare: () => {
              phases.push("prepare");
              throw new Error("policy unavailable");
            },
          },
          execute: async () => {
            phases.push("execute");
            return { content: [{ type: "text", text: "unreachable" }] };
          },
        },
      ],
    });
    await expect(
      gateway.prepareCall({
        operationId: crypto.randomUUID(),
        catalogDigest: catalog.digest,
        identity: definition.identity,
        arguments: { query: "blocked" },
        caller: { kind: "codemode", subjectId: "agent:test" },
      }),
    ).rejects.toThrow("policy unavailable");
    expect(phases).toEqual(["prepare"]);
  });

  test("verifies catalog integrity independently of creation time", () => {
    const first = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      definitions: [definition],
    }).catalog;
    const later = createWorkspaceToolGateway({
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      generation: 1,
      createdAt: new Date("2026-09-02T01:00:00.000Z"),
      definitions: [definition],
    }).catalog;
    expect(first.digest).toBe(later.digest);
    expect(() =>
      parseVerifiedToolGatewayCatalog({
        ...first,
        entries: [{ ...first.entries[0], description: "tampered" }],
      }),
    ).toThrow(ToolGatewayCatalogIntegrityError);
  });

  test("rejects namespace paths that use a tool leaf as a prefix", () => {
    expect(() =>
      createWorkspaceToolGateway({
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        generation: 1,
        definitions: [
          { ...definition, codemodePath: ["docs", "search"] },
          {
            ...definition,
            identity: { serverId: "docs", toolName: "search_advanced" },
            modelName: "docs__search_advanced",
            codemodePath: ["docs", "search", "advanced"],
          },
        ],
      }),
    ).toThrow(ToolGatewayPathCollisionError);
  });
});

describe("ToolGateway argument validation errors", () => {
  // A hosted analytics MCP advertises `context` and `llm_model` as required on
  // `exec` but does not enforce them, so models regularly omit them.
  const execSchema = {
    type: "object",
    properties: {
      command: { type: "string", description: "CLI-style command to run." },
      context: { type: "string", description: "Why the command is being run." },
      llm_model: { type: "string", description: "Model issuing the call." },
    },
    required: ["command", "context", "llm_model"],
  };

  function gatewayFor(inputSchema: ToolGatewayDefinition["inputSchema"]) {
    const executed: Record<string, unknown>[] = [];
    const { gateway } = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      definitions: [
        {
          identity: { serverId: "analytics", toolName: "exec" },
          modelName: "analytics__exec",
          inputSchema,
          source: "mcp",
          approval: "none",
          execute: async (argumentsValue) => {
            executed.push(argumentsValue);
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
      ],
    });
    const callModel = (argumentsValue: Record<string, unknown>) =>
      gateway.callModel({
        modelName: "analytics__exec",
        arguments: argumentsValue,
        subjectId: "agent:test",
      });
    return { callModel, executed };
  }

  async function rejection(promise: Promise<unknown>): Promise<ToolGatewayInputValidationError> {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ToolGatewayInputValidationError);
    return error as ToolGatewayInputValidationError;
  }

  test("names every missing required property and executes the corrected call", async () => {
    const { callModel, executed } = gatewayFor(execSchema);
    const error = await rejection(callModel({ command: "search project-get" }));
    expect(error.code).toBe("invalid_tool_arguments");
    expect(error.issues).toEqual([
      { path: "context", keyword: "required", message: 'missing required property "context"' },
      {
        path: "llm_model",
        keyword: "required",
        message: 'missing required property "llm_model"',
      },
    ]);
    expect(error.omittedIssueCount).toBe(0);
    expect(error.message).toBe(
      'Tool arguments do not match the tool\'s input schema: missing required property "context"; missing required property "llm_model"',
    );
    expect(error.message).not.toContain("search project-get");
    expect(executed).toEqual([]);

    const corrected = {
      command: "search project-get",
      context: "Find the project id",
      llm_model: "scripted",
    };
    await expect(callModel(corrected)).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    expect(executed).toEqual([corrected]);
  });

  test("names mistyped, unexpected, and nested properties without echoing values", async () => {
    const { callModel, executed } = gatewayFor({
      type: "object",
      properties: {
        command: { type: "string" },
        limit: { type: "integer" },
        mode: { enum: ["fast", "exact"] },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: { field: { type: "string" } },
            required: ["field"],
          },
        },
      },
      required: ["command"],
      additionalProperties: false,
    });
    const error = await rejection(
      callModel({
        command: 42,
        limit: "synthetic-limit-value",
        mode: "synthetic-mode-value",
        filters: [{ value: "synthetic-filter-value" }],
        extra: "synthetic-extra-value",
      }),
    );
    expect(error.issues.map((issue) => issue.message)).toEqual([
      'property "extra" is not allowed',
      '"command" must be string',
      '"limit" must be integer',
      '"mode" must be one of "fast", "exact"',
      'missing required property "filters[0].field"',
    ]);
    expect(error.message).not.toContain("synthetic-");
    expect(error.message).not.toContain("42");
    expect(executed).toEqual([]);
  });

  test("names the object, not the key, when a property name is not allowed", async () => {
    const { callModel } = gatewayFor({
      type: "object",
      properties: { labels: { type: "object", propertyNames: { pattern: "^[a-z]+$" } } },
    });
    const error = await rejection(callModel({ labels: { "Synthetic-Key-Name": "x" } }));
    expect(error.summary).toBe('"labels" has a property name the schema does not allow');
    expect(error.message).not.toContain("Synthetic-Key-Name");
  });

  test("caps the reported problems and counts the rest", async () => {
    const names = Array.from({ length: TOOL_GATEWAY_INPUT_ISSUES_MAX + 4 }, (_, i) => `p${i}`);
    const { callModel } = gatewayFor({
      type: "object",
      properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
      required: names,
    });
    const error = await rejection(callModel({}));
    expect(error.issues).toHaveLength(TOOL_GATEWAY_INPUT_ISSUES_MAX);
    expect(error.omittedIssueCount).toBe(4);
    expect(error.message.endsWith("; and 4 more problems")).toBe(true);
  });

  test("reports only the first problem for arguments above the diagnostic budget", async () => {
    const { callModel } = gatewayFor({
      ...execSchema,
      properties: { ...execSchema.properties, query: { type: "string" } },
    });
    const error = await rejection(
      callModel({
        command: "run",
        query: "q".repeat(TOOL_GATEWAY_INPUT_DIAGNOSTIC_MAX_CHARS),
      }),
    );
    expect(error.issues).toEqual([
      { path: "context", keyword: "required", message: 'missing required property "context"' },
    ]);
  });
});
