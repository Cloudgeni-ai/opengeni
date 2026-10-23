import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { EventOccurrenceToStart } from "@opengeni/db";
import { signStandardWebhook, type SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";
import { dispatchDueEventTriggers } from "../src/event-trigger-dispatch";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("event-sources");
  if (!acquired) throw new Error("Event source tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const memberPermissions = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
  "scheduled_tasks:run",
  "scheduled_tasks:manage",
];

async function fixture(options: { enabled: boolean }) {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Event source fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "workspace:admin",
      "members:manage",
      "sessions:read",
      "sessions:create",
      "sessions:control",
      "scheduled_tasks:run",
      "scheduled_tasks:manage",
      "account:admin",
    ],
  });
  const settings = testSettings({
    productAccessMode: "configured",
    sandboxBackend: "none",
    publicBaseUrl: "https://opengeni.example",
    environmentsEncryptionKey: randomBytes(32).toString("base64"),
    eventTriggersEnabled: options.enabled,
  });
  const bus = new MemoryEventBus();
  const app = createApp({
    db: db.db,
    bus,
    settings,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const person = async (permissions: string[]) => {
    const identity = await ensureExternalIdentity(db.db, {
      accountId,
      source,
      externalId: crypto.randomUUID(),
    });
    const added = await app.request(`/v1/workspaces/${workspace.id}/external-members`, {
      method: "POST",
      headers: service,
      body: JSON.stringify({
        identity: { source, externalId: identity.externalId },
        permissions,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(added.status).toBe(200);
    return {
      subjectId: identity.subjectId,
      headers: {
        ...service,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source, externalId: identity.externalId },
          }),
        ),
      },
    };
  };
  const owner = await person(memberPermissions);
  const other = await person(memberPermissions);
  const sources = `/v1/workspaces/${workspace.id}/event-sources`;
  const tasks = `/v1/workspaces/${workspace.id}/scheduled-tasks`;
  const json = async (response: Response) => (await response.json()) as Record<string, any>;
  const createAutomation = async (headers: Record<string, string>, events: unknown) =>
    await app.request(tasks, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Triage new orders",
        schedule: { type: "manual" },
        agentConfig: {
          prompt: "Look at the new order and flag anything unusual",
          resources: [],
          tools: [],
          metadata: {},
          sandboxBackend: "none",
        },
        events,
      }),
    });
  const deliver = async (
    webhookUrl: string,
    secret: string,
    body: string,
    webhookId = `msg_${crypto.randomUUID()}`,
  ) =>
    await app.request(new URL(webhookUrl).pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signStandardWebhook({ secret, webhookId, body }),
      },
      body,
    });
  return {
    app,
    bus,
    settings,
    workspace,
    owner,
    other,
    sources,
    tasks,
    json,
    createAutomation,
    deliver,
  };
}

async function makeDue(workspaceId: string): Promise<void> {
  await shared.admin`update scheduled_task_event_settings set dispatch_due_at = now() - interval '1 second'
    where workspace_id = ${workspaceId} and dispatch_due_at is not null`;
}

