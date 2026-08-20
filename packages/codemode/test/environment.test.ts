import { describe, expect, test } from "bun:test";
import type { AttemptToolDefinition } from "../src";
import {
  AttemptToolApprovalRequiredError,
  AttemptToolCatalogIntegrityError,
  AttemptToolCatalogStaleError,
  AttemptToolInputValidationError,
  AttemptToolOutputValidationError,
  createAttemptToolEnvironment,
  parseVerifiedAttemptToolCatalog,
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
    expect(paths[2]).toEqual(["_constructor", "___proto__"]);
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

  test("keeps approval-required tools model-visible but blocks Codemode bypass", async () => {
    let executions = 0;
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
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
