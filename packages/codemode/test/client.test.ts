import { describe, expect, test } from "bun:test";
import {
  CodemodeClient,
  CodemodeOperationError,
  CodemodeToolCallError,
  createCodemodeTools,
  createAttemptToolEnvironment,
  type AttemptToolDefinition,
} from "../src";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

const definition: AttemptToolDefinition = {
  identity: { serverId: "docs", toolName: "search" },
  modelName: "docs__search",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  source: "docs",
  approval: "none",
  execute: async () => ({ content: [] }),
};

function operation(
  operationId: string,
  catalogDigest: string,
  state: "running" | "completed" | "outcome_unknown",
) {
  const now = "2026-08-09T12:00:00.000Z";
  return {
    version: 1 as const,
    operationId,
    ...scope,
    catalogDigest,
    requestDigest: "a".repeat(64),
    identity: definition.identity,
    arguments: { query: "hello" },
    caller: { kind: "codemode" as const, subjectId: "agent:test" },
    state,
    result: state === "completed" ? { content: [{ type: "text" as const, text: "found" }] } : null,
    errorCode: state === "outcome_unknown" ? "tool_outcome_unknown" : null,
    errorMessage: state === "outcome_unknown" ? "Inspect actual state before retrying." : null,
    createdAt: now,
    claimedAt: now,
    executionStartedAt: now,
    completedAt: state === "running" ? null : now,
    updatedAt: now,
  };
}

