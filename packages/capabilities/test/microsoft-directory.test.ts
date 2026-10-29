import { expect, test } from "bun:test";
import {
  INTEGRATION_DEFINITION_PRESENTATIONS,
  MICROSOFT_OUTLOOK_CONTACTS_INTEGRATION_DEFINITION as contacts,
  MICROSOFT_SHAREPOINT_INTEGRATION_DEFINITION as sharepoint,
  MICROSOFT_TEAMS_INTEGRATION_DEFINITION as teams,
  compileOpenApiRevision,
  filterOpenApiDocumentForDefinition,
  integrationDefinitionReadOnlyOperations,
  integrationOperationDisplayTitle,
  invokeOpenApiOperation,
  type IntegrationDefinition,
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
const consistencyLevel = { name: "ConsistencyLevel", in: "header", schema: { type: "string" } };
const document = {
  openapi: "3.1.0",
  info: { title: "Graph", version: "1" },
  servers: [{ url: "https://graph.microsoft.com/v1.0" }],
  paths: {
    "/users": {
      get: operation("users.user.ListUser", {
        parameters: [
          consistencyLevel,
          { name: "$search", in: "query", schema: { type: "string" } },
        ],
      }),
      post: operation("users.user.CreateUser", json),
    },
    "/users/{user-id}": {
      parameters: [{ name: "user-id", in: "path", required: true, schema: { type: "string" } }],
      get: operation("users.user.GetUser"),
      patch: operation("users.user.UpdateUser", json),
      delete: operation("users.user.DeleteUser"),
    },
    "/users/{user-id}/manager": {
      parameters: [{ name: "user-id", in: "path", required: true, schema: { type: "string" } }],
      get: operation("users.GetManager"),
    },
    "/users/{user-id}/directReports": {
      parameters: [{ name: "user-id", in: "path", required: true, schema: { type: "string" } }],
      get: operation("users.ListDirectReports"),
    },
    "/me/manager": { get: operation("me.GetManager") },
    "/me/manager/$ref": {
      put: operation("me.UpdateManagerRef", json),
      delete: operation("me.DeleteManagerRef"),
    },
    "/me/directReports": { get: operation("me.ListDirectReports") },
    "/me/directReports/{directoryObject-id}": {
      get: operation("me.GetDirectReports"),
    },
    "/me/directReports/$count": { get: operation("me.directReports.GetCount") },
    "/me/directReports/graph.user": { get: operation("me.ListDirectReports.AsUser") },
    "/me/contacts": { get: operation("me.ListContacts") },
  },
};

const compile = (definition: IntegrationDefinition) =>
  compileOpenApiRevision(filterOpenApiDocumentForDefinition(document, definition), {
    definitionId: definition.id,
    schemaMode: "provider_validated_json",
    readOnlyOperations: integrationDefinitionReadOnlyOperations(definition),
  });

const lookupKeys = [
  "me.ListDirectReports",
  "users.ListDirectReports",
  "users.user.GetUser",
  "users.user.ListUser",
];
const managerKeys = ["me.GetManager", "users.GetManager"];

test.each([
  [sharepoint, "User.ReadBasic.All", lookupKeys],
  // Microsoft requires User.Read.All for any manager lookup.
  [teams, "User.Read.All", [...lookupKeys, ...managerKeys]],
] as const)(
  "%# work-account integrations can look up colleagues read-only",
  (definition, scope, expected) => {
    const compiled = compile(definition);
    const keys = compiled.tools.map((tool) => tool.operationKey);
    const tools = compiled.tools.filter((tool) =>
      [...lookupKeys, ...managerKeys].includes(tool.operationKey),
    );
    expect(tools.map((tool) => tool.operationKey).sort()).toEqual([...expected].sort());
    expect(keys).not.toContain("users.user.CreateUser");
    expect(keys).not.toContain("users.user.UpdateUser");
    expect(keys).not.toContain("me.UpdateManagerRef");
    for (const tool of tools) {
      expect(tool).toMatchObject({ safety: "read", approvalMode: "never" });
      expect(compiled.bindings[tool.id]!.requiredScopeAlternatives).toEqual([[scope]]);
    }
    expect(definition.authentication.scopes).toContain(scope);
    expect(INTEGRATION_DEFINITION_PRESENTATIONS[definition.id]?.scopeLabels?.[scope]).toBeDefined();
  },
);

test("Outlook Contacts stays free of directory tools so personal accounts can connect", () => {
  const keys = compile(contacts).tools.map((tool) => tool.operationKey);
  expect(keys).toEqual(["me.ListContacts"]);
  expect(contacts.authentication.scopes).toEqual([
    "offline_access",
    "User.Read",
    "Contacts.ReadWrite",
    "People.Read",
  ]);
  expect(contacts.authentication.authorizationUrl).toContain("/common/");
});

test("Directory search passes the eventual-consistency header Microsoft requires", async () => {
  const compiled = compile(teams);
  const list = compiled.tools.find((tool) => tool.operationKey === "users.user.ListUser")!;
  let request: { url: string; headers: Headers } | undefined;
  await invokeOpenApiOperation(
    {
      revision: compiled,
      authority: { accountId: "a", workspaceId: "w" },
      transport: {
        fetch: async (url, init) => {
          request = { url: String(url), headers: new Headers(init?.headers) };
          return new Response(JSON.stringify({ value: [] }));
        },
      },
    },
    list.id,
    {
      header: { ConsistencyLevel: "eventual" },
      query: { $search: '"displayName:anna"' },
    },
  );
  expect(new URL(request!.url).pathname).toBe("/v1.0/users");
  expect(new URL(request!.url).searchParams.get("$search")).toBe('"displayName:anna"');
  expect(request!.headers.get("ConsistencyLevel")).toBe("eventual");
});

test("Directory operations have plain titles", () => {
  const title = (key: string) =>
    integrationOperationDisplayTitle(key, {
      method: "get",
      serverUrl: "https://graph.microsoft.com/v1.0",
    });
  expect(title("users.user.ListUser")).toBe("Find colleagues");
  expect(title("users.user.GetUser")).toBe("Read a colleague's profile");
  expect(title("me.GetManager")).toBe("Read a manager");
  expect(title("users.ListDirectReports")).toBe("Read direct reports");
});
