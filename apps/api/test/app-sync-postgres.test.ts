import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ScheduledTaskAgentConfig, type AccessGrant } from "@opengeni/contracts";
import {
  eventMatchesTrigger,
  workspaceActivityEvent,
  type ObjectStorageDependency,
  type SessionWorkflowClient,
} from "@opengeni/core";
import { APP_PACKAGE_SYNC_HOOKS } from "../src/app-sync/package-hooks";
import {
  claimAppSyncRun,
  claimEventSourceFeed,
  claimEventTriggerDispatch,
  createDb,
  createEventSource,
  createOrganizationApiKey,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  EVENT_AUTOMATION_MAX_CHAIN_DEPTH,
  finishAppSyncRun,
  SiteDataError,
  createWorkspace,
  deleteEventSource,
  enqueueAppSyncRun,
  ensureExternalIdentity,
  eventOccurrenceProducerKey,
  getScheduledTask,
  listScheduledTaskRuns,
  markEventOccurrenceStarted,
  recordEventDelivery,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { HTTPException } from "hono/http-exception";
import postgres from "postgres";
import { createApp, type AppDependencies } from "../src/app";
import {
  readSiteToolAccountInventory,
  type SiteToolAccountInventory,
} from "../src/site-tool-routing";
import {
  createAppSyncFromDefinition,
  drainAppSyncRuns,
  listAppSyncDefinitions,
  runAppSyncNow,
  type AppSyncDeps,
  type AppSyncToolCaller,
} from "../src/app-sync/service";
import { readSiteSharedSyncTools } from "../src/workspace-tool-target";

// App data sync against PostgreSQL as the restricted application role. The
// connected tool is a fake; everything else (automations, run history, Site
// Data writes and access rules) is real. No session or model is involved.
let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("app-sync");
  if (!acquired) throw new Error("App sync tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const managerPermissions = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "artifacts:read",
  "artifacts:publish",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
] as const;
const viewerPermissions = ["workspace:read", "sessions:read", "artifacts:read"] as const;

function memoryObjectStorage() {
  const objects = new Map<string, Uint8Array>();
  const storage = {
    maxSinglePutSizeBytes: 5_000_000_000,
    headObject: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { ContentLength: bytes.length, VersionToken: "v" } : null;
    },
    getObjectRange: async (input: { key: string; start: number; endInclusive: number }) => {
      const bytes = objects.get(input.key);
      return bytes
        ? { bytes: bytes.slice(input.start, input.endInclusive + 1), versionToken: "v" }
        : null;
    },
    putObject: async (input: { key: string; body: Uint8Array }) => {
      objects.set(input.key, input.body.slice());
    },
    putObjectStreamIfAbsent: async (input: { key: string; chunks: AsyncIterable<Uint8Array> }) => {
      if (objects.has(input.key)) return false;
      const parts: Uint8Array[] = [];
      for await (const part of input.chunks) parts.push(part);
      objects.set(input.key, Buffer.concat(parts));
      return true;
    },
    getObjectBytes: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { bytes, contentType: "text/html" } : null;
    },
    createGetUrl: async (input: { key: string; responseContentDisposition?: string }) => ({
      url: `https://storage.example.test/${input.key}${input.responseContentDisposition ? "?download=1" : ""}`,
      expiresAt: new Date(Date.now() + 60_000),
    }),
    createPutUrl: async (input: { key: string }) => ({
      url: `https://storage.example.test/${input.key}`,
      expiresAt: new Date(Date.now() + 60_000),
      requiredHeaders: {},
    }),
    deleteObject: async (key: string) => {
      objects.delete(key);
    },
  };
  return { storage: storage as unknown as ObjectStorageDependency, objects };
}

type Who = { subjectId: string; grant: AccessGrant; headers: Record<string, string> };

async function fixture() {
  const inventory: { current: AppSyncDeps["appSyncToolInventory"] } = { current: undefined };
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('App sync fixture') returning id`;
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
      "artifacts:read",
      "artifacts:publish",
      "scheduled_tasks:manage",
      "scheduled_tasks:run",
      "account:admin",
    ],
  });
  const settings = testSettings({
    productAccessMode: "configured",
    sandboxBackend: "none",
    // The fake orders tool, configured for the workspace: readers of what a
    // shared sync stored must be able to use it (site-tool-data.ts).
    mcpServers: [{ id: "orders-server", name: "Orders", url: "https://orders.example/mcp" }],
  });
  const deps = {
    db: db.db,
    bus: new MemoryEventBus(),
    settings,
    objectStorage: memoryObjectStorage().storage,
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
    // Tests give people connector accounts through `inventories` below.
    appSyncToolInventory: (routeDeps: never, grant: AccessGrant) =>
      (inventory.current ?? readSiteToolAccountInventory)(routeDeps, grant),
  } as unknown as AppDependencies;
  const app = createApp(deps);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const person = async (permissions: readonly string[]): Promise<Who> => {
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
    expect(added.status, await added.clone().text()).toBe(200);
    return {
      subjectId: identity.subjectId,
      grant: {
        accountId,
        workspaceId: workspace.id,
        subjectId: identity.subjectId,
        permissions: [...permissions] as AccessGrant["permissions"],
        principalKind: "human_session",
      },
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
  const owner = await person(managerPermissions);
  const alice = await person(viewerPermissions);
  const bob = await person(viewerPermissions);
  const teammate = await person(managerPermissions);
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'app-sync-test')`;
  const base = `/v1/workspaces/${workspace.id}/published-artifacts`;
  const request = async (who: Who, method: string, path: string, body?: unknown) => {
    const response = await app.request(`${base}${path}`, {
      method,
      headers: who.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, json };
  };
  const published = await request(owner, "POST", "", {
    title: "Orders",
    html: "<!doctype html><h1>Orders</h1>",
    idempotencyKey: crypto.randomUUID(),
    visibility: "workspace",
  });
  expect(published.status, JSON.stringify(published.json)).toBe(201);
  const siteId = String(published.json.artifact.id);
  const versionId = String(published.json.version.id);
  return {
    app,
    deps: deps as AppDependencies & AppSyncDeps,
    accountId,
    workspace,
    owner,
    alice,
    bob,
    teammate,
    siteId,
    versionId,
    request,
    inventory,
  };
}

const tool = { serverId: "orders-server", toolName: "list_orders" };

/** A fake connected tool: answers per calling person, records every call. */
function fakeTool(answer: (subjectId: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ subjectId: string; args: Record<string, unknown> }> = [];
  const callTool: AppSyncToolCaller = async ({ grant, arguments: args }) => {
    calls.push({ subjectId: grant.subjectId, args });
    const value = answer(grant.subjectId, args);
    if (value instanceof Error) throw value;
    return { content: [{ type: "text", text: JSON.stringify(value) }] } as never;
  };
  return { callTool, calls };
}

test("a shared sync upserts kept fields by key, with no session, and reports its last run", async () => {
  const f = await fixture();
  const defined = await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  expect(defined.status, JSON.stringify(defined.json)).toBe(201);

  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool,
    arguments: { status: "open" },
    recordsPath: "data.items",
    key: "id",
    fields: ["id", "total", "customer.name"],
    schedule: { type: "interval", everySeconds: 3600 },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const syncId = String(created.json.id);
  expect(created.json).toMatchObject({ mode: "shared", ownerSubjectId: f.owner.subjectId });

  // Too frequent schedules are refused readably.
  const tooOften = await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    schedule: { type: "interval", everySeconds: 60 },
  });
  expect(tooOften.status).toBe(422);
  // Viewers can't manage syncs.
  expect((await f.request(f.alice, "GET", `/${f.siteId}/syncs`)).status).toBe(403);

  let total = 10;
  const fake = fakeTool(() => ({
    data: {
      items: [
        { id: "o-1", total, secret: "drop me", customer: { name: "Ada", email: "a@example.com" } },
        { id: 2, total: 5, customer: { name: "Grace" } },
        { total: 1 },
      ],
    },
  }));
  const first = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(first.lastRun).toMatchObject({
    status: "succeeded",
    error: null,
    summary: { received: 3, written: 2, skipped: 1, truncated: false, people: null },
  });
  expect(fake.calls).toEqual([{ subjectId: f.owner.subjectId, args: { status: "open" } }]);

  total = 42;
  const second = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(second.lastRun.status).toBe("succeeded");

  // A viewer reads the shared records: updated in place, only kept fields.
  const read = await f.request(f.alice, "POST", `/${f.siteId}/data/query`, {
    collection: "orders",
  });
  expect(read.status, JSON.stringify(read.json)).toBe(200);
  const records = (read.json.records as Array<{ key: string; data: unknown; owner: string }>)
    .map((record) => ({ key: record.key, data: record.data }))
    .sort((a, b) => a.key.localeCompare(b.key));
  expect(records).toEqual([
    { key: "2", data: { id: 2, total: 5, customer: { name: "Grace" } } },
    { key: "o-1", data: { id: "o-1", total: 42, customer: { name: "Ada" } } },
  ]);

  // Run history: ordinary automation runs, no session (no model run).
  const runs = await listScheduledTaskRuns(f.deps.db, f.workspace.id, syncId);
  expect(runs).toHaveLength(2);
  for (const run of runs) {
    expect(run.actionKind).toBe("app_sync");
    expect(run.sessionId ?? null).toBeNull();
    expect(run.status).toBe("succeeded");
    expect(run.syncSummary?.written).toBe(2);
  }

  // The App reads its last sync time and result.
  const status = await f.request(f.alice, "GET", `/${f.siteId}/data/syncs`);
  expect(status.status, JSON.stringify(status.json)).toBe(200);
  expect(status.json.syncs).toHaveLength(1);
  expect(status.json.syncs[0]).toMatchObject({
    id: syncId,
    collection: "orders",
    mode: "shared",
    active: true,
    optedIn: null,
    lastRun: { status: "succeeded", error: null },
  });
  expect(typeof status.json.syncs[0].lastRun.at).toBe("string");
});

