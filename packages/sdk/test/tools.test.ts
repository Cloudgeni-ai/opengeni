import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { OpenGeniToolReapprovalRequiredError } from "../src/tools";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "../src/types";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const catalog = {
  version: 1 as const,
  accountId: "22222222-2222-4222-8222-222222222222",
  workspaceId,
  generation: 1,
  digest: "a".repeat(64),
  createdAt: "2026-09-02T00:00:00.000Z",
  entries: [
    {
      identity: { serverId: "docs", toolName: "search" },
      modelName: "docs__search",
      codemodePath: ["docs", "search"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      source: "docs" as const,
      approval: "none" as const,
    },
  ],
};

const refreshedCatalog = {
  ...catalog,
  generation: 2,
  digest: "b".repeat(64),
  createdAt: "2026-09-03T00:00:00.000Z",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    },
  });
}

function staleCatalogResponse(): Response {
  return response(
    {
      error: {
        code: "conflict",
        message: "The workspace tool catalog changed; retry with the current catalog.",
        retryable: true,
        details: { code: "catalog_stale" },
      },
    },
    409,
  );
}

describe("OpenGeniClient tools", () => {
  test("loads one catalog and invokes a generated path through the HTTP adapter", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") return response(catalog);
        const body = await request.json();
        if (new URL(request.url).pathname.endsWith("/tools/approvals")) {
          expect(body).toEqual({
            operationId: "33333333-3333-4333-8333-333333333333",
            catalogDigest: catalog.digest,
            identity: catalog.entries[0]!.identity,
            arguments: { query: "gateway" },
          });
          return response({
            operationId: "33333333-3333-4333-8333-333333333333",
            catalogDigest: catalog.digest,
            identity: catalog.entries[0]!.identity,
            approvalToken: `ogta_${"a".repeat(43)}`,
            expiresAt: "2026-09-02T00:05:00.000Z",
          });
        }
        expect(body).toEqual({
          operationId: "33333333-3333-4333-8333-333333333333",
          catalogDigest: catalog.digest,
          identity: catalog.entries[0]!.identity,
          arguments: { query: "gateway" },
          approvalToken: `ogta_${"a".repeat(43)}`,
        });
        return response({
          operationId: "33333333-3333-4333-8333-333333333333",
          catalogDigest: catalog.digest,
          result: {
            content: [{ type: "text", text: '{"matches":1}' }],
            structuredContent: { matches: 1 },
          },
        });
      }) as typeof fetch,
    });

    const tools = client.tools.forWorkspace(workspaceId);
    const approval = await tools.$approve(
      catalog.entries[0]!.identity,
      { query: "gateway" },
      { operationId: "33333333-3333-4333-8333-333333333333" },
    );
    expect(
      await (tools.docs!.search as (args: unknown, options: unknown) => Promise<unknown>)(
        { query: "gateway" },
        {
          operationId: approval.operationId,
          approvalToken: approval.approvalToken,
        },
      ),
    ).toEqual({ matches: 1 });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        `GET /v1/workspaces/${workspaceId}/tools/catalog`,
        `POST /v1/workspaces/${workspaceId}/tools/approvals`,
        `POST /v1/workspaces/${workspaceId}/tools/calls`,
      ],
    );
  });

  test("supports opaque identity calls without parsing projected names", async () => {
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (_input, init) =>
        init?.method === "POST"
          ? response({
              operationId: "33333333-3333-4333-8333-333333333333",
              catalogDigest: catalog.digest,
              result: { content: [] },
            })
          : response(catalog)) as typeof fetch,
    });
    const result = await client.tools
      .forWorkspace(workspaceId)
      .$call(catalog.entries[0]!.identity, { query: "opaque" });
    expect(result).toEqual({ content: [] });
  });

  test("rejects an approved token after another operation refreshes the shared catalog", async () => {
    const operationId = "77777777-7777-4777-8777-777777777777";
    let catalogReads = 0;
    let callPosts = 0;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          catalogReads += 1;
          return response(catalogReads === 1 ? catalog : refreshedCatalog);
        }
        const body = (await request.json()) as Record<string, unknown>;
        if (new URL(request.url).pathname.endsWith("/tools/approvals")) {
          return response({
            operationId,
            catalogDigest: catalog.digest,
            identity: catalog.entries[0]!.identity,
            approvalToken: `ogta_${"c".repeat(43)}`,
            expiresAt: "2026-09-03T00:05:00.000Z",
          });
        }
        callPosts += 1;
        return response(body);
      }) as typeof fetch,
    });
    const tools = client.tools.forWorkspace(workspaceId);
    const approval = await tools.$approve(catalog.entries[0]!.identity, {}, { operationId });
    await tools.$catalog({ refresh: true });
    await expect(
      tools.$call(
        catalog.entries[0]!.identity,
        {},
        {
          operationId,
          approvalToken: approval.approvalToken,
        },
      ),
    ).rejects.toMatchObject({
      code: "tool_reapproval_required",
      previousCatalogDigest: catalog.digest,
      catalogDigest: refreshedCatalog.digest,
    });
    expect(callPosts).toBe(0);
  });

  test("refreshes and retries one direct identity call with the same generated operation id", async () => {
    let catalogReads = 0;
    const calls: Record<string, unknown>[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          catalogReads += 1;
          return response(catalogReads === 1 ? catalog : refreshedCatalog);
        }
        calls.push((await request.json()) as Record<string, unknown>);
        if (calls.length === 1) return staleCatalogResponse();
        return response({
          operationId: calls.at(-1)!.operationId,
          catalogDigest: refreshedCatalog.digest,
          result: { content: [], structuredContent: { matches: 2 } },
        });
      }) as typeof fetch,
    });

    await expect(
      client.tools
        .forWorkspace(workspaceId)
        .$call(catalog.entries[0]!.identity, { query: "retry" }),
    ).resolves.toEqual({ matches: 2 });
    expect(catalogReads).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(calls[1]!.operationId).toBe(calls[0]!.operationId);
    expect(calls.map((call) => call.catalogDigest)).toEqual([
      catalog.digest,
      refreshedCatalog.digest,
    ]);
  });

  test("re-resolves a generated path against the refreshed catalog before retrying", async () => {
    const operationId = "44444444-4444-4444-8444-444444444444";
    const initial = {
      ...catalog,
      entries: [
        {
          ...catalog.entries[0]!,
          identity: { serverId: "docs", toolName: "search_v1" },
        },
      ],
    };
    const current = {
      ...refreshedCatalog,
      entries: [
        {
          ...refreshedCatalog.entries[0]!,
          identity: { serverId: "docs", toolName: "search_v2" },
        },
      ],
    };
    let catalogReads = 0;
    const calls: Record<string, unknown>[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          catalogReads += 1;
          return response(catalogReads === 1 ? initial : current);
        }
        calls.push((await request.json()) as Record<string, unknown>);
        if (calls.length === 1) return staleCatalogResponse();
        return response({
          operationId,
          catalogDigest: current.digest,
          result: { content: [], structuredContent: { matches: 3 } },
        });
      }) as typeof fetch,
    });

    const tools = client.tools.forWorkspace(workspaceId);
    await expect(
      (tools.docs!.search as (args: unknown, options: unknown) => Promise<unknown>)(
        { query: "generated" },
        { operationId },
      ),
    ).resolves.toEqual({ matches: 3 });
    expect(calls.map((call) => call.identity)).toEqual([
      initial.entries[0]!.identity,
      current.entries[0]!.identity,
    ]);
    expect(calls.map((call) => call.operationId)).toEqual([operationId, operationId]);
  });

  test("refreshes and retries one approval request with the same operation id", async () => {
    const operationId = "55555555-5555-4555-8555-555555555555";
    let catalogReads = 0;
    const approvals: Record<string, unknown>[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          catalogReads += 1;
          return response(catalogReads === 1 ? catalog : refreshedCatalog);
        }
        approvals.push((await request.json()) as Record<string, unknown>);
        if (approvals.length === 1) return staleCatalogResponse();
        return response({
          operationId,
          catalogDigest: refreshedCatalog.digest,
          identity: refreshedCatalog.entries[0]!.identity,
          approvalToken: `ogta_${"b".repeat(43)}`,
          expiresAt: "2026-09-03T00:05:00.000Z",
        });
      }) as typeof fetch,
    });

    await expect(
      client.tools
        .forWorkspace(workspaceId)
        .$approve(catalog.entries[0]!.identity, { query: "approve" }, { operationId }),
    ).resolves.toMatchObject({ operationId });
    expect(approvals).toHaveLength(2);
    expect(approvals.map((approval) => approval.operationId)).toEqual([operationId, operationId]);
    expect(approvals.map((approval) => approval.catalogDigest)).toEqual([
      catalog.digest,
      refreshedCatalog.digest,
    ]);
  });

  test("requires reapproval instead of reusing a token after the digest changes", async () => {
    const operationId = "66666666-6666-4666-8666-666666666666";
    let catalogReads = 0;
    let callCount = 0;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (_input, init) => {
        if (init?.method === "POST") {
          callCount += 1;
          return staleCatalogResponse();
        }
        catalogReads += 1;
        return response(catalogReads === 1 ? catalog : refreshedCatalog);
      }) as typeof fetch,
    });

    let caught: unknown;
    try {
      await client.tools.forWorkspace(workspaceId).$call(
        catalog.entries[0]!.identity,
        { query: "approved" },
        {
          operationId,
          approvalToken: `ogta_${"a".repeat(43)}`,
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenGeniToolReapprovalRequiredError);
    expect(caught).toMatchObject({
      code: "tool_reapproval_required",
      retryable: false,
      operationId,
      previousCatalogDigest: catalog.digest,
      catalogDigest: refreshedCatalog.digest,
      identity: refreshedCatalog.entries[0]!.identity,
    });
    expect(catalogReads).toBe(2);
    expect(callCount).toBe(1);
  });

  test("requires the approved operation id when a call carries a capability", async () => {
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async () => response(catalog)) as unknown as typeof fetch,
    });
    expect(
      client.tools
        .forWorkspace(workspaceId)
        .$call(
          catalog.entries[0]!.identity,
          { query: "opaque" },
          { approvalToken: `ogta_${"a".repeat(43)}` },
        ),
    ).rejects.toThrow("operationId is required");
  });

  test("loads digest-pinned declaration source for editor tooling", async () => {
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async () =>
        response({
          catalogDigest: catalog.digest,
          moduleSpecifier: "@opengeni/sdk",
          source: "declare module '@opengeni/sdk' {}",
        })) as unknown as typeof fetch,
    });
    expect(await client.tools.forWorkspace(workspaceId).$declarations()).toEqual({
      catalogDigest: catalog.digest,
      moduleSpecifier: "@opengeni/sdk",
      source: "declare module '@opengeni/sdk' {}",
    });
  });

  test("does not expose dynamic namespaces as accidental thenables", async () => {
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async () => response(catalog)) as unknown as typeof fetch,
    });
    const tools = client.tools.forWorkspace(workspaceId);
    const docs = tools.docs;
    expect(await Promise.resolve(tools)).toBe(tools);
    expect(await Promise.resolve(docs)).toBe(docs);
  });
});
