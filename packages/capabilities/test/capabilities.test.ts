import { describe, expect, test } from "bun:test";
import { buildSchema, introspectionFromSchema } from "graphql";

import {
  GOOGLE_DRIVE_INTEGRATION_DEFINITION,
  GOOGLE_GMAIL_INTEGRATION_DEFINITION,
  MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION,
  applyCredentialPlacements,
  compileGraphqlRevision,
  compileOpenApiRevision,
  directIntegrationTransport,
  extractMcpToolManifest,
  filterOpenApiDocumentForDefinition,
  googleDiscoveryToOpenApi,
  IntegrationInvocationError,
  invokeGraphqlOperation,
  invokeOpenApiOperation,
  validateGraphqlSelection,
} from "../src";

const authority = {
  accountId: "account-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  initiatingSubjectId: "user:1",
  connectionRef: "connection-1",
};

describe("OpenAPI compiler and local MCP invocation", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "Widgets", version: "1.0.0" },
    servers: [{ url: "https://api.example.com/v1/" }],
    paths: {
      "/widgets/{id}": {
        get: {
          operationId: "widgets.get",
          summary: "Get a widget",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "expand", in: "query", schema: { type: "boolean" } },
          ],
          responses: {
            "200": {
              description: "Widget",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
        delete: {
          operationId: "widgets.delete",
          summary: "Delete a widget",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "Deleted" } },
        },
      },
    },
  };

  test("compiles deterministic safety metadata and invokes through destination-bound auth", async () => {
    const revision = compileOpenApiRevision(document, { definitionId: "widgets" });
    expect(revision.tools).toEqual([
      expect.objectContaining({ id: "widgets_get", safety: "read", approvalMode: "never" }),
      expect.objectContaining({
        id: "widgets_delete",
        safety: "destructive",
        approvalMode: "ask",
      }),
    ]);
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const result = await invokeOpenApiOperation(
      {
        revision,
        authority,
        credentialResolver: {
          resolve: async () => ({
            audience: { origin: "https://api.example.com", pathPrefix: "/v1/" },
            placements: [
              { carrier: "header", name: "Authorization", prefix: "Bearer ", value: "secret" },
              { carrier: "query", name: "tenant", value: "acme" },
            ],
          }),
        },
        transport: directIntegrationTransport(async (input, init) => {
          calls.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return new Response(JSON.stringify({ id: "abc" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      },
      "widgets_get",
      { path: { id: "abc" }, query: { expand: true } },
    );
    expect(calls).toEqual([
      {
        url: "https://api.example.com/v1/widgets/abc?expand=true&tenant=acme",
        authorization: "Bearer secret",
      },
    ]);
    expect(result).toEqual({
      ok: true,
      status: 200,
      contentType: "application/json",
      data: { id: "abc" },
    });
  });

  test("does not replay a mutation after an ambiguous provider authorization failure", async () => {
    const revision = compileOpenApiRevision(document, { definitionId: "widgets" });
    let calls = 0;
    const credentialResolutions: boolean[] = [];
    const invocation = invokeOpenApiOperation(
      {
        revision,
        authority,
        credentialResolver: {
          resolve: async (request) => {
            credentialResolutions.push(request.forceRefresh === true);
            return {
              audience: { origin: "https://api.example.com", pathPrefix: "/v1/" },
              placements: [{ carrier: "header", name: "Authorization", value: "expired-token" }],
            };
          },
        },
        transport: directIntegrationTransport(async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: "expired" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }),
      },
      "widgets_delete",
      { path: { id: "abc" } },
    );
    await expect(invocation).rejects.toMatchObject({
      code: "authorization_rejected",
      outcome: "unknown",
      retryable: false,
      status: 401,
    });
    expect(calls).toBe(1);
    expect(credentialResolutions).toEqual([false, true]);
  });

  test("refreshes and retries a read exactly once after a provider 401", async () => {
    const revision = compileOpenApiRevision(document, { definitionId: "widgets" });
    const credentialResolutions: boolean[] = [];
    const authorizations: string[] = [];
    const result = await invokeOpenApiOperation(
      {
        revision,
        authority,
        credentialResolver: {
          resolve: async (request) => {
            credentialResolutions.push(request.forceRefresh === true);
            return {
              audience: { origin: "https://api.example.com", pathPrefix: "/v1/" },
              placements: [
                {
                  carrier: "header",
                  name: "Authorization",
                  value: request.forceRefresh ? "fresh-token" : "expired-token",
                },
              ],
            };
          },
        },
        transport: directIntegrationTransport(async (_input, init) => {
          const authorization = new Headers(init?.headers).get("authorization") ?? "";
          authorizations.push(authorization);
          return authorization === "fresh-token"
            ? new Response(JSON.stringify({ id: "abc" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            : new Response(null, { status: 401 });
        }),
      },
      "widgets_get",
      { path: { id: "abc" } },
    );
    expect(credentialResolutions).toEqual([false, true]);
    expect(authorizations).toEqual(["expired-token", "fresh-token"]);
    expect(result).toMatchObject({ ok: true, status: 200, data: { id: "abc" } });
  });

  test("rejects a near-identical credential whose audience path is too narrow", () => {
    const url = new URL("https://api.example.com/v1/widgets");
    expect(() =>
      applyCredentialPlacements(url, new Headers(), {
        audience: { origin: "https://api.example.com", pathPrefix: "/v2/" },
        placements: [{ carrier: "header", name: "Authorization", value: "secret" }],
      }),
    ).toThrow(IntegrationInvocationError);
    expect(url.toString()).toBe("https://api.example.com/v1/widgets");
  });

  test("applies cookie/query placements atomically and rejects unsafe destinations", () => {
    const url = new URL("https://api.example.com/v1/widgets");
    const headers = new Headers({ "X-Existing": "retained" });
    applyCredentialPlacements(url, headers, {
      audience: { origin: "https://api.example.com", pathPrefix: "/v1/" },
      placements: [
        { carrier: "header", name: "X-Client", prefix: "Key ", value: "client-secret" },
        { carrier: "query", name: "api_key", value: "query-secret" },
        { carrier: "cookie", name: "session_key", value: "cookie-secret" },
      ],
    });
    expect(url.toString()).toBe("https://api.example.com/v1/widgets?api_key=query-secret");
    expect(headers.get("x-client")).toBe("Key client-secret");
    expect(headers.get("cookie")).toBe("session_key=cookie-secret");

    for (const placements of [
      [
        { carrier: "query" as const, name: "api_key", value: "one" },
        { carrier: "query" as const, name: "api_key", value: "two" },
      ],
      [{ carrier: "header" as const, name: "Host", value: "attacker.example" }],
      [{ carrier: "query" as const, name: "api_key", value: "secret\r\nleak" }],
      [{ carrier: "cookie" as const, name: "session_key", value: "secret; injected=yes" }],
    ]) {
      const rejectedUrl = new URL("https://api.example.com/v1/widgets");
      const rejectedHeaders = new Headers({ "X-Existing": "retained" });
      expect(() =>
        applyCredentialPlacements(rejectedUrl, rejectedHeaders, {
          audience: { origin: "https://api.example.com", pathPrefix: "/v1/" },
          placements,
        }),
      ).toThrow(IntegrationInvocationError);
      expect(rejectedUrl.toString()).toBe("https://api.example.com/v1/widgets");
      expect([...rejectedHeaders.entries()]).toEqual([["x-existing", "retained"]]);
    }
  });
});

describe("GraphQL compiler and invocation", () => {
  const introspection = introspectionFromSchema(
    buildSchema(`
      input WidgetInput { name: String! }
      type Widget { id: ID!, name: String! }
      type Query { widget(id: ID!): Widget }
      type Mutation { createWidget(input: WidgetInput!): Widget! }
    `),
  );

  test("compiles queries and mutations with approval-safe defaults", async () => {
    const revision = compileGraphqlRevision(introspection, {
      definitionId: "widgets-graphql",
      endpoint: "https://graphql.example.com/api",
    });
    expect(revision.tools).toEqual([
      expect.objectContaining({ id: "query_widget", safety: "read", approvalMode: "never" }),
      expect.objectContaining({
        id: "mutation_createwidget",
        safety: "write",
        approvalMode: "ask",
      }),
    ]);
    let body: Record<string, unknown> | null = null;
    const result = await invokeGraphqlOperation(
      {
        revision,
        endpoint: "https://graphql.example.com/api",
        authority,
        transport: directIntegrationTransport(async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ data: { widget: { id: "1", name: "One" } } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      },
      "query_widget",
      { id: "1", select: "id name" },
    );
    expect(body).toMatchObject({
      variables: { id: "1" },
      operationName: "query_widget",
    });
    expect(String(body?.query)).toContain("widget(id: $id) { id name }");
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { widget: { id: "1", name: "One" } },
      errors: null,
    });
  });

  test("rejects operation injection in a custom selection", () => {
    expect(() => validateGraphqlSelection("id } mutation Bad { createWidget")).toThrow(
      IntegrationInvocationError,
    );
  });
});

describe("provider adapters and MCP manifest", () => {
  test("converts Google Discovery methods and schema references into OpenAPI", () => {
    const openapi = googleDiscoveryToOpenApi({
      name: "gmail",
      title: "Gmail API",
      version: "v1",
      rootUrl: "https://gmail.googleapis.com/",
      servicePath: "",
      schemas: {
        LabelList: { type: "object", properties: { labels: { type: "array" } } },
      },
      resources: {
        users: {
          resources: {
            labels: {
              methods: {
                list: {
                  id: "gmail.users.labels.list",
                  path: "gmail/v1/users/{userId}/labels",
                  httpMethod: "GET",
                  parameters: {
                    userId: { type: "string", location: "path", required: true },
                  },
                  response: { $ref: "LabelList" },
                },
              },
            },
          },
        },
      },
    });
    const revision = compileOpenApiRevision(openapi, {
      definitionId: GOOGLE_GMAIL_INTEGRATION_DEFINITION.id,
      provider: "google",
    });
    expect(revision.tools).toEqual([
      expect.objectContaining({ id: "gmail_users_labels_list", safety: "read" }),
    ]);
  });

  test("filters the Microsoft Graph mega-spec to the selected workload", () => {
    const filtered = filterOpenApiDocumentForDefinition(
      {
        openapi: "3.1.0",
        info: { title: "Graph", version: "v1" },
        paths: {
          "/me/messages": { get: {} },
          "/me/messages/{id}": { delete: {} },
          "/me/drive": { get: {} },
        },
      },
      MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION,
    );
    expect(Object.keys(filtered.paths as Record<string, unknown>)).toEqual([
      "/me/messages",
      "/me/messages/{id}",
    ]);
    expect(filtered.servers).toEqual([{ url: "https://graph.microsoft.com/v1.0" }]);
    expect(MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION.provider).toEqual({
      id: "microsoft",
      domain: "graph.microsoft.com",
    });
  });

  test("limits Google Drive to the reviewed read-only operation set", () => {
    const filtered = filterOpenApiDocumentForDefinition(
      googleDiscoveryToOpenApi({
        name: "drive",
        title: "Drive API",
        version: "v3",
        rootUrl: "https://www.googleapis.com/",
        servicePath: "drive/v3/",
        resources: {
          files: {
            methods: {
              list: {
                id: "drive.files.list",
                path: "files",
                httpMethod: "GET",
              },
              get: {
                id: "drive.files.get",
                path: "files/{fileId}",
                httpMethod: "GET",
              },
              create: {
                id: "drive.files.create",
                path: "files",
                httpMethod: "POST",
              },
              update: {
                id: "drive.files.update",
                path: "files/{fileId}",
                httpMethod: "PATCH",
              },
              delete: {
                id: "drive.files.delete",
                path: "files/{fileId}",
                httpMethod: "DELETE",
              },
            },
          },
          permissions: {
            methods: {
              list: {
                id: "drive.permissions.list",
                path: "files/{fileId}/permissions",
                httpMethod: "GET",
              },
              create: {
                id: "drive.permissions.create",
                path: "files/{fileId}/permissions",
                httpMethod: "POST",
              },
            },
          },
        },
      }),
      GOOGLE_DRIVE_INTEGRATION_DEFINITION,
    );
    const revision = compileOpenApiRevision(filtered, {
      definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id,
      provider: "google",
    });

    expect(
      GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes.filter((scope) =>
        scope.startsWith("https://www.googleapis.com/auth/drive"),
      ),
    ).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
    expect(GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes).not.toContain(
      "https://www.googleapis.com/auth/drive",
    );
    expect(GOOGLE_DRIVE_INTEGRATION_DEFINITION.authentication.scopes).not.toContain(
      "https://www.googleapis.com/auth/drive.file",
    );
    expect(revision.tools.map((tool) => tool.operationKey).sort()).toEqual([
      "drive.files.get",
      "drive.files.list",
      "drive.permissions.list",
    ]);
    expect(revision.tools.every((tool) => tool.safety === "read")).toBe(true);
    expect(JSON.stringify(filtered)).not.toMatch(
      /drive\.(files\.(create|update|delete)|permissions\.create)/,
    );
  });

  test("projects malformed MCP entries out and deterministically resolves name collisions", () => {
    expect(
      extractMcpToolManifest({
        tools: [
          { name: "List Files", description: "First", inputSchema: { type: "object" } },
          { name: "list-files", description: "Second" },
          { name: "" },
          null,
        ],
      }).tools,
    ).toEqual([
      expect.objectContaining({ toolId: "list_files", toolName: "List Files" }),
      expect.objectContaining({ toolId: "list_files_2", toolName: "list-files" }),
    ]);
  });
});
