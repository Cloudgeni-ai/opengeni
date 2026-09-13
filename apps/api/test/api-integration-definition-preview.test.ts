import { expect, test } from "bun:test";
import { MAX_INTEGRATION_SPEC_BYTES, CORE_INTEGRATION_DEFINITIONS } from "@opengeni/capabilities";
import { resolveApiIntegrationPreview } from "../src/integrations/api-integrations";

test("curated Microsoft preview parses documents above the custom-source limit", async () => {
  const source = JSON.stringify({
    openapi: "3.1.0",
    info: {
      title: "Microsoft Graph",
      version: "1",
    },
    "x-unused-documentation": "x".repeat(MAX_INTEGRATION_SPEC_BYTES),
    paths: {
      "/me/messages": {
        get: {
          operationId: "mail.list",
          responses: { "200": { description: "Messages" } },
        },
      },
      "/users": {
        get: {
          operationId: "users.list",
          responses: { "200": { description: "Users" } },
        },
      },
    },
  });
  const common = {
    connection: null,
    transport: { fetch: async () => new Response(source) },
    authority: {
      accountId: "preview",
      workspaceId: "preview",
      initiatingSubjectId: "preview",
    },
  };
  const resolved = await resolveApiIntegrationPreview({
    ...common,
    source: { kind: "definition", definitionId: "microsoft-outlook-mail" },
  });
  expect(resolved.preview.tools.map((tool) => tool.id)).toEqual(["mail_list"]);
  await expect(
    resolveApiIntegrationPreview({
      ...common,
      source: { kind: "openapi", url: "https://example.com/openapi.json" },
    }),
  ).rejects.toThrow();
});

test("Microsoft definitions persist bounded provider-validated schemas; custom sources stay full", async () => {
  const operation = {
    post: {
      operationId: "create",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/Entity" } } },
      },
      responses: { "200": { description: "OK" } },
    },
  };
  const source = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Graph", version: "1" },
    servers: [{ url: "https://graph.microsoft.com/v1.0/" }],
    components: {
      schemas: { Entity: { type: "object", description: "x".repeat(3 * 1024 * 1024) } },
    },
    paths: {
      "/me/messages": operation,
      "/me/calendar": operation,
      "/me/contacts": operation,
      "/me/drive": operation,
    },
  });
  const common = {
    connection: null,
    transport: { fetch: async () => new Response(source) },
    authority: { accountId: "preview", workspaceId: "preview", initiatingSubjectId: "preview" },
  };
  for (const definition of CORE_INTEGRATION_DEFINITIONS.filter(
    (d) => d.provider.id === "microsoft",
  )) {
    const result = await resolveApiIntegrationPreview({
      ...common,
      source: { kind: "definition", definitionId: definition.id },
    });
    expect(JSON.stringify(result.revision).length).toBeLessThan(10_000);
  }
  await expect(
    resolveApiIntegrationPreview({
      ...common,
      source: { kind: "openapi", url: "https://example.com/api.json" },
    }),
  ).rejects.toThrow("storage limit");
});
