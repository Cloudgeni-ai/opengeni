import { expect, test } from "bun:test";
import {
  OpenGeniClient,
  signOpenGeniPayload,
  verifyCredentialProviderRequest,
  verifyWebhookEvent,
  type CredentialProviderInitiatorContext,
} from "../src/index";
import {
  createOrganizationWebhook,
  deleteOrganizationCredentialProvider,
  deleteOrganizationWebhook,
  getOrganizationCredentialProvider,
  getOrganizationWebhook,
  getWorkspaceWebhook,
  listOrganizationWebhookDeliveries,
  listOrganizationWebhooks,
  putOrganizationCredentialProvider,
  redeliverOrganizationWebhookDelivery,
  rotateOrganizationCredentialProviderSecret,
  rotateOrganizationWebhookSecret,
  rotateWorkspaceCredentialProviderSecret,
  rotateWorkspaceWebhookSecret,
  getWorkspaceInheritedIntegrations,
  testWorkspaceCredentialProvider,
  testWorkspaceWebhook,
  updateOrganizationWebhook,
} from "@opengeni/sdk/workspace-integrations";

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
  expect(await putOrganizationCredentialProvider(client, "org/one", provider)).toEqual(receipt);
  await getOrganizationCredentialProvider(client, "org/one");
  await deleteOrganizationCredentialProvider(client, "org/one");
  await createOrganizationWebhook(client, "org/one", {
    ...webhook,
    eventTypes: [...webhook.eventTypes],
  });
  await listOrganizationWebhooks(client, "org/one");
  await getOrganizationWebhook(client, "org/one", "hook/one");
  await updateOrganizationWebhook(client, "org/one", "hook/one", { workspaceFilter: null });
  await listOrganizationWebhookDeliveries(client, "org/one", "hook/one", { limit: 25 });
  await redeliverOrganizationWebhookDelivery(client, "org/one", "hook/one", "delivery/one");
  await deleteOrganizationWebhook(client, "org/one", "hook/one");
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
  expect(await getWorkspaceWebhook(client, "workspace", "hook")).toEqual(webhook);
  expect(path).toBe("/v1/workspaces/workspace/webhooks/hook");
});

test("signature helpers retain routing and embedder identity additions", async () => {
  const initiatingHuman = {
    subjectId: "external_user:internal",
    externalIdentity: { source: "product", externalId: "customer-user-7" },
  };
  const event = {
    lane: "organization" as const,
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
    lane: "organization" as const,
    mcpServers: [{ id: "product-capabilities", url: "https://product.example/mcp" }],
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
    initiatorContext: {
      kind: "human",
      initiator: { kind: "subject", subjectId: initiatingHuman.subjectId },
      context: {},
    } satisfies CredentialProviderInitiatorContext,
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
  // An older sender remains compatible; absence never implies human authority.
  const { initiatorContext: _context, ...legacy } = request;
  const legacyBody = JSON.stringify(legacy);
  expect(
    await verifyCredentialProviderRequest({
      body: legacyBody,
      headers: { "OpenGeni-Signature": await signOpenGeniPayload(secret, legacyBody) },
      secret,
    }),
  ).toEqual(legacy);
  const tampered = JSON.stringify({
    ...request,
    initiatorContext: { ...request.initiatorContext, kind: "service" },
  });
  await expect(
    verifyCredentialProviderRequest({
      body: tampered,
      headers: { "OpenGeni-Signature": await signOpenGeniPayload(secret, body) },
      secret,
    }),
  ).rejects.toThrow("signature verification failed");
});

test("verified pre-upgrade session and usage deliveries default their missing lane", async () => {
  const secret = "legacy-lane-secret";
  for (const type of ["turn.completed", "usage.exhausted", "usage.period_reset"]) {
    const event = {
      id: "event",
      type,
      workspaceId: "workspace",
      ...(type === "turn.completed" ? { sessionId: "session" } : {}),
      data: {},
    };
    const body = JSON.stringify(event);
    const verified = await verifyWebhookEvent({
      body,
      secret,
      headers: { "OpenGeni-Signature": await signOpenGeniPayload(secret, body) },
    });
    expect(JSON.stringify(verified.event)).toBe(JSON.stringify({ ...event, lane: "workspace" }));
    for (const lane of [null, "invalid", ...(type.startsWith("usage.") ? ["organization"] : [])]) {
      const invalidBody = JSON.stringify({ ...event, lane });
      await expect(
        verifyWebhookEvent({
          body: invalidBody,
          secret,
          headers: { "OpenGeni-Signature": await signOpenGeniPayload(secret, invalidBody) },
        }),
      ).rejects.toThrow();
    }
  }
});

test("secret rotation helpers use exact scoped POSTs and return the new secret once", async () => {
  const calls: { path: string; method: string | undefined }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    fetch: async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, method: init?.method });
      return Response.json({ secret: "new-once", provider: {}, webhook: {} });
    },
  });
  expect((await rotateOrganizationCredentialProviderSecret(client, "org/one")).secret).toBe(
    "new-once",
  );
  expect((await rotateOrganizationWebhookSecret(client, "org/one", "hook/one")).secret).toBe(
    "new-once",
  );
  expect((await rotateWorkspaceCredentialProviderSecret(client, "ws/one")).secret).toBe("new-once");
  expect((await rotateWorkspaceWebhookSecret(client, "ws/one", "hook/one")).secret).toBe(
    "new-once",
  );
  expect(calls).toEqual([
    { method: "POST", path: "/v1/organizations/org%2Fone/credential-provider/rotate-secret" },
    { method: "POST", path: "/v1/organizations/org%2Fone/webhooks/hook%2Fone/rotate-secret" },
    { method: "POST", path: "/v1/workspaces/ws%2Fone/credential-provider/rotate-secret" },
    { method: "POST", path: "/v1/workspaces/ws%2Fone/webhooks/hook%2Fone/rotate-secret" },
  ]);
});

