import { describe, expect, test } from "bun:test";
import type { AttemptToolCatalog, AttemptToolResult } from "@opengeni/contracts";

import {
  CodemodeClient,
  createCodemodeSiteRequestHandler,
  createAttemptToolEnvironment,
} from "../src";

const catalog: AttemptToolCatalog = {
  version: 1,
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
  generation: 1,
  digest: "a".repeat(64),
  createdAt: "2026-09-04T00:00:00.000Z",
  entries: [
    {
      identity: { serverId: "linear", toolName: "issues_list" },
      modelName: "linear__issues_list",
      codemodePath: ["linear", "issues_list"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      source: "mcp",
      approval: "none",
    },
  ],
};

describe("local Site Codemode handler", () => {
  test.each(["invoke", "calls"] as const)(
    "real client never refreshes a pinned Site submission into a changed executable definition (%s)",
    async (endpoint) => {
      const definition = { ...catalog.entries[0]!, execute: () => ({ content: [] }) };
      const { accountId, workspaceId, sessionId, turnId, attemptId, executionGeneration } = catalog;
      const scope = { accountId, workspaceId, sessionId, turnId, attemptId, executionGeneration };
      const first = createAttemptToolEnvironment({
        scope,
        generation: 1,
        definitions: [definition],
      }).catalog;
      const next = createAttemptToolEnvironment({
        scope,
        generation: 2,
        definitions: [
          {
            ...definition,
            inputSchema: { type: "object", properties: { changed: { type: "boolean" } } },
          },
        ],
      }).catalog;
      let reads = 0;
      let submissions = 0;
      let effects = 0;
      const client = new CodemodeClient({
        baseUrl: "https://codemode.invalid",
        token: "test",
        fetch: (async (input) => {
          if (String(input).endsWith("/catalog"))
            return Response.json(++reads === 1 ? first : next);
          if (++submissions === 1)
            return Response.json(
              {
                error: {
                  code: "conflict",
                  retryable: true,
                  outcomeUnknown: false,
                  details: { code: "codemode_catalog_stale" },
                },
              },
              { status: 409 },
            );
          effects++;
          throw new Error("Changed schema must never be submitted");
        }) as typeof fetch,
      });
      const handler = createCodemodeSiteRequestHandler(client);
      const target = { identity: definition.identity };
      const resolve = await handler(
        new Request("https://preview.invalid/__opengeni/site-tools/resolve", {
          method: "POST",
          body: JSON.stringify({ target }),
        }),
      );
      const tool = await resolve.json();
      const response = await handler(
        new Request(`https://preview.invalid/__opengeni/site-tools/${endpoint}`, {
          method: "POST",
          body: JSON.stringify({
            ...(endpoint === "invoke"
              ? { target, expectedDefinitionDigest: tool.definitionDigest }
              : { identity: definition.identity, catalogDigest: first.digest }),
            arguments: {},
            operationId: crypto.randomUUID(),
          }),
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: endpoint === "invoke" ? "tool_definition_stale" : "catalog_stale",
          retryable: true,
        },
      });
      expect(reads).toBe(2);
      expect(submissions).toBe(1);
      expect(effects).toBe(0);
    },
  );
  test("targeted preview uses only the frozen attempt and rejects stale or host-only authority before execution", async () => {
    const calls: unknown[] = [];
    const handler = createCodemodeSiteRequestHandler({
      catalog: async () => catalog,
      call: async (...args: unknown[]) => {
        calls.push(args);
        return { content: [], structuredContent: { ok: true } };
      },
    } as unknown as CodemodeClient);
    const request = (method: string, body: unknown) =>
      handler(
        new Request(`http://localhost/__opengeni/site-tools/${method}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    const target = { identity: catalog.entries[0]!.identity };
    const resolved = await (await request("resolve", { target })).json();
    expect(resolved).toMatchObject({ version: 1, entry: catalog.entries[0] });
    const invocation = {
      target,
      operationId: "66666666-6666-4666-8666-666666666666",
      arguments: { first: 10 },
      expectedDefinitionDigest: resolved.definitionDigest,
    };
    expect(
      (await request("invoke", { ...invocation, expectedDefinitionDigest: "b".repeat(64) })).status,
    ).toBe(409);
    expect(
      (await request("invoke", { ...invocation, approvalToken: `ogta_${"a".repeat(43)}` })).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await request("invoke", invocation)).status).toBe(200);
    expect(calls).toEqual([
      [
        catalog.entries[0]!.identity,
        { first: 10 },
        expect.objectContaining({ operationId: invocation.operationId }),
      ],
    ]);
  });
  test("forwards configuration and control routes for normal API authorization", async () => {
    const forwarded: string[] = [];
    const client = new CodemodeClient({
      baseUrl: "http://upstream.test",
      token: "test",
      fetch: (async (input: RequestInfo | URL) => {
        forwarded.push(String(input));
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    const handler = createCodemodeSiteRequestHandler(client);
    for (const [method, path] of [
      ["PUT", "/v1/workspaces/site-host/sessions/one/tool-policy"],
      ["PUT", "/v1/workspaces/site-host/sessions/one/visibility"],
      ["POST", "/v1/workspaces/site-host/sessions/one/forks"],
      ["POST", "/v1/workspaces/site-host/sessions/one/steer"],
      ["POST", "/v1/workspaces/site-host/sessions/one/control"],
      ["GET", "/v1/workspaces/site-host/api-keys"],
    ] as const) {
      const response = await handler(
        new Request(`http://localhost/__opengeni/site-tools/sdk${path}`, {
          method,
          ...(method === "GET" ? {} : { body: "{}" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(forwarded.at(-1)).toBe(`http://upstream.test/sdk${path}`);
    }
    expect(forwarded).toHaveLength(6);
    const allowed = await handler(
      new Request("http://localhost/__opengeni/site-tools/sdk/v1/workspaces/site-host/sessions"),
    );
    expect(allowed.status).toBe(200);
    expect(forwarded.at(-1)).toBe("http://upstream.test/sdk/v1/workspaces/site-host/sessions");
  });

  test("SDK event streams deliver before completion and retain cancellation", async () => {
    let cancelled = false;
    let forwardedHeaders: HeadersInit | undefined;
    const client = {
      sessionRequest: async (_path: string, init: RequestInit) => {
        forwardedHeaders = init.headers;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: live\n\n"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    } as unknown as CodemodeClient;
    const response = await createCodemodeSiteRequestHandler(client)(
      new Request(
        "http://localhost/__opengeni/site-tools/sdk/v1/workspaces/site-host/sessions/one/events/stream",
        { headers: { "last-event-id": "cursor-42" } },
      ),
    );
    const reader = response.body!.getReader();
    expect(new Headers(forwardedHeaders).get("last-event-id")).toBe("cursor-42");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: live\n\n");
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  test("forwards decoded SDK response bodies without stale wire encoding", async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(Bun.gzipSync(JSON.stringify({ session: { id: "created" } })), {
          status: 201,
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        }),
    });
    const client = new CodemodeClient({
      baseUrl: upstream.url.toString(),
      token: "test",
    });
    const preview = Bun.serve({
      port: 0,
      fetch: createCodemodeSiteRequestHandler(client),
    });
    try {
      const response = await fetch(
        new URL("/__opengeni/site-tools/sdk/v1/workspaces/site-host/sessions", preview.url),
        {
          method: "POST",
          body: "{}",
        },
      );
      expect(response.status).toBe(201);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.json()).toEqual({ session: { id: "created" } });
    } finally {
      preview.stop(true);
      upstream.stop(true);
    }
  });

  test("projects the frozen catalog and executes through the existing client", async () => {
    const calls: unknown[] = [];
    const result: AttemptToolResult = {
      content: [],
      structuredContent: { issues: [{ id: "LIN-1" }] },
    };
    const client = {
      catalog: async () => catalog,
      call: async (identity: unknown, args: unknown, options: unknown) => {
        calls.push({ identity, args, options });
        return result;
      },
    } as unknown as CodemodeClient;
    const handler = createCodemodeSiteRequestHandler(client);

    const catalogResponse = await handler(
      new Request("http://localhost/__opengeni/site-tools/catalog"),
    );
    const projected = (await catalogResponse.json()) as Record<string, unknown>;
    expect(projected).not.toHaveProperty("accountId");
    expect(projected).not.toHaveProperty("attemptId");
    expect(projected).toMatchObject({
      digest: catalog.digest,
      entries: catalog.entries,
    });

    const callResponse = await handler(
      new Request("http://localhost/__opengeni/site-tools/calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "66666666-6666-4666-8666-666666666666",
          catalogDigest: catalog.digest,
          identity: catalog.entries[0]!.identity,
          arguments: { first: 10 },
        }),
      }),
    );
    expect(await callResponse.json()).toEqual({
      operationId: "66666666-6666-4666-8666-666666666666",
      catalogDigest: catalog.digest,
      result,
    });
    expect(calls).toEqual([
      {
        identity: catalog.entries[0]!.identity,
        args: { first: 10 },
        options: expect.objectContaining({
          operationId: "66666666-6666-4666-8666-666666666666",
        }),
      },
    ]);
  });

  test("rejects a stale browser catalog before execution", async () => {
    let calls = 0;
    const client = {
      catalog: async () => catalog,
      call: async () => {
        calls += 1;
        return { content: [] };
      },
    } as unknown as CodemodeClient;
    const response = await createCodemodeSiteRequestHandler(client)(
      new Request("http://localhost/__opengeni/site-tools/calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          catalogDigest: "b".repeat(64),
          identity: catalog.entries[0]!.identity,
          arguments: {},
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "catalog_stale" },
    });
    expect(calls).toBe(0);
  });
});

test("optional browser client loads without credentials; tool requests still need them", async () => {
  let acquired = 0;
  const handler = createCodemodeSiteRequestHandler(() => {
    acquired++;
    throw new Error("No attempt");
  });
  const url = "http://localhost/__opengeni/site-tools/client.js";
  const response = await handler(new Request(url));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(await response.text()).toContain("createOpenGeniSiteClient");
  expect(await (await handler(new Request(url, { method: "HEAD" }))).text()).toBe("");
  expect((await handler(new Request(url, { method: "POST" }))).status).toBe(405);
  expect(acquired).toBe(0);
  expect(
    (await handler(new Request("http://localhost/__opengeni/site-tools/catalog"))).status,
  ).toBe(500);
  expect(acquired).toBe(1);
});
