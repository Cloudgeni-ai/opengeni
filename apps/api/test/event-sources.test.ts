import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ScheduledTask } from "@opengeni/contracts";
import type { EventOccurrenceToStart } from "@opengeni/db";
import {
  eventRouteSecret,
  signStandardWebhook,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
import {
  bindAuthorizedGitHubInstallationRepositories,
  claimRecordingTranscriptVersion,
  completeRecordingTranscriptVersion,
  createConnection,
  createDb,
  createRecording,
  finalizeRecording,
  saveRecordingNote,
  markRecordingChunksUploaded,
  reserveRecordingChunks,
  createOrganizationApiKey,
  createWorkspace,
  deleteGitHubInstallationBinding,
  encryptEnvironmentValue,
  ensureExternalIdentity,
  eventOccurrenceProducerKey,
  getScheduledTask,
  githubInstallationRouteKey,
  markEventOccurrenceStarted,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import {
  type FakeMcpEventsProfile,
  type FakeMcpEventsServer,
  type FakeMcpEventType,
  startFakeMcpEventsServer,
} from "@opengeni/testing/mcp-events-server";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";
import { dispatchDueEventTriggers } from "../src/event-trigger-dispatch";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { pumpDueEventSourceFeeds, pumpDueMcpEventSubscriptions } from "@opengeni/core";

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
  mcpServers?: Array<{
    id: string;
    name: string;
    url: string;
    connectionRef?: { providerDomain: string; kind: "oauth2"; subjectScope: "subject" };
  }>;
  github?: { webhookSecret: string; appSlug: string; api: AppDependencies["githubAppApi"] };
  eventSourceFetch?: typeof fetch;
  webhookBaseUrl?: string;
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
    ...(options.webhookBaseUrl ? { webhookBaseUrl: options.webhookBaseUrl } : {}),
    ...(options.github
      ? {
          githubWebhookSecret: options.github.webhookSecret,
          githubAppSlug: options.github.appSlug,
        }
      : {}),
  });
  const bus = new MemoryEventBus();
  const dependencies = {
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
    ...(options.github ? { githubAppApi: options.github.api } : {}),
    ...(options.eventSourceFetch ? { eventSourceFetch: options.eventSourceFetch } : {}),
  } as unknown as AppDependencies;
  const app = createApp(dependencies);
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
    dependencies,
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The first-party MCP tools as an agent in the workspace calls them. */
async function agent(
  f: Fixture,
  subjectId: string,
  metadata: Record<string, unknown> = {},
  permissions = ["scheduled_tasks:manage", "scheduled_tasks:run"],
) {
  const server = buildOpenGeniMcpServer(f.dependencies as unknown as ApiRouteDeps, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    subjectId,
    permissions,
    metadata,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "event-agent-tools-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };
    const text = result.content.map((item) => item.text ?? "").join("\n");
    if (result.isError) return { error: text };
    return JSON.parse(text) as Record<string, any>;
  };
  return { client, call, close: () => Promise.all([client.close(), server.close()]) };
}

/** A separate agent per run, so a test needs no chat. */
const separateAgent = {
  runMode: "new_session_per_run",
  agentConfig: { prompt: "Summarize the new order", resources: [], metadata: {} },
};

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
    expect(deliveries.deliveries[1]).toMatchObject({
      duplicateCount: 1,
      bodyRetained: true,
      eventTypes: ["order.created"],
    });
    expect(deliveries.deliveries[2]).toMatchObject({
      bodyRetained: false,
      eventIds: [],
      eventTypes: [],
    });

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

  test("a run-once automation finishes after its first event run, and turning it on re-arms it", async () => {
    const f = await fixture({ enabled: true });
    const { source, signingSecret } = await f.json(
      await f.app.request(f.sources, {
        method: "POST",
        headers: f.owner.headers,
        body: JSON.stringify({ kind: "webhook", adapter: "standard", name: "Deploys" }),
      }),
    );
    const automation = await f.json(
      await f.createAutomation(f.owner.headers, {
        triggers: [{ sourceId: source.id, eventTypes: ["deploy.finished"] }],
        once: true,
      }),
    );
    expect(automation.events).toMatchObject({ once: true, completedAt: null });
    const started: EventOccurrenceToStart[] = [];
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
    const deploy = () =>
      f.deliver(
        source.webhookUrl,
        signingSecret,
        JSON.stringify({ type: "deploy.finished", data: { id: crypto.randomUUID() } }),
      );
    const read = async () =>
      await f.json(
        await f.app.request(`${f.tasks}/${automation.id}`, { headers: f.owner.headers }),
      );

    expect((await deploy()).status).toBe(200);
    await dispatch();
    expect(started).toHaveLength(1);
    const finished = await read();
    expect(finished.status).toBe("active");
    expect(finished.events.completedAt).not.toBeNull();

    // Finished, it no longer listens.
    expect((await deploy()).status).toBe(200);
    await dispatch();
    expect(started).toHaveLength(1);

    // Turning it on again listens for the next one, not the ones it missed.
    const resumed = await f.app.request(`${f.tasks}/${automation.id}/resume`, {
      method: "POST",
      headers: f.owner.headers,
    });
    expect(resumed.status).toBe(200);
    expect((await f.json(resumed)).events.completedAt).toBeNull();
    await dispatch();
    expect(started).toHaveLength(1);
    expect((await deploy()).status).toBe(200);
    await dispatch();
    expect(started).toHaveLength(2);
    expect((await read()).events.completedAt).not.toBeNull();
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
    expect(await f.json(off)).toMatchObject({
      status: "disabled",
      statusReason: "Turned off",
      statusReasonCode: "turned_off",
      statusReasonDetail: null,
    });
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
    const linearSecret = "lin_wh_0123456789abcdef";
    // Linear shows its secret only after it has the URL: the source waits for it.
    const waiting = await f.app.request(f.sources, {
      method: "POST",
      headers: f.owner.headers,
      body: JSON.stringify({ kind: "webhook", adapter: "linear", name: "Linear (setup)" }),
    });
    expect(waiting.status).toBe(201);
    const pending = (await f.json(waiting)).source;
    expect(pending).toMatchObject({
      status: "blocked",
      visibility: "private",
      awaitingSigningSecret: true,
    });
    expect(pending.statusReason).toContain("Paste the signing secret Linear shows");
    expect(pending).toMatchObject({
      statusReasonCode: "awaiting_secret",
      statusReasonDetail: null,
    });
    const early = await f.app.request(new URL(pending.webhookUrl).pathname, {
      method: "POST",
      headers: { "content-type": "application/json", "linear-event": "Issue" },
      body: JSON.stringify({ action: "create", type: "Issue" }),
    });
    expect(early.status).not.toBe(200);
    const { deliveries } = await f.json(
      await f.app.request(`${f.sources}/${pending.id}/deliveries`, { headers: f.owner.headers }),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: "rejected", bodyRetained: false });
    expect(deliveries[0].reason).toContain("No signing secret yet");
    const turnedOn = await f.app.request(`${f.sources}/${pending.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ status: "active" }),
    });
    expect(turnedOn.status).toBe(422);
    const pasted = await f.app.request(`${f.sources}/${pending.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ signingSecret: linearSecret }),
    });
    expect(pasted.status).toBe(200);
    expect(await f.json(pasted)).toMatchObject({
      status: "active",
      statusReason: null,
      statusReasonCode: null,
      awaitingSigningSecret: false,
    });

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

