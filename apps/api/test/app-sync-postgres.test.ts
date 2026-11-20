import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AccessGrant } from "@opengeni/contracts";
import type { ObjectStorageDependency, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createScheduledTaskRun,
  createWorkspace,
  enqueueAppSyncRun,
  ensureExternalIdentity,
  getScheduledTask,
  listScheduledTaskRuns,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { HTTPException } from "hono/http-exception";
import { createApp, type AppDependencies } from "../src/app";
import {
  createAppSyncFromDefinition,
  drainAppSyncRuns,
  listAppSyncDefinitions,
  runAppSyncNow,
  type AppSyncToolCaller,
} from "../src/app-sync/service";

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
  const settings = testSettings({ productAccessMode: "configured", sandboxBackend: "none" });
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
  return { deps, accountId, workspace, owner, alice, bob, siteId, request };
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
  expect(optIn.json).toEqual({ syncId, optedIn: true });

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
  expect(optOut.json).toEqual({ syncId, optedIn: false });
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
});
