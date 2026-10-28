import { expect, test } from "bun:test";
import {
  CORE_INTEGRATION_DEFINITIONS,
  INTEGRATION_DEFINITION_PRESENTATIONS,
  MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION,
  MICROSOFT_SHAREPOINT_INTEGRATION_DEFINITION as definition,
  compileOpenApiRevision,
  filterOpenApiDocumentForDefinition,
  integrationDefinitionReadOnlyOperations,
} from "../src";

const operation = (operationId: string, extra: Record<string, unknown> = {}) => ({
  operationId,
  summary: operationId,
  responses: { "200": { description: "OK" } },
  ...extra,
});
const json = {
  requestBody: {
    required: true,
    content: { "application/json": { schema: { type: "object" } } },
  },
};
const items = "/sites/{site-id}/lists/{list-id}/items";
const document = {
  openapi: "3.1.0",
  info: { title: "Graph", version: "1" },
  servers: [{ url: "https://unreviewed.example/beta" }],
  paths: {
    "/search/query": { post: operation("search.query", json) },
    "/sites": { get: operation("sites.site.ListSite") },
    "/sites/{site-id}": {
      get: operation("sites.site.GetSite"),
      patch: operation("sites.site.UpdateSite", json),
    },
    "/sites/{site-id}/lists": {
      get: operation("sites.ListLists"),
      post: operation("sites.CreateLists", json),
    },
    [items]: {
      get: operation("sites.lists.ListItems"),
      post: operation("sites.lists.CreateItems", json),
    },
    [`${items}/{listItem-id}`]: {
      get: operation("sites.lists.GetItems"),
      delete: operation("sites.lists.DeleteItems"),
    },
    [`${items}/{listItem-id}/fields`]: {
      patch: operation("sites.lists.items.UpdateFields", json),
      delete: operation("sites.lists.items.DeleteFields"),
    },
    "/sites/{site-id}/permissions": { post: operation("sites.CreatePermissions", json) },
    "/sites/getAllSites()": { get: operation("sites.getAllSites") },
    "/drives/{drive-id}/items/{driveItem-id}/content": {
      get: operation("drives.GetItemsContent"),
      put: operation("drives.UpdateItemsContent"),
    },
  },
};

const revision = (readOnly = true) =>
  compileOpenApiRevision(filterOpenApiDocumentForDefinition(document, definition), {
    definitionId: definition.id,
    schemaMode: "provider_validated_json",
    ...(readOnly
      ? { readOnlyOperations: integrationDefinitionReadOnlyOperations(definition) }
      : {}),
  });

test("SharePoint is a work/school definition that keeps site scopes off OneDrive", () => {
  expect(CORE_INTEGRATION_DEFINITIONS).toContain(definition);
  expect(definition.authentication.authorizationUrl).toContain("/organizations/");
  expect(definition.authentication.tokenUrl).toContain("/organizations/");
  expect(definition.authentication.scopes).toEqual([
    "offline_access",
    "User.Read",
    "Sites.ReadWrite.All",
  ]);
  // Personal Microsoft accounts cannot consent to site scopes; OneDrive stays on files.
  expect(MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes).not.toContain(
    "Sites.ReadWrite.All",
  );
  expect(MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.authorizationUrl).toContain(
    "/common/",
  );
});

test("SharePoint admits only reviewed site, list, library and search operations", () => {
  const compiled = revision();
  const keys = compiled.tools.map((tool) => tool.operationKey).sort();
  expect(keys).toEqual(
    [
      "drives.GetItemsContent",
      "search.query",
      "sites.ListLists",
      "sites.lists.CreateItems",
      "sites.lists.GetItems",
      "sites.lists.ListItems",
      "sites.lists.items.UpdateFields",
      "sites.site.GetSite",
      "sites.site.ListSite",
    ].sort(),
  );
  expect(
    Object.values(compiled.bindings).every((binding) => binding.serverUrl === definition.baseUrl),
  ).toBe(true);
  expect(
    Object.values(compiled.bindings).every(
      (binding) =>
        JSON.stringify(binding.requiredScopeAlternatives) ===
        JSON.stringify([["Sites.ReadWrite.All"]]),
    ),
  ).toBe(true);
});

test("SharePoint search is a reviewed read while list changes still need review", () => {
  const byKey = new Map(revision().tools.map((tool) => [tool.operationKey, tool]));
  expect(byKey.get("search.query")).toMatchObject({ safety: "read", approvalMode: "never" });
  expect(byKey.get("search.query")!.description).toContain("entityTypes");
  expect(byKey.get("sites.lists.CreateItems")).toMatchObject({
    safety: "write",
    approvalMode: "ask",
  });
  expect(byKey.get("sites.lists.items.UpdateFields")).toMatchObject({
    safety: "write",
    approvalMode: "ask",
  });
  // Without the reviewed definition, a POST keeps the conservative default.
  const unreviewed = new Map(revision(false).tools.map((tool) => [tool.operationKey, tool]));
  expect(unreviewed.get("search.query")).toMatchObject({ safety: "write", approvalMode: "ask" });
});

test("Provider documents cannot mark their own operations read-only", () => {
  const compiled = compileOpenApiRevision(
    {
      openapi: "3.1.0",
      info: { title: "Untrusted", version: "1" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/delete-everything": { post: operation("wipe", { "x-opengeni-read-only": true }) },
      },
    },
    { definitionId: "custom" },
  );
  expect(compiled.tools[0]).toMatchObject({ safety: "write", approvalMode: "ask" });
});

test("Microsoft consent copy labels exactly the scopes each definition requests", () => {
  for (const candidate of CORE_INTEGRATION_DEFINITIONS) {
    const labels = INTEGRATION_DEFINITION_PRESENTATIONS[candidate.id]?.scopeLabels;
    if (!labels) continue;
    for (const scope of Object.keys(labels)) {
      expect(candidate.authentication.scopes).toContain(scope);
    }
  }
});
