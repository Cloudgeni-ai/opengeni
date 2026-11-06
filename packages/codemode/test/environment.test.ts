import { describe, expect, spyOn, test } from "bun:test";
import { ATTEMPT_TOOL_CATALOG_VERSION, AttemptToolCatalog } from "@opengeni/contracts";
import { prepareToolGatewayDefinitions } from "@opengeni/tool-gateway";
import type { AttemptToolDefinition, CodemodeClient, CodemodeToolFunction } from "../src";
import {
  AttemptToolApprovalRequiredError,
  AttemptToolCatalogIntegrityError,
  AttemptToolCatalogStaleError,
  AttemptToolInputValidationError,
  AttemptToolOutputValidationError,
  compileCodemodeTools,
  createAttemptToolEnvironment,
  digestAttemptToolCatalog,
  parseVerifiedAttemptToolCatalog,
  verifyAttemptToolCatalog,
} from "../src";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

function definition(
  serverId: string,
  toolName: string,
  execute: AttemptToolDefinition["execute"] = async (args) => ({
    content: [{ type: "text", text: JSON.stringify(args) }],
  }),
): AttemptToolDefinition {
  return {
    identity: { serverId, toolName },
    modelName: `${serverId}__${toolName}`,
    description: `Run ${toolName}`,
    inputSchema: { type: "object", additionalProperties: true },
    source: "mcp",
    approval: "none",
    execute,
  };
}