test("a failing tool fails the run in history and shows as the App's last sync error", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, { accessMode: "shared" });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool,
    key: "id",
    schedule: { type: "manual" },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const syncId = String(created.json.id);

  // A tool that asks first can't be approved in an unattended run.
  const asking = fakeTool(
    () => new HTTPException(409, { message: "tool_gateway_approval_required" }),
  );
  const approval = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, asking.callTool);
  expect(approval.lastRun.status).toBe("failed");
  expect(approval.lastRun.error).toContain("asks for approval");

  // A tool error result fails it too, with the tool's own message.
  const erroring: AppSyncToolCaller = async () =>
    ({ isError: true, content: [{ type: "text", text: "rate limited" }] }) as never;
  const failed = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, erroring);
  expect(failed.lastRun).toMatchObject({ status: "failed" });
  expect(failed.lastRun.error).toContain("rate limited");

  const runs = await listScheduledTaskRuns(f.deps.db, f.workspace.id, syncId);
  expect(runs.map((run) => run.status)).toEqual(["failed", "failed"]);
  expect(runs.some((run) => (run.error ?? "").includes("rate limited"))).toBe(true);

  const status = await f.request(f.alice, "GET", `/${f.siteId}/data/syncs`);
  expect(status.json.syncs[0].lastRun).toMatchObject({ status: "failed" });
  expect(status.json.syncs[0].lastRun.error).toContain("rate limited");
  const listed = await f.request(f.owner, "GET", `/${f.siteId}/syncs`);
  expect(listed.json.syncs[0].lastRun.error).toContain("rate limited");
});

test("a personal sync fills only the opted-in person's own records", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/my-tasks`, {
    accessMode: "per_viewer",
    privateRecords: true,
  });
  // A shared sync can't fill a per_viewer collection.
  const wrongMode = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Tasks",
    collection: "my-tasks",
    tool,
    key: "id",
    schedule: { type: "manual" },
  });
  expect(wrongMode.status).toBe(422);
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "My tasks",
    collection: "my-tasks",
    mode: "personal",
    tool,
    key: "id",
    schedule: { type: "calendar", hour: 7, minute: 0, timeZone: "Europe/Oslo" },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const syncId = String(created.json.id);

  const optIn = await f.request(f.alice, "PUT", `/${f.siteId}/syncs/${syncId}/subscription`);
  expect(optIn.status, JSON.stringify(optIn.json)).toBe(200);
  expect(optIn.json).toEqual({ syncId, optedIn: true, account: null });

  const fake = fakeTool((subjectId) => [{ id: "t-1", title: `task of ${subjectId}` }]);
  const run = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(run.lastRun).toMatchObject({
    status: "succeeded",
    summary: { written: 1, people: { total: 1, failed: 0 } },
  });
  // The tool ran as Alice only, never as the owner or Bob.
  expect(fake.calls.map((call) => call.subjectId)).toEqual([f.alice.subjectId]);

  const mine = await f.request(f.alice, "POST", `/${f.siteId}/data/query`, {
    collection: "my-tasks",
  });
  expect(mine.json.records).toHaveLength(1);
  expect(mine.json.records[0]).toMatchObject({
    key: "t-1",
    owner: `user:${f.alice.subjectId}`,
    data: { title: `task of ${f.alice.subjectId}` },
  });
  for (const other of [f.bob, f.owner]) {
    const theirs = await f.request(other, "POST", `/${f.siteId}/data/query`, {
      collection: "my-tasks",
    });
    expect(theirs.json.records).toEqual([]);
  }

  // Each viewer sees their own opt-in and last run.
  const aliceStatus = await f.request(f.alice, "GET", `/${f.siteId}/data/syncs`);
  expect(aliceStatus.json.syncs[0]).toMatchObject({
    mode: "personal",
    optedIn: true,
    lastRun: { status: "succeeded" },
  });
  const bobStatus = await f.request(f.bob, "GET", `/${f.siteId}/data/syncs`);
  expect(bobStatus.json.syncs[0]).toMatchObject({ optedIn: false, lastRun: null });

  // Opting out stops further runs for that person.
  const optOut = await f.request(f.alice, "DELETE", `/${f.siteId}/syncs/${syncId}/subscription`);
  expect(optOut.json).toEqual({ syncId, optedIn: false, account: null });
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(fake.calls).toHaveLength(1);
});

test("queued runs from the worker execute; syncs export and install paused", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool,
    key: "id",
    schedule: { type: "interval", everySeconds: 900 },
  });
  const syncId = String(created.json.id);

  // What the worker does for a scheduled fire: a run plus a queue entry.
  const run = await createScheduledTaskRun(f.deps.db, {
    workspaceId: f.workspace.id,
    taskId: syncId,
    triggerType: "schedule",
    producerKey: `test-fire:${crypto.randomUUID()}`,
  });
  await enqueueAppSyncRun(f.deps.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    taskId: syncId,
    runId: run.id,
  });
  const fake = fakeTool(() => ({ items: [{ id: "a" }, { id: "b" }] }));
  let drained = 0;
  for (let pass = 0; pass < 5 && drained === 0; pass += 1)
    drained = (await drainAppSyncRuns(f.deps, { limit: 50, callTool: fake.callTool })).claimed;
  expect(drained).toBeGreaterThan(0);
  const [settled] = await listScheduledTaskRuns(f.deps.db, f.workspace.id, syncId);
  expect(settled).toMatchObject({ id: run.id, status: "succeeded", actionKind: "app_sync" });
  expect(settled!.syncSummary?.written).toBe(2);
  // A drained run is not executed twice.
  await drainAppSyncRuns(f.deps, { limit: 50, callTool: fake.callTool });
  expect(fake.calls).toHaveLength(1);

  const definitions = await listAppSyncDefinitions(f.deps, f.owner.grant, f.siteId);
  expect(definitions).toEqual([
    expect.objectContaining({
      name: "Orders",
      collection: "orders",
      mode: "shared",
      tool,
      key: "id",
      schedule: expect.objectContaining({ type: "interval", everySeconds: 900 }),
    }),
  ]);
  const installed = await createAppSyncFromDefinition(
    f.deps,
    f.owner.grant,
    f.siteId,
    definitions[0]!,
  );
  expect(installed.status).toBe("paused");
  expect((await getScheduledTask(f.deps.db, f.workspace.id, installed.id))?.status).toBe("paused");

  const removed = await f.request(f.owner, "DELETE", `/${f.siteId}/syncs/${syncId}`);
  expect(removed.status, JSON.stringify(removed.json)).toBe(200);
  const listed = await f.request(f.owner, "GET", `/${f.siteId}/syncs`);
  expect(listed.json.syncs.map((sync: { id: string }) => sync.id)).toEqual([installed.id]);

  // App packages carry syncs through the same definitions. A replayed
  // install finds the sync by name instead of creating it twice, and a
  // definition this deployment can't read is reported, not fatal.
  const exported = await APP_PACKAGE_SYNC_HOOKS.list({
    deps: f.deps,
    grant: f.owner.grant,
    appId: f.siteId,
  });
  expect(exported).toEqual([expect.objectContaining({ name: "Orders" })]);
  const replayed = await APP_PACKAGE_SYNC_HOOKS.createPaused({
    deps: f.deps,
    grant: f.owner.grant,
    appId: f.siteId,
    syncs: [...exported, { name: "Broken" }],
    installKey: crypto.randomUUID(),
  });
  expect(replayed.created).toEqual(["Orders"]);
  expect(replayed.notCreated).toEqual([expect.objectContaining({ name: "Broken" })]);
  const after = await f.request(f.owner, "GET", `/${f.siteId}/syncs`);
  expect(after.json.syncs).toHaveLength(1);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A connector with accounts ("orders"), and which accounts each person has. */
function inventories(
  f: Fixture,
  accounts: Record<string, Array<{ serverId: string; shared?: boolean }>>,
) {
  f.inventory.current = async (_deps, grant): Promise<SiteToolAccountInventory> => ({
    canonical: new Map([
      ["orders", { capabilityId: null, name: "Orders", providerDomain: "orders.example" }],
    ]),
    plain: new Set(),
    accounts: (accounts[grant.subjectId] ?? []).map((account) => ({
      serverId: account.serverId,
      canonicalServerId: "orders",
      connector: "Orders",
      account: `${account.serverId}@example.com`,
      connectionId: crypto.randomUUID(),
      ...(account.shared ? { shared: true } : {}),
    })),
  });
}

async function syncRuns(f: Fixture, syncId: string) {
  return await shared.admin<Array<{ status: string; chain_depth: number; error: string | null }>>`
    select status, chain_depth, error from scheduled_task_runs
    where workspace_id = ${f.workspace.id} and task_id = ${syncId} order by created_at, id`;
}

test("an automation woken by a sync's changes can't loop through app_sync_run past the chain limit", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool,
    key: "id",
    schedule: { type: "manual" },
  });
  const syncId = String(created.json.id);
  // Someone listens for App changes, so they are recorded with their depth.
  await shared.admin`insert into workspace_webhooks (account_id, workspace_id, url, secret_encrypted, event_types)
    values (${f.accountId}, ${f.workspace.id}, 'https://example.test', 'sealed', array['app.record.added'])`;
  let next = 0;
  const fake = fakeTool(() => [{ id: `order-${(next += 1)}` }]);

  // Automation A, which an `app.record.added` event wakes. Its runs are
  // made the way the event dispatcher makes them: one deeper than the event.
  const automationId = crypto.randomUUID();
  await createScheduledTask(f.deps.db, {
    id: automationId,
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    name: "React to new orders",
    status: "active",
    visibility: "workspace_shared",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-task-${automationId}`,
    runMode: "new_session_per_run",
    overlapPolicy: "skip",
    action: { kind: "agent_turn" },
    agentConfig: ScheduledTaskAgentConfig.parse({ prompt: "Refresh the orders" }),
    createdBy: { kind: "subject", subjectId: f.owner.subjectId },
    metadata: {},
  } as never);
  const automationAgent = async (depth: number): Promise<AccessGrant> => {
    const run = { id: crypto.randomUUID() };
    const session = await createSession(db.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      initialMessage: "Refresh the orders",
      resources: [],
      tools: [],
      metadata: { scheduledTaskRunId: run.id },
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    } as never);
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`insert into scheduled_task_runs (id, task_id, trigger_type, status, account_id,
          workspace_id, session_id, fired_at, chain_depth)
        values (${run.id}, ${automationId}, 'event', 'running', ${f.accountId}, ${f.workspace.id},
          ${session.id}, now(), ${depth})`;
    });
    // The turn the automation's run started (fixture rows, so database
    // guards for real dispatch are bypassed).
    const [turn] = await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      return await tx<{ id: string }[]>`
      INSERT INTO session_turns (
        account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, position, prompt, model, reasoning_effort, sandbox_backend,
        execution_generation, initiator_kind, initiator_subject_id, initiator_context,
        scheduled_task_run_id
      ) VALUES (
        ${f.accountId}, ${f.workspace.id}, ${session.id}, gen_random_uuid(),
        ${`app-sync-loop-${crypto.randomUUID()}`}, 'running', 0, 'Refresh the orders',
        'gpt-5.6-sol', 'medium', 'none', 1, 'subject', ${f.owner.subjectId}, '{"accepted":true}'::jsonb,
        ${run.id}
      ) RETURNING id`;
    });
    const attemptId = crypto.randomUUID();
    await shared.admin.begin(async (tx) => {
      await tx`UPDATE sessions SET active_turn_id = ${turn!.id} WHERE id = ${session.id}`;
      await tx`UPDATE session_turns SET active_attempt_id = ${attemptId} WHERE id = ${turn!.id}`;
      await tx`
        INSERT INTO session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, mcp_approval_policies
        ) VALUES (
          ${attemptId}, ${f.accountId}, ${f.workspace.id}, ${session.id}, ${turn!.id}, 1,
          'running', 'app-sync-wf', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
        )`;
    });
    return {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      subjectId: "worker:first-party-mcp",
      permissions: ["artifacts:read", "artifacts:publish", "scheduled_tasks:run"],
      principalKind: "agent_attempt",
      metadata: { sessionId: session.id, turnId: turn!.id, attemptId, executionGeneration: 1 },
    };
  };
  const newestEventDepth = async () => {
    const [row] = await shared.admin<
      {
        id: string;
        chain_depth: number;
        automation_id: string | null;
        automation_run_id: string | null;
        subject_id: string | null;
        data: Record<string, unknown>;
      }[]
    >`
      select id, chain_depth, automation_id, automation_run_id, subject_id, data
      from workspace_activity_events
      where workspace_id = ${f.workspace.id} and type = 'app.record.added'
      order by created_at desc, id desc limit 1`;
    // A sync runs no model, so its writes aren't Opengeni's own: a trigger
    // with default settings still hears them.
    expect(row?.automation_run_id).toBeNull();
    const event = workspaceActivityEvent(
      {
        id: row!.id,
        type: "app.record.added",
        occurredAt: new Date().toISOString(),
        sessionId: null,
        turnId: null,
        subjectId: row!.subject_id,
        automationId: row!.automation_id,
        automationRunId: row!.automation_run_id,
        chainDepth: Number(row!.chain_depth),
        data: row!.data,
        chatTitle: null,
        automationName: null,
        subjectLabel: null,
        url: null,
        appId: f.siteId,
      },
      null,
    );
    expect(
      eventMatchesTrigger(event, {
        eventTypes: ["app.record.added"],
        conditions: [],
        includeOwnEvents: false,
      }),
    ).toBe(true);
    return Number(row!.chain_depth);
  };

  // A person runs the sync: a chain of depth 1.
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  const depths = [await newestEventDepth()];
  // The dispatcher wakes A for events below the limit; A runs the sync again.
  for (let guard = 0; guard < 10 && depths.at(-1)! < EVENT_AUTOMATION_MAX_CHAIN_DEPTH; guard += 1) {
    const agent = await automationAgent(depths.at(-1)! + 1);
    const result = await runAppSyncNow(f.deps, agent, f.siteId, syncId, fake.callTool);
    expect(result.lastRun.status).toBe("succeeded");
    depths.push(await newestEventDepth());
  }
  expect(depths).toEqual([1, 3]);
  expect((await syncRuns(f, syncId)).map((run) => run.chain_depth)).toEqual([1, 3]);

  // An automation already at the limit can't run the sync at all.
  const deep = await automationAgent(EVENT_AUTOMATION_MAX_CHAIN_DEPTH);
  const refused = await runAppSyncNow(f.deps, deep, f.siteId, syncId, fake.callTool).catch(
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(SiteDataError);
  expect((refused as SiteDataError).message).toContain("loop");
  expect(fake.calls).toHaveLength(2);
});

