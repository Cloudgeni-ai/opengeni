import { describe, expect, test } from "bun:test";

import {
  compileOpenApiRevision,
  createOpenApiMcpServer,
  filterOpenApiDocumentForDefinition,
  genericPathScopeOperations,
  invokeOpenApiOperation,
  type IntegrationDefinition,
} from "../src";

const ok = { "200": { description: "OK" } };
const parameter = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
});
const document = {
  openapi: "3.0.4",
  info: { title: "Mail", version: "1" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/me/messages": {
      get: { operationId: "messages.list", summary: "List messages", responses: ok },
    },
    "/me/messages/{message-id}": {
      parameters: [parameter("message-id")],
      get: { operationId: "messages.get", summary: "Get message", responses: ok },
      delete: { operationId: "messages.delete", summary: "Delete message", responses: ok },
    },
    "/me/mailFolders/{mailFolder-id}/messageRules": {
      parameters: [parameter("mailFolder-id")],
      get: { operationId: "rules.list", summary: "List message rules", responses: ok },
      post: { operationId: "rules.create", summary: "Create message rule", responses: ok },
    },
    "/me/mailFolders/delta()": {
      get: { operationId: "folders.delta", summary: "Folder changes", responses: ok },
    },
    "/me/drive/search(q='{q}')": {
      parameters: [parameter("q")],
      get: { operationId: "drive.search", summary: "Search drive", responses: ok },
    },
    "/users": { get: { operationId: "users.list", summary: "List users", responses: ok } },
  },
};
const definition = {
  id: "mail",
  name: "Mail",
  summary: "Mail",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "api.example.com" },
  source: {
    kind: "openapi",
    url: "https://example.com/openapi.json",
    operationAllowlist: [{ path: "/me/messages", method: "get" }],
    genericPathScope: { prefixes: ["/me/messages", "/me/mailFolders", "/me/drive"] },
  },
  baseUrl: "https://api.example.com/v1",
  authentication: {
    kind: "oauth2",
    provider: "microsoft",
    authorizationUrl: "https://login.example.com/authorize",
    tokenUrl: "https://login.example.com/token",
    scopes: [],
    tokenPlacement: { carrier: "header", name: "Authorization", prefix: "Bearer " },
  },
  facets: [],
} as unknown as IntegrationDefinition;

const compile = (withGeneric = true) =>
  compileOpenApiRevision(filterOpenApiDocumentForDefinition(document, definition), {
    definitionId: "mail",
    ...(withGeneric
      ? { genericPathOperations: genericPathScopeOperations(document, definition) }
      : {}),
  });

const call = async (toolId: string, args: Record<string, unknown>) => {
  const requests: { url: string; method: string; body: string | null; headers: Headers }[] = [];
  const result = await invokeOpenApiOperation(
    {
      revision: compile(),
      authority: { accountId: "a", workspaceId: "w", connectionRef: "c" },
      credentialResolver: {
        async resolve() {
          return {
            audience: { origin: "https://api.example.com", pathPrefix: "/v1/" },
            placements: [{ carrier: "header", name: "Authorization", value: "Bearer token" }],
          } as never;
        },
      },
      transport: {
        async fetch(input, init) {
          requests.push({
            url: String(input),
            method: String(init?.method),
            body: typeof init?.body === "string" ? init.body : null,
            headers: new Headers(init?.headers),
          });
          return Response.json({ value: [] });
        },
      },
    },
    toolId,
    args,
  );
  return { result, requests };
};

