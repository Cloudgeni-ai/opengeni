/**
 * App data syncs into a Site SQL table, on PostgreSQL as the restricted
 * application role, with Site SQL served by the real gateway Worker's
 * `SiteDatabase` Durable Object in workerd (Miniflare). The connected tool
 * is a fake.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AccessGrant } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import type { ObjectStorageDependency, SessionWorkflowClient } from "@opengeni/core";
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
import { runAppSyncNow, type AppSyncDeps, type AppSyncToolCaller } from "../src/app-sync/service";
import { siteSqlTransport } from "../src/site-sql/service";

const SECRET = "app-sync-sql-gateway-secret-0123456789abcdef";
const ORIGIN = "https://internal.sites.test";
const GATEWAY_DIR = resolve(import.meta.dir, "../../site-gateway");
const SQL_SETTINGS: Partial<Settings> = {
  sitesCloudflareStorageEnabled: true,
  sitesGatewayInternalOrigin: ORIGIN,
  sitesGatewaySecret: SECRET,
};

let shared: SharedTestDatabase;
let db: DbClient;
let mf: { dispatchFetch: Function; dispose(): Promise<void>; ready: Promise<unknown> } | null =
  null;
let buildDir = "";

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("app-sync-sql");
  if (!acquired) throw new Error("App sync SQL tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
  buildDir = mkdtempSync(join(tmpdir(), "app-sync-sql-test-"));
  const build = await Bun.build({
    entrypoints: [join(GATEWAY_DIR, "src/index.ts")],
    outdir: buildDir,
    target: "browser",
    format: "esm",
    naming: "worker.js",
  });
  if (!build.success) throw new AggregateError(build.logs, "Worker build failed");
  const { Miniflare } = await import(Bun.resolveSync("miniflare", GATEWAY_DIR));
  mf = new Miniflare({
    modules: true,
    scriptPath: join(buildDir, "worker.js"),
    modulesRoot: buildDir,
    compatibilityDate: "2026-07-01",
    bindings: {
      SITES_DOMAIN: "sites.test",
      API_ORIGIN: "http://127.0.0.1:18787",
      APP_ORIGIN: "https://app.test",
      GATEWAY_SECRET: SECRET,
      ENVIRONMENT: "test",
    },
    durableObjects: { SITE_DB: { className: "SiteDatabase", useSQLite: true } },
  });
  await mf!.ready;
  siteSqlTransport.fetch = async (input, init) =>
    (await mf!.dispatchFetch(input, {
      ...init,
      signal: undefined,
      headers: { ...(init.headers as Record<string, string>), "MF-Original-URL": input },
    })) as unknown as Response;
}, 180_000);

afterAll(async () => {
  await mf?.dispose();
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const PERMISSIONS = [
  "workspace:read",
  "sessions:read",
  "artifacts:read",
  "artifacts:publish",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
] as const;

async function fixture(overrides: Partial<Settings> = SQL_SETTINGS) {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('App sync SQL fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [...PERMISSIONS, "workspace:admin", "members:manage", "account:admin"],
  });
  const deps = {
    db: db.db,
    bus: new MemoryEventBus(),
    settings: testSettings({
      productAccessMode: "configured",
      sandboxBackend: "none",
      ...overrides,
    }),
    objectStorage: {
      maxSinglePutSizeBytes: 5_000_000_000,
      putObject: noop,
      headObject: async () => null,
      getObjectBytes: async () => null,
      deleteObject: noop,
    } as unknown as ObjectStorageDependency,
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
      permissions: PERMISSIONS,
      operationId: crypto.randomUUID(),
    }),
  });
  expect(added.status, await added.clone().text()).toBe(200);
  const grant: AccessGrant = {
    accountId,
    workspaceId: workspace.id,
    subjectId: identity.subjectId,
    permissions: [...PERMISSIONS] as AccessGrant["permissions"],
    principalKind: "human_session",
  };
  const headers = {
    ...service,
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { source, externalId: identity.externalId } }),
    ),
  };
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'app-sync-sql-test')`;
  const base = `/v1/workspaces/${workspace.id}/published-artifacts`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, json, text };
  };
  const published = await call("POST", "", {
    title: "Orders",
    html: "<!doctype html><h1>Orders</h1>",
    idempotencyKey: crypto.randomUUID(),
    visibility: "workspace",
  });
  expect(published.status, published.text).toBe(201);
  return {
    deps: deps as AppDependencies & AppSyncDeps,
    grant,
    call,
    siteId: String(published.json.artifact.id),
  };
}

function fakeTool(answer: () => unknown) {
  let calls = 0;
  const callTool: AppSyncToolCaller = async () => {
    calls += 1;
    return { content: [{ type: "text", text: JSON.stringify(answer()) }] } as never;
  };
  return { callTool, calls: () => calls };
}

const tool = { serverId: "orders-server", toolName: "list_orders" };

test("a shared sync upserts rows into an SQL table by key, and removeMissing deletes its rows", async () => {
  const f = await fixture();
  const base = `/${f.siteId}`;
  expect((await f.call("PUT", `${base}/sql/settings`, { enabled: true })).status).toBe(200);
  const migrated = await f.call("POST", `${base}/sql/migrations`, {
    name: "create_orders",
    sql: "CREATE TABLE orders (id TEXT PRIMARY KEY, customer TEXT, total REAL, tags TEXT, note TEXT);",
  });
  expect(migrated.status, migrated.text).toBe(201);
  const query = await f.call("PUT", `${base}/sql/queries/list_orders`, {
    sql: "SELECT id, customer, total, tags, note FROM orders ORDER BY id",
    audience: "signed_in",
  });
  expect(query.status, query.text).toBeLessThan(300);
  // A row the app wrote itself keeps its own columns and is never removed by the sync.
  expect(
    (
      await f.call("POST", `${base}/sql/execute`, {
        sql: "INSERT INTO orders (id, customer, note) VALUES ('manual', 'Me', 'mine')",
      })
    ).status,
  ).toBe(200);

  let items: unknown[] = [
    { id: "o-1", customer: { name: "Ada" }, total: 10, tags: ["new"] },
    { id: "o-2", customer: { name: "Grace" }, total: 5, tags: [] },
  ];
  const fake = fakeTool(() => ({ items }));
  const target = {
    table: "orders",
    keyColumn: "id",
    columns: { customer: "customer.name", total: "total", tags: "tags" },
  };
  const created = await f.call("POST", `${base}/syncs`, {
    name: "Orders",
    target,
    tool,
    recordsPath: "items",
    key: "id",
    removeMissing: true,
    schedule: { type: "manual" },
  });
  expect(created.status, created.text).toBe(201);
  expect(created.json).toMatchObject({ target, collection: "orders", removeMissing: true });
  const syncId = String(created.json.id);

  const first = await runAppSyncNow(f.deps, f.grant, f.siteId, syncId, fake.callTool);
  expect(first.lastRun).toMatchObject({
    status: "succeeded",
    summary: { received: 2, written: 2, removed: 0 },
  });
  const rows = async () =>
    (await f.call("POST", `${base}/sql/queries/list_orders`, {})).json.rows as unknown[];
  expect(await rows()).toEqual([
    { id: "manual", customer: "Me", total: null, tags: null, note: "mine" },
    { id: "o-1", customer: "Ada", total: 10, tags: '["new"]', note: null },
    { id: "o-2", customer: "Grace", total: 5, tags: "[]", note: null },
  ]);

  // Updated in place by key; o-2 is gone from the tool, so it is removed.
  items = [{ id: "o-1", customer: { name: "Ada L." }, total: 12, tags: ["new"] }];
  const second = await runAppSyncNow(f.deps, f.grant, f.siteId, syncId, fake.callTool);
  expect(second.lastRun.summary).toMatchObject({ written: 1, removed: 1 });
  expect(await rows()).toEqual([
    { id: "manual", customer: "Me", total: null, tags: null, note: "mine" },
    { id: "o-1", customer: "Ada L.", total: 12, tags: '["new"]', note: null },
  ]);

  // The sync shows the table on the app's own status.
  const status = await f.call("GET", `${base}/data/syncs`);
  expect(status.json.syncs[0]).toMatchObject({ collection: "orders", table: "orders" });
});

test("a table sync must be shared and needs a key column the table has", async () => {
  const f = await fixture();
  const base = `/${f.siteId}`;
  expect((await f.call("PUT", `${base}/sql/settings`, { enabled: true })).status).toBe(200);
  await f.call("POST", `${base}/sql/migrations`, {
    name: "create_orders",
    sql: "CREATE TABLE orders (id TEXT PRIMARY KEY, total REAL);",
  });
  const body = {
    name: "Orders",
    target: { table: "orders", keyColumn: "id", columns: { total: "total" } },
    tool,
    key: "id",
    schedule: { type: "manual" },
  };
  const personal = await f.call("POST", `${base}/syncs`, { ...body, mode: "personal" });
  expect(personal.status).toBe(422);
  const both = await f.call("POST", `${base}/syncs`, { ...body, collection: "orders" });
  expect(both.status).toBe(422);
  // A key column that isn't unique fails the run readably instead of adding duplicates.
  const wrongKey = await f.call("POST", `${base}/syncs`, {
    ...body,
    target: { table: "orders", keyColumn: "total", columns: { id: "id" } },
  });
  expect(wrongKey.status, wrongKey.text).toBe(201);
  const run = await runAppSyncNow(
    f.deps,
    f.grant,
    f.siteId,
    String(wrongKey.json.id),
    fakeTool(() => [{ id: "a", total: 1 }]).callTool,
  );
  expect(run.lastRun.status).toBe("failed");
  expect(run.lastRun.error).toBeTruthy();
});

test("without app SQL a table sync is refused readably", async () => {
  const f = await fixture({});
  const refused = await f.call("POST", `/${f.siteId}/syncs`, {
    name: "Orders",
    target: { table: "orders", keyColumn: "id", columns: { total: "total" } },
    tool,
    key: "id",
    schedule: { type: "manual" },
  });
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(refused.json.error.message).toContain("no app SQL");
});
