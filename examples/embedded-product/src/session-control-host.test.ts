import { expect, test } from "bun:test";
import { OpenGeniClient } from "@opengeni/sdk";
import { createHostHandler } from "./host-handler";

test("host control keeps the authenticated actor and exact versions without exposing arbitrary routes", async () => {
  const calls: { path: string; body: unknown; actor: string | null }[] = [];
  const service = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        actor: new Headers(init?.headers).get("x-opengeni-external-actor"),
      });
      return Response.json({});
    },
  });
  const handler = createHostHandler({
    service,
    authenticate: async () => ({
      workspaceId: "host-workspace",
      externalId: "host-user",
      source: "host",
    }),
    authorizeMutation: async () => true,
    returnUrl: () => "https://host.example",
    siteHref: () => "https://host.example",
  });
  const input = {
    action: "cancel",
    expectedControlEtag: "observed-version",
    clientEventId: crypto.randomUUID(),
  };
  expect(
    (
      await handler(
        new Request("https://host.example/api/sessions/session/control", {
          method: "POST",
          body: JSON.stringify({ ...input, workspaceId: "forged", actorSubjectId: "forged" }),
        }),
      )
    ).status,
  ).toBe(200);
  expect(calls[0]).toMatchObject({
    path: "/v1/workspaces/host-workspace/sessions/session/control",
    body: input,
  });
  expect(JSON.parse(decodeURIComponent(calls[0]!.actor!))).toMatchObject({
    mode: "external",
    identity: { externalId: "host-user", source: "host" },
  });
  expect(
    (await handler(new Request("https://host.example/api/sessions/session/queue"))).status,
  ).toBe(200);
  expect(calls[1]!.path).toBe("/v1/workspaces/host-workspace/sessions/session/queue");
  expect(
    (
      await handler(
        new Request("https://host.example/api/sessions/session/control", {
          method: "POST",
          body: JSON.stringify({ ...input, action: "delete-everything" }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await handler(new Request("https://host.example/api/sessions/session/arbitrary"))).status,
  ).toBe(404);
  expect(calls).toHaveLength(2);
  const checkout = {
    clientEventId: crypto.randomUUID(),
    expectedTurnVersion: 4,
    expectedDraftRevision: 8,
    replaceDraft: false,
  };
  expect(
    (
      await handler(
        new Request("https://host.example/api/sessions/session/queue/turn/edit", {
          method: "POST",
          body: JSON.stringify(checkout),
        }),
      )
    ).status,
  ).toBe(200);
  expect(calls[2]).toMatchObject({
    path: "/v1/workspaces/host-workspace/sessions/session/queue/turn/edit",
    body: checkout,
  });
  const draft = {
    text: "Reviewed draft",
    annotations: [],
    resources: [],
    model: "fixture-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    expectedRevision: 8,
  };
  expect(
    (
      await handler(
        new Request("https://host.example/api/sessions/session/composer-draft", {
          method: "PUT",
          body: JSON.stringify(draft),
        }),
      )
    ).status,
  ).toBe(200);
  expect(calls[3]).toMatchObject({
    path: "/v1/workspaces/host-workspace/sessions/session/composer-draft",
    body: draft,
  });
  const { expectedRevision, ...content } = draft;
  const submit = {
    ...content,
    expectedDraftRevision: expectedRevision + 1,
    delivery: "send",
    clientEventId: crypto.randomUUID(),
    controlEtag: "observed-version",
    connectionAuthorities: [],
  };
  expect(
    (
      await handler(
        new Request("https://host.example/api/sessions/session/composer-draft/submit", {
          method: "POST",
          body: JSON.stringify(submit),
        }),
      )
    ).status,
  ).toBe(200);
  expect(calls[4]).toMatchObject({
    path: "/v1/workspaces/host-workspace/sessions/session/composer-draft/submit",
    body: submit,
  });
  expect(calls.every((call) => call.actor === calls[0]!.actor)).toBe(true);
});