test("focused helpers require only requestJson and deletes opt in to void responses", async () => {
  const calls: unknown[][] = [];
  const client: Pick<OpenGeniClient, "requestJson"> = {
    async requestJson<T>(...args: unknown[]): Promise<T> {
      calls.push(args);
      return undefined as T;
    },
  };
  expect(await deleteOrganizationCredentialProvider(client, "org")).toBeUndefined();
  expect(await deleteOrganizationWebhook(client, "org", "hook")).toBeUndefined();
  expect(calls).toEqual([
    [
      "DELETE",
      "/v1/organizations/org/credential-provider",
      undefined,
      {},
      { responseType: "void" },
    ],
    ["DELETE", "/v1/organizations/org/webhooks/hook", undefined, {}, { responseType: "void" }],
  ]);
});

test("void helpers retain authentication and contract checks without relaxing ordinary JSON reads", async () => {
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async () => new Response(null, { status: 204 }),
  });
  await deleteOrganizationCredentialProvider(client, "org");
  await expect(getOrganizationCredentialProvider(client, "org")).rejects.toThrow();

  const strict = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiContract: "strict",
    fetch: async () =>
      new Response(null, {
        status: 204,
        headers: { "x-opengeni-api-contract": "future-contract" },
      }),
  });
  await expect(deleteOrganizationCredentialProvider(strict, "org")).rejects.toThrow("contract");
});

test("integration administration helpers are absent from the eager client", () => {
  for (const name of [
    "createOrganizationWebhook",
    "deleteOrganizationCredentialProvider",
    "deleteOrganizationWebhook",
    "getOrganizationCredentialProvider",
    "getOrganizationWebhook",
    "getWorkspaceWebhook",
    "listOrganizationWebhookDeliveries",
    "listOrganizationWebhooks",
    "putOrganizationCredentialProvider",
    "redeliverOrganizationWebhookDelivery",
    "rotateOrganizationCredentialProviderSecret",
    "rotateOrganizationWebhookSecret",
    "rotateWorkspaceCredentialProviderSecret",
    "rotateWorkspaceWebhookSecret",
    "testWorkspaceCredentialProvider",
    "testWorkspaceWebhook",
    "getWorkspaceInheritedIntegrations",
    "updateOrganizationWebhook",
  ]) {
    expect(name in new OpenGeniClient({ baseUrl: "https://fixture.invalid" })).toBe(false);
  }
});

test("a verified webhook.test event names the workspace but no session", async () => {
  const secret = "whsec_test";
  const body = JSON.stringify({
    id: crypto.randomUUID(),
    type: "webhook.test",
    lane: "workspace",
    workspaceId: crypto.randomUUID(),
    sessionId: null,
    turnId: null,
    occurredAt: new Date().toISOString(),
    data: { webhookId: crypto.randomUUID() },
  });
  const { event } = await verifyWebhookEvent({
    body,
    headers: { "OpenGeni-Signature": await signOpenGeniPayload(secret, body) },
    secret,
  });
  expect(event.type).toBe("webhook.test");
  expect(event.sessionId).toBeNull();

  // Only usage and test events may omit the session.
  const sessionless = body.replace('"webhook.test"', '"turn.completed"');
  await expect(
    verifyWebhookEvent({
      body: sessionless,
      headers: { "OpenGeni-Signature": await signOpenGeniPayload(secret, sessionless) },
      secret,
    }),
  ).rejects.toThrow("signature verification failed");
});

test("test and inherited helpers use exact workspace-scoped routes", async () => {
  const calls: unknown[][] = [];
  const client: Pick<OpenGeniClient, "requestJson"> = {
    async requestJson<T>(...args: unknown[]): Promise<T> {
      calls.push(args);
      return {} as T;
    },
  };
  await testWorkspaceWebhook(client, "ws/one", "hook/one");
  await testWorkspaceCredentialProvider(client, "ws/one");
  await getWorkspaceInheritedIntegrations(client, "ws/one");
  expect(calls).toEqual([
    ["POST", "/v1/workspaces/ws%2Fone/webhooks/hook%2Fone/test"],
    ["POST", "/v1/workspaces/ws%2Fone/credential-provider/test"],
    ["GET", "/v1/workspaces/ws%2Fone/inherited-integrations"],
  ]);
});
