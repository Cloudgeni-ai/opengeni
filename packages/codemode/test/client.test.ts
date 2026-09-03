import { describe, expect, test } from "bun:test";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";
import {
  CodemodeClient,
  CodemodeOperationError,
  CodemodeTransportError,
  CodemodeToolCallError,
  createCodemodeTools,
  createAttemptToolEnvironment,
  environmentCodemodeClient,
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
  state: "queued" | "running" | "completed" | "outcome_unknown",
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
    completedAt: state === "completed" || state === "outcome_unknown" ? now : null,
    updatedAt: now,
  };
}

describe("CodemodeClient", () => {
  test("uses a transient direct bearer without requiring a token file", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    }).catalog;
    const authorizations: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization"));
        return Response.json(catalog);
      },
    });
    try {
      const environment: Record<string, string> = {
        OPENGENI_CODEMODE_URL: `http://127.0.0.1:${server.port}/codemode`,
        OPENGENI_CODEMODE_TOKEN: "transient-attempt-bearer",
        // A stale ambient pointer must never override exact per-exec delivery.
        OPENGENI_CODEMODE_TOKEN_FILE: "/does/not/exist",
      };
      expect((await environmentCodemodeClient(environment).catalog()).digest).toBe(catalog.digest);
      expect(authorizations).toEqual(["Bearer transient-attempt-bearer"]);
    } finally {
      server.stop(true);
    }
  });

  test("builds the frozen namespace and polls one idempotent operation to completion", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      createdAt: new Date("2026-08-09T12:00:00.000Z"),
      definitions: [definition],
    }).catalog;
    const operationId = "66666666-6666-4666-8666-666666666666";
    const requests: Array<{
      url: string;
      authorization: string | null;
      apiContract: string | null;
      body: unknown;
    }> = [];
    let reads = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        apiContract: new Headers(init?.headers).get("x-opengeni-api-contract"),
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
    expect(
      requests.every(({ apiContract }) => apiContract === OPENGENI_API_CONTRACT_REVISION),
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

  test("does not adopt an existing operation after a deterministic submission conflict", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    }).catalog;
    const operationId = "89898989-8989-4989-8989-898989898989";
    let operationReads = 0;
    const client = new CodemodeClient({
      baseUrl: "https://api.example.test/codemode",
      token: "token",
      fetch: (async (input, init) => {
        if (String(input).endsWith("/catalog")) return Response.json(catalog);
        if (init?.method === "POST") {
          return Response.json(
            {
              error: {
                status: 409,
                code: "conflict",
                message: "Codemode operation id is already bound to a different request",
                retryable: false,
                outcomeUnknown: false,
                details: { code: "codemode_operation_conflict" },
              },
            },
            { status: 409 },
          );
        }
        operationReads += 1;
        return Response.json(operation(operationId, catalog.digest, "completed"));
      }) as typeof fetch,
    });

    await expect(
      client.call(definition.identity, { query: "hello" }, { operationId }),
    ).rejects.toMatchObject({
      name: "CodemodeTransportError",
      status: 409,
      remoteCode: "codemode_operation_conflict",
      outcomeUnknown: false,
    });
    expect(operationReads).toBe(0);
  });

  test("recovers the exact bound operation when a deterministic wake notification fails", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    }).catalog;
    const operationId = "89898989-8989-4989-8989-898989898988";
    const originalNow = Date.now;
    let now = originalNow();
    let posts = 0;
    let reads = 0;
    Date.now = () => now;
    try {
      const client = new CodemodeClient({
        baseUrl: "https://api.example.test/codemode",
        token: "token",
        fetch: (async (input, init) => {
          const url = String(input);
          if (url.endsWith("/catalog")) return Response.json(catalog);
          if (init?.method === "POST") {
            posts += 1;
            if (posts === 1) {
              return Response.json({
                operation: operation(operationId, catalog.digest, "queued"),
                dispatch: "accepted",
              });
            }
            return Response.json(
              {
                error: {
                  code: "conflict",
                  message: "Codemode execution attempt is no longer active",
                  retryable: false,
                  outcomeUnknown: false,
                  details: { code: "codemode_inactive_attempt" },
                },
              },
              { status: 409 },
            );
          }
          reads += 1;
          if (reads === 1) {
            now += 2_001;
            return Response.json(operation(operationId, catalog.digest, "queued"));
          }
          return Response.json(operation(operationId, catalog.digest, "completed"));
        }) as typeof fetch,
        pollIntervalMs: 1,
      });

      expect(await client.call(definition.identity, { query: "hello" }, { operationId })).toEqual({
        content: [{ type: "text", text: "found" }],
      });
      expect(posts).toBe(2);
      expect(reads).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });

  test("reports outcome unknown with the operation id when wake recovery is unavailable", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    }).catalog;
    const originalNow = Date.now;
    let now = originalNow();
    let operationId: string | null = null;
    let posts = 0;
    let reads = 0;
    Date.now = () => now;
    try {
      const client = new CodemodeClient({
        baseUrl: "https://api.example.test/codemode",
        token: "token",
        fetch: (async (input, init) => {
          const url = String(input);
          if (url.endsWith("/catalog")) return Response.json(catalog);
          if (init?.method === "POST") {
            posts += 1;
            const body = JSON.parse(String(init.body)) as { operationId: string };
            operationId ??= body.operationId;
            if (posts === 1) {
              return Response.json({
                operation: operation(operationId, catalog.digest, "queued"),
                dispatch: "accepted",
              });
            }
            return Response.json(
              {
                error: {
                  code: "conflict",
                  message: "Codemode execution attempt is no longer active",
                  retryable: false,
                  outcomeUnknown: false,
                  details: { code: "codemode_inactive_attempt" },
                },
              },
              { status: 409 },
            );
          }
          reads += 1;
          if (reads === 1) {
            now += 2_001;
            return Response.json(operation(operationId!, catalog.digest, "queued"));
          }
          throw new TypeError("journal read unavailable");
        }) as typeof fetch,
        pollIntervalMs: 1,
      });

      let caught: unknown;
      try {
        await client.call(definition.identity, { query: "hello" });
      } catch (error) {
        caught = error;
      }
      const recoveredOperationId = String((caught as CodemodeTransportError).details?.operationId);
      if (!operationId) throw new Error("missing generated operation id");
      expect(caught).toMatchObject({
        name: "CodemodeTransportError",
        remoteCode: "codemode_operation_recovery_unavailable",
        retryable: true,
        outcomeUnknown: true,
        details: { operationId: expect.any(String) },
      });
      expect(recoveredOperationId).toBe(operationId);
      expect(operationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(posts).toBe(2);
      expect(reads).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });

  test("rejects a mismatched operation recovered after an ambiguous POST failure", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    }).catalog;
    const operationId = "90909090-9090-4090-8090-909090909090";
    let operationReads = 0;
    const client = new CodemodeClient({
      baseUrl: "https://api.example.test/codemode",
      token: "token",
      fetch: (async (input, init) => {
        if (String(input).endsWith("/catalog")) return Response.json(catalog);
        if (init?.method === "POST") {
          throw new TypeError("response connection lost after commit");
        }
        operationReads += 1;
        return Response.json({
          ...operation(operationId, catalog.digest, "completed"),
          identity: { serverId: "docs", toolName: "different" },
        });
      }) as typeof fetch,
    });

    await expect(
      client.call(definition.identity, { query: "hello" }, { operationId }),
    ).rejects.toMatchObject({
      name: "CodemodeTransportError",
      status: 409,
      remoteCode: "codemode_operation_conflict",
      retryable: false,
      outcomeUnknown: false,
    });
    expect(operationReads).toBe(1);
  });

  test("refreshes and re-resolves one stale path before operation creation", async () => {
    const originalDefinition = {
      ...definition,
      codemodePath: ["docs", "search"],
    };
    const currentDefinition = {
      ...definition,
      identity: { serverId: "docs", toolName: "search_v2" },
      modelName: "docs__search_v2",
      codemodePath: ["docs", "search"],
    };
    const originalCatalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [originalDefinition],
    }).catalog;
    const currentCatalog = createAttemptToolEnvironment({
      scope,
      generation: 2,
      definitions: [currentDefinition],
    }).catalog;
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let catalogReads = 0;
    const submissions: Array<Record<string, unknown>> = [];
    const client = new CodemodeClient({
      baseUrl: "https://api.example.test/codemode",
      token: "token",
      fetch: (async (input, init) => {
        if (String(input).endsWith("/catalog")) {
          catalogReads += 1;
          return Response.json(catalogReads === 1 ? originalCatalog : currentCatalog);
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        submissions.push(body);
        if (submissions.length === 1) {
          return Response.json(
            {
              error: {
                status: 409,
                code: "conflict",
                message: "Codemode tool catalog is stale for the active execution attempt",
                retryable: true,
                details: { code: "codemode_catalog_stale" },
              },
            },
            { status: 409 },
          );
        }
        return Response.json({
          operation: {
            ...operation(operationId, currentCatalog.digest, "completed"),
            identity: currentDefinition.identity,
          },
          dispatch: "terminal",
        });
      }) as typeof fetch,
    });

    expect(await client.callPath(["docs", "search"], { query: "hello" }, { operationId })).toEqual({
      content: [{ type: "text", text: "found" }],
    });
    expect(catalogReads).toBe(2);
    expect(submissions).toEqual([
      expect.objectContaining({
        operationId,
        catalogDigest: originalCatalog.digest,
        identity: originalDefinition.identity,
      }),
      expect.objectContaining({
        operationId,
        catalogDigest: currentCatalog.digest,
        identity: currentDefinition.identity,
      }),
    ]);
  });

  test("an abort stops observation without sending server cancellation", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    }).catalog;
    const controller = new AbortController();
    const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let markCreated!: () => void;
    const created = new Promise<void>((resolve) => {
      markCreated = resolve;
    });
    const requests: Array<{ method: string; url: string }> = [];
    const client = new CodemodeClient({
      baseUrl: "https://api.example.test/codemode",
      token: "token",
      fetch: (async (input, init) => {
        const method = init?.method ?? "GET";
        requests.push({ method, url: String(input) });
        if (String(input).endsWith("/catalog")) return Response.json(catalog);
        markCreated();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }) as typeof fetch,
    });
    const call = client.call(
      definition.identity,
      { query: "hello" },
      { operationId, signal: controller.signal },
    );
    await created;
    controller.abort(new DOMException("Caller stopped observing", "AbortError"));
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toEqual([
      { method: "GET", url: "https://api.example.test/codemode/catalog" },
      { method: "POST", url: "https://api.example.test/codemode/calls" },
    ]);
  });

  test("exposes stable structured transport codes without changing error identity", async () => {
    const catalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    }).catalog;
    const client = new CodemodeClient({
      baseUrl: "https://api.example.test/codemode",
      token: "token",
      fetch: (async (input) => {
        if (String(input).endsWith("/catalog")) return Response.json(catalog);
        return Response.json(
          {
            error: {
              status: 409,
              code: "conflict",
              message: "Codemode tool catalog is stale for the active execution attempt",
              retryable: true,
              outcomeUnknown: false,
              details: { code: "codemode_catalog_stale" },
            },
          },
          { status: 409 },
        );
      }) as typeof fetch,
    });
    let caught: unknown;
    try {
      await client.call(definition.identity, { query: "hello" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodemodeTransportError);
    expect(caught).toMatchObject({
      name: "CodemodeTransportError",
      code: "codemode_transport_error",
      remoteCode: "codemode_catalog_stale",
      status: 409,
      retryable: true,
      outcomeUnknown: false,
    });
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