test("a long run renews its lease, and a run that overlaps another is skipped", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/mine`, {
    accessMode: "per_viewer",
    privateRecords: true,
  });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Mine",
    collection: "mine",
    mode: "personal",
    tool,
    key: "id",
    schedule: { type: "interval", everySeconds: 3600 },
  });
  const syncId = String(created.json.id);
  for (const who of [f.alice, f.bob])
    expect((await f.request(who, "PUT", `/${f.siteId}/syncs/${syncId}/subscription`)).status).toBe(
      200,
    );
  const lease = async () => {
    const [row] = await shared.admin<{ live: boolean }[]>`
      select lease_until > now() + interval '60 seconds' as live from app_sync_queue
      where task_id = ${syncId}`;
    return row?.live ?? null;
  };
  let otherExecutor = -1;
  let renewedBeforeSecondPerson: boolean | null = null;
  const fake = fakeTool((subjectId) => {
    if (subjectId === f.alice.subjectId) return [{ id: "a" }];
    return [{ id: "b" }];
  });
  const callTool: AppSyncToolCaller = async (input) => {
    if (input.grant.subjectId === f.alice.subjectId)
      // The first person's call outlives the lease.
      await shared.admin`update app_sync_queue set lease_until = now() - interval '1 second'
        where task_id = ${syncId}`;
    else {
      renewedBeforeSecondPerson = await lease();
      // Another executor finds nothing to take over.
      otherExecutor = (await drainAppSyncRuns(f.deps, { limit: 50, callTool: fake.callTool }))
        .claimed;
    }
    return await fake.callTool(input);
  };
  const run = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, callTool);
  expect(run.lastRun).toMatchObject({
    status: "succeeded",
    summary: { written: 2, people: { total: 2, failed: 0 } },
  });
  expect(renewedBeforeSecondPerson).toBe(true);
  expect(otherExecutor).toBe(0);

  // Overlap: one run is in progress (claimed), a second one waits.
  const enqueue = async () => {
    const queued = await createScheduledTaskRun(f.deps.db, {
      workspaceId: f.workspace.id,
      taskId: syncId,
      triggerType: "scheduled",
      producerKey: `overlap:${crypto.randomUUID()}`,
    });
    await enqueueAppSyncRun(f.deps.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      taskId: syncId,
      runId: queued.id,
    });
    return queued.id;
  };
  const first = await enqueue();
  const inProgress = await claimAppSyncRun(f.deps.db, {
    workspaceId: f.workspace.id,
    runId: first,
  });
  expect(inProgress?.overlapping).toBe(false);
  // Queue ids are listed across workspaces only outside any workspace
  // context; inside another workspace's context none of them are visible.
  const appRole = postgres(shared.appUrl, { max: 1 });
  try {
    const seen = await appRole.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${crypto.randomUUID()}, true),
        set_config('opengeni.workspace_id', ${crypto.randomUUID()}, true)`;
      return await tx`select run_id from app_sync_queue`;
    });
    expect(seen).toHaveLength(0);
    const outside = await appRole`select run_id from app_sync_queue where run_id = ${first}`;
    expect(outside).toHaveLength(1);
  } finally {
    await appRole.end();
  }
  const second = await enqueue();
  const before = fake.calls.length;
  expect((await drainAppSyncRuns(f.deps, { limit: 50, callTool: fake.callTool })).claimed).toBe(1);
  expect(fake.calls).toHaveLength(before);
  const [skipped] = await listScheduledTaskRuns(f.deps.db, f.workspace.id, syncId).then((runs) =>
    runs.filter((item) => item.id === second),
  );
  expect(skipped).toMatchObject({ status: "skipped" });
  expect(skipped!.error).toContain("still in progress");
  await finishAppSyncRun(f.deps.db, {
    workspaceId: f.workspace.id,
    runId: first,
    status: "succeeded",
    error: null,
    summary: null,
  });
});

