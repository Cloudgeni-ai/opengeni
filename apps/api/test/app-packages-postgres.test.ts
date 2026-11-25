/**
 * App packages end to end: export an app (a Site) from one workspace and
 * install it into another through the real API routes and agent tools, on
 * PostgreSQL as the restricted application role, with Site SQL served by the
 * real gateway Worker's `SiteDatabase` Durable Object in workerd (Miniflare).
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { APP_PACKAGE_FORMAT, type AccessGrant, type AppPackage } from "@opengeni/contracts";
import {
  readSidebarLayoutForGrant,
  updateSidebarLayoutForGrant,
  type ApiRouteDeps,
  type ObjectStorageDependency,
  type SessionWorkflowClient,
} from "@opengeni/core";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import {
  createConnection,
  createDb,
  createOrganizationApiKey,
  encryptEnvironmentValue,
  persistAttemptToolCatalog,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  markSiteToolData,
  type DbClient,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";
import { sweepAppPackageExports } from "../src/app-packages/exports";
import { NO_APP_SYNCS, setAppSyncHooks } from "../src/app-packages/syncs";
import { APP_PACKAGE_SYNC_HOOKS } from "../src/app-sync/package-hooks";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { siteSqlTransport } from "../src/site-sql/service";

const SECRET = "app-package-gateway-secret-0123456789abcdef";
const ORIGIN = "https://internal.sites.test";
const GATEWAY_DIR = resolve(import.meta.dir, "../../site-gateway");

let shared: SharedTestDatabase;
let db: DbClient;
let mf: { dispatchFetch: Function; dispose(): Promise<void>; ready: Promise<unknown> } | null =
  null;
let buildDir = "";

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("app-packages");
  if (!acquired) throw new Error("App package tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
  buildDir = mkdtempSync(join(tmpdir(), "app-packages-test-"));
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

afterEach(() => setAppSyncHooks(NO_APP_SYNCS));

const noop = async () => undefined;
const PERMISSIONS = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
  "artifacts:read",
  "artifacts:publish",
] as const;
const SQL_SETTINGS: Partial<Settings> = {
  sitesCloudflareStorageEnabled: true,
  sitesGatewayInternalOrigin: ORIGIN,
  sitesGatewaySecret: SECRET,
};

function memoryObjectStorage(): ObjectStorageDependency {
  const objects = new Map<string, Uint8Array>();
  return {
    maxSinglePutSizeBytes: 5_000_000_000,
    objects,
    headObject: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { ContentLength: bytes.length, VersionToken: "v" } : null;
    },
    putObject: async (input: { key: string; body: Uint8Array }) => {
      objects.set(input.key, input.body.slice());
    },
    getObjectBytes: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { bytes, contentType: "text/html" } : null;
    },
    deleteObject: async (key: string) => {
      objects.delete(key);
    },
    createGetUrl: async (input: { key: string }) => ({
      url: `https://storage.test/${input.key}`,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  } as unknown as ObjectStorageDependency;
}

type Who = { subjectId: string; grant: AccessGrant; headers: Record<string, string> };

async function fixture(overrides: Partial<Settings> = SQL_SETTINGS) {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('App package fixture') returning id`;
  const accountId = String(account!.id);
  const source = await createWorkspace(db.db, { accountId, name: "Source workspace" });
  const target = await createWorkspace(db.db, { accountId, name: "Target workspace" });
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
      "artifacts:read",
      "artifacts:publish",
      "account:admin",
    ],
  });
  const settings = testSettings({
    productAccessMode: "configured",
    sandboxBackend: "none",
    ...overrides,
  });
  const objectStorage = memoryObjectStorage();
  const deps = {
    db: db.db,
    bus: new MemoryEventBus(),
    settings,
    objectStorage,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies;
  const app = createApp(deps);
  const identitySource = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const person = async (workspaceId: string): Promise<Who> => {
    const identity = await ensureExternalIdentity(db.db, {
      accountId,
      source: identitySource,
      externalId: crypto.randomUUID(),
    });
    const added = await app.request(`/v1/workspaces/${workspaceId}/external-members`, {
      method: "POST",
      headers: service,
      body: JSON.stringify({
        identity: { source: identitySource, externalId: identity.externalId },
        permissions: PERMISSIONS,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(added.status).toBe(200);
    return {
      subjectId: identity.subjectId,
      grant: {
        accountId,
        workspaceId,
        subjectId: identity.subjectId,
        permissions: [...PERMISSIONS] as AccessGrant["permissions"],
        principalKind: "human_session",
      },
      headers: {
        ...service,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source: identitySource, externalId: identity.externalId },
          }),
        ),
      },
    };
  };
  const author = await person(source.id);
  const installer = await person(target.id);
  const call = async (who: Who, method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
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
    return { status: response.status, json, text };
  };
  const appBase = (workspaceId: string, appId: string) =>
    `/v1/workspaces/${workspaceId}/published-artifacts/${appId}`;
  return {
    app,
    deps,
    accountId,
    source,
    target,
    author,
    installer,
    call,
    appBase,
    objectStorage,
    exportApp: (appId: string, body: Record<string, unknown> = {}, who: Who = author) =>
      call(who, "POST", `${appBase(source.id, appId)}/package`, body),
    install: (body: Record<string, unknown>, who: Who = installer) =>
      call(who, "POST", `/v1/workspaces/${target.id}/app-packages/install`, {
        idempotencyKey: crypto.randomUUID(),
        ...body,
      }),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const TOOLS = [{ serverId: "example-crm", toolName: "contacts_list" }];

/** A small task board in the source workspace: collections, a database and some data. */
async function buildBoard(f: Fixture, { sql = true }: { sql?: boolean } = {}) {
  const created = await f.call(
    f.author,
    "POST",
    `/v1/workspaces/${f.source.id}/published-artifacts`,
    {
      title: "Team board",
      description: "Tasks and notes",
      html: "<!doctype html><h1>Team board</h1>",
      source: {
        entrypoint: "index.html",
        files: [
          { path: "index.html", content: "<!doctype html><h1>Team board</h1>" },
          { path: "app.js", content: "console.log('board')" },
        ],
      },
      requestedTools: TOOLS,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(created.status, created.text).toBe(201);
  const appId = created.json.artifact.id as string;
  const base = f.appBase(f.source.id, appId);
  const collection = await f.call(f.author, "PUT", `${base}/data/collections/tasks`, {
    accessMode: "shared",
    jsonSchema: {
      type: "object",
      properties: { title: { type: "string" }, done: { type: "boolean" } },
      required: ["title"],
    },
    indexedFields: ["priority"],
    uniqueFields: [["title"]],
  });
  expect(collection.status, collection.text).toBeLessThan(300);
  const notes = await f.call(f.author, "PUT", `${base}/data/collections/notes`, {
    accessMode: "per_viewer",
  });
  expect(notes.status, notes.text).toBeLessThan(300);
  const written = await f.call(f.author, "POST", `${base}/data/write`, {
    operations: [
      { op: "insert", collection: "tasks", data: { title: "Plan", done: false, priority: 1 } },
      { op: "put", collection: "tasks", key: "launch", data: { title: "Launch", priority: 2 } },
    ],
  });
  expect(written.status, written.text).toBe(200);
  if (sql) {
    expect((await f.call(f.author, "PUT", `${base}/sql/settings`, { enabled: true })).status).toBe(
      200,
    );
    const migrated = await f.call(f.author, "POST", `${base}/sql/migrations`, {
      name: "create_items",
      sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER);",
    });
    expect(migrated.status, migrated.text).toBe(201);
    const second = await f.call(f.author, "POST", `${base}/sql/migrations`, {
      name: "index_items",
      sql: "CREATE INDEX items_name ON items (name);",
    });
    expect(second.status, second.text).toBe(201);
    const query = await f.call(f.author, "PUT", `${base}/sql/queries/list_items`, {
      sql: "SELECT name, qty FROM items ORDER BY id",
      audience: "signed_in",
      description: "Every item",
    });
    expect(query.status, query.text).toBeLessThan(300);
    const insert = await f.call(f.author, "POST", `${base}/sql/execute`, {
      sql: "INSERT INTO items (name, qty) VALUES ('Bolts', 40), ('Nuts', 12)",
    });
    expect(insert.status, insert.text).toBe(200);
  }
  return appId;
}

async function described(f: Fixture, appId: string) {
  const base = f.appBase(f.target.id, appId);
  const data = await f.call(f.installer, "GET", `${base}/data`);
  expect(data.status, data.text).toBe(200);
  const sql = await f.call(f.installer, "GET", `${base}/sql`);
  return { data: data.json, sql: sql.json, base };
}

test("an exported app installs into another workspace and works there, with empty data", async () => {
  const f = await fixture();
  const appId = await buildBoard(f);
  const exported = await f.exportApp(appId);
  expect(exported.status, exported.text).toBe(200);
  const pkg = exported.json.package as AppPackage;
  expect(exported.json.filename).toBe("team-board.opengeni-app.json");
  expect(exported.json.notExported).toEqual([]);
  expect(pkg).toMatchObject({
    format: APP_PACKAGE_FORMAT,
    version: 1,
    app: { title: "Team board", description: "Tasks and notes" },
    tools: TOOLS,
    sql: {
      migrations: [{ name: "create_items" }, { name: "index_items" }],
      queries: [{ name: "list_items", audience: "signed_in", description: "Every item" }],
    },
    syncs: [],
  });
  expect(pkg.app.html).toContain("Team board");
  expect(pkg.app.source?.files.map((file) => file.path)).toEqual(["index.html", "app.js"]);
  expect(pkg.data.collections.map((collection) => collection.name).sort()).toEqual([
    "notes",
    "tasks",
  ]);
  expect(pkg.data.collections.find((c) => c.name === "tasks")).toMatchObject({
    accessMode: "shared",
    indexedFields: ["priority"],
    uniqueFields: [["title"]],
  });
  // No data unless the author asks for demo data.
  expect(pkg.demoData).toBeUndefined();
  expect(JSON.stringify(pkg)).not.toContain("Bolts");
  expect(JSON.stringify(pkg)).not.toContain("Launch");

  // Only the app's managers export it; nobody outside its workspace can.
  const outsider = await f.call(
    f.installer,
    "POST",
    `${f.appBase(f.source.id, appId)}/package`,
    {},
  );
  expect(outsider.status).toBeGreaterThanOrEqual(403);

  const key = crypto.randomUUID();
  const installed = await f.install({ package: pkg, idempotencyKey: key });
  expect(installed.status, installed.text).toBe(201);
  expect(installed.json.notInstalled).toEqual([]);
  expect(installed.json.installed).toMatchObject({
    tools: 1,
    migrations: ["create_items", "index_items"],
    queries: ["list_items"],
    syncs: [],
    demoRecords: 0,
    demoRows: 0,
  });
  expect(installed.json.installed.collections.sort()).toEqual(["notes", "tasks"]);
  const newApp = installed.json.app;
  expect(newApp.workspaceId).toBe(f.target.id);
  expect(newApp.id).not.toBe(appId);
  expect(newApp.title).toBe("Team board");
  expect(newApp.currentVersion.requestedTools).toEqual(TOOLS);

  // It works there: the same page and source, empty collections that enforce
  // their definitions, and a migrated empty database with its named query.
  const content = await f.call(f.installer, "GET", `${f.appBase(f.target.id, newApp.id)}/content`);
  expect(content.status, content.text).toBe(200);
  expect(content.json.html).toBe(pkg.app.html);
  expect(content.json.source.files).toHaveLength(2);
  const { data, sql, base } = await described(f, newApp.id);
  expect(data.collections.map((c: any) => [c.name, c.recordCount]).sort()).toEqual([
    ["notes", 0],
    ["tasks", 0],
  ]);
  const invalid = await f.call(f.installer, "POST", `${base}/data/write`, {
    operations: [{ op: "insert", collection: "tasks", data: { done: true } }],
  });
  expect(invalid.status).toBe(422);
  const ok = await f.call(f.installer, "POST", `${base}/data/write`, {
    operations: [{ op: "insert", collection: "tasks", data: { title: "Mine" } }],
  });
  expect(ok.status, ok.text).toBe(200);
  const duplicate = await f.call(f.installer, "POST", `${base}/data/write`, {
    operations: [{ op: "insert", collection: "tasks", data: { title: "Mine" } }],
  });
  expect(duplicate.status).toBe(409);
  expect(sql).toMatchObject({ available: true, enabled: true });
  expect(sql.migrations.map((m: any) => m.name)).toEqual(["create_items", "index_items"]);
  const empty = await f.call(f.installer, "POST", `${base}/sql/queries/list_items`, {});
  expect(empty.status, empty.text).toBe(200);
  expect(empty.json.rows).toEqual([]);
  const added = await f.call(f.installer, "POST", `${base}/sql/execute`, {
    sql: "INSERT INTO items (name, qty) VALUES ('Washers', 3)",
  });
  expect(added.status, added.text).toBe(200);
  const listed = await f.call(f.installer, "POST", `${base}/sql/queries/list_items`, {});
  expect(listed.json.rows).toEqual([{ name: "Washers", qty: 3 }]);

  // The same request again returns the same app and adds nothing.
  const replayed = await f.install({ package: pkg, idempotencyKey: key });
  expect(replayed.status, replayed.text).toBe(200);
  expect(replayed.json.replayed).toBe(true);
  expect(replayed.json.app.id).toBe(newApp.id);
  expect(replayed.json.notInstalled).toEqual([]);
  const again = await described(f, newApp.id);
  expect(again.sql.migrations).toHaveLength(2);
  expect(again.data.collections.find((c: any) => c.name === "tasks").recordCount).toBe(1);

  // A new request installs a second, separate copy.
  const second = await f.install({ package: pkg, title: "Board two" });
  expect(second.status, second.text).toBe(201);
  expect(second.json.app.id).not.toBe(newApp.id);
  expect(second.json.app.title).toBe("Board two");

  // The original keeps its own data.
  const original = await f.call(f.author, "GET", `${f.appBase(f.source.id, appId)}/data`);
  expect(original.json.collections.find((c: any) => c.name === "tasks").recordCount).toBe(2);
}, 120_000);

test("tool data from a connected account is never packaged as demo data", async () => {
  const f = await fixture();
  const appId = await buildBoard(f);
  // A shared sync stored a connected account's data in both: it stays in this workspace.
  await markSiteToolData(f.deps.db, { accountId: f.accountId, workspaceId: f.source.id }, appId, [
    { target: "collection:tasks", connector: "example-crm", route: "example-crm", shared: true },
    { target: "sql", connector: "example-crm", route: "example-crm", shared: true },
  ]);
  const exported = await f.exportApp(appId, { demoData: true });
  expect(exported.status, exported.text).toBe(200);
  expect(exported.json.package.demoData?.records.tasks).toBeUndefined();
  expect(exported.json.package.demoData?.sqlRows.items).toBeUndefined();
  expect(exported.json.notExported).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        part: "demo_data",
        name: "tasks",
        reason: expect.stringContaining("connected account"),
      }),
      expect.objectContaining({
        part: "demo_data",
        name: "items",
        reason: expect.stringContaining("connected account"),
      }),
    ]),
  );
}, 120_000);

