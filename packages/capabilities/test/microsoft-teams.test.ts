import { expect, test } from "bun:test";
import {
  MICROSOFT_TEAMS_INTEGRATION_DEFINITION as definition,
  compileOpenApiRevision,
  filterOpenApiDocumentForDefinition,
  invokeOpenApiOperation,
  isIntegrationDefinitionEnabled,
} from "../src";

const messages = "/chats/{chat-id}/messages";
const operation = (operationId: string) => ({
  operationId,
  responses: { "200": { description: "OK" } },
});
const document = {
  openapi: "3.1.0",
  info: { title: "Graph", version: "1" },
  servers: [{ url: "https://unreviewed.example/beta" }],
  paths: {
    [messages]: {
      parameters: [{ name: "chat-id", in: "path", required: true, schema: { type: "string" } }],
      servers: [{ url: "https://unreviewed.example" }],
      get: operation("chat.read"),
      post: {
        ...operation("chat.send"),
        servers: [{ url: "https://unreviewed.example" }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
      },
      delete: operation("chat.delete"),
      patch: operation("chat.edit"),
    },
    "/chats/{chat-id}/members": { post: operation("members.add") },
    "/chats/getAllMessages()": { get: operation("messages.export") },
    "/teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/softDelete": {
      post: operation("message.softDelete"),
    },
    "/teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/replies": {
      get: operation("replies.read"),
      post: operation("replies.send"),
    },
    "/teams": { post: operation("team.create") },
    "/search/query": { post: operation("search") },
  },
};
const revision = () =>
  compileOpenApiRevision(filterOpenApiDocumentForDefinition(document, definition), {
    definitionId: definition.id,
    schemaMode: "provider_validated_json",
  });

test("Teams uses work/school delegated permissions without migration or tenant administration grants", () => {
  expect(definition.authentication.authorizationUrl).toContain("/organizations/");
  expect(definition.authentication.scopes).toEqual([
    "offline_access",
    "User.Read",
    "Team.ReadBasic.All",
    "Channel.ReadBasic.All",
    "ChannelMessage.Read.All",
    "ChannelMessage.Send",
    "Chat.Read",
    "ChatMessage.Send",
  ]);
  expect(definition.baseUrl).toBe("https://graph.microsoft.com/v1.0");
});

test("Teams rollout defaults closed and allows only an exact workspace or explicit global activation", () => {
  expect(isIntegrationDefinitionEnabled(definition.id)).toBe(false);
  expect(
    isIntegrationDefinitionEnabled(definition.id, { teamsAllowedWorkspaceIds: ["pilot"] }),
  ).toBe(false);
  expect(
    isIntegrationDefinitionEnabled(definition.id, {
      teamsAllowedWorkspaceIds: ["pilot"],
      workspaceId: "other",
    }),
  ).toBe(false);
  expect(
    isIntegrationDefinitionEnabled(definition.id, {
      teamsAllowedWorkspaceIds: ["pilot"],
      workspaceId: "pilot",
    }),
  ).toBe(true);
  expect(isIntegrationDefinitionEnabled(definition.id, { teamsEnabled: true })).toBe(true);
  expect(isIntegrationDefinitionEnabled("microsoft-outlook-mail")).toBe(true);
});

test("Teams projection excludes unreviewed methods and admin/export/search paths and preserves approval classification", () => {
  const compiled = revision();
  expect(compiled.tools.map((tool) => [tool.operationKey, tool.safety, tool.approvalMode])).toEqual(
    [
      ["chat.read", "read", "never"],
      ["chat.send", "write", "ask"],
      ["replies.read", "read", "never"],
      ["replies.send", "write", "ask"],
    ],
  );
  expect(compiled.bindings.chat_send!.parameters[0]!.name).toBe("chat-id");
  expect(compiled.bindings.chat_send!.requiredScopeAlternatives).toEqual([["ChatMessage.Send"]]);
  expect(compiled.bindings.replies_send!.requiredScopeAlternatives).toEqual([
    ["ChannelMessage.Send"],
  ]);
  expect(compiled.bindings.replies_read!.requiredScopeAlternatives).toEqual([
    ["ChannelMessage.Read.All"],
  ]);
  expect(
    Object.values(compiled.bindings).every((binding) => binding.serverUrl === definition.baseUrl),
  ).toBe(true);
  expect(() =>
    filterOpenApiDocumentForDefinition(
      { paths: { "/search/query": document.paths["/search/query"] } },
      definition,
    ),
  ).toThrow("did not match");
});

test("Teams sends preserve message bytes and use the exact connection and delegated scope at the provider boundary", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const resolutions: unknown[] = [];
  let authorized = 0;
  const body = { body: { contentType: "text", content: "Hello <exact text> & team!" } };
  await invokeOpenApiOperation(
    {
      revision: revision(),
      authority: {
        accountId: "a",
        workspaceId: "pilot",
        initiatingSubjectId: "human:alice",
        connectionRef: "alice-connection",
      },
      credentialResolver: {
        resolve: async (input) => {
          resolutions.push(input);
          return {
            audience: { origin: "https://graph.microsoft.com", pathPrefix: "/v1.0" },
            placements: [
              { carrier: "header", name: "Authorization", prefix: "Bearer ", value: "test-token" },
            ],
            authorizeProviderRequest: async () => {
              authorized++;
              return true;
            },
          };
        },
      },
      transport: {
        fetch: async (url, init) => {
          requests.push({ url: String(url), init: init! });
          return new Response(JSON.stringify({ id: "sent" }), { status: 201 });
        },
      },
    },
    "chat_send",
    { path: { "chat-id": "19:abc@thread.v2" }, body },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe(
    "https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.v2/messages",
  );
  expect(requests[0]!.init.body).toBe(JSON.stringify(body));
  expect(new Headers(requests[0]!.init.headers).get("Authorization")).toBe("Bearer test-token");
  expect(authorized).toBe(1);
  expect(resolutions[0]).toMatchObject({
    workspaceId: "pilot",
    initiatingSubjectId: "human:alice",
    connectionRef: "alice-connection",
    requiredScopeAlternatives: [["ChatMessage.Send"]],
  });
});

test("Teams ambiguous message sends are never automatically retried", async () => {
  let calls = 0;
  await expect(
    invokeOpenApiOperation(
      {
        revision: revision(),
        authority: { accountId: "a", workspaceId: "pilot" },
        transport: {
          fetch: async () => {
            calls++;
            throw new Error("socket closed after write");
          },
        },
      },
      "chat_send",
      { path: { "chat-id": "chat" }, body: { body: { content: "hello" } } },
    ),
  ).rejects.toMatchObject({ outcome: "unknown", retryable: false });
  expect(calls).toBe(1);
});

test("Teams continuation tokens stay opaque query values on the selected resource", async () => {
  let destination = "";
  await invokeOpenApiOperation(
    {
      revision: revision(),
      authority: { accountId: "a", workspaceId: "pilot" },
      transport: {
        fetch: async (url) => {
          destination = String(url);
          return new Response("{}");
        },
      },
    },
    "chat_read",
    { path: { "chat-id": "chat" }, query: { $skiptoken: "abc+/=&$filter=other" } },
  );
  const url = new URL(destination);
  expect(url.origin).toBe("https://graph.microsoft.com");
  expect(url.pathname).toBe("/v1.0/chats/chat/messages");
  expect(url.searchParams.get("$skiptoken")).toBe("abc+/=&$filter=other");
  expect(url.searchParams.has("$filter")).toBe(false);
});