test("changing what a personal sync runs clears its opt-ins", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/mine`, {
    accessMode: "per_viewer",
  });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Mine",
    collection: "mine",
    mode: "personal",
    tool,
    arguments: { status: "open" },
    key: "id",
    schedule: { type: "manual" },
  });
  const syncId = String(created.json.id);
  await f.request(f.alice, "PUT", `/${f.siteId}/syncs/${syncId}/subscription`);
  const optedIn = async () =>
    (await f.request(f.alice, "GET", `/${f.siteId}/data/syncs`)).json.syncs[0].optedIn;
  expect(await optedIn()).toBe(true);

  // Renaming or rescheduling keeps consent; same arguments in another order too.
  const renamed = await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    name: "My open orders",
    arguments: { status: "open" },
    schedule: { type: "interval", everySeconds: 3600 },
  });
  expect(renamed.status, JSON.stringify(renamed.json)).toBe(200);
  expect(await optedIn()).toBe(true);

  // New arguments: people opt in again.
  const changed = await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    arguments: { status: "all" },
  });
  expect(changed.status).toBe(200);
  expect(changed.json.subscribers).toBe(0);
  expect(await optedIn()).toBe(false);

  // So does a new tool.
  await f.request(f.alice, "PUT", `/${f.siteId}/syncs/${syncId}/subscription`);
  await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    tool: { serverId: "orders-server", toolName: "list_all_orders" },
  });
  expect(await optedIn()).toBe(false);
});

test("each person's run uses their own account, and a new owner's shared sync uses theirs", async () => {
  const f = await fixture();
  inventories(f, {
    [f.owner.subjectId]: [{ serverId: "account-owner" }],
    [f.teammate.subjectId]: [{ serverId: "account-teammate" }],
    [f.alice.subjectId]: [{ serverId: "account-alice-2" }, { serverId: "account-alice" }],
    [f.bob.subjectId]: [{ serverId: "account-workspace", shared: true }],
  });
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/mine`, {
    accessMode: "per_viewer",
    privateRecords: true,
  });
  const ownRoute = { serverId: "account-owner", toolName: "list_orders" };
  const sharedSync = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool: ownRoute,
    key: "id",
    schedule: { type: "manual" },
  });
  expect(sharedSync.status, JSON.stringify(sharedSync.json)).toBe(201);
  const sharedId = String(sharedSync.json.id);
  const fake = fakeTool(() => [{ id: "x" }]);
  const identities: Array<{ subjectId: string; serverId: string }> = [];
  const callTool: AppSyncToolCaller = async (input) => {
    identities.push({ subjectId: input.grant.subjectId, serverId: input.identity.serverId });
    return await fake.callTool(input);
  };
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, sharedId, callTool);
  expect(identities.at(-1)).toEqual({ subjectId: f.owner.subjectId, serverId: "account-owner" });

  // Another manager saves it: they own it, on their own account.
  const taken = await f.request(f.teammate, "PATCH", `/${f.siteId}/syncs/${sharedId}`, {
    name: "Team orders",
  });
  expect(taken.status, JSON.stringify(taken.json)).toBe(200);
  expect(taken.json).toMatchObject({
    ownerSubjectId: f.teammate.subjectId,
    tool: { serverId: "account-teammate", toolName: "list_orders" },
  });
  await runAppSyncNow(f.deps, f.teammate.grant, f.siteId, sharedId, callTool);
  expect(identities.at(-1)).toEqual({
    subjectId: f.teammate.subjectId,
    serverId: "account-teammate",
  });

  // Personal: Alice's own account; Bob has only the workspace's shared one.
  const personal = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Mine",
    collection: "mine",
    mode: "personal",
    tool: ownRoute,
    key: "id",
    schedule: { type: "manual" },
  });
  const personalId = String(personal.json.id);
  // Alice has two accounts. Opting in without choosing works as before (her
  // first own account) and lists them; she can pick one, and it is kept.
  const unchosen = await f.request(f.alice, "PUT", `/${f.siteId}/syncs/${personalId}/subscription`);
  expect(unchosen.status, JSON.stringify(unchosen.json)).toBe(200);
  expect(unchosen.json).toMatchObject({ syncId: personalId, optedIn: true, account: null });
  expect(unchosen.json.accounts.map((choice: { id: string }) => choice.id).sort()).toEqual([
    "account-alice",
    "account-alice-2",
  ]);
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, personalId, callTool);
  expect(identities.at(-1)).toEqual({ subjectId: f.alice.subjectId, serverId: "account-alice-2" });
  const chosen = await f.request(f.alice, "PUT", `/${f.siteId}/syncs/${personalId}/subscription`, {
    account: "account-alice",
  });
  expect(chosen.json).toEqual({ syncId: personalId, optedIn: true, account: "account-alice" });
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, personalId, callTool);
  expect(identities.at(-1)).toEqual({ subjectId: f.alice.subjectId, serverId: "account-alice" });
  // Opting in again without an account keeps her choice, and back to the other.
  const again = await f.request(f.alice, "PUT", `/${f.siteId}/syncs/${personalId}/subscription`);
  expect(again.json).toMatchObject({ optedIn: true, account: "account-alice" });
  await f.request(f.alice, "PUT", `/${f.siteId}/syncs/${personalId}/subscription`, {
    account: "account-alice-2",
  });
  const foreign = await f.request(f.bob, "PUT", `/${f.siteId}/syncs/${personalId}/subscription`, {
    account: "account-alice",
  });
  expect(foreign.status).toBe(422);
  await f.request(f.bob, "PUT", `/${f.siteId}/syncs/${personalId}/subscription`);
  const run = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, personalId, callTool);
  expect(identities.at(-1)).toEqual({ subjectId: f.alice.subjectId, serverId: "account-alice-2" });
  expect(identities.some((item) => item.subjectId === f.bob.subjectId)).toBe(false);
  expect(run.lastRun.summary?.people).toEqual({ total: 2, failed: 1 });
  const bobStatus = await f.request(f.bob, "GET", `/${f.siteId}/data/syncs`);
  const bobSync = bobStatus.json.syncs.find((sync: { id: string }) => sync.id === personalId);
  expect(bobSync.lastRun.error).toContain("your own account");
});

test("a shared sync runs on the workspace's shared service connection", async () => {
  // An API-key connector connected once for the workspace with a shared key
  // from a vault (docs/secrets.md): the owner has no account of their own.
  const f = await fixture();
  inventories(f, { [f.owner.subjectId]: [{ serverId: "account-workspace", shared: true }] });
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool: { serverId: "orders", toolName: "list_orders" },
    key: "id",
    schedule: { type: "manual" },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const fake = fakeTool(() => [{ id: "1" }]);
  const served: string[] = [];
  const run = await runAppSyncNow(
    f.deps,
    f.owner.grant,
    f.siteId,
    String(created.json.id),
    async (input) => {
      served.push(input.identity.serverId);
      return await fake.callTool(input);
    },
  );
  expect(served).toEqual(["account-workspace"]);
  expect(run.lastRun.status).toBe("succeeded");
  // The connect card reads the shared sync's tool to offer a shared key for it.
  expect(await readSiteSharedSyncTools(f.deps.db, f.owner.grant, f.siteId)).toContainEqual({
    serverId: "orders",
    toolName: "list_orders",
  });
});