test("demo data is included only when the author asks, and installs unless declined", async () => {
  const f = await fixture();
  const appId = await buildBoard(f);
  const exported = await f.exportApp(appId, {
    demoData: { collections: ["tasks"], tables: ["items"] },
  });
  expect(exported.status, exported.text).toBe(200);
  const pkg = exported.json.package as AppPackage;
  expect(pkg.demoData?.records.tasks?.map((r) => r.data.title).sort()).toEqual(["Launch", "Plan"]);
  expect(pkg.demoData?.records.tasks?.find((r) => r.data.title === "Launch")?.key).toBe("launch");
  expect(pkg.demoData?.records.notes).toBeUndefined();
  expect(pkg.demoData?.sqlRows.items).toEqual([
    { id: 1, name: "Bolts", qty: 40 },
    { id: 2, name: "Nuts", qty: 12 },
  ]);
  const all = await f.exportApp(appId, { demoData: true });
  expect(all.status, all.text).toBe(200);
  // Each person's own notes belong to them, not to the app: left out and said so.
  expect(Object.keys(all.json.package.demoData.records).sort()).toEqual(["tasks"]);
  expect(all.json.notExported).toContainEqual(
    expect.objectContaining({ part: "demo_data", name: "notes" }),
  );
  expect(Object.keys(all.json.package.demoData.sqlRows)).toEqual(["items"]);

  const withDemo = await f.install({ package: pkg });
  expect(withDemo.status, withDemo.text).toBe(201);
  expect(withDemo.json.notInstalled).toEqual([]);
  expect(withDemo.json.installed).toMatchObject({ demoRecords: 2, demoRows: 2 });
  const loaded = await described(f, withDemo.json.app.id);
  expect(loaded.data.collections.find((c: any) => c.name === "tasks").recordCount).toBe(2);
  const rows = await f.call(f.installer, "POST", `${loaded.base}/sql/queries/list_items`, {});
  expect(rows.json.rows).toEqual([
    { name: "Bolts", qty: 40 },
    { name: "Nuts", qty: 12 },
  ]);
  const keyed = await f.call(f.installer, "POST", `${loaded.base}/data/get`, {
    collection: "tasks",
    key: "launch",
  });
  expect(keyed.status, keyed.text).toBe(200);

  const declined = await f.install({ package: pkg, demoData: false });
  expect(declined.status, declined.text).toBe(201);
  expect(declined.json.installed).toMatchObject({ demoRecords: 0, demoRows: 0 });
  const empty = await described(f, declined.json.app.id);
  expect(empty.data.collections.find((c: any) => c.name === "tasks").recordCount).toBe(0);
}, 120_000);

