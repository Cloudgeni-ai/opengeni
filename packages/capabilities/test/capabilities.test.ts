import { describe, expect, test } from "bun:test";
import { buildSchema, introspectionFromSchema } from "graphql";

import {
  GOOGLE_GMAIL_PRESET,
  MICROSOFT_OUTLOOK_MAIL_PRESET,
  applyCredentialPlacements,
  compileGraphqlRevision,
  compileOpenApiRevision,
  directIntegrationTransport,
  extractMcpToolManifest,
  filterOpenApiDocumentForPreset,
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
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "204": { description: "Deleted" } },
        },
      },
    },
  };

  test("compiles deterministic safety metadata and invokes through destination-bound auth", async () => {
    const revision = compileOpenApiRevision(document, { integrationId: "widgets" });
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
    const revision = compileOpenApiRevision(document, { integrationId: "widgets" });
    let calls = 0;
    const invocation = invokeOpenApiOperation(
      {
        revision,
        authority,
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
      integrationId: "widgets-graphql",
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
      integrationId: GOOGLE_GMAIL_PRESET.id,
      provider: "google",
    });
    expect(revision.tools).toEqual([
      expect.objectContaining({ id: "gmail_users_labels_list", safety: "read" }),
    ]);
  });

  test("filters the Microsoft Graph mega-spec to the selected workload", () => {
    const filtered = filterOpenApiDocumentForPreset(
      {
        openapi: "3.1.0",
        info: { title: "Graph", version: "v1" },
        paths: {
          "/me/messages": { get: {} },
          "/me/messages/{id}": { delete: {} },
          "/me/drive": { get: {} },
        },
      },
      MICROSOFT_OUTLOOK_MAIL_PRESET,
    );
    expect(Object.keys(filtered.paths as Record<string, unknown>)).toEqual([
      "/me/messages",
      "/me/messages/{id}",
    ]);
    expect(filtered.servers).toEqual([{ url: "https://graph.microsoft.com/v1.0" }]);
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