test("an exported sync runs on the installer's own account in another workspace", async () => {
  const author = await fixture();
  inventories(author, { [author.owner.subjectId]: [{ serverId: "account-author" }] });
  await author.request(author.owner, "PUT", `/${author.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const created = await author.request(author.owner, "POST", `/${author.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool: { serverId: "account-author", toolName: "list_orders" },
    key: "id",
    schedule: { type: "interval", everySeconds: 3600 },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const exported = await APP_PACKAGE_SYNC_HOOKS.list({
    deps: author.deps,
    grant: author.owner.grant,
    appId: author.siteId,
  });
  // The connector travels, not the author's account.
  expect(exported).toEqual([
    expect.objectContaining({ tool: { serverId: "orders", toolName: "list_orders" } }),
  ]);

  const installer = await fixture();
  inventories(installer, { [installer.owner.subjectId]: [{ serverId: "account-installer" }] });
  await installer.request(installer.owner, "PUT", `/${installer.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const installed = await APP_PACKAGE_SYNC_HOOKS.createPaused({
    deps: installer.deps,
    grant: installer.owner.grant,
    appId: installer.siteId,
    syncs: exported,
    installKey: crypto.randomUUID(),
  });
  expect(installed).toEqual({ created: ["Orders"], notCreated: [] });
  const [sync] = (await installer.request(installer.owner, "GET", `/${installer.siteId}/syncs`))
    .json.syncs;
  expect(sync).toMatchObject({
    status: "paused",
    tool: { serverId: "account-installer", toolName: "list_orders" },
  });
  // The installer turns it on and it runs on their account.
  const resumed = await installer.request(
    installer.owner,
    "PATCH",
    `/${installer.siteId}/syncs/${sync.id}`,
    { status: "active" },
  );
  expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);
  const used: string[] = [];
  const fake = fakeTool(() => [{ id: "o-1", total: 3 }]);
  const run = await runAppSyncNow(
    installer.deps,
    installer.owner.grant,
    installer.siteId,
    String(sync.id),
    async (input) => {
      used.push(input.identity.serverId);
      return await fake.callTool(input);
    },
  );
  expect(run.lastRun).toMatchObject({ status: "succeeded", summary: { written: 1 } });
  expect(used).toEqual(["account-installer"]);
  const records = await installer.request(
    installer.owner,
    "POST",
    `/${installer.siteId}/data/query`,
    {
      collection: "orders",
    },
  );
  expect(records.json.records).toEqual([
    expect.objectContaining({ key: "o-1", data: { id: "o-1", total: 3 } }),
  ]);
});

test("a shared sync's stored data stays restricted after it moves, until a manager resets it", async () => {
  const f = await fixture();
  for (const name of ["orders", "archive"])
    expect(
      (
        await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/${name}`, {
          accessMode: "shared_read",
        })
      ).status,
    ).toBe(201);
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool,
    key: "id",
    schedule: { type: "manual" },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const syncId = String(created.json.id);
  const fake = fakeTool(() => [{ id: "o-1", total: 3 }]);
  const run = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(run.lastRun.status, JSON.stringify(run.lastRun)).toBe("succeeded");

  // Alice can't use the orders tool; the owner can.
  inventories(f, { [f.owner.subjectId]: [{ serverId: "orders-server" }] });
  const read = async (who: typeof f.alice) =>
    (await f.request(who, "POST", `/${f.siteId}/data/query`, { collection: "orders" })).status;
  expect(await read(f.alice)).toBe(403);
  expect(await read(f.owner)).toBe(200);

  // The sync now fills another collection: what it stored here stays restricted.
  const moved = await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    collection: "archive",
  });
  expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  expect(await read(f.alice)).toBe(403);
  // And after the sync is deleted.
  expect((await f.request(f.owner, "DELETE", `/${f.siteId}/syncs/${syncId}`)).status).toBe(200);
  expect(await read(f.alice)).toBe(403);

  const resetOrders = async () => {
    const reset = await f.request(f.owner, "POST", `/${f.siteId}/data/collections/orders/reset`, {
      confirm: true,
    });
    expect(reset.status, JSON.stringify(reset.json)).toBe(200);
  };
  // A reset right after a write may race it, so marks from just before it stay.
  await resetOrders();
  expect(await read(f.alice)).toBe(403);

  // Later, a manager resets the data: nothing from the tool is left, so the mark goes.
  await shared.admin`update site_tool_data_sources set created_at = created_at - interval '5 minutes'
    where site_id = ${f.siteId}`;
  // Tombstones are immutable; age this one past its trigger for the test.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update scheduled_tasks set deleted_at = deleted_at - interval '5 minutes'
      where id = ${syncId}`;
  });
  await resetOrders();
  expect(await read(f.alice)).toBe(200);
  // The collection the sync moved to stays marked.
  expect(
    (await f.request(f.alice, "POST", `/${f.siteId}/data/query`, { collection: "archive" })).status,
  ).toBe(403);

  // New shared data after the reset marks it again.
  const again = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders again",
    collection: "orders",
    tool,
    key: "id",
    schedule: { type: "manual" },
  });
  expect(again.status, JSON.stringify(again.json)).toBe(201);
  const rerun = await runAppSyncNow(
    f.deps,
    f.owner.grant,
    f.siteId,
    String(again.json.id),
    fake.callTool,
  );
  expect(rerun.lastRun.status, JSON.stringify(rerun.lastRun)).toBe("succeeded");
  expect(await read(f.alice)).toBe(403);
});

test("a sync run still writing when a manager resets the data marks each page it writes", async () => {
  const f = await fixture();
  for (const name of ["orders", "archive"])
    await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/${name}`, {
      accessMode: "shared_read",
    });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool,
    recordsPath: "items",
    key: "id",
    paging: { mode: "cursor", cursorPath: "next", cursorArgument: "after" },
    schedule: { type: "manual" },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const syncId = String(created.json.id);
  inventories(f, { [f.owner.subjectId]: [{ serverId: "orders-server" }] });
  const read = async () =>
    (await f.request(f.alice, "POST", `/${f.siteId}/data/query`, { collection: "orders" })).status;
  // Between its pages, the sync is pointed elsewhere and a manager resets
  // the data long after the run marked it: the old mark is gone.
  const callTool: AppSyncToolCaller = async ({ arguments: args }) => {
    if (args.after === "p2") {
      const moved = await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
        collection: "archive",
      });
      expect(moved.status, JSON.stringify(moved.json)).toBe(200);
      await shared.admin`update site_tool_data_sources set created_at = created_at - interval '5 minutes'
        where site_id = ${f.siteId}`;
      const reset = await f.request(f.owner, "POST", `/${f.siteId}/data/collections/orders/reset`, {
        confirm: true,
      });
      expect(reset.status, JSON.stringify(reset.json)).toBe(200);
      expect(await read()).toBe(200);
      return {
        content: [{ type: "text", text: JSON.stringify({ items: [{ id: "b" }], next: null }) }],
      } as never;
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ items: [{ id: "a" }], next: "p2" }) }],
    } as never;
  };
  const run = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, callTool);
  expect(run.lastRun.status, JSON.stringify(run.lastRun)).toBe("succeeded");
  // The page it wrote after the reset marked the collection again.
  expect(await read()).toBe(403);
});

test("an archived App's syncs stop", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool,
    key: "id",
    schedule: { type: "manual" },
  });
  const archived = await f.request(f.owner, "PATCH", `/${f.siteId}/status`, {
    status: "archived",
    expectedCurrentVersionId: f.versionId,
    reason: "done",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(archived.status, JSON.stringify(archived.json)).toBe(200);
  const fake = fakeTool(() => [{ id: "x" }]);
  const run = await runAppSyncNow(
    f.deps,
    f.owner.grant,
    f.siteId,
    String(created.json.id),
    fake.callTool,
  );
  expect(run.lastRun.status).toBe("failed");
  expect(run.lastRun.error).toContain("archived");
  expect(fake.calls).toHaveLength(0);
});

test("app upgrades add new syncs paused and change existing ones in place", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const make = async (who: Who, name: string) => {
    const created = await f.request(who, "POST", `/${f.siteId}/syncs`, {
      name,
      collection: "orders",
      tool,
      key: "id",
      schedule: { type: "interval", everySeconds: 3600 },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return created.json as { id: string; status: string };
  };
  const orders = await make(f.owner, "Orders");
  await make(f.teammate, "Theirs");
  await make(f.owner, "Kept");
  const definitions = await listAppSyncDefinitions(f.deps, f.owner.grant, f.siteId);
  const packaged = definitions
    .filter((sync) => sync.name !== "Kept")
    .map((sync) => ({ ...sync, schedule: { type: "interval", everySeconds: 7200 } }));
  packaged.push({ ...definitions[0]!, name: "New orders" });
  const input = { deps: f.deps, grant: f.owner.grant, appId: f.siteId, syncs: packaged as never };
  const plan = await APP_PACKAGE_SYNC_HOOKS.planUpgrade!(input);
  expect(plan).toMatchObject({
    added: ["New orders"],
    changed: expect.arrayContaining(["Orders", "Theirs"]),
    unchanged: [],
    kept: ["Kept"],
  });
  // Someone else's sync stays theirs and unchanged.
  expect(plan.problems).toEqual([expect.objectContaining({ name: "Theirs" })]);

  const applied = await APP_PACKAGE_SYNC_HOOKS.applyUpgrade!({ ...input, upgradeKey: "k" });
  expect(applied.upgraded.sort()).toEqual(["New orders", "Orders"]);
  const listed = (await f.request(f.owner, "GET", `/${f.siteId}/syncs`)).json.syncs as Array<{
    id: string;
    name: string;
    status: string;
    ownerSubjectId: string;
    schedule: { everySeconds?: number };
  }>;
  const byName = new Map(listed.map((sync) => [sync.name, sync]));
  expect(byName.get("Orders")).toMatchObject({
    id: orders.id,
    status: orders.status,
    ownerSubjectId: f.owner.subjectId,
    schedule: expect.objectContaining({ everySeconds: 7200 }),
  });
  expect(byName.get("Theirs")).toMatchObject({
    ownerSubjectId: f.teammate.subjectId,
    schedule: expect.objectContaining({ everySeconds: 3600 }),
  });
  expect(byName.get("New orders")?.status).toBe("paused");
  expect(byName.get("Kept")).toBeDefined();

  // A retry finds it done; someone who doesn't manage the app changes nothing.
  const again = await APP_PACKAGE_SYNC_HOOKS.planUpgrade!(input);
  expect(again.added).toEqual([]);
  expect(again.changed).toEqual(["Theirs"]);
  await expect(
    APP_PACKAGE_SYNC_HOOKS.applyUpgrade!({ ...input, grant: f.alice.grant, upgradeKey: "k" }),
  ).rejects.toThrow();
});

// --- round two: paging, bounds, removeMissing, leases, accounts, opt-in, events ---

async function readKeys(f: Fixture, who: Who, collection: string): Promise<string[]> {
  const read = await f.request(who, "POST", `/${f.siteId}/data/query`, { collection });
  expect(read.status, JSON.stringify(read.json)).toBe(200);
  return (read.json.records as Array<{ key: string }>).map((record) => record.key).sort();
}

test("a sync pages through the tool by cursor or page number, within its bounds", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const pages: Record<string, { items: Array<{ id: string }>; next: string | null }> = {
    start: { items: [{ id: "a" }, { id: "b" }], next: "c2" },
    c2: { items: [{ id: "c" }], next: "c3" },
    c3: { items: [{ id: "d" }], next: null },
  };
  const fake = fakeTool((_subject, args) => pages[String(args.after ?? "start")]);
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool,
    arguments: { status: "open" },
    recordsPath: "items",
    key: "id",
    paging: { mode: "cursor", cursorPath: "next", cursorArgument: "after" },
    schedule: { type: "manual" },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json.paging).toEqual({
    mode: "cursor",
    cursorPath: "next",
    cursorArgument: "after",
  });
  const syncId = String(created.json.id);
  const run = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(run.lastRun).toMatchObject({
    status: "succeeded",
    summary: { received: 4, written: 4, pages: 3, truncated: false, removed: 0 },
  });
  // Each call carries the fixed arguments and the cursor of the page before.
  expect(fake.calls.map((call) => call.args)).toEqual([
    { status: "open" },
    { status: "open", after: "c2" },
    { status: "open", after: "c3" },
  ]);
  expect(await readKeys(f, f.owner, "orders")).toEqual(["a", "b", "c", "d"]);

  // At most maxPages pages: the run says it was cut short.
  await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    paging: { mode: "cursor", cursorPath: "next", cursorArgument: "after", maxPages: 2 },
  });
  const capped = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(capped.lastRun.summary).toMatchObject({ pages: 2, received: 3, truncated: true });

  // At most maxRecords records per run.
  await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    paging: { mode: "cursor", cursorPath: "next", cursorArgument: "after" },
    maxRecords: 2,
  });
  fake.calls.length = 0;
  const limited = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(limited.lastRun.summary).toMatchObject({ received: 2, written: 2, truncated: true });
  expect(fake.calls).toHaveLength(1);

  // Page numbers: count up from firstPage until a page brings nothing new.
  const numbered = fakeTool((_subject, args) => {
    const page = Number(args.page);
    return page <= 3 ? [{ id: `p${page}` }] : [];
  });
  await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    recordsPath: null,
    paging: { mode: "page", pageArgument: "page" },
    maxRecords: null,
  });
  const byPage = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, numbered.callTool);
  expect(byPage.lastRun.summary).toMatchObject({ received: 3, pages: 4, truncated: false });
  expect(numbered.calls.map((call) => call.args.page)).toEqual([1, 2, 3, 4]);

  // A cursor that comes back again stops the run as cut short, not a loop.
  const stuck = fakeTool(() => ({ items: [{ id: "a" }], next: "same" }));
  await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    recordsPath: "items",
    paging: { mode: "cursor", cursorPath: "next", cursorArgument: "after" },
  });
  const looped = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, stuck.callTool);
  expect(looped.lastRun.summary?.truncated).toBe(true);
  expect(stuck.calls.length).toBeLessThanOrEqual(3);
});