test("without Site SQL the rest installs and the database is reported", async () => {
  const f = await fixture();
  const appId = await buildBoard(f);
  const pkg = (await f.exportApp(appId, { demoData: true })).json.package as AppPackage;
  const off = await fixture({});
  const installed = await off.install({ package: pkg });
  expect(installed.status, installed.text).toBe(201);
  expect(installed.json.installed.collections.sort()).toEqual(["notes", "tasks"]);
  expect(installed.json.installed).toMatchObject({ migrations: [], queries: [], demoRecords: 2 });
  expect(installed.json.notInstalled).toEqual([
    expect.objectContaining({ part: "sql", reason: expect.stringContaining("2 migrations") }),
  ]);
  // An app without a database exports where Site SQL is off, too.
  const plain = await buildBoard(off, { sql: false });
  const exported = await off.exportApp(plain, { demoData: true });
  expect(exported.status, exported.text).toBe(200);
  expect(exported.json.package.sql).toEqual({ migrations: [], queries: [] });
}, 120_000);

test("malformed packages are refused or installed leniently", async () => {
  const f = await fixture();
  const notPackage = await f.install({ package: { hello: "world" } });
  expect(notPackage.status).toBe(422);
  expect(notPackage.json.error.message).toContain("isn't an app package");
  const noHtml = await f.install({ package: { format: APP_PACKAGE_FORMAT, version: 1, app: {} } });
  expect(noHtml.status).toBe(422);
  const notJson = await f.app.request(`/v1/workspaces/${f.target.id}/app-packages/install`, {
    method: "POST",
    headers: f.installer.headers,
    body: "{not json",
  });
  expect(notJson.status).toBe(422);

  const partial = await f.install({
    package: {
      format: APP_PACKAGE_FORMAT,
      version: 3,
      somethingNew: { ignored: true },
      app: { title: "Partial", html: "<!doctype html><p>hi</p>", source: { bad: true } },
      tools: [{ serverId: "x" }, { serverId: "example-crm", toolName: "contacts_list" }],
      data: {
        collections: [
          { name: "good", accessMode: "shared" },
          { name: "bad", accessMode: "everyone" },
          { name: "bad schema", accessMode: "shared" },
        ],
      },
      sql: {
        migrations: [
          { name: "broken", sql: "CREATE TABLE (" },
          { name: "after", sql: "CREATE TABLE t (x)" },
        ],
        queries: [{ name: "q", sql: "SELECT 1", audience: "nobody" }],
      },
      syncs: [{ name: "contacts", tool: "contacts_list" }],
      demoData: { records: { good: [{ data: { a: 1 } }], missing: [{ data: {} }] } },
    },
  });
  expect(partial.status, partial.text).toBe(201);
  expect(partial.json.installed).toMatchObject({
    collections: ["good"],
    tools: 1,
    migrations: [],
    demoRecords: 1,
  });
  const parts = partial.json.notInstalled.map((p: any) => `${p.part}:${p.name ?? ""}`);
  expect(parts).toEqual(
    expect.arrayContaining([
      "package:",
      "app:source",
      "tools:#1",
      "collection:bad",
      "collection:bad schema",
      "query:q",
      "migration:broken",
      "migration:after",
      "sync:contacts",
      "demo_data:missing",
    ]),
  );
}, 120_000);

test("syncs go through the sync hooks: listed on export, created paused on install", async () => {
  const f = await fixture();
  const appId = await buildBoard(f, { sql: false });
  const created: Array<{ appId: string; syncs: unknown[]; installKey: string }> = [];
  setAppSyncHooks({
    list: async ({ appId: listed }) =>
      listed === appId
        ? [{ name: "Import contacts", tool: "contacts_list", schedule: "daily" }]
        : [],
    createPaused: async (input) => {
      created.push({ appId: input.appId, syncs: input.syncs, installKey: input.installKey });
      return { created: input.syncs.map((sync) => String(sync.name)), notCreated: [] };
    },
  });
  const pkg = (await f.exportApp(appId)).json.package as AppPackage;
  expect(pkg.syncs).toEqual([
    { name: "Import contacts", tool: "contacts_list", schedule: "daily" },
  ]);
  const installed = await f.install({ package: pkg });
  expect(installed.status, installed.text).toBe(201);
  expect(installed.json.installed.syncs).toEqual(["Import contacts"]);
  expect(created).toEqual([
    {
      appId: installed.json.app.id,
      syncs: pkg.syncs,
      installKey: expect.stringMatching(/^subject:/),
    },
  ]);
}, 120_000);

