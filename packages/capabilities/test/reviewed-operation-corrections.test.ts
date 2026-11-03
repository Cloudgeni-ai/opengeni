import { describe, expect, test } from "bun:test";
import {
  MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION,
  MICROSOFT_SHAREPOINT_INTEGRATION_DEFINITION,
  MICROSOFT_TEAMS_INTEGRATION_DEFINITION,
  compileOpenApiRevision,
  filterOpenApiDocumentForDefinition,
  invokeOpenApiOperation,
  type IntegrationDefinition,
} from "../src";

const ok = { "200": { description: "OK" } };
const pathParameter = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
});
// Shapes from the Microsoft Graph v1.0 OpenAPI document.
const graph = {
  openapi: "3.0.4",
  info: { title: "Graph", version: "v1.0" },
  servers: [{ url: "https://graph.microsoft.com/v1.0" }],
  components: {
    parameters: { top: { name: "$top", in: "query", schema: { type: "integer" } } },
  },
  paths: {
    "/sites/{site-id}/getByPath(path='{path}')": {
      get: {
        operationId: "sites.site.getByPath",
        summary: "Invoke function getByPath",
        responses: ok,
      },
      parameters: [
        pathParameter("site-id"),
        { ...pathParameter("path"), description: "Usage: path='{path}'" },
      ],
    },
    "/sites/{site-id}": {
      get: { operationId: "sites.site.GetSite", responses: ok },
      parameters: [pathParameter("site-id")],
    },
    "/teams/{team-id}/channels/{channel-id}/messages": {
      get: {
        operationId: "teams.channels.ListMessages",
        parameters: [
          { $ref: "#/components/parameters/top" },
          {
            name: "$orderby",
            in: "query",
            style: "form",
            explode: false,
            schema: { type: "array" },
          },
          {
            name: "$expand",
            in: "query",
            style: "form",
            explode: false,
            schema: { type: "array" },
          },
        ],
        responses: ok,
      },
      post: {
        operationId: "teams.channels.CreateMessages",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: ok,
      },
      parameters: [pathParameter("team-id"), pathParameter("channel-id")],
    },
    "/me/messages": {
      get: { operationId: "me.ListMessages", summary: "Get open extension", responses: ok },
      post: {
        operationId: "me.CreateMessages",
        summary: "Create open extension",
        description: "Create an open extension (openTypeExtension object).",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: ok,
      },
    },
  },
};

const compile = (definition: IntegrationDefinition) =>
  compileOpenApiRevision(filterOpenApiDocumentForDefinition(structuredClone(graph), definition), {
    definitionId: definition.id,
    schemaMode: "provider_validated_json",
  });

async function fetchedUrl(
  definition: IntegrationDefinition,
  toolId: string,
  args: Record<string, unknown>,
): Promise<string> {
  let url = "";
  await invokeOpenApiOperation(
    {
      revision: compile(definition),
      authority: { accountId: "a", workspaceId: "w" },
      transport: {
        fetch: async (input) => {
          url = String(input);
          return Response.json({ id: "site" });
        },
      },
    },
    toolId,
    args,
  );
  return url;
}

describe("reviewed operation corrections", () => {
  test("a reviewed request path expands a path parameter as a path, keeping the tool", async () => {
    const sharepoint = MICROSOFT_SHAREPOINT_INTEGRATION_DEFINITION;
    const revision = compile(sharepoint);
    const tool = revision.tools.find((t) => t.operationKey === "sites.site.getByPath")!;
    expect(tool.id).toBe("sites_site_getbypath");
    expect(revision.bindings[tool.id]!.pathTemplate).toBe("/sites/{site-id}:/{path}");
    // Other operations of the same definition are unchanged.
    expect(revision.bindings.sites_site_getsite!.pathTemplate).toBe("/sites/{site-id}");
    for (const path of ["/sites/hr", "sites/hr", "/sites/hr/"]) {
      expect(
        await fetchedUrl(sharepoint, tool.id, {
          path: { "site-id": "contoso.sharepoint.com", path },
        }),
      ).toBe("https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/hr");
    }
    expect(
      await fetchedUrl(sharepoint, tool.id, {
        path: { "site-id": "contoso.sharepoint.com", path: "/sites/R&D Team/a?b#c" },
      }),
    ).toBe(
      "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/R%26D%20Team/a%3Fb%23c",
    );
    // Ordinary path parameters still encode "/".
    expect(await fetchedUrl(sharepoint, "sites_site_getsite", { path: { "site-id": "a/b" } })).toBe(
      "https://graph.microsoft.com/v1.0/sites/a%2Fb",
    );
    await expect(
      fetchedUrl(sharepoint, tool.id, {
        path: { "site-id": "contoso.sharepoint.com", path: "/sites/../me" },
      }),
    ).rejects.toMatchObject({ code: "parameter_invalid", outcome: "not_started" });
  });

  test("a query parameter the provider rejects is not offered, others stay", () => {
    const revision = compile(MICROSOFT_TEAMS_INTEGRATION_DEFINITION);
    const tool = revision.tools.find((t) => t.operationKey === "teams.channels.ListMessages")!;
    const query = (tool.inputSchema as { properties: { query: { properties: object } } }).properties
      .query.properties;
    expect(Object.keys(query).sort()).toEqual(["$expand", "$skiptoken", "$top"]);
    // The other method on the same path is untouched.
    expect(revision.tools.some((t) => t.operationKey === "teams.channels.CreateMessages")).toBe(
      true,
    );
  });

  test("reviewed text replaces a provider summary that describes another operation", () => {
    const revision = compile(MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION);
    const draft = revision.tools.find((t) => t.operationKey === "me.CreateMessages")!;
    expect(draft.name).toBe("Create draft message");
    expect(draft.description).toContain("Create a draft message");
    expect(draft.description).not.toContain("open extension");
    expect(revision.tools.find((t) => t.operationKey === "me.ListMessages")!.name).toBe(
      "List messages",
    );
  });
});