test("removeMissing deletes only what this sync wrote, and only after a complete run", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  let items: Array<{ id: string } | Error> = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const fake = fakeTool((_subject, args) => {
    const page = Number(args.page ?? 1);
    const value = items[page - 1];
    if (value instanceof Error) return value;
    return value ? [value] : [];
  });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool,
    key: "id",
    paging: { mode: "page", pageArgument: "page" },
    removeMissing: true,
    schedule: { type: "manual" },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json.removeMissing).toBe(true);
  const syncId = String(created.json.id);
  // A record someone else wrote is never the sync's to remove.
  const manual = await f.request(f.owner, "POST", `/${f.siteId}/data/write`, {
    operations: [{ op: "put", collection: "orders", key: "manual", data: { id: "manual" } }],
  });
  expect(manual.status, JSON.stringify(manual.json)).toBe(200);
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(await readKeys(f, f.owner, "orders")).toEqual(["a", "b", "c", "manual"]);

  // "b" is gone from the tool: a complete run removes it and says so.
  items = [{ id: "a" }, { id: "c" }];
  const removed = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(removed.lastRun.summary).toMatchObject({ removed: 1, truncated: false });
  expect(await readKeys(f, f.owner, "orders")).toEqual(["a", "c", "manual"]);

  // A run cut short (maxPages) removes nothing.
  items = [{ id: "a" }, { id: "x" }];
  await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    paging: { mode: "page", pageArgument: "page", maxPages: 1 },
  });
  const short = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(short.lastRun.summary).toMatchObject({ truncated: true, removed: 0 });
  expect(await readKeys(f, f.owner, "orders")).toEqual(["a", "c", "manual"]);

  // A failed run removes nothing either, though its first page was written.
  items = [{ id: "a" }, new Error("The orders service is down")];
  await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    paging: { mode: "page", pageArgument: "page" },
  });
  const failed = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(failed.lastRun.status).toBe("failed");
  expect(failed.lastRun.summary).toMatchObject({ removed: 0, written: 1 });
  expect(await readKeys(f, f.owner, "orders")).toEqual(["a", "c", "manual"]);

  // An empty answer, or one with items it can't key (an error body, a
  // renamed key field), never empties the collection.
  items = [];
  const empty = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(empty.lastRun.summary).toMatchObject({ removed: 0 });
  items = [{ id: "a" }, { error: "rate limited" } as unknown as { id: string }];
  const unkeyed = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(unkeyed.lastRun.summary).toMatchObject({ removed: 0, skipped: 1 });
  expect(await readKeys(f, f.owner, "orders")).toEqual(["a", "c", "manual"]);

  // A record someone changed after the sync wrote it (a person, the app or a
  // webhook) is theirs now: it stays when the tool stops returning it.
  const edited = await f.request(f.owner, "POST", `/${f.siteId}/data/write`, {
    operations: [{ op: "put", collection: "orders", key: "c", data: { id: "c", note: "mine" } }],
  });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  items = [{ id: "x" }];
  const kept = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(kept.lastRun.summary).toMatchObject({ removed: 1 });
  expect(await readKeys(f, f.owner, "orders")).toEqual(["c", "manual", "x"]);
});

test("removeMissing in a personal sync removes only that person's own records", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/mine`, {
    accessMode: "per_viewer",
    privateRecords: true,
  });
  const lists: Record<string, string[]> = {
    [f.alice.subjectId]: ["a1", "a2"],
    [f.bob.subjectId]: ["b1", "b2"],
  };
  const fake = fakeTool((subject) => (lists[subject] ?? []).map((id) => ({ id })));
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Mine",
    collection: "mine",
    mode: "personal",
    tool,
    key: "id",
    removeMissing: true,
    schedule: { type: "manual" },
  });
  const syncId = String(created.json.id);
  for (const who of [f.alice, f.bob])
    await f.request(who, "PUT", `/${f.siteId}/syncs/${syncId}/subscription`);
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  lists[f.alice.subjectId] = ["a1"];
  const run = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(run.lastRun.summary).toMatchObject({ removed: 1 });
  expect(await readKeys(f, f.alice, "mine")).toEqual(["a1"]);
  expect(await readKeys(f, f.bob, "mine")).toEqual(["b1", "b2"]);
});

test("a run that loses its lease stops calling and writing; the new holder settles it", async () => {
  const f = await fixture();
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool,
    key: "id",
    paging: { mode: "page", pageArgument: "page" },
    schedule: { type: "manual" },
  });
  const syncId = String(created.json.id);
  const run = await createScheduledTaskRun(f.deps.db, {
    workspaceId: f.workspace.id,
    taskId: syncId,
    triggerType: "manual",
    producerKey: `lease:${crypto.randomUUID()}`,
  });
  await enqueueAppSyncRun(f.deps.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    taskId: syncId,
    runId: run.id,
  });
  const fake = fakeTool((_subject, args) => [{ id: `p${String(args.page)}` }]);
  let taken: { lease_token: string; attempts: number } | undefined;
  const callTool: AppSyncToolCaller = async (input) => {
    const answer = await fake.callTool(input);
    // While the first call runs, its lease ends and another executor claims the run.
    [taken] = await shared.admin<{ lease_token: string; attempts: number }[]>`
      update app_sync_queue set lease_token = gen_random_uuid(), attempts = attempts + 1,
        lease_until = now() + interval '5 minutes'
      where run_id = ${run.id} returning lease_token, attempts`;
    return answer;
  };
  const drained = await drainAppSyncRuns(f.deps, { limit: 50, callTool });
  expect(drained.claimed).toBe(0);
  // One call, nothing written after the lease was lost, and the run is not settled.
  expect(fake.calls).toHaveLength(1);
  expect(await readKeys(f, f.owner, "orders")).toEqual([]);
  const [open] = await syncRuns(f, syncId);
  expect(open?.status).not.toBe("succeeded");
  expect(open?.status).not.toBe("failed");
  // The run's current holder settles it; the stale lease can't.
  expect(
    await finishAppSyncRun(f.deps.db, {
      workspaceId: f.workspace.id,
      runId: run.id,
      status: "succeeded",
      error: null,
      summary: null,
      lease: { leaseToken: crypto.randomUUID(), attempts: taken!.attempts },
    }),
  ).toBe(false);
  expect(
    await finishAppSyncRun(f.deps.db, {
      workspaceId: f.workspace.id,
      runId: run.id,
      status: "succeeded",
      error: null,
      summary: null,
      lease: { leaseToken: taken!.lease_token, attempts: taken!.attempts },
    }),
  ).toBe(true);
  expect((await syncRuns(f, syncId))[0]?.status).toBe("succeeded");
});

test("a shared sync's owner picks one of several accounts; every run checks it is still theirs", async () => {
  const f = await fixture();
  inventories(f, {
    [f.owner.subjectId]: [{ serverId: "account-owner" }, { serverId: "account-owner-2" }],
  });
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const body = {
    name: "Orders",
    collection: "orders",
    tool: { serverId: "orders", toolName: "list_orders" },
    key: "id",
    schedule: { type: "manual" },
  };
  const servers: string[] = [];
  const fake = fakeTool(() => [{ id: "x" }]);
  const callTool: AppSyncToolCaller = async (input) => {
    servers.push(input.identity.serverId);
    return await fake.callTool(input);
  };
  // Without a choice it saves as before: the owner's first own account, and
  // the stored action keeps the previous shape (no ownerAccount).
  const unchosen = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, body);
  expect(unchosen.status, JSON.stringify(unchosen.json)).toBe(201);
  expect(unchosen.json.account).toBeNull();
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, String(unchosen.json.id), callTool);
  expect(servers).toEqual(["account-owner"]);
  expect(await storedActionKeys(f, String(unchosen.json.id))).toEqual(PREVIOUS_ACTION_KEYS);

  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    ...body,
    name: "Orders 2",
    account: "account-owner-2",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json.account).toBe("account-owner-2");
  const syncId = String(created.json.id);
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, callTool);
  expect(servers).toEqual(["account-owner", "account-owner-2"]);
  // The owner's later edits, even of the tool, keep their choice while it is theirs.
  const edited = await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    tool: { serverId: "orders", toolName: "list_orders" },
    schedule: { type: "manual" },
  });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  expect(edited.json.account).toBe("account-owner-2");
  servers.length = 0;

  // The chosen account is disconnected: the run fails readably, on no other account.
  inventories(f, { [f.owner.subjectId]: [{ serverId: "account-owner" }] });
  const gone = await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, callTool);
  expect(gone.lastRun.status).toBe("failed");
  expect(gone.lastRun.error).toMatch(/account/i);
  expect(servers).toEqual([]);
});

/** The fields of a stored sync action before round two (b38f3336). */
const PREVIOUS_ACTION_KEYS = [
  "arguments",
  "collection",
  "connectorTool",
  "declaredTools",
  "fields",
  "key",
  "kind",
  "mode",
  "ownerSubjectId",
  "recordsPath",
  "siteId",
  "tool",
];

async function storedActionKeys(f: Fixture, syncId: string): Promise<string[]> {
  const task = await getScheduledTask(f.deps.db, f.workspace.id, syncId);
  return Object.keys((task?.action ?? {}) as Record<string, unknown>).sort();
}

test("with a workspace shared key and an own account, a shared sync runs on the own one", async () => {
  const f = await fixture();
  inventories(f, {
    [f.owner.subjectId]: [
      { serverId: "account-workspace", shared: true },
      { serverId: "account-owner" },
    ],
  });
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    collection: "orders",
    tool: { serverId: "orders", toolName: "list_orders" },
    key: "id",
    schedule: { type: "manual" },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json.account).toBeNull();
  expect(await storedActionKeys(f, String(created.json.id))).toEqual(PREVIOUS_ACTION_KEYS);
  const served: string[] = [];
  const fake = fakeTool(() => [{ id: "1" }]);
  const callTool: AppSyncToolCaller = async (input) => {
    served.push(input.identity.serverId);
    return await fake.callTool(input);
  };
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, String(created.json.id), callTool);
  expect(served).toEqual(["account-owner"]);
  // The shared key is a choice too.
  const onShared = await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${created.json.id}`, {
    account: "account-workspace",
  });
  expect(onShared.status, JSON.stringify(onShared.json)).toBe(200);
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, String(created.json.id), callTool);
  expect(served).toEqual(["account-owner", "account-workspace"]);
});