test("agents export and install apps with app_export and app_install", async () => {
  const f = await fixture();
  const appId = await buildBoard(f);
  const source = await agentTools(f, f.source.id, f.author);
  const exported = await source.callTool("app_export", { appId, demoData: true });
  expect(exported.isError, JSON.stringify(exported.value)).toBe(false);
  expect(exported.value).toMatchObject({
    filename: "team-board.opengeni-app.json",
    contents: {
      title: "Team board",
      tools: 1,
      migrations: ["create_items", "index_items"],
      queries: ["list_items"],
      demoData: { records: { tasks: 2 }, sqlRows: { items: 2 } },
    },
  });
  const key = new URL(exported.value.downloadUrl.url).pathname.slice(1);
  const stored = (f.objectStorage as any).objects.get(key) as Uint8Array;
  const pkg = JSON.parse(new TextDecoder().decode(stored));
  expect(pkg.format).toBe(APP_PACKAGE_FORMAT);

  const target = await agentTools(f, f.target.id, f.installer);
  const installed = await target.callTool("app_install", {
    package: pkg,
    demoData: false,
    idempotencyKey: "install-board",
  });
  expect(installed.isError, JSON.stringify(installed.value)).toBe(false);
  // This chat's catalog lacks the app's declared tool, so the app is installed
  // without it and the gap is reported instead of failing the install.
  expect(installed.value.notInstalled).toEqual([expect.objectContaining({ part: "tools" })]);
  expect(installed.value.installed).toMatchObject({ demoRecords: 0, demoRows: 0 });
  expect(installed.value.artifactReference).toBe(`[Open app](artifact:${installed.value.app.id})`);
  const replay = await target.callTool("app_install", {
    package: pkg,
    demoData: false,
    idempotencyKey: "install-board",
  });
  expect(replay.value.app.id).toBe(installed.value.app.id);
  expect(replay.value.replayed).toBe(true);

  const missing = await target.callTool("app_install", { idempotencyKey: "nothing" });
  expect(missing.isError).toBe(true);
  // Exporting an app of another workspace finds nothing.
  const foreign = await target.callTool("app_export", { appId });
  expect(foreign.isError).toBe(true);
  expect(foreign.value.error.code).toBe("not_found");
}, 120_000);

/** A connector whose tools run on each person's own account. */
const TRACKER: Partial<Settings> = {
  ...SQL_SETTINGS,
  mcpServers: [
    {
      id: "tracker",
      url: "https://tracker.test/mcp",
      cacheToolsList: false,
      allowedTools: ["list_items", "create_item"],
      connectionRef: {
        providerDomain: "tracker.test",
        kind: "api_key",
        subjectScope: "subject",
        accountSelection: "all_eligible",
      },
    },
  ] as Settings["mcpServers"],
};