describe("agent tools", () => {
  test("the tools and the events field exist only where event triggers run and the session selects them", async () => {
    const on = await fixture({ enabled: true });
    const cases = [
      { f: await fixture({ enabled: false }), metadata: {}, enabled: false },
      { f: on, metadata: {}, enabled: true },
      {
        f: on,
        metadata: {
          sessionId: crypto.randomUUID(),
          firstPartyMcpTools: ["scheduled_tasks_create", "scheduled_tasks_update"],
        },
        enabled: false,
      },
    ];
    for (const { f, metadata, enabled } of cases) {
      const { client, close } = await agent(f, f.owner.subjectId, metadata);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      const create = tools.find((tool) => tool.name === "scheduled_tasks_create")!;
      const update = tools.find((tool) => tool.name === "scheduled_tasks_update")!;
      expect(names.includes("event_sources_list")).toBe(enabled);
      expect(names.includes("events_get")).toBe(enabled);
      expect("events" in (create.inputSchema.properties ?? {})).toBe(enabled);
      expect("events" in (update.inputSchema.properties ?? {})).toBe(enabled);
      expect(create.inputSchema.required?.includes("schedule") ?? false).toBe(!enabled);
      expect(create.description?.includes("event_sources_list")).toBe(enabled);
      await close();
    }
  });

  test("an agent finds a source, sets up a trigger without a schedule, and reads what a run carried", async () => {
    const f = await fixture({ enabled: true });
    const { source, signingSecret } = await f.json(
      await f.app.request(f.sources, {
        method: "POST",
        headers: f.owner.headers,
        body: JSON.stringify({ kind: "webhook", adapter: "standard", name: "Orders" }),
      }),
    );
    expect(
      (
        await f.deliver(
          source.webhookUrl,
          signingSecret,
          JSON.stringify({ type: "order.created", data: { id: "ord_0", total: 1 } }),
        )
      ).status,
    ).toBe(200);
    const owner = await agent(f, f.owner.subjectId);

    expect(await owner.call("event_sources_list", {})).toEqual({
      sources: [
        {
          id: source.id,
          name: "Orders",
          kind: "webhook",
          adapter: "standard",
          status: "active",
          lastEventAt: expect.any(String),
        },
      ],
      // This workspace's own events need no setting up.
      readyToAdd: [{ id: "workspace", name: "This workspace", kind: "workspace" }],
    });
    const described = await owner.call("event_sources_list", { sourceId: source.id });
    expect(described.eventTypes.map((type: { type: string }) => type.type)).toEqual([
      "order.created",
    ]);

    expect(
      await owner.call("scheduled_tasks_create", { name: "Orders", ...separateAgent }),
    ).toEqual({ error: expect.stringContaining("Add a schedule, or event triggers") });
    const created = await owner.call("scheduled_tasks_create", {
      name: "New orders",
      ...separateAgent,
      events: {
        triggers: [
          {
            sourceId: source.id,
            eventTypes: ["order.created"],
            conditions: [{ field: "data.total", op: "exists" }],
          },
        ],
      },
    });
    expect(created.outcome).toBe("created");
    const taskId = created.resource.id as string;
    const got = await owner.call("scheduled_tasks_get", { id: taskId });
    expect(got.schedule).toEqual({ type: "manual" });
    expect(got.events).toMatchObject({
      once: false,
      maxRunsPerHour: 30,
      triggers: [
        {
          sourceId: source.id,
          eventTypes: ["order.created"],
          conditions: [{ field: "data.total", op: "exists" }],
          includeOwnEvents: false,
          status: "active",
        },
      ],
    });

    // Another member sees neither the private source nor its events.
    const other = await agent(f, f.other.subjectId);
    expect(await other.call("event_sources_list", {})).toMatchObject({ sources: [] });
    expect(await other.call("event_sources_list", { sourceId: source.id })).toEqual({
      error: expect.stringContaining("Event source not found"),
    });

    const body = JSON.stringify({
      type: "order.created",
      data: { id: "ord_1", total: 129, title: "Order 1" },
    });
    expect((await f.deliver(source.webhookUrl, signingSecret, body)).status).toBe(200);
    const started: EventOccurrenceToStart[] = [];
    await makeDue(f.workspace.id);
    await dispatchDueEventTriggers({
      db: db.db,
      settings: f.settings,
      bus: f.bus,
      startRun: async (occurrence) => {
        if (occurrence.taskId === taskId) started.push(occurrence);
      },
    });
    expect(started).toHaveLength(1);
    await markEventOccurrenceStarted(db.db, f.workspace.id, started[0]!.id);
    const task = await getScheduledTask(db.db, f.workspace.id, taskId);
    const run = await eventRun(task!, eventOccurrenceProducerKey(started[0]!.id));

    const runs = await owner.call("scheduled_task_runs_list", { taskId });
    expect(runs.runs[0].eventOccurrence).toEqual({
      triggerIds: [got.events.triggers[0].id],
      eventCount: 1,
    });
    const carried = await owner.call("events_get", { scheduledTaskRunId: run.id });
    expect(carried).toMatchObject({
      scheduledTaskRunId: run.id,
      eventCount: 1,
      events: [{ type: "order.created", subject: "ord_1", summary: "Order 1" }],
    });
    expect(carried.nextOffset).toBeUndefined();
    const eventId = carried.events[0].id as string;
    expect(await owner.call("events_get", { eventId })).toMatchObject({
      event: { id: eventId, type: "order.created", data: { id: "ord_1", total: 129 } },
    });
    expect(await other.call("events_get", { eventId })).toEqual({
      error: expect.stringContaining(`Event not found: ${eventId}`),
    });
    expect(await owner.call("events_get", {})).toEqual({
      error: expect.stringContaining("Pass either eventId or scheduledTaskRunId"),
    });

    // events replaces every trigger; an empty list removes them.
    const cleared = await owner.call("scheduled_tasks_update", {
      id: taskId,
      events: { triggers: [] },
    });
    expect(cleared.outcome).toBe("updated");
    expect((await owner.call("scheduled_tasks_get", { id: taskId })).events).toBeUndefined();
    await Promise.all([owner.close(), other.close()]);
  });
});

/**
 * A finished run for an occurrence. Only its link to the occurrence matters
 * here, so it skips the admission the worker goes through.
 */