test("install and upgrade work when the installer has several accounts", async () => {
  const f = await fixture();
  inventories(f, {
    [f.owner.subjectId]: [{ serverId: "account-owner" }, { serverId: "account-owner-2" }],
  });
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/orders`, {
    accessMode: "shared_read",
  });
  const definition = {
    name: "Orders",
    collection: "orders",
    tool: { serverId: "orders", toolName: "list_orders" },
    key: "id",
    schedule: { type: "manual" as const },
  };
  const input = {
    deps: f.deps,
    grant: f.owner.grant,
    appId: f.siteId,
    syncs: [definition] as never,
  };
  const installed = await APP_PACKAGE_SYNC_HOOKS.createPaused({ ...input, installKey: "i" });
  expect(installed).toEqual({ created: ["Orders"], notCreated: [] });
  const listed = (await f.request(f.owner, "GET", `/${f.siteId}/syncs`)).json.syncs as Array<{
    id: string;
    status: string;
  }>;
  expect(listed).toHaveLength(1);
  expect(listed[0]!.status).toBe("paused");
  const syncId = listed[0]!.id;
  // The owner picks an account; an upgrade that changes the tool keeps it.
  await f.request(f.owner, "PATCH", `/${f.siteId}/syncs/${syncId}`, {
    account: "account-owner-2",
  });
  const upgraded = await APP_PACKAGE_SYNC_HOOKS.applyUpgrade!({
    ...input,
    syncs: [{ ...definition, tool: { serverId: "orders", toolName: "list_orders_v2" } }] as never,
    upgradeKey: "k",
  });
  expect(upgraded).toEqual({ upgraded: ["Orders"], notUpgraded: [] });
  const after = (await f.request(f.owner, "GET", `/${f.siteId}/syncs`)).json.syncs.find(
    (sync: { id: string }) => sync.id === syncId,
  );
  expect(after).toMatchObject({
    account: "account-owner-2",
    tool: { serverId: "account-owner-2", toolName: "list_orders_v2" },
  });
});

test("the opt-in review names the tool, accounts and collection, and a framed opt-in is refused", async () => {
  const f = await fixture();
  inventories(f, {
    [f.alice.subjectId]: [{ serverId: "account-alice" }, { serverId: "account-alice-2" }],
  });
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/mine`, {
    accessMode: "per_viewer",
    privateRecords: true,
  });
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Mine",
    collection: "mine",
    mode: "personal",
    tool: { serverId: "orders", toolName: "list_orders" },
    key: "id",
    schedule: { type: "manual" },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const syncId = String(created.json.id);
  const review = await f.request(f.alice, "GET", `/${f.siteId}/syncs/${syncId}/opt-in`);
  expect(review.status, JSON.stringify(review.json)).toBe(200);
  expect(review.json).toMatchObject({
    syncId,
    name: "Mine",
    mode: "personal",
    collection: "mine",
    tool: { toolName: "list_orders", connector: "Orders" },
    account: null,
    optedIn: false,
    blocked: null,
  });
  expect(review.json.accounts.map((choice: { id: string }) => choice.id).sort()).toEqual([
    "account-alice",
    "account-alice-2",
  ]);
  // From inside the app's frame neither the review nor the opt-in answers.
  const framed = { ...f.alice, headers: { ...f.alice.headers, "x-opengeni-site-id": f.siteId } };
  const framedReview = await f.request(framed, "GET", `/${f.siteId}/syncs/${syncId}/opt-in`);
  expect([403, 404]).toContain(framedReview.status);
  const framedJoin = await f.request(framed, "PUT", `/${f.siteId}/syncs/${syncId}/subscription`, {
    account: "account-alice",
  });
  expect([403, 404]).toContain(framedJoin.status);
  expect(
    (await f.request(f.alice, "GET", `/${f.siteId}/syncs/${syncId}/opt-in`)).json.optedIn,
  ).toBe(false);
  // From Opengeni, with the chosen account.
  const joined = await f.request(f.alice, "PUT", `/${f.siteId}/syncs/${syncId}/subscription`, {
    account: "account-alice",
  });
  expect(joined.json).toEqual({ syncId, optedIn: true, account: "account-alice" });
  const after = await f.request(f.alice, "GET", `/${f.siteId}/syncs/${syncId}/opt-in`);
  expect(after.json).toMatchObject({ optedIn: true, account: "account-alice" });
});

test("a sync hears its owner's own event sources; a personal run from one is only for its owner", async () => {
  const f = await fixture();
  inventories(f, {
    [f.owner.subjectId]: [{ serverId: "account-owner" }],
    [f.alice.subjectId]: [{ serverId: "account-alice" }],
  });
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/mine`, {
    accessMode: "per_viewer",
    privateRecords: true,
  });
  const source = async (owner: Who, visibility: "private" | "workspace") =>
    (
      await createEventSource(f.deps.db, {
        accountId: f.accountId,
        workspaceId: f.workspace.id,
        createdBySubjectId: owner.subjectId,
        kind: "webhook",
        adapter: "standard",
        name: `Deploys ${visibility}`,
        ownerSubjectId: owner.subjectId,
        visibility,
        secretEncrypted: "encrypted-secret",
      })
    ).source;
  const ownerPrivate = await source(f.owner, "private");
  const alicePrivate = await source(f.alice, "private");
  const body = (sourceId: string) => ({
    name: "Mine",
    collection: "mine",
    mode: "personal",
    tool: { serverId: "orders", toolName: "list_orders" },
    key: "id",
    schedule: { type: "manual" },
    events: { triggers: [{ sourceId, eventTypes: ["deploy.finished"] }] },
  });
  // Someone else's private source can't start the owner's sync.
  const refused = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, body(alicePrivate.id));
  expect(refused.status, JSON.stringify(refused.json)).toBeGreaterThanOrEqual(400);
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, body(ownerPrivate.id));
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const syncId = String(created.json.id);
  for (const who of [f.owner, f.alice])
    expect((await f.request(who, "PUT", `/${f.siteId}/syncs/${syncId}/subscription`)).status).toBe(
      200,
    );

  const payload = new TextEncoder().encode("{}");
  const delivered = await recordEventDelivery(f.deps.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    sourceId: ownerPrivate.id,
    status: "accepted",
    reason: null,
    dedupeKey: `webhook-id:${crypto.randomUUID()}`,
    body: payload,
    bodyBytes: payload.byteLength,
    bodySha256: createHash("sha256").update(payload).digest("hex"),
    headers: {},
    events: [
      {
        externalId: null,
        streamKey: "",
        type: "deploy.finished",
        occurredAt: new Date(),
        subject: "deploy-1",
        summary: "Deploy finished",
        url: null,
        actor: { kind: "person", name: "Ada" },
        data: { id: "deploy-1" },
        dataTruncated: false,
        gapBefore: false,
      },
    ],
    match: (candidate, trigger) => trigger.eventTypes.includes(candidate.type),
    settleMs: 0,
  });
  // The owner's private source reaches the sync.
  expect(delivered.matchedTaskIds).toContain(syncId);
  const dispatch = await claimEventTriggerDispatch(f.deps.db, f.workspace.id, syncId);
  expect(dispatch.start).toHaveLength(1);
  const run = await createScheduledTaskRun(f.deps.db, {
    workspaceId: f.workspace.id,
    taskId: syncId,
    triggerType: "event",
    producerKey: eventOccurrenceProducerKey(dispatch.start[0]!.id),
  });
  await enqueueAppSyncRun(f.deps.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    taskId: syncId,
    runId: run.id,
  });
  const fake = fakeTool((subject) => [{ id: subject.slice(-6) }]);
  await drainAppSyncRuns(f.deps, { limit: 50, callTool: fake.callTool });
  // Only the person whose source fired runs.
  expect(fake.calls.map((call) => call.subjectId)).toEqual([f.owner.subjectId]);

  // A manual run is for everyone opted in.
  await runAppSyncNow(f.deps, f.owner.grant, f.siteId, syncId, fake.callTool);
  expect(new Set(fake.calls.slice(1).map((call) => call.subjectId))).toEqual(
    new Set([f.owner.subjectId, f.alice.subjectId]),
  );
});

test("a personal sync's trigger on the owner's Gmail also hears each subscriber's own Gmail, only for them", async () => {
  const f = await fixture();
  inventories(f, {
    [f.owner.subjectId]: [{ serverId: "account-owner" }],
    [f.alice.subjectId]: [{ serverId: "account-alice" }],
    [f.bob.subjectId]: [{ serverId: "account-bob" }],
  });
  for (const [name, accessMode] of [
    ["mine", "per_viewer"],
    ["team", "shared_read"],
  ] as const)
    await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/${name}`, { accessMode });
  const gmail = async (who: Who) =>
    (
      await createEventSource(f.deps.db, {
        accountId: f.accountId,
        workspaceId: f.workspace.id,
        createdBySubjectId: who.subjectId,
        kind: "gmail",
        name: "Gmail",
        ownerSubjectId: who.subjectId,
        visibility: "private",
        externalKey: `email:${who.subjectId}@example.test`,
      })
    ).source;
  const [ownerMail, aliceMail, bobMail] = [
    await gmail(f.owner),
    await gmail(f.alice),
    await gmail(f.bob),
  ];
  const save = async (mode: "personal" | "shared", collection: string) => {
    const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
      name: `Mail ${mode}`,
      collection,
      mode,
      tool: { serverId: "orders", toolName: "list_orders" },
      key: "id",
      schedule: { type: "manual" },
      events: { triggers: [{ sourceId: ownerMail.id, eventTypes: ["message.received"] }] },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return String(created.json.id);
  };
  const personal = await save("personal", "mine");
  const sharedSync = await save("shared", "team");
  // Alice opts in; Bob doesn't.
  expect(
    (await f.request(f.alice, "PUT", `/${f.siteId}/syncs/${personal}/subscription`)).status,
  ).toBe(200);

  // Alice's own Gmail is now read for the sync; Bob's isn't.
  const wanted = async (sourceId: string) =>
    (await claimEventSourceFeed(f.deps.db, f.workspace.id, sourceId, 1_000))?.wanted ?? null;
  expect(await wanted(aliceMail.id)).toBe(true);
  expect(await wanted(bobMail.id)).toBe(false);

  const deliver = async (sourceId: string) => {
    const payload = new TextEncoder().encode(crypto.randomUUID());
    return await recordEventDelivery(f.deps.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      sourceId,
      status: "accepted",
      reason: null,
      dedupeKey: `gmail:${crypto.randomUUID()}`,
      body: payload,
      bodyBytes: payload.byteLength,
      bodySha256: createHash("sha256").update(payload).digest("hex"),
      headers: {},
      events: [
        {
          externalId: crypto.randomUUID(),
          streamKey: "",
          type: "message.received",
          occurredAt: new Date(),
          subject: "Hello",
          summary: "Hello",
          url: null,
          actor: { kind: "person", name: "Ada" },
          data: {},
          dataTruncated: false,
          gapBefore: false,
        },
      ],
      match: (candidate, trigger) => trigger.eventTypes.includes(candidate.type),
      settleMs: 0,
    });
  };
  // Bob isn't opted in: his mail starts nothing. A shared sync never hears a subscriber.
  expect((await deliver(bobMail.id)).matchedTaskIds).toEqual([]);
  const fromAlice = await deliver(aliceMail.id);
  expect(fromAlice.matchedTaskIds).toEqual([personal]);
  expect(fromAlice.matchedTaskIds).not.toContain(sharedSync);

  const dispatch = await claimEventTriggerDispatch(f.deps.db, f.workspace.id, personal);
  expect(dispatch.start).toHaveLength(1);
  const run = await createScheduledTaskRun(f.deps.db, {
    workspaceId: f.workspace.id,
    taskId: personal,
    triggerType: "event",
    producerKey: eventOccurrenceProducerKey(dispatch.start[0]!.id),
  });
  await enqueueAppSyncRun(f.deps.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    taskId: personal,
    runId: run.id,
  });
  const fake = fakeTool((subject) => [{ id: subject.slice(-6) }]);
  await drainAppSyncRuns(f.deps, { limit: 50, callTool: fake.callTool });
  // The run is only for Alice, on her own account, although the owner's trigger fired it.
  expect(fake.calls.map((call) => call.subjectId)).toEqual([f.alice.subjectId]);

  // Opted out, her mail no longer starts it.
  expect(
    (await f.request(f.alice, "DELETE", `/${f.siteId}/syncs/${personal}/subscription`)).status,
  ).toBe(200);
  expect((await deliver(aliceMail.id)).matchedTaskIds).toEqual([]);
});

