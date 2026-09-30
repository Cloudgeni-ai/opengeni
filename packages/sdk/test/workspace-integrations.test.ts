import { expect, test } from "bun:test";
import {
  OpenGeniClient,
  signOpenGeniPayload,
  verifyCredentialProviderRequest,
  verifyWebhookEvent,
} from "../src/index";

test("organization helpers preserve method, organization, filter and one-time response", async () => {
  const calls: { url: URL; method: string; body: unknown; actor: string | null }[] = [];
  const receipt = {
    secret: "test-only-secret",
    provider: {
      organizationId: "org/one",
      url: "https://product.example/credentials",
      enabled: true,
      timeoutMs: 10_000,
      createdAt: "2026-09-30T08:00:00Z",
      updatedAt: "2026-09-30T08:00:00Z",
      workspaceFilter: { externalSource: "product:production" },
    },
  };
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "test-only-key",
    fetch: async (url, init) => {
      calls.push({
        url: new URL(String(url)),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
        actor: new Headers(init?.headers).get("x-opengeni-external-actor"),
      });
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json(receipt);
    },
  });
  const provider = {
    url: "https://product.example/credentials",
    workspaceFilter: { externalSource: "product:production" },
    timeoutMs: 10_000,
  };
  const webhook = {
    url: "https://product.example/events",
    workspaceFilter: { externalSource: "product:production" },
    eventTypes: ["turn.completed"] as const,
  };
  expect(await client.putOrganizationCredentialProvider("org/one", provider)).toEqual(receipt);
  await client.getOrganizationCredentialProvider("org/one");
  await client.deleteOrganizationCredentialProvider("org/one");
  await client.createOrganizationWebhook("org/one", {
    ...webhook,
    eventTypes: [...webhook.eventTypes],
  });
  await client.listOrganizationWebhooks("org/one");
  await client.getOrganizationWebhook("org/one", "hook/one");
  await client.updateOrganizationWebhook("org/one", "hook/one", { workspaceFilter: null });
  await client.listOrganizationWebhookDeliveries("org/one", "hook/one", { limit: 25 });
  await client.redeliverOrganizationWebhookDelivery("org/one", "hook/one", "delivery/one");
  await client.deleteOrganizationWebhook("org/one", "hook/one");
  const root = "/v1/organizations/org%2Fone";
  expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
    ["PUT", `${root}/credential-provider`],
    ["GET", `${root}/credential-provider`],
    ["DELETE", `${root}/credential-provider`],
    ["POST", `${root}/webhooks`],
    ["GET", `${root}/webhooks`],
    ["GET", `${root}/webhooks/hook%2Fone`],
    ["PATCH", `${root}/webhooks/hook%2Fone`],
    ["GET", `${root}/webhooks/hook%2Fone/deliveries`],
    ["POST", `${root}/webhooks/hook%2Fone/deliveries/delivery%2Fone/redeliver`],
    ["DELETE", `${root}/webhooks/hook%2Fone`],
  ]);
  expect(calls[0]!.body).toEqual(provider);
  expect(calls[3]!.body).toEqual(webhook);
  expect(calls[6]!.body).toEqual({ workspaceFilter: null });
  expect(calls[7]!.url.searchParams.get("limit")).toBe("25");
  expect(calls.every((call) => call.actor === null)).toBe(true);
});

test("workspace webhook get remains workspace-scoped", async () => {
  let path = "";
  const webhook = {
    id: "hook",
    workspaceId: "workspace",
    url: "https://product.example/events",
    eventTypes: [],
    enabled: true,
    description: null,
    createdAt: "2026-09-30T08:00:00Z",
    updatedAt: "2026-09-30T08:00:00Z",
  };
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    fetch: async (url) => {
      path = new URL(String(url)).pathname;
      return Response.json(webhook);
    },
  });
  expect(await client.getWorkspaceWebhook("workspace", "hook")).toEqual(webhook);
  expect(path).toBe("/v1/workspaces/workspace/webhooks/hook");
});

test("signature helpers retain routing and embedder identity additions", async () => {
  const initiatingHuman = {
    subjectId: "external_user:internal",
    externalIdentity: { source: "product", externalId: "customer-user-7" },
  };
  const event = {
    id: "event",
    type: "turn.completed",
    workspaceId: "workspace",
    workspace: { id: "workspace", externalSource: "product", externalId: "tenant-5" },
    sessionId: "session",
    turnId: "turn",
    sequence: 42,
    occurredAt: "2026-09-30T08:00:00Z",
    data: { status: "idle" },
    initiatingHuman,
  };
  const secret = "test-only-secret";
  const eventBody = JSON.stringify(event);
  expect(
    (
      await verifyWebhookEvent({
        body: eventBody,
        headers: { "OpenGeni-Signature": await signOpenGeniPayload(secret, eventBody) },
        secret,
      })
    ).event,
  ).toEqual(event);
  const request = {
    type: "credentials.request" as const,
    purpose: "provision" as const,
    forceRefresh: false,
    accountId: "organization",
    workspaceId: "workspace",
    sessionId: "session",
    rootSessionId: "session",
    parentSessionId: null,
    turnId: "turn",
    attemptId: "attempt",
    initiator: { kind: "subject", subjectId: initiatingHuman.subjectId },
    initiatingHumanSubjectId: initiatingHuman.subjectId,
    initiatingHuman,
    sandboxBackend: "modal",
    sandboxOs: "linux",
  };
  const body = JSON.stringify(request);
  expect(
    await verifyCredentialProviderRequest({
      body,
      headers: { "OpenGeni-Signature": await signOpenGeniPayload(secret, body) },
      secret,
    }),
  ).toEqual(request);
});
