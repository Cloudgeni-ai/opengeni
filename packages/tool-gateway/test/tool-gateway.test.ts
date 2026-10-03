import { describe, expect, spyOn, test } from "bun:test";
import { createObservability, withMcpTelemetry, withTraceContext } from "@opengeni/observability";
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
  test("prepared gateway timing retains call context after preparation and never replays a rejection", async () => {
    const bodies: any[] = [];
    const observer = createObservability(
      {
        serviceName: "test",
        environment: "test",
        observabilityStructuredLogs: true,
        observabilityMetricsEnabled: false,
        observabilityOtlpHeaders: "",
        observabilityOtlpEndpoint: "http://collector",
      },
      {
        component: "worker",
        exporter: async (_url, body) => {
          bodies.push(body);
        },
      },
    );
    const root = observer.startSpan("attempt");
    let executions = 0;
    let completions = 0;
    const { catalog, gateway } = createWorkspaceToolGateway({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      definitions: [
        {
          ...definition,
          execute: async () => {
            executions++;
            return { isError: true, content: [{ type: "text", text: "SECRET_PROVIDER_RESULT" }] };
          },
          lifecycle: {
            prepare: async () => ({
              complete: async () => {
                completions++;
              },
            }),
          },
        },
      ],
    });
    const prepared = await withMcpTelemetry(observer, "attempt", () =>
      withTraceContext(root, () =>
        gateway.prepareCall({
          operationId: crypto.randomUUID(),
          catalogDigest: catalog.digest,
          identity: definition.identity,
          arguments: { query: "SECRET_ARGUMENT" },
          caller: { kind: "codemode", subjectId: "human:test" },
        }),
      ),
    );
    expect((await prepared.execute()).isError).toBe(true);
    root.end();
    await observer.flush();
    const spans = bodies.flatMap((b) => b.resourceSpans.flatMap((r: any) => r.scopeSpans[0].spans));
    const attributes = (s: any) =>
      Object.fromEntries(s.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
    const execution = spans.find((s) => s.name === "mcp.phase.execution");
    const preparation = spans.find((s) => s.name === "mcp.phase.gateway_policy");
    expect(execution.parentSpanId).toBe(root.spanId);
    expect(attributes(execution).mcpCallKey).toBe(attributes(preparation).mcpCallKey);
    expect(attributes(execution).outcome).toBe("rejected");
    expect(JSON.stringify(spans)).not.toContain("SECRET");
    expect(executions).toBe(1);
    expect(completions).toBe(1);
  });
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

  const scheduleSchema = {
    type: "object",
    properties: {
      schedule: {
        anyOf: [
          { type: "object", properties: { type: { const: "manual" } }, required: ["type"] },
          {
            type: "object",
            properties: { type: { const: "once" }, at: { type: "string" } },
            required: ["type", "at"],
          },
          {
            type: "object",
            properties: {
              type: { const: "interval" },
              everySeconds: { type: "number", minimum: 1 },
            },
            required: ["type", "everySeconds"],
          },
        ],
      },
      name: { type: "string" },
    },
    required: ["schedule", "name"],
  };

  test("reports only the selected union branch and keeps independent errors", async () => {
    const { callModel, executed } = gatewayFor(scheduleSchema);
    const error = await rejection(callModel({ schedule: { type: "interval" } }));
    expect(error.issues.map((issue) => issue.message)).toEqual([
      'missing required property "name"',
      'missing required property "schedule.everySeconds"',
    ]);
    expect(error.summary).not.toContain("once");
    expect(error.summary).not.toContain('"schedule.at"');
    expect(executed).toEqual([]);
    const corrected = { name: "test", schedule: { type: "interval", everySeconds: 7200 } };
    await expect(callModel(corrected)).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    expect(executed).toEqual([corrected]);
  });

  test("unknown and missing discriminators name the possible formats without unrelated requirements", async () => {
    const { callModel } = gatewayFor(scheduleSchema);
    const unknown = await rejection(
      callModel({ name: "test", schedule: { type: "synthetic-unknown-tag" } }),
    );
    expect(unknown.summary).toBe('"schedule.type" must be one of "manual", "once", "interval"');
    expect(unknown.summary).not.toContain("synthetic");
    const missing = await rejection(callModel({ name: "test", schedule: {} }));
    expect(missing.summary).toBe(
      'missing required property "schedule.type" (selects one of "manual", "once", "interval")',
    );
    expect(missing.summary).not.toContain("everySeconds");
    expect(missing.summary).not.toContain("schedule.at");
  });

  test("ambiguous formats report alternative requirements instead of adding them together", async () => {
    const { callModel } = gatewayFor({
      anyOf: [
        { type: "object", properties: { foo: { type: "string" } }, required: ["foo"] },
        {
          type: "object",
          properties: { bar: { type: "string" }, baz: { type: "string" } },
          required: ["bar", "baz"],
        },
      ],
    });
    const error = await rejection(callModel({}));
    expect(error.issues).toHaveLength(1);
    expect(error.summary).toBe(
      'arguments must match one declared input format: alternative 1 (missing required property "foo") or alternative 2 (missing required property "bar"; missing required property "baz")',
    );
  });

  test("discriminator selection follows references and conjunctions in nested array unions", async () => {
    const { callModel } = gatewayFor({
      $defs: {
        local: {
          allOf: [
            {
              type: "object",
              properties: { kind: { enum: ["file", "folder"] } },
              required: ["kind"],
            },
            { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          ],
        },
        remote: {
          type: "object",
          properties: { kind: { const: "url" }, url: { type: "string" } },
          required: ["kind", "url"],
        },
      },
      type: "object",
      properties: {
        resources: {
          type: "array",
          items: { oneOf: [{ $ref: "#/$defs/local" }, { $ref: "#/$defs/remote" }] },
        },
      },
    });
    const error = await rejection(callModel({ resources: [{ kind: "url" }, { kind: "file" }] }));
    expect(error.issues.map((issue) => issue.message)).toEqual([
      'missing required property "resources[0].url"',
      'missing required property "resources[1].path"',
    ]);
    const unknown = await rejection(callModel({ resources: [{ kind: "bad" }] }));
    expect(unknown.summary).toBe('"resources[0].kind" must be one of "file", "folder", "url"');
  });

  test("shared tags never choose the branch with fewer errors", async () => {
    const { callModel } = gatewayFor({
      anyOf: [
        {
          type: "object",
          properties: { kind: { const: "shared" }, foo: { type: "string" } },
          required: ["kind", "foo"],
        },
        {
          type: "object",
          properties: {
            kind: { const: "shared" },
            bar: { type: "string" },
            baz: { type: "string" },
          },
          required: ["kind", "bar", "baz"],
        },
      ],
    });
    const error = await rejection(callModel({ kind: "shared" }));
    expect(error.summary).toContain(
      'alternative 1 (missing required property "foo") or alternative 2',
    );
    expect(error.summary).toContain(
      'missing required property "bar"; missing required property "baz"',
    );
  });

  test("optional absent tags do not invent a missing discriminator requirement", async () => {
    const { callModel } = gatewayFor({
      anyOf: [
        {
          type: "object",
          properties: { kind: { const: "one" }, foo: { type: "string" } },
          required: ["foo"],
        },
        {
          type: "object",
          properties: { kind: { const: "two" }, bar: { type: "string" } },
          required: ["bar"],
        },
      ],
    });
    const error = await rejection(callModel({}));
    expect(error.summary).toBe(
      'arguments must match one declared input format: alternative 1 (missing required property "foo") or alternative 2 (missing required property "bar")',
    );
    expect(error.summary).not.toContain('property "kind"');
  });

  test("ambiguous outer formats preserve a nested union's selected branch", async () => {
    const { callModel } = gatewayFor({
      anyOf: [
        {
          type: "object",
          properties: { schedule: scheduleSchema.properties.schedule },
          required: ["schedule"],
        },
        { type: "object", properties: { other: { type: "string" } }, required: ["other"] },
      ],
    });
    const error = await rejection(callModel({ schedule: { type: "interval" } }));
    expect(error.summary).toBe(
      'arguments must match one declared input format: alternative 1 (missing required property "schedule.everySeconds") or alternative 2 (missing required property "other")',
    );
    expect(error.summary).not.toContain("schedule.at");
    expect(error.summary).not.toContain("once");
  });

  test("a literal inside a nested alternative cannot exclude its containing branch", async () => {
    const { callModel } = gatewayFor({
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { anyOf: [{ const: "one" }, { const: "two" }] },
            foo: { type: "string" },
          },
          required: ["kind", "foo"],
        },
        {
          type: "object",
          properties: { kind: { const: "two" }, bar: { type: "string" } },
          required: ["kind", "bar"],
        },
      ],
    });
    const error = await rejection(callModel({ kind: "two" }));
    expect(error.summary).toBe(
      'arguments must match one declared input format: alternative 1 (missing required property "foo") or alternative 2 (missing required property "bar")',
    );
  });

  test("reference siblings constrain tags across supported catalog dialects", async () => {
    const schema = {
      $defs: { tag: { enum: ["one", "two"] } },
      anyOf: [
        {
          type: "object",
          properties: { kind: { $ref: "#/$defs/tag", const: "one" }, foo: { type: "string" } },
          required: ["kind", "foo"],
        },
        {
          type: "object",
          properties: { kind: { $ref: "#/$defs/tag", const: "two" }, bar: { type: "string" } },
          required: ["kind", "bar"],
        },
      ],
    };
    const old = await rejection(gatewayFor(schema).callModel({ kind: "two" }));
    expect(old.summary).toBe('missing required property "bar"');
    const current = await rejection(
      gatewayFor({ ...schema, $schema: "https://json-schema.org/draft/2020-12/schema" }).callModel({
        kind: "two",
      }),
    );
    expect(current.summary).toBe('missing required property "bar"');
  });

  test("a false schema alternative contributes no irrelevant argument problems", async () => {
    const { callModel } = gatewayFor({
      anyOf: [
        false,
        { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      ],
    });
    const error = await rejection(callModel({}));
    expect(error.summary).toBe('missing required property "name"');
  });

  test("errors outside a union remain independent when they use the same referenced schema", async () => {
    const { callModel } = gatewayFor({
      $defs: {
        stamped: { type: "object", properties: { stamp: { type: "string" } }, required: ["stamp"] },
      },
      anyOf: [
        {
          allOf: [
            { $ref: "#/$defs/stamped" },
            { type: "object", properties: { kind: { const: "one" } }, required: ["kind"] },
          ],
        },
        {
          allOf: [
            { $ref: "#/$defs/stamped" },
            { type: "object", properties: { kind: { const: "two" } }, required: ["kind"] },
          ],
        },
      ],
      type: "object",
      properties: { metadata: { $ref: "#/$defs/stamped" } },
    });
    const error = await rejection(callModel({ kind: "unknown", metadata: {} }));
    expect(error.issues.map((issue) => issue.message)).toEqual([
      '"kind" must be one of "one", "two"',
      'missing required property "metadata.stamp"',
    ]);
  });

  test("array-item union diagnostics remain capped and count distinct omitted problems", async () => {
    const { callModel } = gatewayFor({
      type: "object",
      properties: { schedules: { type: "array", items: scheduleSchema.properties.schedule } },
    });
    const count = 1000;
    const error = await rejection(
      callModel({ schedules: Array.from({ length: count }, () => ({ type: "interval" })) }),
    );
    expect(error.issues).toHaveLength(TOOL_GATEWAY_INPUT_ISSUES_MAX);
    expect(error.issues[0]?.message).toBe('missing required property "schedules[0].everySeconds"');
    expect(error.omittedIssueCount).toBe(count - TOOL_GATEWAY_INPUT_ISSUES_MAX);
    expect(error.summary).not.toContain("must equal");
  });

  test("an independent reused reference remains required before or after a union at the same instance", async () => {
    const stamp = { $ref: "#/$defs/stamp" };
    const alternatives = {
      anyOf: [
        {
          allOf: [
            stamp,
            { type: "object", properties: { kind: { const: "one" } }, required: ["kind"] },
          ],
        },
        {
          allOf: [
            stamp,
            { type: "object", properties: { kind: { const: "two" } }, required: ["kind"] },
          ],
        },
      ],
    };
    for (const allOf of [
      [stamp, alternatives],
      [alternatives, stamp],
    ]) {
      const { callModel } = gatewayFor({
        $defs: {
          stamp: { type: "object", properties: { stamp: { type: "string" } }, required: ["stamp"] },
        },
        allOf,
      });
      const error = await rejection(callModel({ kind: "unknown" }));
      expect(error.issues.map((issue) => issue.message).sort()).toEqual([
        '"kind" must be one of "one", "two"',
        'missing required property "stamp"',
      ]);
    }
  });

  test("anchored and embedded-id alternatives retain only the applicable requirements", async () => {
    for (const reference of [
      "#Schedule",
      "https://schemas.example.test/schedule",
      "https://schemas.example.test/schedule#Schedule",
    ]) {
      const { callModel } = gatewayFor({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          schedule: {
            ...(reference === "#Schedule" ? {} : { $id: "https://schemas.example.test/schedule" }),
            $anchor: "Schedule",
            type: "object",
            anyOf: [
              {
                type: "object",
                properties: { kind: { const: "one" }, foo: { type: "string" } },
                required: ["kind", "foo"],
              },
              {
                type: "object",
                properties: { kind: { const: "two" }, bar: { type: "string" } },
                required: ["kind", "bar"],
              },
            ],
          },
        },
        type: "object",
        properties: { schedule: { $ref: reference } },
      });
      const error = await rejection(callModel({ schedule: { kind: "two" } }));
      expect(error.summary).toBe('missing required property "schedule.bar"');
      const unknown = await rejection(callModel({ schedule: { kind: "unknown" } }));
      expect(unknown.summary).toBe('"schedule.kind" must be one of "one", "two"');
    }
  });

  test("pattern and additional-property references remain independent of a later union", async () => {
    const stamp = { $ref: "#/$defs/stamp" };
    const alternatives = {
      anyOf: [
        {
          allOf: [
            stamp,
            { type: "object", properties: { kind: { const: "one" } }, required: ["kind"] },
          ],
        },
        {
          allOf: [
            stamp,
            { type: "object", properties: { kind: { const: "two" } }, required: ["kind"] },
          ],
        },
      ],
    };
    for (const first of [
      { type: "object", patternProperties: { "^metadata$": stamp } },
      { type: "object", additionalProperties: stamp },
    ]) {
      const { callModel } = gatewayFor({
        $defs: {
          stamp: { type: "object", properties: { stamp: { type: "string" } }, required: ["stamp"] },
        },
        allOf: [first, { type: "object", properties: { metadata: alternatives } }],
      });
      const error = await rejection(callModel({ metadata: { kind: "unknown" } }));
      expect(error.issues.map((issue) => issue.message).sort()).toEqual([
        '"metadata.kind" must be one of "one", "two"',
        'missing required property "metadata.stamp"',
      ]);
    }
  });

  test("embedded resources resolve fragment references against their own definitions", async () => {
    const { callModel } = gatewayFor({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        one: { const: "one" },
        two: { const: "two" },
        schedule: {
          $id: "https://schemas.example.test/scoped-schedule",
          $defs: { one: { const: "two" }, two: { const: "one" } },
          type: "object",
          anyOf: [
            {
              properties: { kind: { $ref: "#/$defs/one" }, foo: { type: "string" } },
              required: ["kind", "foo"],
            },
            {
              properties: { kind: { $ref: "#/$defs/two" }, bar: { type: "string" } },
              required: ["kind", "bar"],
            },
          ],
        },
      },
      type: "object",
      properties: { schedule: { $ref: "https://schemas.example.test/scoped-schedule" } },
    });
    const error = await rejection(callModel({ schedule: { kind: "two" } }));
    expect(error.summary).toBe('missing required property "schedule.foo"');
    const other = await rejection(callModel({ schedule: { kind: "one" } }));
    expect(other.summary).toBe('missing required property "schedule.bar"');
  });

  test("unproven reference ownership preserves explicit constraint evidence", async () => {
    const stamp = { $ref: "#/$defs/stamp" };
    const alternatives = {
      anyOf: [
        {
          allOf: [
            stamp,
            { type: "object", properties: { kind: { const: "one" } }, required: ["kind"] },
          ],
        },
        {
          allOf: [
            stamp,
            { type: "object", properties: { kind: { const: "two" } }, required: ["kind"] },
          ],
        },
      ],
    };
    for (const object of [false, true]) {
      const schema = object
        ? {
            type: "object",
            allOf: [
              { type: "object", unevaluatedProperties: stamp },
              { type: "object", properties: { metadata: alternatives } },
            ],
          }
        : {
            type: "object",
            properties: {
              metadata: {
                type: "array",
                allOf: [
                  { type: "array", contains: stamp },
                  { type: "array", items: alternatives },
                ],
              },
            },
          };
      const { callModel } = gatewayFor({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          stamp: { type: "object", properties: { stamp: { type: "string" } }, required: ["stamp"] },
        },
        ...schema,
      });
      const error = await rejection(
        callModel({ metadata: object ? { kind: "unknown" } : [{ kind: "unknown" }] }),
      );
      const path = object ? "metadata.stamp" : "metadata[0].stamp";
      expect(error.issues.find((issue) => issue.path === path)?.message).toBe(
        `an independent constraint or alternative reports: missing required property "${path}"`,
      );
      expect(error.summary).toContain('must be one of "one", "two"');
    }
  });

  test("legacy dependency references retain their independent requirements", async () => {
    const stamp = { $ref: "#/$defs/stamp" };
    const { callModel } = gatewayFor({
      $defs: {
        stamp: { type: "object", properties: { stamp: { type: "string" } }, required: ["stamp"] },
      },
      type: "object",
      dependencies: { trigger: { type: "object", properties: { metadata: stamp } } },
      properties: {
        metadata: {
          anyOf: [
            { allOf: [stamp, { properties: { kind: { const: "one" } }, required: ["kind"] }] },
            { allOf: [stamp, { properties: { kind: { const: "two" } }, required: ["kind"] }] },
          ],
        },
      },
    });
    const error = await rejection(callModel({ trigger: true, metadata: { kind: "unknown" } }));
    expect(error.issues.map((issue) => issue.message).sort()).toEqual([
      '"metadata.kind" must be one of "one", "two"',
      'missing required property "metadata.stamp"',
    ]);
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

  test("oversized arguments never turn union alternatives into cumulative corrections", async () => {
    const { callModel } = gatewayFor({
      ...scheduleSchema,
      properties: { ...scheduleSchema.properties, prompt: { type: "string" } },
    });
    const error = await rejection(
      callModel({
        name: "test",
        schedule: { type: "interval" },
        prompt: "x".repeat(TOOL_GATEWAY_INPUT_DIAGNOSTIC_MAX_CHARS),
      }),
    );
    expect(error.summary).toBe('"schedule" must match one declared alternative input format');
    expect(error.summary).not.toContain('"schedule.at"');
    expect(error.summary).not.toContain("once");
    expect(error.issues).toHaveLength(1);
  });

  test("never runs a pattern on a string longer than the schema's maxLength", async () => {
    // Backtracking-heavy on a long non-matching string; `maxLength` is what
    // keeps the accept/reject validator from ever running it on one.
    const pattern = "^(\\w+\\s?)*$";
    const { callModel } = gatewayFor({
      type: "object",
      properties: {
        command: { type: "string" },
        tags: { type: "array", items: { type: "string", maxLength: 16, pattern } },
      },
      required: ["command", "context"],
    });
    const patternInputLengths: number[] = [];
    const originalTest = RegExp.prototype.test;
    const spy = spyOn(RegExp.prototype, "test").mockImplementation(function (
      this: RegExp,
      value: string,
    ) {
      if (this.source === pattern) patternInputLengths.push(String(value).length);
      return originalTest.call(this, value);
    });
    let error: ToolGatewayInputValidationError;
    try {
      error = await rejection(
        callModel({ command: "run", tags: ["short tag", `${"a".repeat(40)}!`, "bad!"] }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(error.issues.map((issue) => issue.message)).toEqual([
      'missing required property "context"',
      '"tags[1]" must NOT have more than 16 characters',
      '"tags[2]" must match pattern "^(\\w+\\s?)*$"',
    ]);
    expect(patternInputLengths.length).toBeGreaterThan(0);
    expect(patternInputLengths.every((length) => length <= 16)).toBe(true);
  });
});