describe("CodemodeClient", () => {
  test("builds the frozen namespace and polls one idempotent operation to completion", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      createdAt: new Date("2026-08-09T12:00:00.000Z"),
      definitions: [definition],
    }).catalog;
    const operationId = "66666666-6666-4666-8666-666666666666";
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    let reads = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/catalog")) return Response.json(catalog);
      if (url.endsWith("/calls")) {
        return Response.json({
          operation: operation(operationId, catalog.digest, "running"),
          dispatch: "accepted",
        });
      }
      reads += 1;
      return Response.json(
        operation(operationId, catalog.digest, reads === 1 ? "running" : "completed"),
      );
    }) as typeof fetch;
    const client = new CodemodeClient({
      baseUrl: "https://api.example.test/v1/workspaces/ws/codemode/",
      token: async () => "exact-attempt-token",
      fetch: fetchImpl,
      pollIntervalMs: 50,
    });
    const tools = await client.tools();
    const docs = tools.docs;
    if (!docs || typeof docs === "function") throw new Error("missing docs namespace");
    const search = docs.search;
    if (typeof search !== "function") throw new Error("missing search function");
    expect(await search({ query: "hello" }, { operationId })).toEqual({
      content: [{ type: "text", text: "found" }],
    });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.example.test/v1/workspaces/ws/codemode/catalog",
      "https://api.example.test/v1/workspaces/ws/codemode/calls",
      `https://api.example.test/v1/workspaces/ws/codemode/calls/${operationId}`,
      `https://api.example.test/v1/workspaces/ws/codemode/calls/${operationId}`,
    ]);
    expect(
      requests.every(({ authorization }) => authorization === "Bearer exact-attempt-token"),
    ).toBe(true);
    expect(requests[1]!.body).toMatchObject({ operationId, identity: definition.identity });
  });

  test("surfaces outcome-unknown distinctly and never silently retries the tool", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    }).catalog;
    const operationId = "77777777-7777-4777-8777-777777777777";
    let posts = 0;
    const client = new CodemodeClient({
      baseUrl: "https://api.example.test/codemode",
      token: "token",
      fetch: (async (input) => {
        if (String(input).endsWith("/catalog")) return Response.json(catalog);
        posts += 1;
        return Response.json({
          operation: operation(operationId, catalog.digest, "outcome_unknown"),
          dispatch: "terminal",
        });
      }) as typeof fetch,
      pollIntervalMs: 50,
    });
    await expect(
      client.call(definition.identity, { query: "hello" }, { operationId }),
    ).rejects.toMatchObject({
      name: "CodemodeOperationError",
      code: "tool_outcome_unknown",
    } satisfies Partial<CodemodeOperationError>);
    expect(posts).toBe(1);
  });

  test("recovers a committed operation by id when the POST response is lost", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    }).catalog;
    const operationId = "88888888-8888-4888-8888-888888888888";
    let posts = 0;
    let reads = 0;
    const client = new CodemodeClient({
      baseUrl: "https://api.example.test/codemode",
      token: "token",
      fetch: (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/catalog")) return Response.json(catalog);
        if (init?.method === "POST") {
          posts += 1;
          throw new TypeError("response connection lost after commit");
        }
        reads += 1;
        return Response.json(operation(operationId, catalog.digest, "completed"));
      }) as typeof fetch,
      pollIntervalMs: 50,
    });
    expect(await client.call(definition.identity, { query: "hello" }, { operationId })).toEqual({
      content: [{ type: "text", text: "found" }],
    });
    expect(posts).toBe(1);
    expect(reads).toBe(1);
  });

  test("calls the exact catalog identity through a lazy namespace without parsing wire names", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    }).catalog;
    const operationId = "99999999-9999-4999-8999-999999999999";
    const calls: Array<Record<string, unknown>> = [];
    const client = new CodemodeClient({
      baseUrl: "https://api.example.test/codemode",
      token: "token",
      fetch: (async (input, init) => {
        if (String(input).endsWith("/catalog")) return Response.json(catalog);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push(body);
        return Response.json({
          operation: operation(operationId, catalog.digest, "completed"),
          dispatch: "terminal",
        });
      }) as typeof fetch,
    });
    const tools = createCodemodeTools(() => client);

    expect(await tools.docs!.search!({ query: "hello" }, { operationId })).toEqual({
      content: [{ type: "text", text: "found" }],
    });
    expect(calls).toEqual([
      expect.objectContaining({
        operationId,
        identity: definition.identity,
        arguments: { query: "hello" },
      }),
    ]);
    const docs = tools.docs;
    expect(Promise.resolve(docs)).resolves.toBe(docs);
  });

  test("rejects an unknown lazy namespace before submitting a call", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    }).catalog;
    let posts = 0;
    const client = new CodemodeClient({
      baseUrl: "https://api.example.test/codemode",
      token: "token",
      fetch: (async (input) => {
        if (String(input).endsWith("/catalog")) return Response.json(catalog);
        posts += 1;
        throw new Error("unexpected request");
      }) as typeof fetch,
    });

    await expect(createCodemodeTools(() => client).docs!.missing!()).rejects.toMatchObject({
      code: "tool_not_found",
    });
    expect(posts).toBe(0);
  });

  test("returns declared structured content and raises a typed tool error", async () => {
    const typedDefinition: AttemptToolDefinition = {
      ...definition,
      outputSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
    };
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [typedDefinition],
    }).catalog;
    let shouldFail = false;
    const client = new CodemodeClient({
      baseUrl: "https://api.example.test/codemode",
      token: "token",
      fetch: (async (input, init) => {
        if (String(input).endsWith("/catalog")) return Response.json(catalog);
        const body = JSON.parse(String(init?.body)) as { operationId: string };
        const value = operation(body.operationId, catalog.digest, "completed");
        return Response.json({
          operation: {
            ...value,
            result: shouldFail
              ? {
                  content: [{ type: "text", text: "Nope" }],
                  structuredContent: {
                    error: { code: "not_ready", message: "Not ready", retryable: true },
                  },
                  isError: true,
                }
              : { content: [], structuredContent: { count: 3 } },
          },
          dispatch: "terminal",
        });
      }) as typeof fetch,
    });
    const tools = createCodemodeTools(() => client);

    expect(await tools.docs!.search!()).toEqual({ count: 3 });
    shouldFail = true;
    await expect(tools.docs!.search!()).rejects.toMatchObject({
      name: "CodemodeToolCallError",
      code: "not_ready",
      retryable: true,
    } satisfies Partial<CodemodeToolCallError>);
  });
});