test("subscriber events stay private on the run, every batched event counts, and a lost source runs for nobody", async () => {
  const f = await fixture();
  inventories(f, {
    [f.owner.subjectId]: [{ serverId: "account-owner" }],
    [f.alice.subjectId]: [{ serverId: "account-alice" }],
    [f.bob.subjectId]: [{ serverId: "account-bob" }],
  });
  await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/mine`, {
    accessMode: "per_viewer",
  });
  const gmail = async (who: Who) =>
    (
      await createEventSource(f.deps.db, {
        accountId: f.accountId,
        workspaceId: f.workspace.id,
        createdBySubjectId: who.subjectId,
        kind: "gmail",
        name: "Gmail",
        ownerSubjectId: who.subjectId,
        visibility: "private",
        externalKey: `email:${who.subjectId}@example.test`,
      })
    ).source;
  const [ownerMail, aliceMail, bobMail] = [
    await gmail(f.owner),
    await gmail(f.alice),
    await gmail(f.bob),
  ];
  const created = await f.request(f.owner, "POST", `/${f.siteId}/syncs`, {
    name: "Mail",
    collection: "mine",
    mode: "personal",
    tool: { serverId: "orders", toolName: "list_orders" },
    key: "id",
    schedule: { type: "manual" },
    events: { triggers: [{ sourceId: ownerMail.id, eventTypes: ["message.received"] }] },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const sync = String(created.json.id);
  for (const who of [f.alice, f.bob])
    expect((await f.request(who, "PUT", `/${f.siteId}/syncs/${sync}/subscription`)).status).toBe(
      200,
    );

  const deliver = async (sourceId: string, count: number, subject: string, ago = 0) => {
    const payload = new TextEncoder().encode(crypto.randomUUID());
    await recordEventDelivery(f.deps.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      sourceId,
      status: "accepted",
      reason: null,
      dedupeKey: `gmail:${crypto.randomUUID()}`,
      body: payload,
      bodyBytes: payload.byteLength,
      bodySha256: createHash("sha256").update(payload).digest("hex"),
      headers: {},
      events: Array.from({ length: count }, (_, index) => ({
        externalId: crypto.randomUUID(),
        streamKey: "",
        type: "message.received",
        occurredAt: new Date(Date.now() - ago + index),
        subject,
        summary: `${subject} body`,
        url: "https://mail.example.test/message",
        actor: { kind: "person" as const, name: "Doctor" },
        data: {},
        dataTruncated: false,
        gapBefore: false,
      })),
      match: (candidate, trigger) => trigger.eventTypes.includes(candidate.type),
      settleMs: 0,
    });
  };
  const runOnce = async () => {
    const dispatch = await claimEventTriggerDispatch(f.deps.db, f.workspace.id, sync);
    expect(dispatch.start).toHaveLength(1);
    const run = await createScheduledTaskRun(f.deps.db, {
      workspaceId: f.workspace.id,
      taskId: sync,
      triggerType: "event",
      producerKey: eventOccurrenceProducerKey(dispatch.start[0]!.id),
    });
    await markEventOccurrenceStarted(f.deps.db, f.workspace.id, dispatch.start[0]!.id);
    await enqueueAppSyncRun(f.deps.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      taskId: sync,
      runId: run.id,
    });
    const fake = fakeTool((subject) => [{ id: subject.slice(-6) }]);
    await drainAppSyncRuns(f.deps, { limit: 50, callTool: fake.callTool });
    return fake.calls.map((call) => call.subjectId).sort();
  };

  // 1. The owner's event keeps its text on the run; Alice's keeps only which event it was.
  await deliver(ownerMail.id, 1, "Owner note", 60_000);
  await deliver(aliceMail.id, 1, "Your test results");
  expect(await runOnce()).toEqual([f.alice.subjectId]);
  const runs = await f.app.request(
    `/v1/workspaces/${f.workspace.id}/scheduled-tasks/${sync}/runs`,
    { headers: f.teammate.headers },
  );
  expect(runs.status).toBe(200);
  const history = await runs.text();
  expect(history).toContain("Owner note");
  expect(history).not.toContain("Your test results");
  expect(history).toContain(aliceMail.id);
  const kept = (
    JSON.parse(history) as Array<{
      eventOccurrence: { events: Array<Record<string, unknown>> };
    }>
  ).flatMap((entry) => entry.eventOccurrence.events);
  expect(kept.find((event) => event.sourceId === aliceMail.id)).toMatchObject({
    subject: null,
    summary: "",
    url: null,
    actor: { kind: "unknown", name: null },
  });

  // 2. Past the 50 events a run keeps, Alice's and Bob's events still run for them.
  await deliver(ownerMail.id, 50, "Owner note", 60_000);
  await deliver(aliceMail.id, 1, "Alice");
  await deliver(bobMail.id, 1, "Bob");
  expect(await runOnce()).toEqual([f.alice.subjectId, f.bob.subjectId].sort());

  // 3. A source gone before the run starts it for nobody, never for every subscriber.
  await deliver(aliceMail.id, 1, "Alice again");
  const dispatch = await claimEventTriggerDispatch(f.deps.db, f.workspace.id, sync);
  expect(dispatch.start).toHaveLength(1);
  expect((await deleteEventSource(f.deps.db, f.workspace.id, aliceMail.id)).kind).toBe("deleted");
  const run = await createScheduledTaskRun(f.deps.db, {
    workspaceId: f.workspace.id,
    taskId: sync,
    triggerType: "event",
    producerKey: eventOccurrenceProducerKey(dispatch.start[0]!.id),
  });
  await enqueueAppSyncRun(f.deps.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    taskId: sync,
    runId: run.id,
  });
  const fake = fakeTool((subject) => [{ id: subject.slice(-6) }]);
  await drainAppSyncRuns(f.deps, { limit: 50, callTool: fake.callTool });
  expect(fake.calls).toEqual([]);
});