describe("generic path tools", () => {
  test("are offered only for a definition that opts in, with read and change defaults", async () => {
    const plain = compile(false);
    expect(plain.tools.map((tool) => tool.id)).toEqual(["messages_list"]);
    const revision = compile();
    expect(revision.tools.map((tool) => [tool.id, tool.safety, tool.approvalMode])).toEqual([
      ["messages_list", "read", "never"],
      ["find_operations", "read", "never"],
      ["call_read_operation", "read", "never"],
      ["call_change_operation", "destructive", "ask"],
    ]);
    // The scope is part of the executable identity.
    expect(revision.contentSha256).not.toBe(plain.contentSha256);
    const listed = await createOpenApiMcpServer({
      revision,
      transport: { fetch: async () => new Response() },
      authority: { accountId: "a", workspaceId: "w" },
    }).listTools();
    const change = listed.find((tool) => tool.name === "call_change_operation")!;
    expect(change.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(change._meta?.["opengeni/approvalMode"]).toBe("ask");
  });

  test("the find tool searches the scope and points at a dedicated tool", async () => {
    const { result, requests } = await call("find_operations", { query: "message rules" });
    expect(requests).toEqual([]);
    const found = result.data as { total: number; operations: Record<string, unknown>[] };
    // Operations matching both words rank first.
    expect(found.operations.slice(0, 2)).toEqual([
      {
        method: "GET",
        path: "/me/mailFolders/{mailFolder-id}/messageRules",
        summary: "List message rules",
      },
      {
        method: "POST",
        path: "/me/mailFolders/{mailFolder-id}/messageRules",
        summary: "Create message rule",
      },
    ]);
    expect(found.operations).toContainEqual({
      method: "GET",
      path: "/me/messages",
      summary: "List messages",
      tool: "messages_list",
    });
    const posts = await call("find_operations", { query: "message", method: "post" });
    expect((posts.result.data as { operations: { path: string }[] }).operations).toEqual([
      expect.objectContaining({ path: "/me/mailFolders/{mailFolder-id}/messageRules" }),
    ]);
    expect(
      JSON.stringify((await call("find_operations", { query: "users" })).result.data),
    ).not.toContain("/users");
  });

  test("the read tool sends a GET to the matched path with the connection's credential", async () => {
    const { result, requests } = await call("call_read_operation", {
      path: "/me/mailFolders/inbox/messageRules",
      query: { $top: 5 },
      header: { Prefer: 'outlook.body-content-type="text"' },
    });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe(
      "https://api.example.com/v1/me/mailFolders/inbox/messageRules?%24top=5",
    );
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer token");
    expect(requests[0]!.headers.get("prefer")).toBe('outlook.body-content-type="text"');
    // Values are encoded once; literal segments come from the reviewed template.
    const encoded = await call("call_read_operation", { path: "/ME/messages/AA%2Fb=c d" });
    expect(encoded.requests[0]!.url).toBe("https://api.example.com/v1/me/messages/AA%2Fb%3Dc%20d");
    const literal = await call("call_read_operation", { path: "/me/mailFolders/delta()" });
    expect(literal.requests[0]!.url).toBe("https://api.example.com/v1/me/mailFolders/delta()");
    const quoted = await call("call_read_operation", { path: "/me/drive/search(q='budget 2026')" });
    expect(quoted.requests[0]!.url).toBe(
      "https://api.example.com/v1/me/drive/search(q='budget%202026')",
    );
  });

  test("a path outside the scope, or an unsafe one, is refused before any request", async () => {
    for (const args of [
      { path: "/users" },
      { path: "/me/messages/a/b" },
      { path: "/me/messages/.." },
      { path: "/me/messages/%2E%2E" },
      { path: "/me/messages?$top=1" },
      { path: "me/messages" },
      { path: "/me//messages" },
      { path: "/me/mailFolders/inbox/messageRules", header: { Authorization: "Bearer x" } },
    ]) {
      await expect(call("call_read_operation", args)).rejects.toMatchObject({
        code: "parameter_invalid",
        outcome: "not_started",
      });
    }
    // The read tool never sends another method, and the change tool never sends GET.
    await expect(
      call("call_read_operation", { path: "/me/messages/1", method: "delete" }),
    ).resolves.toMatchObject({ requests: [{ method: "GET" }] });
    await expect(
      call("call_change_operation", { method: "get", path: "/me/messages/1" }),
    ).rejects.toMatchObject({ code: "parameter_invalid" });
    await expect(
      call("call_change_operation", { method: "patch", path: "/me/messages/1" }),
    ).rejects.toMatchObject({ code: "parameter_invalid" });
  });

  test("the change tool sends the chosen method and body", async () => {
    const created = await call("call_change_operation", {
      method: "POST",
      path: "/me/mailFolders/inbox/messageRules",
      body: { displayName: "Move invoices" },
    });
    expect(created.requests[0]).toMatchObject({
      method: "POST",
      url: "https://api.example.com/v1/me/mailFolders/inbox/messageRules",
      body: '{"displayName":"Move invoices"}',
    });
    expect(created.requests[0]!.headers.get("content-type")).toBe("application/json");
    const deleted = await call("call_change_operation", {
      method: "delete",
      path: "/me/messages/m1",
    });
    expect(deleted.requests[0]).toMatchObject({ method: "DELETE", body: null });
  });
});