describe("event sources", () => {
  test("everything answers as absent while event triggers are off", async () => {
    const f = await fixture({ enabled: false });
    expect((await f.app.request(f.sources, { headers: f.owner.headers })).status).toBe(404);
    const created = await f.app.request(f.sources, {
      method: "POST",
      headers: f.owner.headers,
      body: JSON.stringify({ kind: "webhook", adapter: "standard", name: "Orders" }),
    });
    expect(created.status).toBe(404);
    const intake = await f.app.request(`/v1/webhooks/events/${crypto.randomUUID()}`, {
      method: "POST",
      body: "{}",
    });
    expect(intake.status).toBe(404);
    const automation = await f.createAutomation(f.owner.headers, {
      triggers: [{ sourceId: crypto.randomUUID(), eventTypes: ["order.created"] }],
    });
    expect(automation.status).toBe(422);
    const config = await f.json(await f.app.request("/v1/config/client"));
    expect(config.eventTriggers).toEqual({ enabled: false });
  });

  test("a signed delivery wakes the automation whose trigger matches it", async () => {
    const f = await fixture({ enabled: true });
    const created = await f.app.request(f.sources, {
      method: "POST",
      headers: f.owner.headers,
      body: JSON.stringify({ kind: "webhook", adapter: "standard", name: "Orders" }),
    });
    expect(created.status).toBe(201);
    const { source, signingSecret } = await f.json(created);
    expect(signingSecret).toStartWith("whsec_");
    expect(source.webhookUrl).toStartWith("https://opengeni.example/v1/webhooks/events/");
    expect(source).toMatchObject({ kind: "webhook", adapter: "standard", visibility: "private" });

    // A private source is invisible to other members and unusable by their automations.
    expect(
      (await f.app.request(`${f.sources}/${source.id}`, { headers: f.other.headers })).status,
    ).toBe(404);
    const foreign = await f.createAutomation(f.other.headers, {
      triggers: [{ sourceId: source.id, eventTypes: ["order.created"] }],
    });
    expect(foreign.status).toBe(422);

    const automationResponse = await f.createAutomation(f.owner.headers, {
      triggers: [
        {
          sourceId: source.id,
          eventTypes: ["order.*"],
          conditions: [{ field: "data.total", op: "exists" }],
        },
      ],
    });
    expect(automationResponse.status).toBe(201);
    const automation = await f.json(automationResponse);
    expect(automation.events).toMatchObject({
      maxRunsPerHour: 30,
      once: false,
      triggers: [{ sourceId: source.id, eventTypes: ["order.*"], includeOwnEvents: false }],
    });

    const unsigned = await f.app.request(new URL(source.webhookUrl).pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "order.created", data: { total: 12 } }),
    });
    expect(unsigned.status).toBe(401);

    const body = JSON.stringify({
      type: "order.created",
      timestamp: new Date().toISOString(),
      data: { id: "ord_1", total: 129, title: "Order 1" },
    });
    const accepted = await f.deliver(source.webhookUrl, signingSecret, body, "msg_order_1");
    expect(accepted.status).toBe(200);
    expect(await f.json(accepted)).toMatchObject({ status: "accepted" });
    const repeated = await f.deliver(source.webhookUrl, signingSecret, body, "msg_order_1");
    expect(repeated.status).toBe(200);

    // Data that does not satisfy the condition is stored but fires nothing.
    const unmatched = await f.deliver(
      source.webhookUrl,
      signingSecret,
      JSON.stringify({ type: "order.created", data: { id: "ord_2" } }),
    );
    expect(unmatched.status).toBe(200);

    const deliveries = await f.json(
      await f.app.request(`${f.sources}/${source.id}/deliveries`, { headers: f.owner.headers }),
    );
    expect(deliveries.deliveries.map((delivery: any) => delivery.status)).toEqual([
      "accepted",
      "accepted",
      "rejected",
    ]);
    expect(deliveries.deliveries[1]).toMatchObject({ duplicateCount: 1, bodyRetained: true });
    expect(deliveries.deliveries[2]).toMatchObject({ bodyRetained: false, eventIds: [] });

    const events = await f.json(
      await f.app.request(`${f.sources}/${source.id}/events`, { headers: f.owner.headers }),
    );
    expect(events.events).toHaveLength(2);
    expect(events.events[1]).toMatchObject({
      type: "order.created",
      subject: "ord_1",
      summary: "Order 1",
      data: { id: "ord_1", total: 129 },
    });
    const types = await f.json(
      await f.app.request(`${f.sources}/${source.id}/event-types`, { headers: f.owner.headers }),
    );
    expect(types.eventTypes.map((entry: any) => entry.type)).toEqual(["order.created"]);

    const started: EventOccurrenceToStart[] = [];
    const dispatch = () =>
      dispatchDueEventTriggers({
        db: db.db,
        settings: f.settings,
        bus: f.bus,
        startRun: async (occurrence) => {
          if (occurrence.workspaceId === f.workspace.id) started.push(occurrence);
        },
      });
    await makeDue(f.workspace.id);
    await dispatch();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ taskId: automation.id, workspaceId: f.workspace.id });

    // A replay fires its events again, even though the source sent them before.
    const replay = await f.app.request(
      `${f.sources}/${source.id}/deliveries/${deliveries.deliveries[1].id}/replay`,
      { method: "POST", headers: f.owner.headers },
    );
    expect(replay.status).toBe(201);
    const replayed = await f.json(replay);
    expect(replayed.delivery).toMatchObject({
      status: "accepted",
      replayOfDeliveryId: deliveries.deliveries[1].id,
    });
    expect(replayed.delivery.eventIds).toHaveLength(1);
    await makeDue(f.workspace.id);
    await dispatch();
    expect(started).toHaveLength(2);

    const tested = await f.app.request(`${f.sources}/${source.id}/test`, {
      method: "POST",
      headers: f.owner.headers,
      body: JSON.stringify({ type: "order.created", data: { total: 1 } }),
    });
    expect(tested.status).toBe(201);
    expect(await f.json(tested)).toMatchObject({
      event: { type: "order.created", data: { total: 1 } },
      matchedAutomationIds: [automation.id],
    });

    // Rotating the secret retires the old one at once.
    const rotated = await f.json(
      await f.app.request(`${f.sources}/${source.id}/rotate-secret`, {
        method: "POST",
        headers: f.owner.headers,
      }),
    );
    expect(rotated.signingSecret).not.toBe(signingSecret);
    expect((await f.deliver(source.webhookUrl, signingSecret, body)).status).toBe(401);
    expect((await f.deliver(source.webhookUrl, rotated.signingSecret, body)).status).toBe(200);

    // A source automations still use is kept until their triggers go.
    expect(
      (
        await f.app.request(`${f.sources}/${source.id}`, {
          method: "DELETE",
          headers: f.owner.headers,
        })
      ).status,
    ).toBe(409);
    const cleared = await f.app.request(`${f.tasks}/${automation.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ events: { triggers: [] } }),
    });
    expect(cleared.status).toBe(200);
    expect((await f.json(cleared)).events).toBeUndefined();
    expect(
      (
        await f.app.request(`${f.sources}/${source.id}`, {
          method: "DELETE",
          headers: f.owner.headers,
        })
      ).status,
    ).toBe(200);
    expect((await f.deliver(source.webhookUrl, rotated.signingSecret, body)).status).toBe(404);
  });

  test("a turned-off source logs deliveries without firing, and replays once it is back on", async () => {
    const f = await fixture({ enabled: true });
    const { source, signingSecret } = await f.json(
      await f.app.request(f.sources, {
        method: "POST",
        headers: f.owner.headers,
        body: JSON.stringify({ kind: "webhook", adapter: "standard", name: "Orders" }),
      }),
    );
    const automation = await f.json(
      await f.createAutomation(f.owner.headers, {
        triggers: [{ sourceId: source.id, eventTypes: ["order.created"] }],
        once: true,
      }),
    );
    expect(automation.events).toMatchObject({ once: true, completedAt: null });
    const off = await f.app.request(`${f.sources}/${source.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(await f.json(off)).toMatchObject({ status: "disabled", statusReason: "Turned off" });
    const body = JSON.stringify({ type: "order.created", data: { id: "ord_9" } });
    const ignored = await f.deliver(source.webhookUrl, signingSecret, body);
    expect(await f.json(ignored)).toMatchObject({ status: "ignored" });
    const { deliveries } = await f.json(
      await f.app.request(`${f.sources}/${source.id}/deliveries`, { headers: f.owner.headers }),
    );
    expect(deliveries[0]).toMatchObject({ status: "ignored", reason: "The source is turned off" });
    const blocked = await f.app.request(
      `${f.sources}/${source.id}/deliveries/${deliveries[0].id}/replay`,
      { method: "POST", headers: f.owner.headers },
    );
    expect(blocked.status).toBe(409);
    await f.app.request(`${f.sources}/${source.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ status: "active" }),
    });
    const replayed = await f.app.request(
      `${f.sources}/${source.id}/deliveries/${deliveries[0].id}/replay`,
      { method: "POST", headers: f.owner.headers },
    );
    expect((await f.json(replayed)).delivery).toMatchObject({ status: "accepted" });

    // A run-once automation can't also repeat on a schedule.
    const repeating = await f.app.request(`${f.tasks}/${automation.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ schedule: { type: "interval", everySeconds: 3600 } }),
    });
    expect(repeating.status).toBe(422);
  });

  test("pasted Linear secrets verify Linear's signature", async () => {
    const f = await fixture({ enabled: true });
    const missing = await f.app.request(f.sources, {
      method: "POST",
      headers: f.owner.headers,
      body: JSON.stringify({ kind: "webhook", adapter: "linear", name: "Linear" }),
    });
    expect(missing.status).toBe(400);
    const linearSecret = "lin_wh_0123456789abcdef";
    const created = await f.app.request(f.sources, {
      method: "POST",
      headers: f.owner.headers,
      body: JSON.stringify({
        kind: "webhook",
        adapter: "linear",
        name: "Linear",
        visibility: "workspace",
        signingSecret: linearSecret,
      }),
    });
    expect(created.status).toBe(201);
    const { source, signingSecret } = await f.json(created);
    expect(signingSecret).toBeUndefined();
    // A shared source is visible to other members, who can use but not change it.
    expect(
      (await f.app.request(`${f.sources}/${source.id}`, { headers: f.other.headers })).status,
    ).toBe(200);
    expect(
      (
        await f.app.request(`${f.sources}/${source.id}/rotate-secret`, {
          method: "POST",
          headers: f.other.headers,
        })
      ).status,
    ).toBe(403);
    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      createdAt: new Date().toISOString(),
      webhookTimestamp: Date.now(),
      url: "https://linear.app/acme/issue/ENG-42",
      actor: { type: "user", name: "Ada" },
      data: { identifier: "ENG-42", title: "Checkout is slow", team: { key: "ENG" } },
    });
    const delivered = await f.app.request(new URL(source.webhookUrl).pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-delivery": crypto.randomUUID(),
        "linear-event": "Issue",
        "linear-signature": createHmac("sha256", linearSecret).update(body).digest("hex"),
      },
      body,
    });
    expect(delivered.status).toBe(200);
    const { events } = await f.json(
      await f.app.request(`${f.sources}/${source.id}/events`, { headers: f.other.headers }),
    );
    expect(events[0]).toMatchObject({
      type: "Issue.create",
      subject: "ENG-42",
      summary: "Issue created: ENG-42 Checkout is slow",
      actor: { kind: "person", name: "Ada" },
    });
  });
});
