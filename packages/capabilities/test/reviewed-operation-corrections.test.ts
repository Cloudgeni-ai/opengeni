import { describe, expect, test } from "bun:test";
import {
  CORE_INTEGRATION_DEFINITIONS,
  MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION,
  MICROSOFT_SHAREPOINT_INTEGRATION_DEFINITION,
  MICROSOFT_TEAMS_INTEGRATION_DEFINITION,
  compileOpenApiRevision,
  filterOpenApiDocumentForDefinition,
  invokeOpenApiOperation,
  type IntegrationDefinition,
} from "../src";
import { requestPathTemplate } from "../src/integration-definitions";

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

  test("an already percent-encoded path is encoded once, and its path guidance is generic", async () => {
    const sharepoint = MICROSOFT_SHAREPOINT_INTEGRATION_DEFINITION;
    const args = (path: string) => ({ path: { "site-id": "contoso.sharepoint.com", path } });
    const expected =
      "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/R%26D%20Team";
    expect(await fetchedUrl(sharepoint, "sites_site_getbypath", args("/sites/R%26D%20Team"))).toBe(
      expected,
    );
    expect(await fetchedUrl(sharepoint, "sites_site_getbypath", args("/sites/R&D Team"))).toBe(
      expected,
    );
    // A literal % that is not an escape stays a literal %.
    expect(await fetchedUrl(sharepoint, "sites_site_getbypath", args("/sites/100%"))).toBe(
      "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/100%25",
    );
    await expect(
      fetchedUrl(sharepoint, "sites_site_getbypath", args("/sites/%2e%2e/me")),
    ).rejects.toMatchObject({ code: "parameter_invalid" });
    const tool = compile(sharepoint).tools.find((t) => t.id === "sites_site_getbypath")!;
    const pathSchema = (
      tool.inputSchema as { properties: { path: { properties: Record<string, unknown> } } }
    ).properties.path.properties.path;
    expect(JSON.stringify(pathSchema)).not.toContain("path='");
  });

  test("path values that would move the request or are not text are recoverable errors", async () => {
    const sharepoint = MICROSOFT_SHAREPOINT_INTEGRATION_DEFINITION;
    for (const siteId of ["..", ".", "\uD800"]) {
      await expect(
        fetchedUrl(sharepoint, "sites_site_getsite", { path: { "site-id": siteId } }),
      ).rejects.toMatchObject({ code: "parameter_invalid", outcome: "not_started" });
    }
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
    expect(draft.description).toContain("Create a new email draft in");
    expect(draft.description).not.toContain("open extension");
    expect(revision.tools.find((t) => t.operationKey === "me.ListMessages")!.name).toBe(
      "List messages",
    );
  });

  test("a request path onto an existing path merges methods; shared query parameters can be omitted", async () => {
    const spec = {
      openapi: "3.0.4",
      info: { title: "Files", version: "1" },
      servers: [{ url: "https://api.example.com/v1" }],
      paths: {
        "/drives/{drive-id}/root:/{path}": {
          delete: { operationId: "items.delete", responses: ok },
          parameters: [pathParameter("drive-id"), pathParameter("path")],
        },
        "/drives/{drive-id}/getByPath(path='{path}')": {
          get: { operationId: "items.getByPath", responses: ok },
          parameters: [
            pathParameter("drive-id"),
            pathParameter("path"),
            { name: "$orderby", in: "query", schema: { type: "string" } },
            { name: "$top", in: "query", schema: { type: "integer" } },
          ],
        },
      },
    };
    const definition = {
      ...MICROSOFT_SHAREPOINT_INTEGRATION_DEFINITION,
      id: "files",
      source: {
        kind: "openapi",
        url: "https://api.example.com/openapi.json",
        operationAllowlist: [
          { path: "/drives/{drive-id}/root:/{path}", method: "delete" },
          {
            path: "/drives/{drive-id}/getByPath(path='{path}')",
            method: "get",
            requestPath: "/drives/{drive-id}/root:/{+path}",
            omitQueryParameters: ["$orderby"],
          },
        ],
      },
    } as unknown as IntegrationDefinition;
    const filtered = filterOpenApiDocumentForDefinition(structuredClone(spec), definition);
    const merged = (filtered.paths as Record<string, Record<string, unknown>>)[
      "/drives/{drive-id}/root:/{path}"
    ]!;
    expect(Object.keys(merged).filter((key) => key === "get" || key === "delete")).toEqual([
      "delete",
      "get",
    ]);
    const revision = compileOpenApiRevision(filtered, { definitionId: "files" });
    const get = revision.bindings.items_getbypath!;
    expect(get.parameters.map((p) => p.name).sort()).toEqual(["$top", "drive-id", "path"]);
    expect(get.parameters.find((p) => p.name === "path")!.allowReserved).toBe(true);
    expect(
      revision.bindings.items_delete!.parameters.find((p) => p.name === "path")!.allowReserved,
    ).toBeUndefined();

    const collision = {
      ...definition,
      source: {
        ...definition.source,
        operationAllowlist: [
          {
            path: "/drives/{drive-id}/root:/{path}",
            method: "delete",
          },
          {
            path: "/drives/{drive-id}/getByPath(path='{path}')",
            method: "get",
            requestPath: "/drives/{drive-id}/root:/{+path}",
          },
          {
            path: "/drives/{drive-id}/getByPath(path='{path}')",
            method: "get",
            requestPath: "/drives/{drive-id}/root:/{+path}",
          },
        ],
      },
    } as unknown as IntegrationDefinition;
    expect(() =>
      filterOpenApiDocumentForDefinition(structuredClone(spec), collision),
    ).not.toThrow();
    const clash = structuredClone(spec) as typeof spec & { paths: Record<string, unknown> };
    clash.paths["/drives/{drive-id}/root:/{path}"] = {
      ...spec.paths["/drives/{drive-id}/root:/{path}"],
      get: { operationId: "items.get", responses: ok },
    };
    const both = {
      ...definition,
      source: {
        ...definition.source,
        operationAllowlist: [
          { path: "/drives/{drive-id}/root:/{path}", method: "get" },
          ...(definition.source as { operationAllowlist: unknown[] }).operationAllowlist.slice(1),
        ],
      },
    } as unknown as IntegrationDefinition;
    expect(() => filterOpenApiDocumentForDefinition(clash, both)).toThrow(/twice/);
  });

  test("a colon in the first path segment stays a path, not a URL scheme", async () => {
    const revision = compileOpenApiRevision(
      {
        openapi: "3.0.4",
        info: { title: "Files", version: "1" },
        servers: [{ url: "https://api.example.com/v1" }],
        paths: {
          "/{drive-id}:/{path}": {
            get: { operationId: "items.get", responses: ok },
            parameters: [
              pathParameter("drive-id"),
              { ...pathParameter("path"), allowReserved: true },
            ],
          },
        },
      },
      { definitionId: "files" },
    );
    let url = "";
    await invokeOpenApiOperation(
      {
        revision,
        authority: { accountId: "a", workspaceId: "w" },
        transport: {
          fetch: async (input) => {
            url = String(input);
            return Response.json({});
          },
        },
      },
      "items_get",
      { path: { "drive-id": "d", path: "a/b" } },
    );
    expect(url).toBe("https://api.example.com/v1/d:/a/b");
  });

  test("every path parameter only a reviewed request path names is described", () => {
    const names = (path: string) => [...path.matchAll(/\{\+?([^}]+)\}/g)].map((m) => m[1]!);
    for (const definition of CORE_INTEGRATION_DEFINITIONS) {
      if (definition.source.kind !== "openapi") continue;
      for (const entry of definition.source.operationAllowlist ?? []) {
        if (!entry.requestPath) continue;
        const added = names(requestPathTemplate(entry.requestPath)).filter(
          (name) => !names(entry.path).includes(name),
        );
        for (const name of added) expect(entry.pathParameterDescriptions?.[name]).toBeString();
      }
    }
  });

  test("a request path with other path parameters gets its own parameter list", async () => {
    const spec = {
      openapi: "3.0.4",
      info: { title: "Files", version: "1" },
      servers: [{ url: "https://api.example.com/v1" }],
      paths: {
        "/drives/{drive-id}/items/{item-id}": {
          get: {
            operationId: "items.get",
            parameters: [{ name: "$select", in: "query", schema: { type: "string" } }],
            responses: ok,
          },
          parameters: [pathParameter("drive-id"), pathParameter("item-id")],
        },
      },
    };
    const definition = {
      ...MICROSOFT_SHAREPOINT_INTEGRATION_DEFINITION,
      id: "files",
      source: {
        kind: "openapi",
        url: "https://api.example.com/openapi.json",
        operationAllowlist: [
          { path: "/drives/{drive-id}/items/{item-id}", method: "get" },
          {
            path: "/drives/{drive-id}/items/{item-id}",
            method: "get",
            operationId: "items.getByPath",
            summary: "Get item by path",
            requestPath: "/drives/{drive-id}/root:/{+path}",
            pathParameterDescriptions: { path: "The item's path." },
          },
        ],
      },
    } as unknown as IntegrationDefinition;
    const revision = compileOpenApiRevision(filterOpenApiDocumentForDefinition(spec, definition), {
      definitionId: "files",
    });
    // The provider operation keeps its tool; the reviewed one is a second tool.
    expect(revision.tools.map((tool) => tool.id).sort()).toEqual(["items_get", "items_getbypath"]);
    const byPath = revision.tools.find((tool) => tool.id === "items_getbypath")!;
    expect(byPath.name).toBe("Get item by path");
    const pathSchema = (byPath.inputSchema as { properties: { path: Record<string, unknown> } })
      .properties.path as {
      properties: Record<string, { description?: string }>;
      required: string[];
    };
    expect(Object.keys(pathSchema.properties).sort()).toEqual(["drive-id", "path"]);
    expect(pathSchema.required.sort()).toEqual(["drive-id", "path"]);
    expect(pathSchema.properties.path!.description).toBe("The item's path.");
    expect(
      revision.bindings.items_getbypath!.parameters.map((parameter) => parameter.name).sort(),
    ).toEqual(["$select", "drive-id", "path"]);
    let url = "";
    await invokeOpenApiOperation(
      {
        revision,
        authority: { accountId: "a", workspaceId: "w" },
        transport: {
          async fetch(input) {
            url = String(input);
            return Response.json({});
          },
        },
      },
      "items_getbypath",
      { path: { "drive-id": "d", path: "Documents/Q4 plan.docx" } },
    );
    expect(url).toBe("https://graph.microsoft.com/v1.0/drives/d/root:/Documents/Q4%20plan.docx");
  });
});
