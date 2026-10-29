import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { configureBillingLegacyAccounts, signStandardWebhook } from "@opengeni/core";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

// End to end through the HTTP app and real PostgreSQL: the credential that
// starts a chat decides the origin frozen on its first turn.
const SECRET = "billing-origin-e2e-secret";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("billing-origin-e2e");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("Billing origin end-to-end tests require real PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("a person in the app starts app use; a delegated token for the same person starts API use", async () => {
  if (!client || !shared) return;
  const app = createApp({
    settings: testSettings({
      productAccessMode: "local",
      delegationSecret: SECRET,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
    managedAuth: null,
  });
  // The local install's own person, as the desktop app signs in.
  const local = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:local",
    accountExternalId: "default",
    accountName: "Local",
    workspaceExternalSource: "opengeni:local",
    workspaceExternalId: "default",
    workspaceName: "Local",
    subjectId: "dev",
    subjectLabel: "Local dev",
  });
  const grant = local.workspaceGrants[0]!;
  const create = async (authorization?: string) => {
    const response = await app.request(`/v1/workspaces/${grant.workspaceId}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({ initialMessage: "Run", tools: [], visibility: "workspace" }),
    });
    if (response.status !== 202) throw new Error(`${response.status} ${await response.text()}`);
    const session = (await response.json()) as { id: string };
    const [turn] = await shared!.admin<{ billingOrigin: string | null }[]>`
      select billing_origin as "billingOrigin" from session_turns
      where workspace_id = ${grant.workspaceId}::uuid and session_id = ${session.id}::uuid`;
    return turn?.billingOrigin;
  };

  expect(await create()).toBe("app");
  const token = await signDelegatedAccessToken(SECRET, {
    ...grant,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  expect(await create(`Bearer ${token}`)).toBe("api");
}, 180_000);

test("a person's edits and manual runs keep an app schedule app; a delegated token's schedule is API use", async () => {
  if (!client || !shared) return;
  const noop = async () => undefined;
  const app = createApp({
    settings: testSettings({
      productAccessMode: "local",
      delegationSecret: SECRET,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as never,
    managedAuth: null,
  });
  const local = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:local",
    accountExternalId: "default",
    accountName: "Local",
    workspaceExternalSource: "opengeni:local",
    workspaceExternalId: "default",
    workspaceName: "Local",
    subjectId: "dev",
    subjectLabel: "Local dev",
  });
  const grant = local.workspaceGrants[0]!;
  const base = `/v1/workspaces/${grant.workspaceId}/scheduled-tasks`;
  const send = async (method: string, path: string, body: unknown, authorization?: string) => {
    const response = await app.request(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    });
    if (response.status >= 300) {
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as { id?: string };
  };
  const origin = async (taskId: string) => {
    const [task] = await shared!.admin<{ billingOrigin: string | null }[]>`
      select billing_origin as "billingOrigin" from scheduled_tasks
      where workspace_id = ${grant.workspaceId}::uuid and id = ${taskId}::uuid`;
    return task?.billingOrigin;
  };
  const schedule = (authorization?: string) =>
    send(
      "POST",
      "",
      {
        name: "Weekly review",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: {
          prompt: "Review",
          resources: [],
          tools: [],
          metadata: {},
          sandboxBackend: "none",
        },
      },
      authorization,
    );
  // The person's own credential, with no test override: edits and manual
  // runs from the app never turn the schedule into API use.
  const taskId = (await schedule()).id!;
  expect(await origin(taskId)).toBe("app");
  await send("PATCH", `/${taskId}`, { name: "Weekly review, renamed" });
  await send("POST", `/${taskId}/trigger`, {});
  expect(await origin(taskId)).toBe("app");
  // A product holding a delegated token for the same person: API use.
  const token = await signDelegatedAccessToken(SECRET, {
    ...grant,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  const productTask = (await schedule(`Bearer ${token}`)).id!;
  expect(await origin(productTask)).toBe("api");
  await send("PATCH", `/${productTask}`, { name: "Edited by the product" }, `Bearer ${token}`);
  await send("POST", `/${productTask}/trigger`, {}, `Bearer ${token}`);
  expect(await origin(productTask)).toBe("api");
}, 180_000);

// Whoever holds a webhook source's signing secret can sign deliveries to its
// public URL. When an API caller set or received it, deliveries fire the
// automations listening on it as API use, whoever set them up and whenever.
async function eventSourceHarness(options: { legacy?: boolean } = {}) {
  const noop = async () => undefined;
  const local = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "opengeni:local",
    accountExternalId: "default",
    accountName: "Local",
    workspaceExternalSource: "opengeni:local",
    workspaceExternalId: "default",
    workspaceName: "Local",
    subjectId: "dev",
    subjectLabel: "Local dev",
  });
  const grant = local.workspaceGrants[0]!;
  const app = createApp({
    settings: testSettings({
      productAccessMode: "local",
      delegationSecret: SECRET,
      sandboxBackend: "none",
      eventTriggersEnabled: true,
      environmentsEncryptionKey: randomBytes(32).toString("base64"),
      publicBaseUrl: "https://opengeni.example",
      // CloudGeni's legacy account: every caller is funded as app.
      ...(options.legacy ? { billingLegacyAccountIds: [grant.accountId] } : {}),
    }),
    db: client!.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as never,
    managedAuth: null,
  });
  // A product holding a delegated token for the same person: API use.
  const api = `Bearer ${await signDelegatedAccessToken(SECRET, {
    ...grant,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
  const workspacePath = `/v1/workspaces/${grant.workspaceId}`;
  const send = async (method: string, path: string, body?: unknown, authorization?: string) => {
    const response = await app.request(`${workspacePath}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status >= 300) {
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as Record<string, any>;
  };
  const standardSource = async (authorization?: string) =>
    (await send(
      "POST",
      "/event-sources",
      { kind: "webhook", adapter: "standard", name: "Orders" },
      authorization,
    )) as { source: { id: string; webhookUrl: string }; signingSecret: string };
  const linearSource = async (signingSecret: string) =>
    (
      (await send("POST", "/event-sources", {
        kind: "webhook",
        adapter: "linear",
        name: "Linear",
        signingSecret,
      })) as { source: { id: string; webhookUrl: string } }
    ).source;
  // The person sets the automation up in the app.
  const automation = async (sourceId: string, eventType: string) => {
    const task = await send("POST", "/scheduled-tasks", {
      name: "Triage",
      schedule: { type: "manual" },
      agentConfig: {
        prompt: "Look at the event",
        resources: [],
        tools: [],
        metadata: {},
        sandboxBackend: "none",
      },
      events: { triggers: [{ sourceId, eventTypes: [eventType] }] },
    });
    return task.id as string;
  };
  const origin = async (taskId: string) => {
    const [task] = await shared!.admin<{ billingOrigin: string | null }[]>`
      select billing_origin as "billingOrigin" from scheduled_tasks
      where workspace_id = ${grant.workspaceId}::uuid and id = ${taskId}::uuid`;
    return task?.billingOrigin;
  };
  const resetOrigin = async (taskId: string) => {
    await shared!.admin`update scheduled_tasks set billing_origin = null
      where workspace_id = ${grant.workspaceId}::uuid and id = ${taskId}::uuid`;
  };
  const sourceHolder = async (sourceId: string) => {
    const [source] = await shared!.admin<{ holder: string | null }[]>`
      select secret_billing_origin as holder from event_sources
      where workspace_id = ${grant.workspaceId}::uuid and id = ${sourceId}::uuid`;
    return source?.holder;
  };
  const deliverStandard = async (webhookUrl: string, secret: string) => {
    const body = JSON.stringify({
      type: "order.created",
      timestamp: new Date().toISOString(),
      data: { id: `ord_${crypto.randomUUID()}`, total: 12 },
    });
    const response = await app.request(new URL(webhookUrl).pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signStandardWebhook({ secret, webhookId: `msg_${crypto.randomUUID()}`, body }),
      },
      body,
    });
    expect(response.status).toBe(200);
  };
  const deliverLinear = async (webhookUrl: string, secret: string) => {
    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      createdAt: new Date().toISOString(),
      webhookTimestamp: Date.now(),
      url: "https://linear.app/acme/issue/ENG-42",
      actor: { type: "user", name: "Ada" },
      data: { identifier: `ENG-${Math.floor(Math.random() * 1e6)}`, title: "Checkout is slow" },
    });
    const response = await app.request(new URL(webhookUrl).pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-delivery": crypto.randomUUID(),
        "linear-event": "Issue",
        "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
      },
      body,
    });
    expect(response.status).toBe(200);
  };
  // A GitLab-style shared token: the secret itself travels in a header.
  const tokenFormat = (type: Record<string, string>) => ({
    signature: { scheme: "token", header: "X-Gitlab-Token" },
    type,
  });
  const customSource = async (signingSecret: string) =>
    (
      (await send("POST", "/event-sources", {
        kind: "webhook",
        adapter: "custom",
        name: "GitLab",
        format: tokenFormat({ path: "object_kind" }),
        signingSecret,
      })) as { source: { id: string; webhookUrl: string } }
    ).source;
  const deliverToken = async (webhookUrl: string, secret: string, kind = "push") =>
    await app.request(new URL(webhookUrl).pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-token": secret,
        "x-gitlab-event": "Push Hook",
      },
      body: JSON.stringify({ object_kind: kind, event_name: kind, id: crypto.randomUUID() }),
    });
  const patchStatus = async (sourceId: string, body: unknown, authorization?: string) =>
    (
      await app.request(`${workspacePath}/event-sources/${sourceId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(body),
      })
    ).status;
  return {
    api,
    send,
    tokenFormat,
    customSource,
    deliverToken,
    patchStatus,
    standardSource,
    linearSource,
    automation,
    origin,
    resetOrigin,
    sourceHolder,
    deliverStandard,
    deliverLinear,
  };
}

test("an API caller that rotates a webhook's secret makes deliveries fire its automations as API use, even ones added later", async () => {
  if (!client || !shared) return;
  const h = await eventSourceHarness();
  const { source } = await h.standardSource();
  const before = await h.automation(source.id, "order.created");
  expect(await h.origin(before)).toBe("app");
  const { signingSecret } = await h.send(
    "POST",
    `/event-sources/${source.id}/rotate-secret`,
    undefined,
    h.api,
  );
  // An automation from before origins, and one the person adds afterwards.
  await h.resetOrigin(before);
  const after = await h.automation(source.id, "order.created");
  expect(await h.origin(after)).toBe("app");
  await h.deliverStandard(source.webhookUrl, signingSecret);
  expect(await h.origin(before)).toBe("api");
  expect(await h.origin(after)).toBe("api");
}, 180_000);

test("an API caller that pastes a webhook's secret makes deliveries fire its automations as API use", async () => {
  if (!client || !shared) return;
  const h = await eventSourceHarness();
  const source = await h.linearSource("lin_wh_person_0123456789");
  const taskId = await h.automation(source.id, "Issue.create");
  await h.resetOrigin(taskId);
  const secret = "lin_wh_product_0123456789";
  await h.send("PATCH", `/event-sources/${source.id}`, { signingSecret: secret }, h.api);
  const later = await h.automation(source.id, "Issue.create");
  await h.deliverLinear(source.webhookUrl, secret);
  expect(await h.origin(taskId)).toBe("api");
  expect(await h.origin(later)).toBe("api");
  // A person pasting a secret afterwards never turns the source back.
  const personSecret = "lin_wh_person_again_0123";
  await h.send("PATCH", `/event-sources/${source.id}`, { signingSecret: personSecret });
  const latest = await h.automation(source.id, "Issue.create");
  await h.deliverLinear(source.webhookUrl, personSecret);
  expect(await h.origin(latest)).toBe("api");
}, 180_000);

test("a webhook an API caller creates, and so holds the secret of, fires a person's automations as API use", async () => {
  if (!client || !shared) return;
  const h = await eventSourceHarness();
  const { source, signingSecret } = await h.standardSource(h.api);
  const taskId = await h.automation(source.id, "order.created");
  expect(await h.origin(taskId)).toBe("app");
  await h.deliverStandard(source.webhookUrl, signingSecret);
  expect(await h.origin(taskId)).toBe("api");
}, 180_000);

test("a person's own webhook secrets keep their automations app use", async () => {
  if (!client || !shared) return;
  const h = await eventSourceHarness();
  const { source, signingSecret: first } = await h.standardSource();
  const standardTask = await h.automation(source.id, "order.created");
  await h.deliverStandard(source.webhookUrl, first);
  const { signingSecret } = await h.send("POST", `/event-sources/${source.id}/rotate-secret`);
  await h.deliverStandard(source.webhookUrl, signingSecret);
  expect(await h.origin(standardTask)).toBe("app");
  expect(await h.sourceHolder(source.id)).toBeNull();

  const linear = await h.linearSource("lin_wh_person_0123456789");
  const linearTask = await h.automation(linear.id, "Issue.create");
  const pasted = "lin_wh_person_new_0123456";
  await h.send("PATCH", `/event-sources/${linear.id}`, { signingSecret: pasted });
  await h.deliverLinear(linear.webhookUrl, pasted);
  expect(await h.origin(linearTask)).toBe("app");
  expect(await h.sourceHolder(linear.id)).toBeNull();
}, 180_000);

test("CloudGeni's legacy account stays app use whoever holds a webhook's secret", async () => {
  if (!client || !shared) return;
  try {
    await legacyAccountStaysApp(shared);
  } finally {
    // The legacy list is process-wide: put back the test default.
    configureBillingLegacyAccounts(testSettings().billingLegacyAccountIds ?? []);
  }
}, 180_000);

async function legacyAccountStaysApp(pg: SharedTestDatabase) {
  const h = await eventSourceHarness({ legacy: true });
  const rotated = (await h.standardSource()).source;
  const rotatedTask = await h.automation(rotated.id, "order.created");
  const { signingSecret } = await h.send(
    "POST",
    `/event-sources/${rotated.id}/rotate-secret`,
    undefined,
    h.api,
  );
  await h.deliverStandard(rotated.webhookUrl, signingSecret);
  expect(await h.origin(rotatedTask)).toBe("app");
  expect(await h.sourceHolder(rotated.id)).toBeNull();

  const linear = await h.linearSource("lin_wh_person_0123456789");
  const linearTask = await h.automation(linear.id, "Issue.create");
  const pasted = "lin_wh_product_0123456789";
  await h.send("PATCH", `/event-sources/${linear.id}`, { signingSecret: pasted }, h.api);
  await h.deliverLinear(linear.webhookUrl, pasted);
  expect(await h.origin(linearTask)).toBe("app");

  const created = await h.standardSource(h.api);
  const createdTask = await h.automation(created.source.id, "order.created");
  await h.deliverStandard(created.source.webhookUrl, created.signingSecret);
  expect(await h.origin(createdTask)).toBe("app");

  // A source an API caller held before the account went legacy stays app too.
  await pg.admin`update event_sources set secret_billing_origin = 'api'
    where id = ${created.source.id}::uuid`;
  await h.deliverStandard(created.source.webhookUrl, created.signingSecret);
  expect(await h.origin(createdTask)).toBe("app");
}

test("an API caller that changes only a webhook's format makes deliveries fire its automations as API use", async () => {
  if (!client || !shared) return;
  const h = await eventSourceHarness();
  const secret = "glpat-person-0123456789";
  const source = await h.customSource(secret);
  const taskId = await h.automation(source.id, "push");
  // A person changing the format leaves the source and its automations app.
  await h.send("PATCH", `/event-sources/${source.id}`, {
    format: h.tokenFormat({ path: "event_name" }),
  });
  expect(await h.sourceHolder(source.id)).toBeNull();
  expect((await h.deliverToken(source.webhookUrl, secret)).status).toBe(200);
  expect(await h.origin(taskId)).toBe("app");
  // The format says how deliveries are verified and read: an API caller
  // writing it is treated as holding the secret.
  await h.send(
    "PATCH",
    `/event-sources/${source.id}`,
    { format: h.tokenFormat({ path: "object_kind" }) },
    h.api,
  );
  expect(await h.sourceHolder(source.id)).toBe("api");
  expect((await h.deliverToken(source.webhookUrl, secret)).status).toBe(200);
  expect(await h.origin(taskId)).toBe("api");
}, 180_000);

test("a webhook format can't read its event type or ids from the header the secret is in", async () => {
  if (!client || !shared) return;
  const h = await eventSourceHarness();
  const secret = "glpat-person-abcdefghij";
  const source = await h.customSource(secret);
  // Any spelling of the signature header, for the type, delivery id or an event id part.
  for (const authorization of [undefined, h.api]) {
    for (const format of [
      h.tokenFormat({ header: "x-gitlab-token" }),
      { ...h.tokenFormat({ path: "object_kind" }), deliveryId: { header: "X-GITLAB-TOKEN" } },
      {
        ...h.tokenFormat({ path: "object_kind" }),
        eventId: { parts: [{ path: "id" }, { header: "X-Gitlab-Token" }] },
      },
    ]) {
      expect(await h.patchStatus(source.id, { format }, authorization)).toBe(400);
    }
  }
  expect(await h.sourceHolder(source.id)).toBeNull();

  // A format stored before the refusal reads that header as absent: the
  // secret never becomes an event type, an id or a kept header.
  await shared.admin`update event_sources set webhook_format = ${shared.admin.json({
    signature: { scheme: "token", header: "X-Gitlab-Token", prefix: "" },
    type: { header: "X-Gitlab-Token" },
    deliveryId: { header: "x-gitlab-token" },
  })} where id = ${source.id}::uuid`;
  const response = await h.deliverToken(source.webhookUrl, secret);
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain(secret);
  const stored = await shared.admin<{ text: string }[]>`
    select row_to_json(delivery)::text as text from event_deliveries delivery
      where source_id = ${source.id}::uuid
    union all
    select row_to_json(event)::text from inbound_events event where source_id = ${source.id}::uuid`;
  expect(stored.length).toBeGreaterThan(0);
  for (const row of stored) expect(row.text).not.toContain(secret);
}, 180_000);