test("packages carry connector tools, and agents keep the ones their chat has", async () => {
  const f = await fixture(TRACKER);
  // As a published version stores them: the author's own account route,
  // paired with its connector, and tools declared for the connector itself.
  const declared = [
    { serverId: "account-author0001", toolName: "list_items" },
    { serverId: "tracker", toolName: "list_items" },
    { serverId: "tracker", toolName: "create_item" },
    { serverId: "example-crm", toolName: "contacts_list" },
  ];
  const created = await f.call(
    f.author,
    "POST",
    `/v1/workspaces/${f.source.id}/published-artifacts`,
    {
      title: "Tracker board",
      html: "<!doctype html><h1>Tracker</h1>",
      requestedTools: declared,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(created.status, created.text).toBe(201);
  const exported = await f.exportApp(created.json.artifact.id);
  expect(exported.status, exported.text).toBe(200);
  const pkg = exported.json.package as AppPackage;
  // No account of the author's leaves the workspace.
  expect(pkg.tools).toEqual([
    { serverId: "tracker", toolName: "list_items" },
    { serverId: "tracker", toolName: "create_item" },
    { serverId: "example-crm", toolName: "contacts_list" },
  ]);

  // From the Apps page every tool is kept; each viewer connects their own.
  const page = await f.install({ package: pkg });
  expect(page.status, page.text).toBe(201);
  expect(page.json.installed.tools).toBe(3);
  expect(page.json.notInstalled).toEqual([]);

  // This chat has the installer's own tracker account for list_items only.
  const agent = await agentTools(f, f.target.id, f.installer, [
    { serverId: "account-installer01", canonicalServerId: "tracker", toolName: "list_items" },
  ]);
  const installed = await agent.callTool("app_install", {
    package: pkg,
    idempotencyKey: "tracker-board",
  });
  expect(installed.isError, JSON.stringify(installed.value)).toBe(false);
  expect(installed.value.installed.tools, JSON.stringify(installed.value.notInstalled)).toBe(1);
  expect(installed.value.notInstalled).toEqual([
    expect.objectContaining({ part: "tools", name: "create_item" }),
    expect.objectContaining({ part: "tools", name: "contacts_list" }),
  ]);
  const version = await f.call(f.installer, "GET", f.appBase(f.target.id, installed.value.app.id));
  expect(version.status, version.text).toBe(200);
  expect(JSON.stringify(version.json)).toContain('"serverId":"tracker"');
  expect(JSON.stringify(version.json)).not.toContain("account-author0001");

  // A replay returns the same app and reports the same, nothing more.
  const replay = await agent.callTool("app_install", {
    package: pkg,
    idempotencyKey: "tracker-board",
  });
  expect(replay.value.replayed).toBe(true);
  expect(replay.value.app.id).toBe(installed.value.app.id);
  expect(replay.value.notInstalled).toEqual(installed.value.notInstalled);
}, 120_000);

test("packages carry the app's sidebar links, added once on install", async () => {
  const f = await fixture();
  const appId = await buildBoard(f);
  const admin = {
    ...f.author.grant,
    permissions: [...f.author.grant.permissions, "workspace:admin"],
  } as AccessGrant;
  await updateSidebarLayoutForGrant(f.deps, admin, {
    scope: "workspace",
    changes: [
      { op: "add", item: { type: "app", appId, label: "Board" } },
      {
        op: "add",
        item: {
          type: "group",
          label: "Team",
          items: [{ type: "app", appId, path: "/releases", label: "Releases" }],
        },
      },
    ],
  });
  const exported = await f.exportApp(appId);
  expect(exported.status, exported.text).toBe(200);
  const pkg = exported.json.package as AppPackage;
  expect(pkg.sidebar).toEqual([
    { label: "Board" },
    { path: "/releases", label: "Releases", group: "Team" },
  ]);

  // Not an admin in the target workspace: the links go to their own sidebar.
  const key = crypto.randomUUID();
  const installed = await f.install({ package: pkg, idempotencyKey: key });
  expect(installed.status, installed.text).toBe(201);
  expect(installed.json.installed.sidebar).toBe(2);
  expect(installed.json.notInstalled).toEqual([]);
  const newId = installed.json.app.id as string;
  const read = await readSidebarLayoutForGrant(f.deps, f.installer.grant);
  const summary = () =>
    read.items.map((item) =>
      item.type === "group"
        ? {
            group: item.label,
            items: item.items.map((child) => child.type === "app" && child.appId),
          }
        : item.type === "live_list"
          ? `list:${item.list}`
          : item.type === "app" && item.appId,
    );
  // After the built-in default's Pinned apps list (left out of the rail while empty).
  expect(summary()).toEqual(["list:pinned_apps", newId, { group: "Team", items: [newId] }]);

  // A replay adds nothing again.
  const replay = await f.install({ package: pkg, idempotencyKey: key });
  expect(replay.json.replayed).toBe(true);
  expect(replay.json.installed.sidebar).toBe(0);
  expect((await readSidebarLayoutForGrant(f.deps, f.installer.grant)).items).toHaveLength(3);
}, 120_000);

test("the same key with a different package installs a different app", async () => {
  const f = await fixture();
  const appId = await buildBoard(f, { sql: false });
  const pkg = (await f.exportApp(appId)).json.package as AppPackage;
  const first = await f.install({ package: pkg, idempotencyKey: "same-key" });
  expect(first.status, first.text).toBe(201);
  const replay = await f.install({ package: pkg, idempotencyKey: "same-key" });
  expect(replay.status, replay.text).toBe(200);
  expect(replay.json.app.id).toBe(first.json.app.id);
  expect(replay.json.notInstalled).toEqual([]);
  const other = await f.install({
    package: { ...pkg, data: { collections: [{ name: "extra", accessMode: "shared" }] } },
    idempotencyKey: "same-key",
  });
  expect(other.status, other.text).toBe(201);
  expect(other.json.app.id).not.toBe(first.json.app.id);
  // The first app is unchanged.
  const firstData = await described(f, first.json.app.id);
  expect(firstData.data.collections.map((c: any) => c.name).sort()).toEqual(["notes", "tasks"]);
}, 120_000);

test("installing syncs needs permission to manage automations", async () => {
  const f = await fixture();
  setAppSyncHooks(APP_PACKAGE_SYNC_HOOKS);
  const appId = await buildBoard(f, { sql: false });
  const pkg = (await f.exportApp(appId)).json.package as AppPackage;
  pkg.syncs = [
    {
      name: "Import contacts",
      collection: "tasks",
      mode: "shared",
      tool: { serverId: "tracker", toolName: "list_items" },
      schedule: { type: "interval", everySeconds: 3600 },
    },
  ];
  // The installer can publish apps but not manage automations.
  const installed = await f.install({ package: pkg });
  expect(installed.status, installed.text).toBe(201);
  expect(installed.json.installed.syncs).toEqual([]);
  expect(installed.json.notInstalled).toEqual([
    {
      part: "sync",
      name: "Import contacts",
      reason: "Adding syncs needs permission to manage automations in this workspace",
    },
  ]);
}, 120_000);

/** Upgrade an app of the source workspace from a package, as its author. */
function upgrade(f: Fixture, appId: string, body: Record<string, unknown>, who: Who = f.author) {
  return f.call(who, "POST", `${f.appBase(f.source.id, appId)}/package/upgrade`, body);
}

async function sqlRows(f: Fixture, appId: string, sql: string) {
  const result = await f.call(f.author, "POST", `${f.appBase(f.source.id, appId)}/sql/execute`, {
    sql,
  });
  expect(result.status, result.text).toBe(200);
  return result.json.rows as Array<Record<string, unknown>>;
}

test("an upgrade publishes the package's version and runs only what is new, keeping the data", async () => {
  const f = await fixture();
  const appId = await buildBoard(f);
  const pkg = (await f.exportApp(appId)).json.package as AppPackage;
  const before = await f.call(f.author, "GET", `${f.appBase(f.source.id, appId)}/data`);

  // The app's own package changes nothing.
  const same = await upgrade(f, appId, { package: pkg, dryRun: true });
  expect(same.status, same.text).toBe(200);
  const versionBefore = same.json.app.currentVersion.id as string;
  expect(same.json.plan).toMatchObject({
    version: { changed: false },
    tools: { added: [], removed: [] },
    collections: { added: [], changed: [], kept: [] },
    migrations: { applied: ["create_items", "index_items"], new: [], conflicting: [] },
    queries: { added: [], changed: [], removed: [] },
    destructive: [],
    conflicts: [],
  });

  const next: AppPackage = structuredClone(pkg);
  next.app.html = "<!doctype html><h1>Team board 2</h1>";
  delete next.app.source;
  next.data.collections = [
    ...next.data.collections.filter((c) => c.name !== "notes"),
    { name: "labels", accessMode: "shared" } as AppPackage["data"]["collections"][number],
  ];
  next.sql.migrations.push({
    name: "add_price",
    sql: "ALTER TABLE items ADD COLUMN price INTEGER DEFAULT 0;",
  });
  next.sql.queries = [
    { ...next.sql.queries[0]!, sql: "SELECT name, qty, price FROM items ORDER BY id" },
    { name: "count_items", sql: "SELECT count(*) AS n FROM items", audience: "signed_in" },
  ] as AppPackage["sql"]["queries"];
  const planned = await upgrade(f, appId, { package: next, dryRun: true });
  expect(planned.status, planned.text).toBe(200);
  expect(planned.json).toMatchObject({ dryRun: true, applied: false });
  expect(planned.json.plan).toMatchObject({
    version: { changed: true, html: true, source: true, tools: false },
    collections: { added: ["labels"], changed: [], unchanged: ["tasks"], kept: ["notes"] },
    migrations: { applied: ["create_items", "index_items"], new: ["add_price"], conflicting: [] },
    queries: { added: ["count_items"], changed: ["list_items"], removed: [] },
    destructive: [],
    conflicts: [],
  });
  // A dry run changes nothing; applying needs a key.
  expect((await sqlRows(f, appId, "SELECT name FROM pragma_table_info('items')")).length).toBe(3);
  const keyless = await upgrade(f, appId, { package: next });
  expect(keyless.status).toBe(422);

  const key = crypto.randomUUID();
  const applied = await upgrade(f, appId, { package: next, idempotencyKey: key });
  expect(applied.status, applied.text).toBe(200);
  expect(applied.json.notUpgraded).toEqual([]);
  expect(applied.json.upgraded).toMatchObject({
    version: true,
    collections: ["labels"],
    migrations: ["add_price"],
  });
  expect(applied.json.upgraded.queries.sort()).toEqual(["count_items", "list_items"]);
  expect(applied.json.app.id).toBe(appId);
  expect(applied.json.app.title).toBe("Team board");
  expect(applied.json.app.currentVersion.id).not.toBe(versionBefore);

  const content = await f.call(f.author, "GET", `${f.appBase(f.source.id, appId)}/content`);
  expect(content.json.html).toBe(next.app.html);
  const after = await f.call(f.author, "GET", `${f.appBase(f.source.id, appId)}/data`);
  const counts = (json: any) =>
    Object.fromEntries(json.collections.map((c: any) => [c.name, c.recordCount]));
  expect(counts(after.json)).toEqual({ ...counts(before.json), labels: 0 });
  const listed = await f.call(
    f.author,
    "POST",
    `${f.appBase(f.source.id, appId)}/sql/queries/list_items`,
    {},
  );
  expect(listed.json.rows).toEqual([
    { name: "Bolts", qty: 40, price: 0 },
    { name: "Nuts", qty: 12, price: 0 },
  ]);
  const sql = await f.call(f.author, "GET", `${f.appBase(f.source.id, appId)}/sql`);
  expect(sql.json.migrations.map((m: any) => m.name)).toEqual([
    "create_items",
    "index_items",
    "add_price",
  ]);

  // The same request again finds it done and publishes nothing new.
  const replayed = await upgrade(f, appId, { package: next, idempotencyKey: key });
  expect(replayed.status, replayed.text).toBe(200);
  expect(replayed.json.plan.version.changed).toBe(false);
  expect(replayed.json.upgraded).toMatchObject({ version: false, migrations: [], queries: [] });
  expect(replayed.json.app.currentVersion.id).toBe(applied.json.app.currentVersion.id);

  // Managers only.
  const outsider = await f.call(
    f.installer,
    "POST",
    `${f.appBase(f.source.id, appId)}/package/upgrade`,
    { package: next, dryRun: true },
  );
  expect(outsider.status).toBeGreaterThanOrEqual(403);
}, 120_000);

test("destructive changes need allowDestructive, and conflicts stop the upgrade", async () => {
  const f = await fixture();
  const appId = await buildBoard(f);
  const pkg = (await f.exportApp(appId)).json.package as AppPackage;

  const risky: AppPackage = structuredClone(pkg);
  risky.app.html = "<!doctype html><h1>Risky</h1>";
  risky.sql.migrations.push({ name: "drop_qty", sql: "ALTER TABLE items DROP COLUMN qty;" });
  // The empty notes collection may change who reads it; nothing is hidden.
  risky.data.collections = risky.data.collections.map((c) =>
    c.name === "notes" ? { ...c, accessMode: "shared" } : c,
  );
  const plan = await upgrade(f, appId, { package: risky, dryRun: true });
  expect(plan.status, plan.text).toBe(200);
  expect(plan.json.plan.collections.changed).toEqual(["notes"]);
  expect(plan.json.plan.destructive).toEqual([
    expect.objectContaining({ part: "migration", name: "drop_qty" }),
  ]);
  const refused = await upgrade(f, appId, { package: risky, idempotencyKey: crypto.randomUUID() });
  expect(refused.status, refused.text).toBe(409);
  expect(refused.json.error.message).toContain("allowDestructive");
  // Nothing ran.
  expect((await sqlRows(f, appId, "SELECT name FROM pragma_table_info('items')")).length).toBe(3);
  const content = await f.call(f.author, "GET", `${f.appBase(f.source.id, appId)}/content`);
  expect(content.json.html).toBe(pkg.app.html);

  // A migration the app ran, with other SQL: nothing applies, even when allowed.
  const conflicting: AppPackage = structuredClone(risky);
  conflicting.sql.migrations[0] = {
    name: "create_items",
    sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT);",
  };
  conflicting.data.collections.push({
    name: "labels",
    accessMode: "shared",
  } as AppPackage["data"]["collections"][number]);
  const blocked = await upgrade(f, appId, {
    package: conflicting,
    allowDestructive: true,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(blocked.status, blocked.text).toBe(409);
  const sourceData = await f.call(f.author, "GET", `${f.appBase(f.source.id, appId)}/data`);
  expect(sourceData.json.collections.map((c: any) => c.name).sort()).toEqual(["notes", "tasks"]);
  const dry = await upgrade(f, appId, { package: conflicting, dryRun: true });
  expect(dry.json.plan.migrations.conflicting).toEqual(["create_items"]);
  expect(dry.json.plan.conflicts).toEqual([
    expect.objectContaining({ part: "migration", name: "create_items" }),
  ]);
  // Changing who reads a collection that has records stops it too.
  const hiding: AppPackage = structuredClone(pkg);
  hiding.data.collections = hiding.data.collections.map((c) =>
    c.name === "tasks" ? { ...c, accessMode: "per_viewer" } : c,
  );
  const hidden = await upgrade(f, appId, { package: hiding, dryRun: true });
  expect(hidden.json.plan.conflicts).toEqual([
    expect.objectContaining({ part: "collection", name: "tasks" }),
  ]);

  // Confirmed, the destructive upgrade applies.
  const allowed = await upgrade(f, appId, {
    package: risky,
    allowDestructive: true,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(allowed.status, allowed.text).toBe(200);
  expect(allowed.json.notUpgraded).toEqual([]);
  expect(allowed.json.upgraded).toMatchObject({
    version: true,
    collections: ["notes"],
    migrations: ["drop_qty"],
  });
  expect(await sqlRows(f, appId, "SELECT name FROM items ORDER BY id")).toEqual([
    { name: "Bolts" },
    { name: "Nuts" },
  ]);
}, 120_000);

test("upgrades compare syncs through the sync hooks and agents upgrade with app_upgrade", async () => {
  const f = await fixture();
  const appId = await buildBoard(f, { sql: false });
  const applied: Array<{ syncs: unknown[]; upgradeKey: string }> = [];
  setAppSyncHooks({
    ...NO_APP_SYNCS,
    list: async () => [{ name: "Import", tool: "contacts_list" }],
    planUpgrade: async ({ syncs }) => ({
      added: syncs.map((s) => String(s.name)).filter((n) => n !== "Import"),
      changed: ["Import"],
      unchanged: [],
      kept: ["Old"],
      problems: [],
    }),
    applyUpgrade: async ({ syncs, upgradeKey }) => {
      applied.push({ syncs, upgradeKey });
      return { upgraded: syncs.map((s) => String(s.name)), notUpgraded: [] };
    },
  });
  const pkg = (await f.exportApp(appId)).json.package as AppPackage;
  pkg.syncs = [
    { name: "Import", tool: "contacts_list", schedule: "hourly" },
    { name: "Extra", tool: "contacts_list" },
  ];
  const agent = await agentTools(f, f.source.id, f.author);
  const dry = await agent.callTool("app_upgrade", {
    appId,
    package: pkg,
    dryRun: true,
    idempotencyKey: "upgrade-syncs",
  });
  expect(dry.isError, JSON.stringify(dry.value)).toBe(false);
  expect(dry.value.plan.syncs).toEqual({
    added: ["Extra"],
    changed: ["Import"],
    unchanged: [],
    kept: ["Old"],
  });
  expect(applied).toEqual([]);
  const done = await agent.callTool("app_upgrade", {
    appId,
    package: pkg,
    idempotencyKey: "upgrade-syncs",
  });
  expect(done.isError, JSON.stringify(done.value)).toBe(false);
  expect(done.value.upgraded.syncs).toEqual(["Import", "Extra"]);
  expect(applied).toEqual([{ syncs: pkg.syncs, upgradeKey: expect.stringMatching(/^attempt:/) }]);
  const missing = await agent.callTool("app_upgrade", { appId, idempotencyKey: "nothing" });
  expect(missing.isError).toBe(true);
}, 120_000);

test("demo data carries shared files and SQL blob values", async () => {
  const f = await fixture();
  const appId = await buildBoard(f);
  const base = f.appBase(f.source.id, appId);
  const upload = async (name: string, body: string, scope: "shared" | "private") => {
    const response = await f.app.request(
      `${base}/files?name=${encodeURIComponent(name)}&scope=${scope}`,
      {
        method: "POST",
        headers: { ...f.author.headers, "content-type": "text/plain" },
        body,
      },
    );
    const text = await response.text();
    expect(response.status, text).toBe(201);
    return JSON.parse(text) as { id: string };
  };
  const sharedFile = await upload("readme.txt", "hello", "shared");
  await upload("mine.txt", "private", "private");
  await f.call(f.author, "POST", `${base}/data/write`, {
    operations: [{ op: "put", collection: "tasks", key: "doc", data: { title: sharedFile.id } }],
  });
  expect(
    (
      await f.call(f.author, "POST", `${base}/sql/migrations`, {
        name: "create_blobs",
        sql: "CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB);",
      })
    ).status,
  ).toBe(201);
  await sqlRows(f, appId, "INSERT INTO blobs (data) VALUES (X'00ff10'), (NULL)");

  const exported = await f.exportApp(appId, { demoData: true });
  expect(exported.status, exported.text).toBe(200);
  const pkg = exported.json.package as AppPackage;
  expect(pkg.demoData?.files).toEqual([
    expect.objectContaining({
      id: sharedFile.id,
      name: "readme.txt",
      base64: Buffer.from("hello").toString("base64"),
    }),
  ]);
  expect(pkg.demoData?.sqlRows.blobs).toEqual([
    { id: 1, data: { $base64: "AP8Q" } },
    { id: 2, data: null },
  ]);
  expect(exported.json.notExported).toContainEqual(
    expect.objectContaining({ part: "demo_data", name: "files" }),
  );
  // Only files, when asked for only files.
  const onlyFiles = await f.exportApp(appId, { demoData: { files: true } });
  expect(onlyFiles.status, onlyFiles.text).toBe(200);
  expect(onlyFiles.json.package.demoData.files).toHaveLength(1);
  expect(onlyFiles.json.package.demoData.records).toEqual({});

  const installed = await f.install({ package: pkg });
  expect(installed.status, installed.text).toBe(201);
  expect(installed.json.notInstalled).toEqual([]);
  expect(installed.json.installed).toMatchObject({ demoFiles: 1 });
  const target = f.appBase(f.target.id, installed.json.app.id);
  const files = await f.call(f.installer, "GET", `${target}/files`);
  expect(files.json.files).toEqual([expect.objectContaining({ name: "readme.txt" })]);
  const newId = files.json.files[0].id as string;
  // Records that named the old file name the new one.
  const doc = await f.call(f.installer, "POST", `${target}/data/get`, {
    collection: "tasks",
    key: "doc",
  });
  expect(JSON.stringify(doc.json)).toContain(newId);
  const blobs = await f.call(f.installer, "POST", `${target}/sql/execute`, {
    sql: "SELECT id, hex(data) AS hex FROM blobs ORDER BY id",
  });
  expect(blobs.json.rows).toEqual([
    { id: 1, hex: "00FF10" },
    { id: 2, hex: "" },
  ]);
}, 120_000);

const b64 = (text: string) => Buffer.from(text).toString("base64");

/** One asset file of an app's current version, through the console's asset route. */
async function assetText(f: Fixture, who: Who, workspaceId: string, appId: string, path: string) {
  const content = await f.call(who, "GET", `${f.appBase(workspaceId, appId)}/content`);
  expect(content.status, content.text).toBe(200);
  const base = String(content.json.assetBaseUrl);
  const response = await f.app.request(`${new URL(base).pathname}${path}`);
  return { status: response.status, text: await response.text(), base };
}

test("multi-file apps travel in packages with their files and keep their provenance", async () => {
  const f = await fixture();
  const packageId = crypto.randomUUID();
  const original: Record<string, unknown> = {
    format: APP_PACKAGE_FORMAT,
    version: 1,
    packageId,
    app: {
      title: "Split board",
      html: '<!doctype html><script type="module" src="./assets/index-1.js"></script>',
      assets: {
        files: [
          { path: "assets/index-1.js", base64: b64("export const v = 1;") },
          { path: "assets/index-1.css", base64: b64("body{margin:0}") },
        ],
      },
    },
    tools: [],
    data: { collections: [] },
    sql: { migrations: [], queries: [] },
    syncs: [],
  };
  // Installed into the source workspace: the copy serves its files and records the package.
  const first = await f.call(
    f.author,
    "POST",
    `/v1/workspaces/${f.source.id}/app-packages/install`,
    { package: original, idempotencyKey: crypto.randomUUID() },
  );
  expect(first.status, first.text).toBe(201);
  expect(first.json.packageId).toBe(packageId);
  const appId = first.json.app.id as string;
  const served = await assetText(f, f.author, f.source.id, appId, "assets/index-1.js");
  expect(served).toMatchObject({ status: 200, text: "export const v = 1;" });

  // Exported again: the same files and the same package id.
  const exported = await f.exportApp(appId);
  expect(exported.status, exported.text).toBe(200);
  const pkg = exported.json.package as AppPackage;
  expect(pkg.packageId).toBe(packageId);
  expect(pkg.app.assets?.files).toEqual([
    { path: "assets/index-1.css", base64: b64("body{margin:0}") },
    { path: "assets/index-1.js", base64: b64("export const v = 1;") },
  ]);

  // Installed elsewhere: the files under the copy's own token.
  const copy = await f.install({ package: pkg });
  expect(copy.status, copy.text).toBe(201);
  const copyId = copy.json.app.id as string;
  const copied = await assetText(f, f.installer, f.target.id, copyId, "assets/index-1.css");
  expect(copied).toMatchObject({ status: 200, text: "body{margin:0}" });
  expect(copied.base).not.toBe(served.base);

  // An app made here exports with an id of its own, the same every time.
  const own = await buildBoard(f, { sql: false });
  const ownIds = await Promise.all([f.exportApp(own), f.exportApp(own)]);
  expect(ownIds[0].json.package.packageId).toBe(ownIds[1].json.package.packageId);
  expect(ownIds[0].json.package.packageId).not.toBe(packageId);

  const upgradeCopy = (body: Record<string, unknown>) =>
    f.call(f.installer, "POST", `${f.appBase(f.target.id, copyId)}/package/upgrade`, body);
  // A newer version of the same app: the changed files publish under a new token.
  const next = structuredClone(pkg);
  next.app.assets!.files[1] = { path: "assets/index-1.js", base64: b64("export const v = 2;") };
  const planned = await upgradeCopy({ package: next, dryRun: true });
  expect(planned.status, planned.text).toBe(200);
  expect(planned.json.plan).toMatchObject({
    version: { changed: true, html: false, assets: true },
    package: { id: packageId, current: packageId },
    destructive: [],
  });
  const applied = await upgradeCopy({ package: next, idempotencyKey: crypto.randomUUID() });
  expect(applied.status, applied.text).toBe(200);
  expect(applied.json.upgraded.version).toBe(true);
  const upgraded = await assetText(f, f.installer, f.target.id, copyId, "assets/index-1.js");
  expect(upgraded).toMatchObject({ status: 200, text: "export const v = 2;" });
  expect(upgraded.base).not.toBe(copied.base);

  // Another app's package is refused unless confirmed, then becomes the copy's.
  const other = { ...structuredClone(next), packageId: ownIds[0].json.package.packageId };
  const refused = await upgradeCopy({ package: other, idempotencyKey: crypto.randomUUID() });
  expect(refused.status, refused.text).toBe(409);
  expect(refused.json.error.message).toContain("different app");
  expect(refused.json.error.details.plan.destructive).toEqual([
    expect.objectContaining({ part: "package" }),
  ]);
  const forced = await upgradeCopy({
    package: other,
    allowDestructive: true,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(forced.status, forced.text).toBe(200);
  const after = await upgradeCopy({ package: other, dryRun: true });
  expect(after.json.plan.package).toEqual({ id: other.packageId, current: other.packageId });

  // A package's files must be valid: a bad one refuses the install.
  const broken = structuredClone(original) as any;
  broken.app.assets.files.push({ path: "../escape.js", base64: b64("x") });
  const bad = await f.install({ package: broken });
  expect(bad.status).toBe(422);
}, 120_000);

test("upgrades check asset files and an app's own package id first; export measures files before reading them", async () => {
  const f = await fixture();
  const own = await buildBoard(f, { sql: false });
  const pkg = (await f.exportApp(own)).json.package as AppPackage;

  // An app made here is compared by the id its exports carry.
  const other = { ...structuredClone(pkg), packageId: crypto.randomUUID() };
  const planned = await upgrade(f, own, { package: other, dryRun: true });
  expect(planned.status, planned.text).toBe(200);
  expect(planned.json.plan.package).toEqual({ id: other.packageId, current: pkg.packageId });
  expect(planned.json.plan.destructive).toEqual([
    { part: "package", reason: "This package is from a different app" },
  ]);

  // A bad asset file is a conflict in the plan, and nothing runs.
  const broken = structuredClone(pkg) as any;
  broken.data.collections.push({ name: "extra", accessMode: "shared" });
  broken.app.assets = { files: [{ path: "../escape.js", base64: b64("x") }] };
  const dry = await upgrade(f, own, { package: broken, dryRun: true });
  expect(dry.status, dry.text).toBe(200);
  expect(dry.json.plan.conflicts).toEqual([
    expect.objectContaining({ part: "version", name: "assets" }),
  ]);
  const applied = await upgrade(f, own, { package: broken, idempotencyKey: crypto.randomUUID() });
  expect(applied.status, applied.text).toBe(409);
  const data = await f.call(f.author, "GET", `${f.appBase(f.source.id, own)}/data`);
  expect(data.json.collections.map((c: any) => c.name)).not.toContain("extra");

  // Files too large for a package are refused from the manifest, before any is read.
  const huge = (n: number) => ({
    path: `assets/big-${n}.js`,
    sha256: String(n).repeat(64),
    sizeBytes: 9_500_000,
  });
  // Version history is immutable to the app; the admin skips that trigger to fake big files.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update workspace_artifact_versions set asset_manifest = ${tx.json({
      token: "t".repeat(22),
      files: [huge(1), huge(2)],
    })} where artifact_id = ${own}`;
  });
  const tooBig = await f.exportApp(own);
  expect(tooBig.status, tooBig.text).toBe(413);
  expect(tooBig.json.error.message).toContain("over 24 MB");

  // Install takes no more than export makes.
  const padded = { ...structuredClone(pkg), padding: "x".repeat(24 * 1024 * 1024) };
  expect((await f.install({ package: padded })).status).toBe(413);
}, 120_000);

test("stored export files are recorded and swept after they expire", async () => {
  const f = await fixture();
  const appId = await buildBoard(f, { sql: false });
  const agent = await agentTools(f, f.source.id, f.author);
  const exported = await agent.callTool("app_export", { appId });
  expect(exported.isError, JSON.stringify(exported.value)).toBe(false);
  const key = new URL(exported.value.downloadUrl.url).pathname.slice(1);
  const objects = (f.objectStorage as any).objects as Map<string, Uint8Array>;
  expect(objects.has(key)).toBe(true);
  const rows = () =>
    shared.admin<Array<{ object_key: string; attempts: number; last_error: string | null }>>`
      select object_key, attempts, last_error from app_package_exports
      where workspace_id = ${f.source.id}`;
  const [recorded] = await rows();
  expect(recorded?.object_key).toBe(key);
  const [expiry] = await shared.admin<Array<{ hours: number }>>`
    select extract(epoch from expires_at - created_at) / 3600 as hours
    from app_package_exports where workspace_id = ${f.source.id}`;
  expect(Math.round(Number(expiry!.hours))).toBe(24);

  // Not yet due: nothing is deleted.
  await sweepAppPackageExports({ db: db.db, objectStorage: f.objectStorage });
  expect(objects.has(key)).toBe(true);

  await shared.admin`update app_package_exports set next_attempt_at = now() - interval '1 second'
    where workspace_id = ${f.source.id}`;
  // A failed delete keeps the record for a later retry.
  const failing = {
    deleteObject: async () => {
      throw new Error("storage is down");
    },
  };
  const failed = await sweepAppPackageExports({ db: db.db, objectStorage: failing });
  expect(failed.failed).toBeGreaterThanOrEqual(1);
  const [retry] = await rows();
  expect(retry).toMatchObject({ attempts: 1, last_error: "storage is down" });
  expect(objects.has(key)).toBe(true);

  await shared.admin`update app_package_exports set next_attempt_at = now() - interval '1 second'
    where workspace_id = ${f.source.id}`;
  for (let pass = 0; pass < 5 && (await rows()).length > 0; pass += 1)
    await sweepAppPackageExports({ db: db.db, objectStorage: f.objectStorage }, { limit: 200 });
  expect(objects.has(key)).toBe(false);
  expect(await rows()).toEqual([]);
}, 120_000);

/**
 * An agent attempt acting for `who` in a workspace, with the app package
 * tools. `accountTools` gives its chat account routes (`account-…`) of a
 * connector: a verified tool catalog with those tools and the turn's frozen
 * account bindings that name the connector behind each route.
 */
async function agentTools(
  f: Fixture,
  workspaceId: string,
  who: Who,
  accountTools: Array<{ serverId: string; canonicalServerId: string; toolName: string }> = [],
) {
  const tools = ["app_export", "app_install", "app_upgrade"];
  const session = await createSession(db.db, {
    accountId: f.accountId,
    workspaceId,
    initialMessage: "Move my board",
    resources: [],
    tools: [],
    metadata: {},
    model: "gpt-5.6-sol",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
  // An account route's connector is frozen on the turn when it is accepted.
  let bindings: unknown[] | null = null;
  if (accountTools.length > 0) {
    const connection = await createConnection(db.db, {
      accountId: f.accountId,
      workspaceId,
      providerDomain: "tracker.test",
      kind: "api_key",
      createdBySubjectId: who.subjectId,
      credentialEncrypted: encryptEnvironmentValue(Buffer.alloc(32, 17), "fixture-only"),
    });
    const connectionId = connection.id;
    const ref = {
      connectionId,
      subjectScope: "workspace",
      providerDomain: "tracker.test",
      kind: "api_key",
    };
    bindings = [...new Set(accountTools.map((tool) => tool.serverId))].map((serverId) => ({
      serverId,
      canonicalServerId: accountTools.find((tool) => tool.serverId === serverId)!.canonicalServerId,
      connectionId,
      originWorkspaceId: workspaceId,
      subjectScope: "workspace",
      ownerSubjectId: null,
      accountLabel: "team@tracker.test",
      providerDomain: "tracker.test",
      kind: "api_key",
      connectionRef: ref,
      ...(connection.connectionAuthorityGeneration
        ? { connectionAuthorityGeneration: connection.connectionAuthorityGeneration }
        : {}),
    }));
  }
  const [turn] = await shared.admin.begin(async (tx) => {
    // The bindings fence reads their connection in this account's scope.
    await tx`SELECT set_config('opengeni.account_id', ${f.accountId}, true)`;
    return await tx<{ id: string }[]>`
    INSERT INTO session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend,
      execution_generation, initiator_kind, initiator_subject_id, initiator_context,
      mcp_account_bindings
    ) VALUES (
      ${f.accountId}, ${workspaceId}, ${session.id}, gen_random_uuid(),
      ${`app-package-wf-${crypto.randomUUID()}`}, 'running', 0, 'Move my board',
      'gpt-5.6-sol', 'medium', 'none', 1, 'subject', ${who.subjectId}, '{"accepted":true}'::jsonb,
      ${bindings ? tx.json(bindings as never) : null}
    ) RETURNING id`;
  });
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`UPDATE sessions SET active_turn_id = ${turn!.id},
      first_party_mcp_tools = ${tx.json(tools)} WHERE id = ${session.id}`;
    await tx`UPDATE session_turns SET active_attempt_id = ${attemptId} WHERE id = ${turn!.id}`;
    await tx`
      INSERT INTO session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) VALUES (
        ${attemptId}, ${f.accountId}, ${workspaceId}, ${session.id}, ${turn!.id}, 1,
        'running', 'app-package-wf', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });
  if (accountTools.length > 0)
    await persistAttemptToolCatalog(
      db.db,
      createAttemptToolEnvironment({
        scope: {
          accountId: f.accountId,
          workspaceId,
          sessionId: session.id,
          turnId: turn!.id,
          attemptId,
          executionGeneration: 1,
        },
        generation: 1,
        createdAt: new Date(),
        definitions: accountTools.map((tool) => ({
          identity: { serverId: tool.serverId, toolName: tool.toolName },
          modelName: `${tool.serverId}__${tool.toolName}`.replace(/[^A-Za-z0-9_]/gu, "_"),
          description: `Run ${tool.toolName}`,
          inputSchema: { type: "object", additionalProperties: true },
          source: "mcp" as const,
          approval: "none" as const,
          execute: async () => ({ content: [] }),
        })),
      }).catalog,
    );
  const grant: AccessGrant = {
    accountId: f.accountId,
    workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions: ["artifacts:read", "artifacts:publish"],
    principalKind: "agent_attempt",
    metadata: {
      sessionId: session.id,
      turnId: turn!.id,
      attemptId,
      executionGeneration: 1,
      firstPartyMcpTools: tools,
    },
  };
  const server = buildOpenGeniMcpServer(f.deps as unknown as ApiRouteDeps, grant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "app-package-test", version: "1" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (item) => item.type === "text",
    )?.text;
    let value: any = text ?? null;
    try {
      value = JSON.parse(text ?? "null");
    } catch {
      // Argument errors are plain text.
    }
    return { isError: result.isError === true, value };
  };
  return { callTool, mcp };
}