describe("AttemptToolEnvironment", () => {
  test("more tools than the catalog holds are left out and reported, not fatal", () => {
    // Before: AttemptToolCatalog.parse rejected all 4,097 entries and the turn failed.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reported: string[] = [];
      const definitions = Array.from({ length: 4_097 }, (_, index) =>
        definition("big", `tool_${index}`),
      );
      const { catalog } = createAttemptToolEnvironment({
        scope,
        generation: 1,
        definitions,
        onWarnings: (warnings) => reported.push(...warnings.map((warning) => warning.code)),
      });
      expect(catalog.entries).toHaveLength(4_096);
      expect(reported).toEqual(["catalog_entry_limit"]);
      expect(warn.mock.calls[0]![1]).toMatchObject({ event: "tool_catalog_degraded", count: 1 });
    } finally {
      warn.mockRestore();
    }
  });

  test("internal construction never re-signs a digest smuggled through scope", () => {
    const suppliedScope = { ...scope, digest: "a".repeat(64) };
    expect(() =>
      createAttemptToolEnvironment({
        scope: suppliedScope,
        generation: 1,
        definitions: [definition("docs", "search")],
      }),
    ).toThrow(AttemptToolCatalogIntegrityError);
  });

  test("does not partially freeze or memoize a catalog with mutable non-JSON annotations", () => {
    const { catalog } = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        {
          ...definition("docs", "search"),
          annotations: { observedAt: new Date("2026-08-09T12:00:00.000Z") },
        },
      ],
    });
    expect(Object.isFrozen(catalog)).toBe(false);
    expect(Object.isFrozen(catalog.entries[0]!.inputSchema)).toBe(false);
    expect(parseVerifiedAttemptToolCatalog(catalog)).not.toBe(catalog);
  });

  test("immutable snapshots preserve the prior catalog bytes and digest", () => {
    const definitions = [definition("docs", "search"), definition("docs", "fetch")];
    const createdAt = new Date("2026-08-09T12:00:00.000Z");
    const unsigned = {
      version: ATTEMPT_TOOL_CATALOG_VERSION,
      ...scope,
      generation: 1,
      createdAt: createdAt.toISOString(),
      entries: [
        ...prepareToolGatewayDefinitions(
          definitions.map((entry) => ({
            ...entry,
            execute: async () => ({ content: [] }),
          })),
        ).entries,
      ],
    };
    const previous = AttemptToolCatalog.parse({
      ...unsigned,
      digest: digestAttemptToolCatalog(unsigned),
    });
    const current = createAttemptToolEnvironment({ scope, generation: 1, createdAt, definitions });
    expect(JSON.stringify(current.catalog)).toBe(JSON.stringify(previous));
  });

  test("single-hash construction preserves ordered catalog bytes for varied metadata", () => {
    for (let i = 0; i < 20; i++) {
      const definitions: AttemptToolDefinition[] = ["zeta", "alpha", "middle"].map((name) => ({
        ...definition("docs", name),
        title: `Title ${i} — ${name}`,
        inputSchema: {
          type: "object",
          properties: {
            "10": { const: i },
            "2": { enum: [null, true, "text"] },
            z: { type: "array", items: { type: "string" } },
          },
          required: ["z", "2"],
          additionalProperties: false,
        },
        outputSchema: { type: "object", properties: { value: { const: -0 } } },
        annotations: { readOnlyHint: true, custom: { b: [i, null], a: "value" } },
        icons: [{ src: "https://example.test/icon.svg", sizes: ["16x16", "32x32"] }],
      }));
      const createdAt = new Date("2026-08-09T12:00:00.000Z");
      const unsigned = {
        version: ATTEMPT_TOOL_CATALOG_VERSION,
        ...scope,
        generation: i + 1,
        createdAt: createdAt.toISOString(),
        firstPartyMcpPermissions: [] as [],
        entries: [
          ...prepareToolGatewayDefinitions(
            definitions.map((entry) => ({
              ...entry,
              execute: async () => ({ content: [] }),
            })),
          ).entries,
        ],
      };
      const previous = parseVerifiedAttemptToolCatalog({
        ...unsigned,
        digest: digestAttemptToolCatalog(unsigned),
      });
      const current = createAttemptToolEnvironment({
        scope,
        generation: i + 1,
        createdAt,
        firstPartyMcpPermissions: [],
        definitions,
      }).catalog;
      expect(JSON.stringify(current)).toBe(JSON.stringify(previous));
      expect(parseVerifiedAttemptToolCatalog(structuredClone(current))).toEqual(previous);
    }
  });

  test("reuses only the exact immutable catalog snapshot and detaches caller schemas", () => {
    const schema = { type: "object", properties: { query: { type: "string" } } };
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [{ ...definition("docs", "search"), inputSchema: schema }],
    });
    const { catalog } = environment;
    expect(parseVerifiedAttemptToolCatalog(catalog)).toBe(catalog);
    const receipt = verifyAttemptToolCatalog(catalog);
    receipt.byteLength = 0;
    receipt.catalog = { ...catalog, digest: "f".repeat(64) };
    expect(verifyAttemptToolCatalog(catalog).catalog).toBe(catalog);
    expect(verifyAttemptToolCatalog(catalog).byteLength).toBe(
      new TextEncoder().encode(JSON.stringify(catalog)).byteLength,
    );
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.entries)).toBe(true);
    expect(Object.isFrozen(catalog.entries[0]!.inputSchema.properties)).toBe(true);
    expect(() => {
      catalog.entries[0]!.description = "changed";
    }).toThrow();
    schema.properties.query.type = "number";
    expect(catalog.entries[0]!.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
    });
    const copy = structuredClone(catalog);
    expect(parseVerifiedAttemptToolCatalog(copy)).toEqual(catalog);
    expect(parseVerifiedAttemptToolCatalog(copy)).not.toBe(copy);
    copy.entries[0]!.description = "tampered";
    Object.freeze(copy);
    expect(() => parseVerifiedAttemptToolCatalog(copy)).toThrow(AttemptToolCatalogIntegrityError);
  });

  test("binds a deterministic digest to exact attempt scope and tool catalog", () => {
    const createdAt = new Date("2026-08-09T12:00:00.000Z");
    const first = createAttemptToolEnvironment({
      scope,
      generation: 1,
      createdAt,
      definitions: [definition("docs", "search")],
    });
    const identical = createAttemptToolEnvironment({
      scope,
      generation: 1,
      createdAt,
      definitions: [definition("docs", "search")],
    });
    const changed = createAttemptToolEnvironment({
      scope,
      generation: 1,
      createdAt,
      definitions: [definition("docs", "fetch")],
    });
    expect(first.catalog.digest).toBe(identical.catalog.digest);
    expect(first.catalog.digest).not.toBe(changed.catalog.digest);
    const laterTimestamp = createAttemptToolEnvironment({
      scope,
      generation: 1,
      createdAt: new Date("2026-08-09T13:00:00.000Z"),
      definitions: [definition("docs", "search")],
    });
    expect(first.catalog.digest).toBe(laterTimestamp.catalog.digest);
    expect(() =>
      parseVerifiedAttemptToolCatalog({
        ...first.catalog,
        entries: [{ ...first.catalog.entries[0], description: "tampered" }],
      }),
    ).toThrow(AttemptToolCatalogIntegrityError);
  });

  test("creates safe stable Codemode paths without using them as authority", () => {
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      createdAt: new Date("2026-08-09T12:00:00.000Z"),
      definitions: [
        definition("foo-bar", "1-search"),
        {
          ...definition("foo_bar", "1_search"),
          modelName: "foo_bar__1_search",
        },
        definition("constructor", "__proto__"),
      ],
    });
    const paths = environment.catalog.entries.map((entry) => entry.codemodePath);
    expect(paths[0]![0]).toBe("foo_bar");
    expect(paths[0]![1]).toMatch(/^_1_search_[0-9a-f]{10}$/u);
    expect(paths[1]![1]).toMatch(/^_1_search_[0-9a-f]{10}$/u);
    expect(paths[0]).not.toEqual(paths[1]);
    expect(paths[2]![0]).toBe("_constructor");
    expect(paths[2]![1]).toMatch(/^___proto___[0-9a-f]{10}$/u);

    const isolated = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition("foo-bar", "1-search")],
    });
    expect(isolated.catalog.entries[0]?.codemodePath).toEqual(paths[0]);
  });

  test("re-paths a path-prefix collision instead of failing the canonical catalog", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const environment = createAttemptToolEnvironment({
        scope,
        generation: 1,
        definitions: [
          { ...definition("docs", "search"), codemodePath: ["docs", "search"] },
          {
            ...definition("docs", "search_advanced"),
            codemodePath: ["docs", "search", "advanced"],
          },
        ],
      });
      expect(environment.catalog.entries.map((entry) => entry.codemodePath)).toEqual([
        ["docs", "search"],
        ["docs", expect.stringMatching(/^search_advanced_[0-9a-f]{16}$/u)],
      ]);
      expect(warn.mock.calls[0]![1]).toMatchObject({
        event: "tool_catalog_degraded",
        sessionId: scope.sessionId,
        attemptId: scope.attemptId,
        warnings: [{ code: "path_disambiguated", toolName: "search_advanced" }],
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("an MCP server listing one tool twice still yields a usable attempt catalog", async () => {
    // Staging, November 4, 2026: the ElevenLabs hosted MCP repeated a tool in
    // tools/list and every turn with that account failed with
    // `Tool path account_0939….agents_bulk_delete_knowledge_base_e8b6a12b01 collides`.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const serverId = "account-0939a3b0e4a4afa388063b840830e169707a22f94853349c53a4e972948b5c52";
      const listed = {
        ...definition(serverId, "agents_bulk_delete_knowledge_base"),
        modelName: "mcp_4736c7ab5c4aacc3203e2998__agents_bulk_delete_knowledge_base",
        codemodePath: [serverId, "agents_bulk_delete_knowledge_base"],
      };
      const environment = createAttemptToolEnvironment({
        scope,
        generation: 1,
        definitions: [listed, { ...listed }, definition("docs", "search")],
      });
      expect(environment.catalog.entries.map((entry) => entry.codemodePath.join("."))).toEqual([
        "account_0939a3b0e4a4afa388063b840830e169707a22f94853349c53a4e972948b5c52.agents_bulk_delete_knowledge_base_e8b6a12b01",
        "docs.search",
      ]);
      const result = await environment.callModel({
        modelName: listed.modelName,
        arguments: { document_ids: ["a"] },
        subjectId: "agent:test",
      });
      expect(result.content).toEqual([{ type: "text", text: '{"document_ids":["a"]}' }]);
    } finally {
      warn.mockRestore();
    }
  });

  test("the Codemode namespace keeps the first tool when a signed catalog overlaps", () => {
    const entry = (toolName: string, codemodePath: string[]) => ({
      identity: { serverId: "docs", toolName },
      modelName: `docs__${toolName}`,
      codemodePath,
      inputSchema: { type: "object" },
      source: "mcp" as const,
      approval: "none" as const,
    });
    const signed = (entries: ReturnType<typeof entry>[]) => {
      const unsigned = {
        version: ATTEMPT_TOOL_CATALOG_VERSION,
        ...scope,
        generation: 1,
        createdAt: "2026-11-04T00:00:00.000Z",
        entries,
      };
      return { ...unsigned, digest: digestAttemptToolCatalog(unsigned) };
    };
    const client = {} as CodemodeClient;
    const leafFirst = compileCodemodeTools(
      signed([entry("search", ["docs", "search"]), entry("deep", ["docs", "search", "deep"])]),
      client,
    );
    expect(typeof leafFirst.docs!).toBe("object");
    const leaf = (leafFirst.docs as Record<string, CodemodeToolFunction>).search!;
    expect(typeof leaf).toBe("function");
    expect((leaf as unknown as { entry: { identity: unknown } }).entry.identity).toEqual({
      serverId: "docs",
      toolName: "search",
    });
    // A later leaf never replaces an existing namespace (or the tools inside it).
    const namespaceFirst = compileCodemodeTools(
      signed([entry("deep", ["docs", "search", "deep"]), entry("search", ["docs", "search"])]),
      client,
    );
    const namespace = (namespaceFirst.docs as Record<string, Record<string, unknown>>).search!;
    expect(typeof namespace).toBe("object");
    expect(typeof namespace.deep).toBe("function");
  });

  test("routes model and Codemode calls through one opaque executor", async () => {
    const calls: string[] = [];
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        definition("docs", "search", async (args, context) => {
          calls.push(`${context.caller.kind}:${String(args.query)}`);
          return {
            content: [{ type: "text", text: "done" }],
            structuredContent: { ok: true },
          };
        }),
      ],
    });
    const model = await environment.callModel({
      modelName: "docs__search",
      arguments: { query: "one" },
      subjectId: "agent:test",
    });
    const codemode = await environment.call({
      operationId: "66666666-6666-4666-8666-666666666666",
      catalogDigest: environment.catalog.digest,
      identity: { serverId: "docs", toolName: "search" },
      arguments: { query: "two" },
      caller: { kind: "codemode", subjectId: "agent:test" },
    });
    expect(model.structuredContent).toEqual({ ok: true });
    expect(codemode.structuredContent).toEqual({ ok: true });
    expect(calls).toEqual(["model:one", "codemode:two"]);
  });

  test("reuses structural validators without sharing attempt executors", async () => {
    const calls: string[] = [];
    const first = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        {
          ...definition("docs", "search", async () => {
            calls.push("first");
            return { content: [] };
          }),
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    });
    const second = createAttemptToolEnvironment({
      scope: {
        ...scope,
        attemptId: "77777777-7777-4777-8777-777777777777",
      },
      generation: 1,
      definitions: [
        {
          ...definition("docs", "search", async () => {
            calls.push("second");
            return { content: [] };
          }),
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    });

    await first.callModel({
      modelName: "docs__search",
      arguments: { query: "one" },
      subjectId: "agent:test",
    });
    await second.callModel({
      modelName: "docs__search",
      arguments: { query: "two" },
      subjectId: "agent:test",
    });
    await expect(
      second.callModel({
        modelName: "docs__search",
        arguments: { query: 2 },
        subjectId: "agent:test",
      }),
    ).rejects.toBeInstanceOf(AttemptToolInputValidationError);
    expect(calls).toEqual(["first", "second"]);
    expect(first.catalog.attemptId).not.toBe(second.catalog.attemptId);
  });

  test("rejects stale catalogs before execution", async () => {
    let executed = false;
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        definition("docs", "search", async () => {
          executed = true;
          return { content: [] };
        }),
      ],
    });
    await expect(
      environment.call({
        operationId: "66666666-6666-4666-8666-666666666666",
        catalogDigest: "f".repeat(64),
        identity: { serverId: "docs", toolName: "search" },
        arguments: {},
        caller: { kind: "codemode", subjectId: "agent:test" },
      }),
    ).rejects.toBeInstanceOf(AttemptToolCatalogStaleError);
    expect(executed).toBe(false);
  });

  test("requires exact host confirmation before a model can execute a human-approved tool", async () => {
    let executions = 0;
    let approvalConfirmed = false;
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      confirmModelApproval: ({ modelName, subjectId }) =>
        approvalConfirmed && modelName === "github__delete" && subjectId === "agent:test",
      definitions: [
        {
          ...definition("github", "delete", async () => {
            executions += 1;
            return { content: [] };
          }),
          approval: "human",
        },
      ],
    });
    await expect(
      environment.call({
        operationId: "66666666-6666-4666-8666-666666666666",
        catalogDigest: environment.catalog.digest,
        identity: { serverId: "github", toolName: "delete" },
        arguments: {},
        caller: { kind: "codemode", subjectId: "agent:test" },
      }),
    ).rejects.toBeInstanceOf(AttemptToolApprovalRequiredError);
    expect(executions).toBe(0);
    await expect(
      environment.callModel({
        modelName: "github__delete",
        arguments: {},
        subjectId: "agent:test",
      }),
    ).rejects.toBeInstanceOf(AttemptToolApprovalRequiredError);
    expect(executions).toBe(0);
    approvalConfirmed = true;
    await expect(
      environment.callModel({
        modelName: "github__delete",
        arguments: {},
        subjectId: "wrong-agent",
      }),
    ).rejects.toBeInstanceOf(AttemptToolApprovalRequiredError);
    expect(executions).toBe(0);
    expect(
      (
        await environment.callModel({
          modelName: "github__delete",
          arguments: {},
          subjectId: "agent:test",
        })
      ).content,
    ).toEqual([]);
    expect(executions).toBe(1);
  });

  test("validates catalog inputs before execution and successful structured outputs after it", async () => {
    let executions = 0;
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        {
          ...definition("docs", "typed", async (args) => {
            executions += 1;
            return {
              content: [],
              structuredContent: {
                count: args.validResult === true ? 1 : "wrong",
              },
            };
          }),
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              validResult: { type: "boolean" },
            },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { count: { type: "integer" } },
            required: ["count"],
            additionalProperties: false,
          },
        },
      ],
    });
    const call = (argumentsValue: Record<string, string | number | boolean>) =>
      environment.call({
        operationId: crypto.randomUUID(),
        catalogDigest: environment.catalog.digest,
        identity: { serverId: "docs", toolName: "typed" },
        arguments: argumentsValue,
        caller: { kind: "codemode", subjectId: "agent:test" },
      });

    await expect(call({ query: 42 })).rejects.toBeInstanceOf(AttemptToolInputValidationError);
    expect(executions).toBe(0);
    await expect(call({ query: "hello", validResult: false })).rejects.toBeInstanceOf(
      AttemptToolOutputValidationError,
    );
    expect(executions).toBe(1);
    expect((await call({ query: "hello", validResult: true })).structuredContent).toEqual({
      count: 1,
    });
  });

  test("accepts a spilled model overflow receipt instead of the catalog output schema", async () => {
    const receipt = {
      type: "tool_result_spilled" as const,
      sandboxPath: "/workspace/tool-results/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json",
      fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      byteSize: 2_000_000,
      mediaType: "application/json" as const,
    };
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        {
          ...definition("docs", "typed", async () => ({
            isError: false,
            content: [{ type: "text", text: JSON.stringify(receipt) }],
            structuredContent: receipt,
          })),
          outputSchema: {
            type: "object",
            properties: { count: { type: "integer" } },
            required: ["count"],
            additionalProperties: false,
          },
        },
      ],
    });
    const result = await environment.callModel({
      modelName: "docs__typed",
      arguments: {},
      subjectId: "worker:mcp-model",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual(receipt);
  });
});