async function eventRun(task: ScheduledTask, producerKey: string) {
  return await shared.admin.begin(async (sql) => {
    await sql`set local session_replication_role = replica`;
    const [run] = await sql<{ id: string }[]>`
      insert into scheduled_task_runs (
        id, account_id, workspace_id, task_id, task_authority_revision, task_execution_digest,
        trigger_type, producer_key, fired_at, status, action_kind, completed_at
      ) values (
        ${crypto.randomUUID()}, ${task.accountId}, ${task.workspaceId}, ${task.id},
        ${task.authorityRevision}, ${task.executionDigest}, 'event', ${producerKey}, now(),
        'succeeded', 'agent_turn', now()
      ) returning id`;
    return run!;
  });
}

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

  async function mcpFixture(
    options: { profile?: FakeMcpEventsProfile; webhookBaseUrl?: string } = {},
  ) {
    let app: { request: (path: string, init: RequestInit) => Promise<Response> } | null = null;
    const fake = startFakeMcpEventsServer({
      // A server built for ChatGPT offers webhook delivery only.
      eventTypes:
        options.profile === "chatgpt"
          ? [{ ...TICKET_CLOSED, delivery: ["webhook"] }]
          : [TICKET_CREATED, TICKET_CLOSED],
      ...(options.profile ? { profile: options.profile } : {}),
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
      ...(options.webhookBaseUrl ? { webhookBaseUrl: options.webhookBaseUrl } : {}),
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

  test("a server that offers events is ready to use: its first use adds the person's source", async () => {
    const f = await mcpFixture();
    const ready = async (headers: Record<string, string>) =>
      (await f.json(await f.app.request(`${f.sources}/ready`, { headers }))).sources;
    const workspace = { key: "workspace", kind: "workspace", name: "This workspace" };
    // A server without events isn't offered, and a workspace key owns no sources.
    expect(await ready(f.owner.headers)).toEqual([
      { key: "mcp-server:events-fixture", kind: "mcp", name: "Events Fixture" },
      workspace,
    ]);
    expect(await ready(f.service)).toEqual([]);

    // An agent with no sources finds the server, reads its event types and
    // sets up an automation on it, without anyone adding a source first.
    const owner = await agent(f, f.owner.subjectId);
    expect(await owner.call("event_sources_list", {})).toEqual({
      sources: [],
      readyToAdd: [
        { id: "mcp-server:events-fixture", name: "Events Fixture", kind: "mcp" },
        { id: "workspace", name: "This workspace", kind: "workspace" },
      ],
    });
    const described = await owner.call("event_sources_list", {
      sourceId: "mcp-server:events-fixture",
    });
    expect(described.source).toMatchObject({ name: "Events Fixture", kind: "mcp" });
    expect(described.eventTypes.map((type: { type: string }) => type.type)).toEqual([
      "ticket.created",
      "ticket.closed",
    ]);
    const sourceId = described.source.id as string;
    const created = await owner.call("scheduled_tasks_create", {
      name: "Billing tickets",
      ...separateAgent,
      events: {
        triggers: [
          {
            sourceId: "mcp-server:events-fixture",
            eventTypes: ["ticket.created"],
            arguments: { queue: "billing" },
          },
        ],
      },
    });
    expect(created.outcome).toBe("created");
    const automation = await f.task(created.resource.id);
    expect(automation.events.triggers[0]).toMatchObject({ sourceId, status: "active" });
    expect(await ready(f.owner.headers)).toEqual([workspace]);
    expect((await owner.call("event_sources_list", {})).sources).toMatchObject([
      { id: sourceId, name: "Events Fixture", kind: "mcp" },
    ]);

    // The key keeps naming that same source.
    const again = await f.createAutomation(f.owner.headers, {
      triggers: [{ sourceId: "mcp-server:events-fixture", eventTypes: ["ticket.closed"] }],
    });
    expect(again.status).toBe(201);
    expect((await f.json(again)).events.triggers[0].sourceId).toBe(sourceId);

    // A key for a server without events, or from a workspace key, fails plainly.
    const plain = await f.createAutomation(f.owner.headers, {
      triggers: [{ sourceId: "mcp-server:plain-fixture", eventTypes: ["ticket.created"] }],
    });
    expect(plain.status).toBe(422);
    expect(await plain.text()).toContain("Trigger 1:");
    const asService = await f.createAutomation(f.service, {
      triggers: [{ sourceId: "mcp-server:events-fixture", eventTypes: ["ticket.created"] }],
    });
    expect(asService.status).toBe(422);

    // A session that can't set up automations isn't offered sources to add.
    const reader = await agent(f, f.other.subjectId, {}, ["scheduled_tasks:run"]);
    expect(await reader.call("event_sources_list", {})).not.toHaveProperty("readyToAdd");
    expect(
      await reader.call("event_sources_list", { sourceId: "mcp-server:events-fixture" }),
    ).toEqual({ error: expect.stringContaining("Event source not found") });

    // And the server's events wake the automation.
    await f.pump();
    await f.fake.emit("ticket.created", { queue: "billing", title: "Invoice wrong" });
    await f.pump();
    await f.dispatch();
    expect(f.started.map((run) => run.taskId)).toContain(automation.id);
    await Promise.all([owner.close(), reader.close()]);
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
    expect(blocked.events.triggers[0]).toMatchObject({
      statusReasonCode: "forbidden",
      statusReasonDetail: "Queue is private",
    });

    await f.pump();
    expect((await f.task(automation.id)).events.triggers[0]).toMatchObject({
      status: "active",
      statusReason: null,
      statusReasonCode: null,
      statusReasonDetail: null,
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

  test("webhook delivery goes to the deployment's separate webhook address", async () => {
    const f = await mcpFixture({ webhookBaseUrl: "https://hooks.opengeni.example:8443/" });
    const source = await f.createSource();
    await f.automation(source.id, "ticket.closed", { queue: "billing" });
    await f.pump();
    const [subscription] = await f.subscriptions();
    expect(subscription).toMatchObject({ mode: "webhook", failures: 0 });
    const url = f.fake.subscriptions.get(String(subscription!.server_subscription_id))!.url;
    expect(url).toStartWith("https://hooks.opengeni.example:8443/v1/webhooks/events/");
    expect(f.fake.posts.map((post) => [JSON.parse(post.body).type, post.status])).toEqual([
      ["verification", 200],
    ]);
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

  test("a server built for ChatGPT's earlier draft works over webhooks", async () => {
    const f = await mcpFixture({ profile: "chatgpt" });
    const source = await f.createSource();
    const { eventTypes } = await f.json(
      await f.app.request(`${f.sources}/${source.id}/event-types`, { headers: f.owner.headers }),
    );
    expect(eventTypes.map((entry: any) => entry.type)).toEqual(["ticket.closed"]);
    const automation = await f.automation(source.id, "ticket.closed", { queue: "billing" });

    await f.pump();
    const [subscription] = await f.subscriptions();
    expect(subscription).toMatchObject({ mode: "webhook", failures: 0 });
    const serverId = String(subscription!.server_subscription_id);

    // Its deliveries reuse the event id as webhook-id; a retry is still recorded once.
    const event = await f.fake.emit("ticket.closed", { queue: "billing", title: "Refund sent" });
    const delivered = f.fake.posts.at(-1)!;
    expect(delivered).toMatchObject({ webhookId: event.eventId, status: 200 });
    expect((await f.fake.redeliver(delivered)).status).toBe(200);
    expect((await f.events(source.id)).map((stored) => stored.data.title)).toEqual(["Refund sent"]);
    await f.dispatch();
    expect(f.started.map((run) => run.taskId)).toEqual([automation.id]);

    // Access revoked, in the draft's numbering: the trigger is blocked, not retried quietly.
    await f.fake.terminate(serverId, { code: -32_012, message: "Forbidden" });
    f.fake.failNext("events/subscribe", { code: -32_012, message: "Forbidden" });
    await f.pump();
    expect((await f.task(automation.id)).events.triggers[0].status).toBe("blocked");
  });
});

describe("GitHub event sources", () => {
  const webhookSecret = "github-hook-secret";
  let nextInstallationId = 700_000 + Math.floor(Math.random() * 100_000) * 10;

  function fakeGitHubApp(events: string[], webhookUrl: string | null = null) {
    const setUrls: string[] = [];
    let current = webhookUrl;
    return {
      setUrls,
      api: {
        getWebhookSetup: async () => ({ webhookUrl: current, events }),
        setWebhookUrl: async ({ url }: { url: string }) => {
          setUrls.push(url);
          current = url;
        },
      },
    };
  }

  async function githubFixture(
    app: ReturnType<typeof fakeGitHubApp>,
    options: { webhookBaseUrl?: string } = {},
  ) {
    const f = await fixture({
      enabled: true,
      github: { webhookSecret, appSlug: "opengeni-agent", api: app.api },
      ...options,
    });
    const bind = async (installationId: number, repositoryIds: number[]) => {
      const checkedAt = new Date();
      await bindAuthorizedGitHubInstallationRepositories(db.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        installationId,
        githubAccountId: 9001,
        accountLogin: "acme",
        accountType: "Organization",
        linkedBySubjectId: f.owner.subjectId,
        githubActorId: 9002,
        githubActorLogin: "owner",
        authorityKind: "organization_owner",
        authorityCheckedAt: checkedAt,
        authorityExpiresAt: new Date(checkedAt.getTime() + 5 * 60_000),
        authorityNonce: `github-events-${crypto.randomUUID()}`,
        repositoryIds,
        eventRouteSecret: eventRouteSecret(f.settings),
      });
    };
    const addSource = async () =>
      await f.app.request(f.sources, {
        method: "POST",
        headers: f.owner.headers,
        body: JSON.stringify({ kind: "github" }),
      });
    return { ...f, bind, addSource };
  }

  function installation(): number {
    nextInstallationId += 1;
    return nextInstallationId;
  }

  function pullRequestOpened(
    installationId: number,
    repositoryId: number,
    sender: { login: string; type: string } = { login: "octocat", type: "User" },
  ): string {
    return JSON.stringify({
      action: "opened",
      installation: { id: installationId },
      repository: {
        id: repositoryId,
        name: "api",
        full_name: "acme/api",
        owner: { login: "acme" },
      },
      sender,
      pull_request: {
        number: 7,
        title: "Add retries",
        html_url: "https://github.com/acme/api/pull/7",
      },
    });
  }

  function signed(
    body: string,
    event: string,
    delivery = crypto.randomUUID(),
    secret = webhookSecret,
  ) {
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    };
  }

  test("a workspace's GitHub source receives its repositories' events and wakes automations", async () => {
    const github = fakeGitHubApp(["pull_request", "push"]);
    const f = await githubFixture(github);
    const installationId = installation();

    const unconnected = await f.addSource();
    expect(unconnected.status).toBe(422);
    expect(await unconnected.text()).toContain("Connect GitHub to this workspace first");

    await f.bind(installationId, [601]);
    const created = await f.addSource();
    expect(created.status).toBe(201);
    const { source } = await f.json(created);
    expect(source).toMatchObject({
      kind: "github",
      name: "GitHub",
      ownerSubjectId: null,
      visibility: "workspace",
      webhookUrl: null,
    });
    // The App had no webhook, so it now sends its webhooks here.
    expect(github.setUrls).toEqual(["https://opengeni.example/v1/webhooks/github"]);
    // Adding it again returns the same source and leaves the App alone.
    expect((await f.json(await f.addSource())).source.id).toBe(source.id);
    expect(github.setUrls).toHaveLength(1);
    expect(
      (await f.app.request(`${f.sources}/${source.id}`, { headers: f.other.headers })).status,
    ).toBe(200);

    const types = await f.json(
      await f.app.request(`${f.sources}/${source.id}/event-types`, { headers: f.owner.headers }),
    );
    const byType = new Map<string, any>(types.eventTypes.map((entry: any) => [entry.type, entry]));
    expect(byType.get("pull_request.opened")).toMatchObject({ available: true });
    expect(byType.get("issues.opened")).toMatchObject({ available: false });

    const automationResponse = await f.createAutomation(f.owner.headers, {
      triggers: [{ sourceId: source.id, eventTypes: ["pull_request.opened"] }],
    });
    expect(automationResponse.status).toBe(201);
    const automation = await f.json(automationResponse);

    const deliveryId = crypto.randomUUID();
    const body = pullRequestOpened(installationId, 601);
    const received = await f.app.request(
      "/v1/webhooks/github",
      signed(body, "pull_request", deliveryId),
    );
    expect(received.status).toBe(200);
    expect(await f.json(received)).toEqual({ deliveries: 1 });
    // GitHub redelivering the same delivery is recorded once.
    await f.app.request("/v1/webhooks/github", signed(body, "pull_request", deliveryId));
    // Another repository of the installation, or another installation, is not this workspace's.
    const otherRepository = await f.app.request(
      "/v1/webhooks/github",
      signed(pullRequestOpened(installationId, 602), "pull_request"),
    );
    expect(await f.json(otherRepository)).toEqual({ deliveries: 0 });
    const otherInstallation = await f.app.request(
      "/v1/webhooks/github",
      signed(pullRequestOpened(installation(), 601), "pull_request"),
    );
    expect(await f.json(otherInstallation)).toEqual({ deliveries: 0 });
    // Events made by Opengeni's own App are kept but leave the trigger alone.
    const own = await f.app.request(
      "/v1/webhooks/github",
      signed(
        pullRequestOpened(installationId, 601, { login: "opengeni-agent[bot]", type: "Bot" }),
        "pull_request",
      ),
    );
    expect(await f.json(own)).toEqual({ deliveries: 1 });
    const forged = await f.app.request(
      "/v1/webhooks/github",
      signed(body, "pull_request", crypto.randomUUID(), "not-the-secret"),
    );
    expect(forged.status).toBe(401);

    const deliveries = await f.json(
      await f.app.request(`${f.sources}/${source.id}/deliveries`, { headers: f.owner.headers }),
    );
    expect(deliveries.deliveries).toHaveLength(2);
    expect(deliveries.deliveries[1]).toMatchObject({
      status: "accepted",
      duplicateCount: 1,
      bodyRetained: true,
    });
    const events = await f.json(
      await f.app.request(`${f.sources}/${source.id}/events`, { headers: f.owner.headers }),
    );
    expect(events.events.map((event: any) => [event.type, event.actor.kind])).toEqual([
      ["pull_request.opened", "opengeni"],
      ["pull_request.opened", "person"],
    ]);
    expect(events.events[1]).toMatchObject({
      subject: "acme/api#7",
      summary: "Pull request opened: acme/api#7 Add retries",
    });
    const [queued] =
      await shared.admin`select count(*)::int as count from scheduled_task_event_inbox
      where task_id = ${automation.id}`;
    expect(queued!.count).toBe(1);

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
    expect(started[0]).toMatchObject({ taskId: automation.id });

    // A replay reads the stored delivery with its GitHub headers again. The
    // source is the workspace's, so members use it and admins manage it.
    const replayPath = `${f.sources}/${source.id}/deliveries/${deliveries.deliveries[1].id}/replay`;
    expect(
      (await f.app.request(replayPath, { method: "POST", headers: f.owner.headers })).status,
    ).toBe(403);
    const replay = await f.app.request(replayPath, { method: "POST", headers: f.service });
    expect(replay.status).toBe(201);
    const replayed = await f.json(replay);
    expect(replayed.delivery).toMatchObject({ status: "accepted" });
    expect(replayed.delivery.eventIds).toHaveLength(1);
    await makeDue(f.workspace.id);
    await dispatch();
    expect(started).toHaveLength(2);
  });

  test("the source follows the workspace's GitHub connection", async () => {
    const f = await githubFixture(fakeGitHubApp(["pull_request"]));
    const first = installation();
    const second = installation();
    await f.bind(first, [701]);
    const { source } = await f.json(await f.addSource());
    await f.bind(second, [801]);
    const deliver = async (installationId: number, repositoryId: number) =>
      (await f.json(
        await f.app.request(
          "/v1/webhooks/github",
          signed(pullRequestOpened(installationId, repositoryId), "pull_request"),
        ),
      )) as { deliveries: number };
    expect(await deliver(second, 801)).toEqual({ deliveries: 1 });
    expect(await deliver(first, 701)).toEqual({ deliveries: 1 });

    await deleteGitHubInstallationBinding(db.db, {
      accountId: f.workspace.accountId,
      workspaceId: f.workspace.id,
      installationId: first,
      eventRouteSecret: eventRouteSecret(f.settings),
    });
    expect(await deliver(first, 701)).toEqual({ deliveries: 0 });
    const routes = await shared.admin`select external_key from event_ingress_routes
      where source_id = ${source.id} order by external_key`;
    // The route table has no tenant RLS, so it keeps a keyed hash, never the installation.
    expect(routes.map((route) => route.external_key)).toEqual([
      githubInstallationRouteKey(eventRouteSecret(f.settings)!, second),
    ]);
    expect(routes[0]!.external_key).toMatch(/^[0-9a-f]{64}$/);

    // Adding the source again recomputes lost routes.
    await shared.admin`delete from event_ingress_routes where source_id = ${source.id}`;
    expect(await deliver(second, 801)).toEqual({ deliveries: 0 });
    expect((await f.addSource()).status).toBe(201);
    expect(await deliver(second, 801)).toEqual({ deliveries: 1 });
  });

  test("an App that sends its webhooks elsewhere is left alone", async () => {
    const github = fakeGitHubApp(["pull_request"], "https://ci.example/hooks/github");
    const f = await githubFixture(github);
    await f.bind(installation(), [901]);
    const refused = await f.addSource();
    expect(refused.status).toBe(409);
    const message = await refused.text();
    expect(message).toContain("https://ci.example/hooks/github");
    expect(message).toContain("https://opengeni.example/v1/webhooks/github");
    expect(github.setUrls).toEqual([]);
  });

  test("a deployment with a separate webhook address gives that address out", async () => {
    const github = fakeGitHubApp(["pull_request"]);
    const f = await githubFixture(github, {
      webhookBaseUrl: "https://hooks.opengeni.example:8443",
    });
    await f.bind(installation(), [951]);
    expect((await f.addSource()).status).toBe(201);
    expect(github.setUrls).toEqual(["https://hooks.opengeni.example:8443/v1/webhooks/github"]);

    const created = await f.app.request(f.sources, {
      method: "POST",
      headers: f.owner.headers,
      body: JSON.stringify({ kind: "webhook", adapter: "standard", name: "Orders" }),
    });
    expect(created.status).toBe(201);
    const { source } = await f.json(created);
    expect(source.webhookUrl).toStartWith(
      "https://hooks.opengeni.example:8443/v1/webhooks/events/",
    );
  });
});

describe("Gmail event sources", () => {
  const MAILBOX = "owner@example.com";
  const TOKEN = "gmail-access-token";
  const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
  const GMAIL_MCP = "https://gmailmcp.googleapis.com/mcp/v1";

  type FakeMessage = {
    id: string;
    historyId: number;
    from: string;
    subject: string;
    messageId?: string;
    labels?: string[];
    deleted?: boolean;
  };

  /** Gmail's REST API for one mailbox: profile, inbox history and message metadata. */
  function fakeGmail() {
    let history = 100;
    let expiredBefore = 0;
    let revoked = false;
    const messages: FakeMessage[] = [];
    const requests: string[] = [];
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!url.toString().startsWith(GMAIL)) return reply(404, {});
      const path = url.pathname.replace("/gmail/v1/users/me", "");
      requests.push(path);
      if (revoked || new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`) {
        return reply(401, { error: { message: "Invalid Credentials", status: "UNAUTHENTICATED" } });
      }
      if (path === "/profile") {
        return reply(200, { emailAddress: MAILBOX, historyId: String(history) });
      }
      if (path === "/history") {
        const start = Number(url.searchParams.get("startHistoryId"));
        expect(url.searchParams.get("labelId")).toBe("INBOX");
        expect(url.searchParams.get("historyTypes")).toBe("messageAdded");
        if (start < expiredBefore) {
          return reply(404, {
            error: { message: "Requested entity was not found.", errors: [{ reason: "notFound" }] },
          });
        }
        const added = messages.filter(
          (message) => message.historyId > start && (message.labels ?? ["INBOX"]).includes("INBOX"),
        );
        return reply(200, {
          history: added.map((message) => ({
            id: String(message.historyId),
            messagesAdded: [
              {
                message: {
                  id: message.id,
                  threadId: `thread-${message.id}`,
                  labelIds: message.labels ?? ["INBOX", "UNREAD"],
                },
              },
            ],
          })),
          historyId: String(history),
        });
      }
      const id = /^\/messages\/([^/]+)$/u.exec(path)?.[1];
      const message = messages.find((candidate) => candidate.id === id);
      if (!message || message.deleted) return reply(404, { error: { message: "Not Found" } });
      expect(url.searchParams.get("format")).toBe("metadata");
      expect(url.searchParams.getAll("metadataHeaders")).toContain("Message-ID");
      return reply(200, {
        id: message.id,
        threadId: `thread-${message.id}`,
        labelIds: message.labels ?? ["INBOX", "UNREAD"],
        snippet: `About ${message.subject}`,
        internalDate: String(Date.parse("2026-10-20T10:00:00Z") + message.historyId * 1000),
        payload: {
          headers: [
            { name: "From", value: message.from },
            { name: "To", value: MAILBOX },
            { name: "Subject", value: message.subject },
            ...(message.messageId ? [{ name: "Message-ID", value: message.messageId }] : []),
          ],
        },
      });
    }) as typeof fetch;
    return {
      fetch,
      requests,
      receive(from: string, subject: string, extra: Partial<FakeMessage> = {}) {
        history += 1;
        const message = { id: `msg-${history}`, historyId: history, from, subject, ...extra };
        messages.push(message);
        return message;
      },
      expireHistory() {
        expiredBefore = history;
      },
      revoke(value: boolean) {
        revoked = value;
      },
    };
  }

  async function gmailFixture() {
    const gmail = fakeGmail();
    const f = await fixture({
      enabled: true,
      mcpServers: [
        {
          id: "gmail",
          name: "Gmail",
          url: GMAIL_MCP,
          connectionRef: {
            providerDomain: "gmailmcp.googleapis.com",
            kind: "oauth2",
            subjectScope: "subject",
          },
        },
      ],
      eventSourceFetch: gmail.fetch,
    });
    const connect = async (subjectId: string) =>
      await createConnection(db.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        subjectId,
        providerDomain: "gmailmcp.googleapis.com",
        kind: "oauth2",
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/gmail.modify",
        ],
        credentialEncrypted: encryptEnvironmentValue(
          Buffer.from(f.settings.environmentsEncryptionKey!, "base64"),
          JSON.stringify({ access_token: TOKEN, token_type: "Bearer", mcp_url: GMAIL_MCP }),
        ),
        metadata: { gmailEmail: MAILBOX, mcpUrl: GMAIL_MCP },
        createdBySubjectId: subjectId,
      });
    const createSource = async () =>
      await f.app.request(f.sources, {
        method: "POST",
        headers: f.owner.headers,
        body: JSON.stringify({ kind: "gmail" }),
      });
    const started: EventOccurrenceToStart[] = [];
    const pump = async () => {
      await shared.admin`update event_source_feeds
        set next_action_at = now() - interval '1 second', lease_until = null
        where workspace_id = ${f.workspace.id}`;
      await pumpDueEventSourceFeeds({
        db: db.db,
        settings: f.settings,
        bus: f.bus,
        fetch: gmail.fetch,
      });
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
    const feed = async () =>
      (
        await shared.admin`select cursor, gap_pending, failures from event_source_feeds
          where workspace_id = ${f.workspace.id}`
      )[0];
    const automation = async (sourceId: string) => {
      const response = await f.createAutomation(f.owner.headers, {
        triggers: [
          {
            sourceId,
            eventTypes: ["message.received"],
            conditions: [
              { field: "data.from_address", op: "contains", value: "@customer.example" },
            ],
          },
        ],
      });
      expect(response.status).toBe(201);
      return await f.json(response);
    };
    const queued = async (taskId: string) =>
      Number(
        (
          await shared.admin`select count(*)::int as count from scheduled_task_event_inbox
            where task_id = ${taskId}`
        )[0]!.count,
      );
    const events = async (sourceId: string) =>
      (
        await f.json(
          await f.app.request(`${f.sources}/${sourceId}/events`, { headers: f.owner.headers }),
        )
      ).events as Array<Record<string, any>>;
    const task = async (id: string) =>
      await f.json(await f.app.request(`${f.tasks}/${id}`, { headers: f.owner.headers }));
    return {
      ...f,
      gmail,
      connect,
      createSource,
      pump,
      dispatch,
      started,
      feed,
      automation,
      queued,
      events,
      task,
    };
  }

  test("a source is the owner's own mailbox, read with their Gmail connection", async () => {
    const f = await gmailFixture();
    const asService = await f.app.request(f.sources, {
      method: "POST",
      headers: f.service,
      body: JSON.stringify({ kind: "gmail" }),
    });
    expect(asService.status).toBe(422);
    const unconnected = await f.createSource();
    expect(unconnected.status).toBe(422);
    expect(await unconnected.text()).toContain("Connect your Gmail account first");

    await f.connect(f.owner.subjectId);
    const created = await f.createSource();
    expect(created.status).toBe(201);
    const { source } = await f.json(created);
    expect(source).toMatchObject({
      kind: "gmail",
      name: `Gmail (${MAILBOX})`,
      visibility: "private",
      ownerSubjectId: f.owner.subjectId,
      webhookUrl: null,
    });
    const again = await f.json(await f.createSource());
    expect(again.source.id).toBe(source.id);
    const shareAttempt = await f.app.request(`${f.sources}/${source.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ visibility: "workspace" }),
    });
    expect(shareAttempt.status).toBe(422);
    const hidden = await f.app.request(`${f.sources}/${source.id}`, { headers: f.other.headers });
    expect(hidden.status).toBe(404);
    const { eventTypes } = await f.json(
      await f.app.request(`${f.sources}/${source.id}/event-types`, { headers: f.owner.headers }),
    );
    expect(eventTypes.map((entry: any) => entry.type)).toEqual(["message.received"]);

    // Nothing listens yet, so the mailbox is not read.
    const before = f.gmail.requests.length;
    await f.pump();
    expect(f.gmail.requests.length).toBe(before);
    expect(await f.feed()).toMatchObject({ cursor: null });
  });

  test("a connected Gmail account is ready to use: naming it in a trigger adds its source", async () => {
    const f = await gmailFixture();
    const ready = async () =>
      (await f.json(await f.app.request(`${f.sources}/ready`, { headers: f.owner.headers })))
        .sources as Array<{ key: string; kind: string; name: string }>;
    // Nothing to read until the person connects Gmail.
    expect((await ready()).map((source) => source.kind)).toEqual(["workspace"]);

    const connection = await f.connect(f.owner.subjectId);
    const key = `gmail:${connection.id}`;
    expect(await ready()).toEqual([
      { key, kind: "gmail", name: `Gmail (${MAILBOX})` },
      { key: "workspace", kind: "workspace", name: "This workspace" },
    ]);

    // Someone else in the workspace can't use another person's mailbox.
    const borrowed = await f.createAutomation(f.other.headers, {
      triggers: [{ sourceId: key, eventTypes: ["message.received"] }],
    });
    expect(borrowed.status).toBe(422);

    const automation = await f.automation(key);
    const sourceId = automation.events.triggers[0].sourceId as string;
    expect(sourceId).not.toBe(key);
    const source = await f.json(
      await f.app.request(`${f.sources}/${sourceId}`, { headers: f.owner.headers }),
    );
    // Named as it was offered.
    expect(source).toMatchObject({ kind: "gmail", name: `Gmail (${MAILBOX})` });
    // Once added it is an ordinary source, and a second use reuses it.
    expect((await ready()).map((entry) => entry.key)).toEqual(["workspace"]);
    const again = await f.automation(key);
    expect(again.events.triggers[0].sourceId).toBe(sourceId);
  });

  test("new inbox mail wakes the automation once; Opengeni's own mail and earlier mail don't", async () => {
    const f = await gmailFixture();
    await f.connect(f.owner.subjectId);
    const { source } = await f.json(await f.createSource());
    f.gmail.receive("Early <early@customer.example>", "Sent before anyone listened");
    const automation = await f.automation(source.id);

    // The first read only learns where "now" is.
    await f.pump();
    expect(await f.feed()).toMatchObject({ cursor: "101", gap_pending: false });
    expect(await f.events(source.id)).toHaveLength(0);

    f.gmail.receive("Ada Lovelace <Ada@Customer.example>", "Order 42 is late");
    f.gmail.receive("Bob <bob@other.example>", "Lunch?");
    f.gmail.receive("Spam <spam@customer.example>", "Win", { labels: ["SPAM"] });
    await f.pump();
    const stored = await f.events(source.id);
    expect(stored.map((event) => event.subject)).toEqual(["Lunch?", "Order 42 is late"]);
    expect(stored[1]).toMatchObject({
      type: "message.received",
      summary: "Email from Ada Lovelace: Order 42 is late",
      url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(MAILBOX)}#all/thread-msg-102`,
      actor: { kind: "person", name: "Ada Lovelace" },
      data: {
        mailbox: MAILBOX,
        from_address: "ada@customer.example",
        subject: "Order 42 is late",
        snippet: "About Order 42 is late",
        labels: ["INBOX", "UNREAD"],
      },
    });
    expect(await f.queued(automation.id)).toBe(1);
    await f.dispatch();
    expect(f.started.map((run) => run.taskId)).toEqual([automation.id]);

    // Reading again finds nothing new.
    await f.pump();
    expect(await f.events(source.id)).toHaveLength(2);

    // Mail Opengeni's own Gmail tools wrote is recorded but fires nothing.
    f.gmail.receive("Ada Lovelace <ada@customer.example>", "Your summary", {
      messageId: `<${crypto.randomUUID()}@opengeni.invalid>`,
    });
    // A message deleted before it is read is left out and said so.
    f.gmail.receive("Cy <cy@customer.example>", "Never mind", { deleted: true });
    await f.pump();
    const [own] = await f.events(source.id);
    expect(own).toMatchObject({ subject: "Your summary", actor: { kind: "opengeni" } });
    expect(await f.queued(automation.id)).toBe(1);
    const deliveries = (
      await f.json(
        await f.app.request(`${f.sources}/${source.id}/deliveries`, { headers: f.owner.headers }),
      )
    ).deliveries as Array<Record<string, any>>;
    expect(deliveries[0]?.reason).toBe("1 message was deleted before Opengeni read it");

    // History Gmail no longer keeps is a gap: reading starts from now.
    f.gmail.receive("Lost <lost@customer.example>", "Lost");
    f.gmail.expireHistory();
    await f.pump();
    expect(await f.feed()).toMatchObject({ gap_pending: true });
    f.gmail.receive("Dee <dee@customer.example>", "After the gap");
    await f.pump();
    const [latest] = await f.events(source.id);
    expect(latest).toMatchObject({ subject: "After the gap", gapBefore: true });
    expect(await f.feed()).toMatchObject({ gap_pending: false });

    // A replayed read fires its mail again.
    const [read] = (
      await f.json(
        await f.app.request(`${f.sources}/${source.id}/deliveries`, { headers: f.owner.headers }),
      )
    ).deliveries as Array<Record<string, any>>;
    const replay = await f.app.request(`${f.sources}/${source.id}/deliveries/${read!.id}/replay`, {
      method: "POST",
      headers: f.owner.headers,
    });
    expect(replay.status).toBe(201);
    expect((await f.json(replay)).delivery.eventIds).toHaveLength(1);
  });

  test("a revoked sign-in blocks the triggers until it clears; pausing stops reading", async () => {
    const f = await gmailFixture();
    await f.connect(f.owner.subjectId);
    const { source } = await f.json(await f.createSource());
    const automation = await f.automation(source.id);
    await f.pump();

    f.gmail.revoke(true);
    await f.pump();
    const blocked = await f.task(automation.id);
    expect(blocked.events.triggers[0]).toMatchObject({
      status: "blocked",
      statusReason: "Reconnect Gmail to keep its mail coming",
      statusReasonCode: "reconnect",
    });

    f.gmail.revoke(false);
    await f.pump();
    expect((await f.task(automation.id)).events.triggers[0]).toMatchObject({
      status: "active",
      statusReason: null,
      statusReasonCode: null,
    });

    const paused = await f.app.request(`${f.tasks}/${automation.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ status: "paused" }),
    });
    expect(paused.status).toBe(200);
    await f.pump();
    expect(await f.feed()).toMatchObject({ cursor: null });
    const reads = f.gmail.requests.length;
    await f.pump();
    expect(f.gmail.requests.length).toBe(reads);
  });
});

describe("This workspace event sources", () => {
  const transcription = { providerId: "elevenlabs", model: "scribe_v2", options: {} };

  async function workspaceFixture() {
    const f = await fixture({ enabled: true });
    const started: EventOccurrenceToStart[] = [];
    const createSource = async (headers: Record<string, string>) =>
      await f.app.request(f.sources, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "workspace" }),
      });
    const pump = async () => {
      await shared.admin`update event_source_feeds
        set next_action_at = now() - interval '1 second', lease_until = null
        where workspace_id = ${f.workspace.id}`;
      await pumpDueEventSourceFeeds({ db: db.db, settings: f.settings, bus: f.bus });
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
    const queued = async (taskId: string) =>
      Number(
        (
          await shared.admin`select count(*)::int as count from scheduled_task_event_inbox
            where task_id = ${taskId}`
        )[0]!.count,
      );
    const events = async (sourceId: string, headers: Record<string, string>) =>
      (await f.json(await f.app.request(`${f.sources}/${sourceId}/events`, { headers })))
        .events as Array<Record<string, any>>;
    /** A meeting by `subjectId` whose first transcript is now ready. */
    const meeting = async (
      subjectId: string,
      title: string,
      visibility: "private" | "workspace",
    ): Promise<string> => {
      const actor = { workspaceId: f.workspace.id, subjectId };
      const recordingId = crypto.randomUUID();
      await createRecording(db.db, {
        ...actor,
        accountId: f.workspace.accountId,
        recordingId,
        title,
        visibility,
        tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
      });
      await reserveRecordingChunks(db.db, {
        ...actor,
        recordingId,
        trackNumber: 0,
        chunks: [
          {
            chunkNumber: 0,
            byteLength: 100,
            sha256: createHash("sha256").update(recordingId).digest("hex"),
            startMilliseconds: 0,
            durationMilliseconds: 5_000,
          },
        ],
      });
      await markRecordingChunksUploaded(db.db, {
        ...actor,
        recordingId,
        trackNumber: 0,
        chunkNumbers: [0],
      });
      const versionId = crypto.randomUUID();
      await finalizeRecording(db.db, {
        ...actor,
        recordingId,
        tracks: [{ trackNumber: 0, chunkCount: 1 }],
        transcription,
        versionId,
      });
      const processingOwner = crypto.randomUUID();
      await claimRecordingTranscriptVersion(db.db, {
        ...actor,
        versionId,
        processingOwner,
        leaseSeconds: 600,
      });
      await completeRecordingTranscriptVersion(db.db, {
        ...actor,
        versionId,
        processingOwner,
        languages: ["en"],
        diarized: false,
        diarization: "none",
        audioMilliseconds: 5_000,
        segments: [
          {
            startMilliseconds: 0,
            endMilliseconds: 4_000,
            trackNumber: 0,
            speakerLabel: "speaker_0",
            text: "We agreed to ship on Friday.",
          },
        ],
      });
      return recordingId;
    };
    return { ...f, started, createSource, pump, dispatch, queued, events, meeting };
  }

  test("it is each person's own, and a workspace key can't make one", async () => {
    const f = await workspaceFixture();
    const first = await f.createSource(f.owner.headers);
    expect(first.status).toBe(201);
    const { source } = await f.json(first);
    expect(source).toMatchObject({
      kind: "workspace",
      name: "This workspace",
      ownerSubjectId: f.owner.subjectId,
      visibility: "private",
      webhookUrl: null,
    });
    // Asking again returns the same source, so clients add it on first use.
    expect((await f.json(await f.createSource(f.owner.headers))).source.id).toBe(source.id);
    // Everyone else gets their own, and can't see this one.
    const theirs = (await f.json(await f.createSource(f.other.headers))).source;
    expect(theirs.id).not.toBe(source.id);
    expect(
      (await f.app.request(`${f.sources}/${source.id}`, { headers: f.other.headers })).status,
    ).toBe(404);
    expect((await f.createSource(f.service)).status).toBe(422);
    const widened = await f.app.request(`${f.sources}/${source.id}`, {
      method: "PATCH",
      headers: f.owner.headers,
      body: JSON.stringify({ visibility: "workspace" }),
    });
    expect(widened.status).toBe(422);
    const types = await f.json(
      await f.app.request(`${f.sources}/${source.id}/event-types`, { headers: f.owner.headers }),
    );
    expect(types.eventTypes.map((entry: { type: string }) => entry.type)).toContain(
      "recording.transcript.ready",
    );
  });

  test("a meeting's transcript becoming ready wakes its owner's automation, never someone else's", async () => {
    const f = await workspaceFixture();
    const { source } = await f.json(await f.createSource(f.owner.headers));
    const created = await f.createAutomation(f.owner.headers, {
      triggers: [
        {
          sourceId: source.id,
          eventTypes: ["recording.transcript.ready"],
          conditions: [{ field: "data.purpose", op: "equals", value: "meeting" }],
        },
      ],
    });
    expect(created.status).toBe(201);
    const automation = await f.json(created);
    // What the Meeting notes template listens for: only meetings its owner recorded.
    const ownMeetings = await f.json(
      await f.createAutomation(f.owner.headers, {
        triggers: [
          {
            sourceId: source.id,
            eventTypes: ["recording.transcript.ready"],
            conditions: [
              { field: "data.purpose", op: "equals", value: "meeting" },
              { field: "data.recordedByYou", op: "equals", value: true },
            ],
          },
        ],
      }),
    );
    const earlier = await f.meeting(f.owner.subjectId, "Before anyone listened", "private");

    // The first read only learns where "now" is.
    await f.pump();
    expect(await f.events(source.id, f.owner.headers)).toHaveLength(0);

    const mine = await f.meeting(f.owner.subjectId, "Weekly sync", "private");
    await f.meeting(f.other.subjectId, "Their private 1:1", "private");
    const sharedMeeting = await f.meeting(f.other.subjectId, "All hands", "workspace");
    await f.pump();

    const stored = await f.events(source.id, f.owner.headers);
    const ready = stored.filter((event) => event.type === "recording.transcript.ready");
    expect(ready.map((event) => event.subject).sort()).toEqual(["All hands", "Weekly sync"]);
    expect(stored.some((event) => event.subject === "Their private 1:1")).toBe(false);
    expect(stored.some((event) => event.data.recordingId === earlier)).toBe(false);
    expect(ready.find((event) => event.data.recordingId === mine)).toMatchObject({
      summary: "Transcript ready: Weekly sync",
      actor: { kind: "unknown" },
      data: {
        recordingId: mine,
        title: "Weekly sync",
        purpose: "meeting",
        visibility: "private",
        recordedByYou: true,
      },
    });
    expect(ready.find((event) => event.data.recordingId === sharedMeeting)?.data).toMatchObject({
      ownerSubjectId: f.other.subjectId,
      recordedByYou: false,
    });
    expect(await f.queued(automation.id)).toBe(2);
    expect(await f.queued(ownMeetings.id)).toBe(1);
    await f.dispatch();
    expect(f.started.map((run) => run.taskId).sort()).toEqual(
      [automation.id, ownMeetings.id].sort(),
    );

    // Reading again finds nothing new, even though it looks back.
    await f.pump();
    expect(await f.events(source.id, f.owner.headers)).toHaveLength(stored.length);

    // The other person's source sees their own private meeting once they listen.
    const theirs = (await f.json(await f.createSource(f.other.headers))).source;
    expect(
      (
        await f.createAutomation(f.other.headers, {
          triggers: [{ sourceId: theirs.id, eventTypes: ["recording.transcript.ready"] }],
        })
      ).status,
    ).toBe(201);
    await f.pump();
    await f.meeting(f.other.subjectId, "Another 1:1", "private");
    await f.pump();
    expect((await f.events(theirs.id, f.other.headers)).map((event) => event.subject)).toContain(
      "Another 1:1",
    );
    expect(
      (await f.events(source.id, f.owner.headers)).some((event) => event.subject === "Another 1:1"),
    ).toBe(false);

    // A replayed read fires its events again.
    const [read] = (
      await f.json(
        await f.app.request(`${f.sources}/${source.id}/deliveries`, { headers: f.owner.headers }),
      )
    ).deliveries as Array<Record<string, any>>;
    const replay = await f.app.request(`${f.sources}/${source.id}/deliveries/${read!.id}/replay`, {
      method: "POST",
      headers: f.owner.headers,
    });
    expect(replay.status).toBe(201);
    expect((await f.json(replay)).delivery.eventIds.length).toBeGreaterThan(0);
  });

  test("notes an agent saves are Opengeni's own, so they don't wake an automation by default", async () => {
    const f = await workspaceFixture();
    const { source } = await f.json(await f.createSource(f.owner.headers));
    const created = await f.createAutomation(f.owner.headers, {
      triggers: [{ sourceId: source.id, eventTypes: ["recording.notes.updated"] }],
    });
    expect(created.status).toBe(201);
    const automation = await f.json(created);
    const recordingId = await f.meeting(f.owner.subjectId, "Planning", "private");
    await f.pump();

    const actor = { workspaceId: f.workspace.id, subjectId: f.owner.subjectId };
    const agentChat = crypto.randomUUID();
    await saveRecordingNote(db.db, {
      ...actor,
      recordingId,
      kind: "notes",
      body: "## Summary\nShip on Friday.",
      sessionId: agentChat,
    });
    await saveRecordingNote(db.db, {
      ...actor,
      recordingId,
      kind: "notes",
      body: "## Summary\nShip on Friday, after the review.",
    });
    await f.pump();

    const saved = (await f.events(source.id, f.owner.headers)).filter(
      (event) => event.type === "recording.notes.updated",
    );
    expect(saved).toHaveLength(2);
    expect(saved.find((event) => event.data.sessionId === agentChat)).toMatchObject({
      summary: "Notes saved: Planning",
      actor: { kind: "opengeni" },
      data: { recordingId, noteRevision: 1 },
    });
    expect(saved.find((event) => event.data.noteRevision === 2)).toMatchObject({
      actor: { kind: "unknown" },
      data: { sessionId: null },
    });
    // Only the person's save wakes it; the agent's needs "Also run for what Opengeni does".
    expect(await f.queued(automation.id)).toBe(1);
    const types = await f.json(
      await f.app.request(`${f.sources}/${source.id}/event-types`, { headers: f.owner.headers }),
    );
    expect(
      types.eventTypes.find((entry: { type: string }) => entry.type === "recording.notes.updated")
        ?.fields,
    ).toContainEqual({
      field: "data.sessionId",
      description: "The chat whose agent saved them; null when a person did",
    });
  });
});

describe("automation templates", () => {
  const sendJson = (headers: Record<string, string>, method: string, body?: unknown) => ({
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  test("a saved template is the workspace's to use, and its saver's or an admin's to change", async () => {
    const f = await fixture({ enabled: true });
    const templates = `/v1/workspaces/${f.workspace.id}/automation-templates`;
    const teamSource = (
      await f.json(
        await f.app.request(
          f.sources,
          sendJson(f.owner.headers, "POST", {
            kind: "webhook",
            adapter: "standard",
            name: "Orders",
            visibility: "workspace",
          }),
        ),
      )
    ).source;
    const created = await f.app.request(
      templates,
      sendJson(f.owner.headers, "POST", {
        name: "Flag unusual orders",
        description: "Looks at each new order.",
        instructions: "Look at the new order and flag anything unusual.",
        schedule: { type: "calendar", hour: 8, minute: 0, daysOfWeek: ["MONDAY"] },
        triggers: [
          {
            source: { kind: "webhook", adapter: "standard", sourceId: teamSource.id },
            eventTypes: ["order.created"],
            conditions: [{ field: "data.total", op: "exists" }],
          },
          { source: { kind: "workspace" }, eventTypes: ["recording.transcript.ready"] },
        ],
      }),
    );
    expect(created.status).toBe(201);
    const { template } = await f.json(created);
    expect(template).toMatchObject({
      name: "Flag unusual orders",
      description: "Looks at each new order.",
      schedule: { type: "calendar", hour: 8, minute: 0, daysOfWeek: ["MONDAY"] },
      maxRunsPerHour: null,
      createdBySubjectId: f.owner.subjectId,
      viewerAccess: "manage",
    });
    expect(template.triggers[0]).toEqual({
      source: { kind: "webhook", adapter: "standard", sourceId: teamSource.id },
      eventTypes: ["order.created"],
      conditions: [{ field: "data.total", op: "exists" }],
      includeOwnEvents: false,
    });

    // Everyone in the workspace finds it; only its saver and admins change it.
    const theirs = (await f.json(await f.app.request(templates, { headers: f.other.headers })))
      .templates as Array<Record<string, unknown>>;
    expect(theirs.map((entry) => [entry.id, entry.viewerAccess])).toEqual([[template.id, "use"]]);
    const one = `${templates}/${template.id}`;
    expect(
      (await f.app.request(one, sendJson(f.other.headers, "PATCH", { name: "Mine now" }))).status,
    ).toBe(403);
    expect((await f.app.request(one, sendJson(f.other.headers, "DELETE"))).status).toBe(403);
    const renamed = await f.app.request(
      one,
      sendJson(f.owner.headers, "PATCH", { name: "Unusual orders", schedule: null }),
    );
    expect(renamed.status).toBe(200);
    expect((await f.json(renamed)).template).toMatchObject({
      name: "Unusual orders",
      description: "Looks at each new order.",
      instructions: "Look at the new order and flag anything unusual.",
      schedule: null,
    });
    expect((await f.app.request(one, sendJson(f.service, "DELETE"))).status).toBe(200);
    expect((await f.app.request(one, sendJson(f.owner.headers, "DELETE"))).status).toBe(404);
    expect(
      (await f.json(await f.app.request(templates, { headers: f.owner.headers }))).templates,
    ).toEqual([]);
  });

  test("a template names only a source shared with the workspace, of its trigger's kind", async () => {
    const f = await fixture({ enabled: true });
    const templates = `/v1/workspaces/${f.workspace.id}/automation-templates`;
    const source = async (visibility: "private" | "workspace") =>
      (
        await f.json(
          await f.app.request(
            f.sources,
            sendJson(f.owner.headers, "POST", {
              kind: "webhook",
              adapter: "standard",
              name: "Orders",
              visibility,
            }),
          ),
        )
      ).source as { id: string };
    const save = async (trigger: Record<string, unknown>) =>
      await f.app.request(
        templates,
        sendJson(f.owner.headers, "POST", {
          name: "Orders",
          instructions: "Look at the order.",
          triggers: [{ eventTypes: ["order.created"], ...trigger }],
        }),
      );
    const mine = await source("private");
    const team = await source("workspace");
    expect(
      (await save({ source: { kind: "webhook", adapter: "standard", sourceId: mine.id } })).status,
    ).toBe(422);
    expect(
      (await save({ source: { kind: "webhook", adapter: "linear", sourceId: team.id } })).status,
    ).toBe(422);
    expect((await save({ source: { kind: "webhook" } })).status).toBe(400);
    expect((await save({ source: { kind: "mcp" } })).status).toBe(400);
    expect((await save({ source: { kind: "github", adapter: "standard" } })).status).toBe(400);
    expect(
      (await save({ source: { kind: "webhook", adapter: "standard", sourceId: team.id } })).status,
    ).toBe(201);
    // A template has no time zone: the person using it brings theirs.
    const zoned = await f.app.request(
      templates,
      sendJson(f.owner.headers, "POST", {
        name: "Brief",
        instructions: "Summarize yesterday.",
        schedule: { type: "calendar", hour: 8, minute: 0, timeZone: "Europe/Oslo" },
      }),
    );
    expect(zoned.status).toBe(400);
  });
});
