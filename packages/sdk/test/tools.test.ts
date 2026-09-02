import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
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

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    },
  });
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
