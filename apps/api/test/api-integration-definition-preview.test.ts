import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  MAX_INTEGRATION_SPEC_BYTES,
  CORE_INTEGRATION_DEFINITIONS,
  integrationDefinitionById,
  type IntegrationDefinition,
} from "@opengeni/capabilities";
import { resolveApiIntegrationPreview } from "../src/integrations/api-integrations";

/** A reviewed definition pinned to a test document instead of the provider's. */
const pinnedTo =
  (source: string) =>
  (definitionId: string): IntegrationDefinition | undefined => {
    const definition = integrationDefinitionById(definitionId);
    if (!definition || definition.source.kind !== "openapi") return definition;
    return {
      ...definition,
      source: {
        ...definition.source,
        pinned: {
          url: "https://example.com/pinned.json",
          sha256: createHash("sha256").update(source).digest("hex"),
        },
      },
    };
  };

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
    definitionLookup: pinnedTo(source),
  };
  const resolved = await resolveApiIntegrationPreview({
    ...common,
    source: { kind: "definition", definitionId: "microsoft-outlook-mail" },
  });
  // The generic tools reach the definition's path scope; /users stays outside it.
  expect(resolved.preview.tools.map((tool) => tool.id)).toEqual([
    "mail_list",
    "find_operations",
    "call_read_operation",
    "call_change_operation",
  ]);
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
      "/me/events": operation,
      "/search/query": operation,
      "/me/contacts": operation,
      "/drives/{drive-id}/items/{driveItem-id}/children": operation,
      "/chats/{chat-id}/messages": operation,
    },
  });
  const common = {
    connection: null,
    transport: { fetch: async () => new Response(source) },
    authority: { accountId: "preview", workspaceId: "preview", initiatingSubjectId: "preview" },
    definitionLookup: pinnedTo(source),
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

test("a reviewed definition is read from its pinned document and refuses any other", async () => {
  const source = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Graph", version: "1" },
    paths: { "/me/messages": { get: { responses: { "200": { description: "OK" } } } } },
  });
  const requested: string[] = [];
  const preview = (definitionLookup?: typeof integrationDefinitionById) =>
    resolveApiIntegrationPreview({
      connection: null,
      transport: {
        fetch: async (input) => {
          requested.push(String(input));
          return new Response(source);
        },
      },
      authority: { accountId: "preview", workspaceId: "preview", initiatingSubjectId: "preview" },
      source: { kind: "definition", definitionId: "microsoft-outlook-mail" },
      ...(definitionLookup ? { definitionLookup } : {}),
    });
  // The provider's moving document changed: nothing is compiled from it.
  await expect(preview()).rejects.toThrow("did not match its pinned digest");
  const mail = integrationDefinitionById("microsoft-outlook-mail")!;
  if (mail.source.kind !== "openapi") throw new Error("expected OpenAPI");
  expect(requested).toEqual([mail.source.pinned!.url]);
  // The installation identity still follows the definition's source URL.
  const resolved = await preview(pinnedTo(source));
  expect(resolved.revision.source.url).toBe(mail.source.url);
});
