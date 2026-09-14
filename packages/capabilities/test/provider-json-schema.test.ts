import { expect, test } from "bun:test";
import { compileOpenApiRevision, createOpenApiMcpServer, invokeOpenApiOperation } from "../src";
import {
  MICROSOFT_OUTLOOK_CONTACTS_INTEGRATION_DEFINITION,
  MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION,
  filterOpenApiDocumentForDefinition,
} from "../src";

test("Contacts and OneDrive request delegated scopes supported by personal accounts", () => {
  expect(MICROSOFT_OUTLOOK_CONTACTS_INTEGRATION_DEFINITION.authentication.scopes).toEqual([
    "offline_access",
    "User.Read",
    "Contacts.ReadWrite",
    "People.Read",
  ]);
  expect(MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes).toEqual([
    "offline_access",
    "User.Read",
    "Files.ReadWrite.All",
  ]);
  const filtered = filterOpenApiDocumentForDefinition(
    {
      paths: {
        "/me/drive": {},
        "/me/followedSites": {},
        "/me/followedSites/{id}": {},
      },
    },
    MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION,
  );
  expect(Object.keys(filtered.paths as object)).toEqual(["/me/drive"]);
});

const document = {
  openapi: "3.1.0",
  info: { title: "Provider", version: "1" },
  servers: [{ url: "https://graph.microsoft.com/v1.0/" }],
  components: {
    schemas: {
      Entity: {
        type: "object",
        required: ["subject"],
        properties: {
          subject: { type: "string" },
          children: { type: "array", items: { $ref: "#/components/schemas/Entity" } },
        },
      },
    },
  },
  paths: {
    "/me/messages/{id}": {
      post: {
        operationId: "message.create",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        security: [{ delegated: ["Mail.ReadWrite"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Entity" } },
            "application/octet-stream": { schema: { type: "string", format: "binary" } },
          },
        },
        responses: {
          "200": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Entity" } } },
          },
        },
      },
    },
  },
};

test("explicit provider JSON mode bounds metadata without changing wire bodies or authorization", async () => {
  const revision = compileOpenApiRevision(document, {
    definitionId: "provider",
    schemaMode: "provider_validated_json",
  });
  const full = compileOpenApiRevision(document, { definitionId: "provider" });
  expect(revision.id).not.toBe(full.id);
  expect(full.tools[0]!.outputSchema).toBeDefined();
  expect(revision.tools[0]!.outputSchema).toBeUndefined();
  expect(revision.tools[0]).toMatchObject({
    safety: "write",
    approvalMode: "ask",
    inputSchema: { required: ["path", "body"] },
  });
  expect(revision.bindings.message_create!.requiredScopeAlternatives).toEqual([["Mail.ReadWrite"]]);
  expect(
    revision.bindings.message_create!.requestBody!.schemas["application/octet-stream"],
  ).toEqual({ type: "string", format: "binary" });
  const calls: RequestInit[] = [];
  const options = {
    revision,
    authority: { accountId: "a", workspaceId: "w", initiatingSubjectId: "u" },
    transport: {
      fetch: async (_url: unknown, init?: RequestInit) => {
        calls.push(init!);
        return new Response("{}");
      },
    },
  };
  const tools = await createOpenApiMcpServer(options).listTools();
  expect(tools[0]!.inputSchema.properties!.body).toEqual({
    description: expect.stringContaining("provider validates"),
  });
  const body = { subject: "Example", nested: { arbitrary: [1, true, null] } };
  await invokeOpenApiOperation(options, "message_create", { path: { id: "1" }, body });
  await invokeOpenApiOperation(options, "message_create", {
    path: { id: "1" },
    body: "bytes",
    contentType: "application/octet-stream",
  });
  expect(calls.map((call) => call.body)).toEqual([JSON.stringify(body), "bytes"]);
});

test("provider JSON mode never traverses large recursive entity schemas", () => {
  const entity = {
    type: "object",
    description: "x".repeat(1024 * 1024),
    properties: {
      left: { $ref: "#/components/schemas/Entity" },
      right: { $ref: "#/components/schemas/Entity" },
    },
  };
  const revision = compileOpenApiRevision(
    { ...document, components: { schemas: { Entity: entity } } },
    {
      definitionId: "provider",
      schemaMode: "provider_validated_json",
    },
  );
  expect(JSON.stringify(revision).length).toBeLessThan(10_000);
});
