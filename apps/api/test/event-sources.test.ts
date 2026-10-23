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
import {
  type FakeMcpEventsServer,
  type FakeMcpEventType,
  startFakeMcpEventsServer,
} from "@opengeni/testing/mcp-events-server";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";
import { dispatchDueEventTriggers } from "../src/event-trigger-dispatch";
import { pumpDueMcpEventSubscriptions } from "@opengeni/core";

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

async function fixture(options: {
  enabled: boolean;
  mcpServers?: Array<{ id: string; name: string; url: string }>;
}) {
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
    mcpServers: options.mcpServers ?? [],
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
    service,
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

const TICKET_CREATED: FakeMcpEventType = {
  name: "ticket.created",
  description: "A ticket was created in a queue.",
  delivery: ["poll"],
  inputSchema: {
    type: "object",
    properties: { queue: { type: "string" } },
    required: ["queue"],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: { queue: { type: "string" }, title: { type: "string" } },
  },
};
const TICKET_CLOSED: FakeMcpEventType = {
  name: "ticket.closed",
  description: "A ticket was closed.",
  delivery: ["poll", "webhook"],
  inputSchema: { type: "object", properties: { queue: { type: "string" } } },
  payloadSchema: { type: "object", properties: { title: { type: "string" } } },
};

describe("MCP event sources", () => {
  const fakes: FakeMcpEventsServer[] = [];
  afterAll(async () => {
    for (const fake of fakes) await fake.stop();
  });

  async function mcpFixture() {
    let app: { request: (path: string, init: RequestInit) => Promise<Response> } | null = null;
    const fake = startFakeMcpEventsServer({
      eventTypes: [TICKET_CREATED, TICKET_CLOSED],
      nextPollMs: 20_000,
      maxTtlMs: 3_600_000,
      webhookFetch: async (url, init) => await app!.request(new URL(url).pathname, init),
    });
    const plain = startFakeMcpEventsServer({ eventTypes: [], advertiseEvents: false });
    fakes.push(fake, plain);
    const f = await fixture({
      enabled: true,
      mcpServers: [
        { id: "events-fixture", name: "Events Fixture", url: fake.url },
        { id: "plain-fixture", name: "Plain Fixture", url: plain.url },
      ],
    });
    app = f.app;
    const started: EventOccurrenceToStart[] = [];
    const pump = async () => {
      await shared.admin`update mcp_event_subscriptions
        set next_action_at = now() - interval '1 second', lease_until = null
        where workspace_id = ${f.workspace.id}`;
      await pumpDueMcpEventSubscriptions({ db: db.db, settings: f.settings, bus: f.bus });
    };
    const dispatch = async () => {
      await makeDue(f.workspace.id);
      await dispatchDueEventTriggers({
        db: db.db,
        settings: f.settings,
        bus: f.bus,
        startRun: async (occurrence) => {
          if (occurrence.workspaceId === f.workspace.id) started.push(occurrence);
        },
      });
    };
    const subscriptions = async () =>
      await shared.admin`select mode, cursor, gap_pending, server_subscription_id, failures
        from mcp_event_subscriptions where workspace_id = ${f.workspace.id}`;
    const createSource = async () => {
      const created = await f.app.request(f.sources, {
        method: "POST",
        headers: f.owner.headers,
        body: JSON.stringify({ kind: "mcp", serverId: "events-fixture" }),
      });
      expect(created.status).toBe(201);
      return (await f.json(created)).source as Record<string, any>;
    };
    const automation = async (sourceId: string, eventType: string, args: unknown) => {
      const response = await f.createAutomation(f.owner.headers, {
        triggers: [{ sourceId, eventTypes: [eventType], arguments: args }],
      });
      expect(response.status).toBe(201);
      return await f.json(response);
    };
    const task = async (id: string) =>
      await f.json(await f.app.request(`${f.tasks}/${id}`, { headers: f.owner.headers }));
    const events = async (sourceId: string) =>
      (
        await f.json(
          await f.app.request(`${f.sources}/${sourceId}/events`, { headers: f.owner.headers }),
        )
      ).events as Array<Record<string, any>>;
    const deliveries = async (sourceId: string) =>
      (
        await f.json(
          await f.app.request(`${f.sources}/${sourceId}/deliveries`, {
            headers: f.owner.headers,
          }),
        )
      ).deliveries as Array<Record<string, any>>;
    return {
      ...f,
      fake,
      started,
      pump,
      dispatch,
      subscriptions,
      createSource,
      automation,
      task,
      events,
      deliveries,
    };
  }

  test("a source is one person's connection to a server that offers events", async () => {
    const f = await mcpFixture();
    const asService = await f.app.request(f.sources, {
      method: "POST",
      headers: f.service,
      body: JSON.stringify({ kind: "mcp", serverId: "events-fixture" }),
    });
    expect(asService.status).toBe(422);
    const plain = await f.app.request(f.sources, {
      method: "POST",
      headers: f.owner.headers,
      body: JSON.stringify({ kind: "mcp", serverId: "plain-fixture" }),
    });
    expect(plain.status).toBe(422);
    const unknown = await f.app.request(f.sources, {
      method: "POST",
      headers: f.owner.headers,
      body: JSON.stringify({ kind: "mcp", serverId: "not-added" }),
    });
    expect(unknown.status).toBe(422);

    const source = await f.createSource();
    expect(source).toMatchObject({
      kind: "mcp",
      name: "Events Fixture",
      visibility: "private",
      webhookUrl: null,
      mcp: { serverId: "events-fixture" },
    });
    const madeShared = await f.app.request(`${f.sources}/${source.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ visibility: "workspace" }),
    });
    expect(madeShared.status).toBe(422);

    const { eventTypes } = await f.json(
      await f.app.request(`${f.sources}/${source.id}/event-types`, { headers: f.owner.headers }),
    );
    expect(eventTypes.map((entry: any) => entry.type)).toEqual(["ticket.created", "ticket.closed"]);
    expect(eventTypes[0]).toMatchObject({
      description: "A ticket was created in a queue.",
      argumentsSchema: TICKET_CREATED.inputSchema,
    });

    const invalid = await f.createAutomation(f.owner.headers, {
      triggers: [{ sourceId: source.id, eventTypes: ["ticket.created"], arguments: { queue: 5 } }],
    });
    expect(invalid.status).toBe(422);
    const missingType = await f.createAutomation(f.owner.headers, {
      triggers: [{ sourceId: source.id, eventTypes: ["ticket.deleted"], arguments: {} }],
    });
    expect(missingType.status).toBe(422);
    const twoTypes = await f.createAutomation(f.owner.headers, {
      triggers: [
        { sourceId: source.id, eventTypes: ["ticket.created", "ticket.closed"], arguments: {} },
      ],
    });
    expect(twoTypes.status).toBe(422);
  });

  test("a polled stream delivers new events once, in order, and wakes the automation", async () => {
    const f = await mcpFixture();
    const source = await f.createSource();
    const automation = await f.automation(source.id, "ticket.created", { queue: "billing" });
    expect(automation.events.triggers[0]).toMatchObject({
      eventTypes: ["ticket.created"],
      arguments: { queue: "billing" },
      status: "active",
    });

    // The first step only learns where "now" is; earlier events are not replayed.
    await f.fake.emit("ticket.created", { queue: "billing", title: "Before" });
    await f.pump();
    expect(await f.subscriptions()).toMatchObject([{ mode: "poll", cursor: "c1" }]);
    expect(f.fake.requestsFor("events/poll")[0]?.params).toMatchObject({
      name: "ticket.created",
      arguments: { queue: "billing" },
      cursor: null,
    });
    expect(f.fake.requestsFor("events/poll")[0]?.mcpName).toBe("ticket.created");

    await f.fake.emit("ticket.created", { queue: "billing", title: "First" }, { eventId: "t-1" });
    await f.fake.emit("ticket.created", { queue: "support", title: "Other queue" });
    await f.fake.emit("ticket.created", { queue: "billing", title: "Second" }, { eventId: "t-2" });
    // The server sends the same event again; it is stored once.
    await f.fake.emit("ticket.created", { queue: "billing", title: "First" }, { eventId: "t-1" });
    await f.pump();
    const stored = await f.events(source.id);
    expect(stored.map((event) => event.data.title)).toEqual(["Second", "First"]);
    expect(stored.every((event) => event.type === "ticket.created")).toBe(true);
    expect(await f.subscriptions()).toMatchObject([{ cursor: "c5", gap_pending: false }]);

    await f.dispatch();
    expect(f.started.map((run) => run.taskId)).toContain(automation.id);

    // Polling again without news stores nothing and fires nothing.
    const runs = f.started.length;
    await f.pump();
    expect(await f.events(source.id)).toHaveLength(2);
    await f.dispatch();
    expect(f.started).toHaveLength(runs);

    // History that expired before the next poll is reported as a gap.
    await f.fake.emit("ticket.created", { queue: "billing", title: "Lost" });
    f.fake.expireHistory();
    await f.fake.emit("ticket.created", { queue: "billing", title: "After the gap" });
    await f.pump();
    const [latest] = await f.events(source.id);
    expect(latest).toMatchObject({ data: { title: "After the gap" }, gapBefore: true });

    // A replayed poll page fires its events again.
    const [page] = await f.deliveries(source.id);
    const replay = await f.app.request(`${f.sources}/${source.id}/deliveries/${page!.id}/replay`, {
      method: "POST",
      headers: f.owner.headers,
    });
    expect(replay.status).toBe(201);
    expect((await f.json(replay)).delivery.eventIds).toHaveLength(1);
    const tested = await f.app.request(`${f.sources}/${source.id}/test`, {
      method: "POST",
      headers: f.owner.headers,
      body: JSON.stringify({ type: "ticket.created", data: { queue: "billing", title: "Test" } }),
    });
    expect(tested.status).toBe(201);
    expect((await f.json(tested)).matchedAutomationIds).toEqual([automation.id]);
  });

  test("a refusal blocks the triggers until it clears, and pausing ends the subscription", async () => {
    const f = await mcpFixture();
    const source = await f.createSource();
    const automation = await f.automation(source.id, "ticket.created", { queue: "billing" });
    await f.pump();

    f.fake.failNext("events/poll", { code: -32_024, message: "Queue is private", data: {} });
    await f.pump();
    const blocked = await f.task(automation.id);
    expect(blocked.events.triggers[0]).toMatchObject({ status: "blocked" });
    expect(blocked.events.triggers[0].statusReason).toContain("Queue is private");

    await f.pump();
    expect((await f.task(automation.id)).events.triggers[0]).toMatchObject({
      status: "active",
      statusReason: null,
    });

    const paused = await f.app.request(`${f.tasks}/${automation.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ status: "paused" }),
    });
    expect(paused.status).toBe(200);
    await f.pump();
    expect(await f.subscriptions()).toHaveLength(0);

    const resumed = await f.app.request(`${f.tasks}/${automation.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ status: "active" }),
    });
    expect(resumed.status).toBe(200);
    await f.pump();
    expect(await f.subscriptions()).toMatchObject([{ mode: "poll" }]);
  });

  test("identical triggers share one subscription; different arguments never cross-fire", async () => {
    const f = await mcpFixture();
    const source = await f.createSource();
    const billing = await f.automation(source.id, "ticket.created", { queue: "billing" });
    const billingToo = await f.automation(source.id, "ticket.created", { queue: "billing" });
    const support = await f.automation(source.id, "ticket.created", { queue: "support" });
    await f.pump();
    expect(await f.subscriptions()).toHaveLength(2);
    expect(f.fake.requestsFor("events/poll")).toHaveLength(2);

    await f.fake.emit("ticket.created", { queue: "billing", title: "Invoice wrong" });
    await f.pump();
    await f.dispatch();
    expect(f.started.map((run) => run.taskId).sort()).toEqual([billing.id, billingToo.id].sort());
    expect(f.started.map((run) => run.taskId)).not.toContain(support.id);
  });

  test("a webhook stream verifies, delivers, dedupes, reports gaps and resubscribes", async () => {
    const f = await mcpFixture();
    const source = await f.createSource();
    const automation = await f.automation(source.id, "ticket.closed", { queue: "billing" });

    await f.pump();
    const [subscription] = await f.subscriptions();
    expect(subscription).toMatchObject({ mode: "webhook", failures: 0 });
    const serverId = String(subscription!.server_subscription_id);
    expect(serverId).toStartWith("sub_");
    expect(f.fake.posts.map((post) => [JSON.parse(post.body).type, post.status])).toEqual([
      ["verification", 200],
    ]);
    const url = f.fake.subscriptions.get(serverId)!.url;
    expect(url).toStartWith("https://opengeni.example/v1/webhooks/events/");

    await f.fake.emit("ticket.closed", { queue: "billing", title: "Refund sent" });
    await f.fake.emit("ticket.closed", { queue: "support", title: "Not ours" });
    const delivered = f.fake.posts.at(-1)!;
    expect(delivered.status).toBe(200);
    expect(f.fake.posts).toHaveLength(2);
    // A retried POST keeps its webhook-id and is recorded once.
    expect((await f.fake.redeliver(delivered)).status).toBe(200);
    expect(await f.events(source.id)).toHaveLength(1);
    expect((await f.deliveries(source.id))[0]).toMatchObject({
      status: "accepted",
      duplicateCount: 1,
    });
    await f.dispatch();
    expect(f.started.map((run) => run.taskId)).toEqual([automation.id]);

    expect((await f.fake.sendGap(serverId)).status).toBe(200);
    await f.fake.emit("ticket.closed", { queue: "billing", title: "After a gap" });
    expect((await f.events(source.id))[0]).toMatchObject({
      data: { title: "After a gap" },
      gapBefore: true,
    });

    // Refreshing keeps the same server subscription and does not verify again.
    await f.pump();
    expect(f.fake.subscriptions.get(serverId)?.refreshes).toBe(1);

    // The server ends the subscription; the next step subscribes again.
    const terminated = await f.fake.terminate(serverId, {
      code: -32_603,
      message: "Server restarted",
    });
    expect(terminated.status).toBe(200);
    expect(f.fake.subscriptions.size).toBe(0);
    await f.pump();
    expect([...f.fake.subscriptions.keys()]).toEqual([serverId]);

    // A delivery for a subscription Opengeni no longer has is answered 410 Gone.
    const paused = await f.app.request(`${f.tasks}/${automation.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ status: "paused" }),
    });
    expect(paused.status).toBe(200);
    await f.pump();
    expect(f.fake.subscriptions.size).toBe(0);
    expect(await f.subscriptions()).toHaveLength(0);
    const late = await f.app.request(new URL(url).pathname, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcp-subscription-id": serverId },
      body: delivered.body,
    });
    expect(late.status).toBe(410);
  });

  test("a webhook the server can't reach falls back to polling", async () => {
    const f = await mcpFixture();
    const source = await f.createSource();
    const automation = await f.automation(source.id, "ticket.closed", {});
    f.fake.failNext("events/subscribe", {
      code: -32_027,
      message: "Callback endpoint error",
      data: { reason: "dns" },
    });
    await f.pump();
    expect(await f.subscriptions()).toMatchObject([{ mode: "poll", failures: 0 }]);
    await f.fake.emit("ticket.closed", { title: "Polled instead" });
    await f.pump();
    // Polling sticks: the webhook is not tried again.
    expect(f.fake.requestsFor("events/subscribe")).toHaveLength(1);
    expect(f.fake.requestsFor("events/poll")).toHaveLength(2);
    expect((await f.events(source.id)).map((event) => event.data.title)).toEqual([
      "Polled instead",
    ]);
    expect((await f.task(automation.id)).events.triggers[0].status).toBe("active");
  });
});
