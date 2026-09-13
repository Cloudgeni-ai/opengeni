import { expect, test } from "bun:test";
import { MAX_INTEGRATION_SPEC_BYTES } from "@opengeni/capabilities";
import { resolveApiIntegrationPreview } from "../src/integrations/api-integrations";

test("curated Microsoft preview parses documents above the custom-source limit", async () => {
  const source = JSON.stringify({
    openapi: "3.1.0",
    info: {
      title: "Microsoft Graph",
      version: "1",
      description: "x".repeat(MAX_INTEGRATION_SPEC_BYTES),
    },
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
