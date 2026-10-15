/**
 * Site SQL end to end: the real API routes and agent tools against
 * PostgreSQL (as the restricted application role), calling the real Site
 * gateway Worker and its `SiteDatabase` SQLite Durable Object in workerd
 * (Miniflare) through the signed internal route.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SITE_GATEWAY_CALLBACK_PATH, type AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps, ObjectStorageDependency, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createSession,
  createSiteViewerSession,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp, type AppDependencies } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { signSiteGatewayRequest } from "../src/site-publishing/gateway-signature";
import { signSiteDbRequest } from "../src/site-sql/gateway";
import {
  dropSiteSqlDatabases,
  siteSqlAudienceRefusal,
  siteSqlLimits,
  siteSqlSitesOfWorkspace,
  siteSqlTransport,
} from "../src/site-sql/service";

const SECRET = "site-sql-gateway-secret-0123456789abcdef";
const ORIGIN = "https://internal.sites.test";
const DOMAIN = "sites.example.test";
const GATEWAY_DIR = resolve(import.meta.dir, "../../site-gateway");

let shared: SharedTestDatabase;
let db: DbClient;
let mf: { dispatchFetch: Function; dispose(): Promise<void>; ready: Promise<unknown> } | null =
  null;
let buildDir = "";

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("site-sql");
  if (!acquired) throw new Error("Site SQL tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
  buildDir = mkdtempSync(join(tmpdir(), "site-sql-api-test-"));
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
      ENVIRONMENT: "production",
    },
    durableObjects: { SITE_DB: { className: "SiteDatabase", useSQLite: true } },
  });
  await mf!.ready;
  // The API reaches the gateway through Miniflare instead of the network.
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
const memberPermissions = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "artifacts:read",
  "artifacts:publish",
] as const;
const SQL_SETTINGS: Partial<Settings> = {
  sitesCloudflareStorageEnabled: true,
  sitesGatewayInternalOrigin: ORIGIN,
  sitesGatewaySecret: SECRET,
};

type Who = { subjectId: string; grant: AccessGrant; headers: Record<string, string> };

/** Just enough object storage to publish Sites. */
function memoryObjectStorage(): ObjectStorageDependency {
  const objects = new Map<string, Uint8Array>();
  return {
    maxSinglePutSizeBytes: 5_000_000_000,
    headObject: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { ContentLength: bytes.length, VersionToken: "v" } : null;
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
    deleteObject: async (key: string) => {
      objects.delete(key);
    },
  } as unknown as ObjectStorageDependency;
}

async function fixture(overrides: Partial<Settings> = SQL_SETTINGS) {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Site SQL fixture') returning id`;
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
      "account:admin",
    ],
  });
  const settings = testSettings({
    productAccessMode: "configured",
    sandboxBackend: "none",
    ...overrides,
  });
  const deps = {
    db: db.db,
    bus: new MemoryEventBus(),
    settings,
    objectStorage: memoryObjectStorage(),
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
    expect(added.status).toBe(200);
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
  const owner = await person(memberPermissions);
  const member = await person(memberPermissions);
  const admin = await person([...memberPermissions, "workspace:admin"]);
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'site-sql-test')`;
  await shared.admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  const base = `/v1/workspaces/${workspace.id}/published-artifacts`;
  const publish = async (title: string) => {
    const response = await app.request(base, {
      method: "POST",
      headers: owner.headers,
      body: JSON.stringify({
        title,
        html: `<!doctype html><h1>${title}</h1>`,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { artifact: { id: string } }).artifact.id;
  };
  const sql = (siteId: string) => {
    const request = async (
      who: Who,
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const response = await app.request(`${base}/${siteId}/sql${path}`, {
        method,
        headers: { ...who.headers, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: response.status, json, text, headers: response.headers };
    };
    const frame = { "x-opengeni-site-id": siteId };
    return {
      request,
      frame,
      enable: (who: Who, enabled = true) => request(who, "PUT", "/settings", { enabled }),
      migrate: (who: Who, name: string, statements: string) =>
        request(who, "POST", "/migrations", { name, sql: statements }),
      define: (who: Who, name: string, definition: Record<string, unknown>) =>
        request(who, "PUT", `/queries/${name}`, definition),
      run: (who: Who, name: string, params: Record<string, unknown> = {}, framed = true) =>
        request(who, "POST", `/queries/${name}`, { params }, framed ? frame : {}),
    };
  };
  return { app, deps, settings, accountId, workspace, owner, member, admin, base, publish, sql };
}

const code = (result: { json: any }) => result.json?.error?.details?.code;

test("Site SQL is cleanly unavailable until the deployment configures it", async () => {
  const f = await fixture({});
  const s = f.sql(await f.publish("Unconfigured"));
  const described = await s.request(f.owner, "GET", "");
  expect(described.status).toBe(200);
  expect(described.json).toMatchObject({ available: false, enabled: false, migrations: [] });
  const enabled = await s.enable(f.owner);
  expect(enabled.status).toBe(503);
  expect(code(enabled)).toBe("unavailable");
  const run = await s.run(f.member, "anything");
  expect(code(run)).toBe("unavailable");
}, 60_000);

test("owners define a schema and named queries; Site pages run them as viewers", async () => {
  const f = await fixture();
  const siteId = await f.publish("Poll");
  const s = f.sql(siteId);

  // Only managers turn it on, and never from a Site frame.
  const memberEnable = await s.enable(f.member);
  expect(memberEnable.status, memberEnable.text).toBe(403);
  // (The Site boundary refuses every framed call outside SITE_OPERATIONS first.)
  expect([403, 404]).toContain(
    (await s.request(f.owner, "PUT", "/settings", { enabled: true }, s.frame)).status,
  );
  // Nothing runs before it is on.
  expect(code(await s.migrate(f.owner, "create_votes", "CREATE TABLE votes (x)"))).toBe("disabled");
  const enabled = await s.enable(f.owner);
  expect(enabled.status, enabled.text).toBe(200);
  expect(enabled.json).toMatchObject({ available: true, enabled: true });

  const migrated = await s.migrate(
    f.owner,
    "create_votes",
    "CREATE TABLE votes (voter TEXT PRIMARY KEY, choice TEXT NOT NULL, at INTEGER);",
  );
  expect(migrated.status, migrated.text).toBe(201);
  expect(migrated.json).toMatchObject({ migration: { ordinal: 1 }, applied: ["create_votes"] });
  expect(code(await s.migrate(f.owner, "create_votes", "SELECT 1"))).toBe("conflict");
  expect(code(await s.migrate(f.owner, "attach", "ATTACH DATABASE 'x' AS y"))).toBe("validation");

  // Named queries: one statement, parameters only; :viewer is bound by Opengeni.
  for (const [name, definition] of [
    [
      "cast",
      {
        sql: "INSERT INTO votes (voter, choice) VALUES (:viewer, :choice) ON CONFLICT (voter) DO UPDATE SET choice = excluded.choice",
        audience: "signed_in",
      },
    ],
    ["tally", { sql: "SELECT choice, count(*) AS n FROM votes GROUP BY choice ORDER BY choice" }],
    ["mine", { sql: "SELECT choice FROM votes WHERE voter = :viewer" }],
    ["everything", { sql: "SELECT * FROM votes ORDER BY voter", audience: "managers" }],
  ] as const) {
    const defined = await s.define(f.owner, name, definition);
    expect({ name, status: defined.status, text: defined.text }).toMatchObject({
      name,
      status: 201,
    });
  }
  for (const refused of [
    "SELECT 1; SELECT 2",
    "ATTACH DATABASE 'x' AS y",
    "PRAGMA writable_schema = 1",
    "SELECT load_extension('x')",
    "VACUUM INTO 'x'",
    "CREATE TABLE t (x)",
    "SELECT * FROM votes WHERE voter = ?",
  ]) {
    const defined = await s.define(f.owner, "bad", { sql: refused });
    expect({ refused, status: defined.status, code: code(defined) }).toEqual({
      refused,
      status: 422,
      code: "validation",
    });
  }
  expect((await s.define(f.member, "x", { sql: "SELECT 1" })).status).toBe(403);

  // A member votes from the Site page; the owner votes too.
  const cast = await s.run(f.member, "cast", { choice: "tea" });
  expect(cast.status, cast.text).toBe(200);
  expect(cast.json.rowsWritten).toBeGreaterThan(0);
  expect((await s.run(f.owner, "cast", { choice: "coffee" })).status).toBe(200);
  expect((await s.run(f.member, "cast", { choice: "coffee" })).status).toBe(200);
  expect((await s.run(f.member, "mine")).json.rows).toEqual([{ choice: "coffee" }]);
  expect((await s.run(f.member, "tally")).json.rows).toEqual([{ choice: "coffee", n: 2 }]);

  // A page cannot impersonate anyone or pass unknown parameters.
  const spoof = await s.run(f.member, "mine", { viewer: `user:${f.owner.subjectId}` });
  expect({ status: spoof.status, code: code(spoof) }).toEqual({ status: 422, code: "validation" });
  expect(code(await s.run(f.member, "cast", { choice: "tea", extra: 1 }))).toBe("validation");
  expect(code(await s.run(f.member, "cast", {}))).toBe("validation");
  expect(code(await s.run(f.member, "missing"))).toBe("not_found");
  // Manager-only queries never run from a Site page, not even the owner's.
  expect(code(await s.run(f.owner, "everything"))).toBe("forbidden");
  expect(code(await s.run(f.member, "everything", {}, false))).toBe("forbidden");
  const everything = await s.run(f.owner, "everything", {}, false);
  expect(everything.status).toBe(200);
  expect(everything.json.rows.map((row: any) => row.voter).sort()).toEqual(
    [`user:${f.member.subjectId}`, `user:${f.owner.subjectId}`].sort(),
  );
  // Only managers use ad hoc SQL, and schema changes go through migrations.
  expect((await s.request(f.member, "POST", "/query", { sql: "SELECT 1" })).status).toBe(403);
  const adhoc = await s.request(f.owner, "POST", "/query", {
    sql: "SELECT count(*) AS n FROM votes WHERE choice = :choice",
    params: { choice: "coffee" },
  });
  expect(adhoc.json.rows).toEqual([{ n: 2 }]);
  expect(code(await s.request(f.owner, "POST", "/query", { sql: "DELETE FROM votes" }))).toBe(
    "validation",
  );
  expect(code(await s.request(f.owner, "POST", "/execute", { sql: "DROP TABLE votes" }))).toBe(
    "validation",
  );
  const pageWrites = (await s.request(f.owner, "GET", "")).json.usage.rowsWrittenThisMonth;
  expect(pageWrites).toBeGreaterThanOrEqual(3);
  const updated = await s.request(f.owner, "POST", "/execute", {
    sql: "UPDATE votes SET at = 1",
  });
  expect(updated.json).toMatchObject({ rowsWritten: 2 });

  // Usage is metered in the usage ledger and counted on the Site.
  const events = await shared.admin<Array<{ event_type: string; quantity: string }>>`
    select event_type, sum(quantity)::text as quantity from usage_events
    where workspace_id = ${f.workspace.id} and source_resource_id = ${siteId}
    group by event_type order by event_type`;
  expect(events.map((event) => event.event_type)).toEqual([
    "site_sql.rows_read",
    "site_sql.rows_written",
    "site_sql.storage_growth_bytes",
  ]);
  const described = await s.request(f.owner, "GET", "");
  // Only Site page calls count toward the monthly caps; the owner's ad hoc
  // UPDATE (like the migration) is metered as events only.
  expect(described.json.usage.rowsWrittenThisMonth).toBe(pageWrites);
  expect(described.json.usage.storageBytes).toBeGreaterThan(0);
  expect(described.json.queries.map((query: any) => [query.name, query.mode])).toEqual([
    ["cast", "write"],
    ["everything", "read"],
    ["mine", "read"],
    ["tally", "read"],
  ]);

  // Data can always leave: SQL, CSV and JSON exports, even while turned off.
  expect((await s.enable(f.owner, false)).json.enabled).toBe(false);
  expect(code(await s.run(f.member, "tally"))).toBe("disabled");
  const dump = await s.request(f.owner, "GET", "/export?format=sql");
  expect(dump.status, dump.text).toBe(200);
  expect(dump.text).toContain("CREATE TABLE votes (voter TEXT PRIMARY KEY");
  expect(dump.text).toContain('INSERT INTO "votes" ("voter", "choice", "at") VALUES (');
  const csv = await s.request(f.owner, "GET", "/export?format=csv&table=votes");
  expect(csv.text.split("\n")[0]).toBe("voter,choice,at");
  const json = await s.request(f.owner, "GET", "/export?format=json");
  expect(json.json.tables.votes.rows).toHaveLength(2);
  expect(json.json.truncated).toBe(false);
  expect((await s.request(f.member, "GET", "/export?format=sql")).status).toBe(403);

  // Reset keeps the schema (rebuilt from Postgres); the dump restores the rows.
  await s.enable(f.owner, true);
  const reset = await s.request(f.owner, "POST", "/reset", { confirm: true });
  expect(reset.json).toEqual({ applied: ["create_votes"], droppedSchema: false });
  expect((await s.run(f.member, "tally")).json.rows).toEqual([]);
  const dataOnly = dump.text
    .split("\n")
    .filter((line) => line.startsWith("INSERT"))
    .join("\n");
  const restored = await s.request(f.owner, "POST", "/import", { format: "sql", sql: dataOnly });
  // One multi-row INSERT holds both rows.
  expect(restored.json).toMatchObject({ imported: 1, migration: null, migrations: [] });
  expect((await s.run(f.member, "tally")).json.rows).toEqual([{ choice: "coffee", n: 2 }]);
  const fromCsv = await s.request(f.owner, "POST", "/import", {
    format: "csv",
    table: "votes",
    csv: 'voter,choice,at\nguest:a,"tea, green",\nguest:b,water,3\n',
  });
  expect(fromCsv.json).toMatchObject({ imported: 2 });
  const fromJson = await s.request(f.owner, "POST", "/import", {
    format: "json",
    table: "votes",
    rows: [{ voter: "guest:a", choice: "milk" }],
    onConflict: "replace",
  });
  expect(fromJson.json).toMatchObject({ imported: 1 });
  const rows = await s.request(f.owner, "POST", "/query", {
    sql: "SELECT voter, choice, at FROM votes WHERE voter LIKE 'guest:%' ORDER BY voter",
  });
  expect(rows.json.rows).toEqual([
    { voter: "guest:a", choice: "milk", at: null },
    { voter: "guest:b", choice: "water", at: 3 },
  ]);
  // A full dump (schema included) into a dropped database records its schema as a migration.
  const dropped = await s.request(f.owner, "POST", "/reset", { confirm: true, schema: "drop" });
  expect(dropped.json).toEqual({ applied: [], droppedSchema: true });
  expect((await s.request(f.owner, "GET", "")).json).toMatchObject({ migrations: [], queries: [] });
  const full = await s.request(f.owner, "POST", "/import", { format: "sql", sql: dump.text });
  expect(full.status, full.text).toBe(200);
  expect(full.json.migration).toMatch(/^import_/u);
  expect(full.json.migrations).toEqual([full.json.migration]);
  const inspected = await s.request(f.owner, "GET", "/inspect");
  expect(inspected.json.tables.map((table: any) => [table.name, table.rowCount])).toEqual([
    ["votes", 2],
  ]);
  expect(inspected.json.pendingMigrations).toEqual([]);
}, 120_000);

test("limits refuse past the monthly write cap and the storage cap", async () => {
  const f = await fixture({
    ...SQL_SETTINGS,
    sitesSqlFreeRowsWrittenPerMonth: 12,
  } as Partial<Settings>);
  const s = f.sql(await f.publish("Capped"));
  await s.enable(f.owner);
  await s.migrate(f.owner, "init", "CREATE TABLE notes (body TEXT);");
  await s.define(f.owner, "add", { sql: "INSERT INTO notes (body) VALUES (:body)" });
  // Every row a Site page writes counts (the migration does not); calls stop once the cap is reached.
  let accepted = 0;
  let capped = await s.run(f.member, "add", { body: "first" });
  while (capped.status === 200 && accepted < 20) {
    accepted += 1;
    capped = await s.run(f.member, "add", { body: `row ${accepted}` });
  }
  expect(accepted).toBe(12);
  expect((await s.request(f.owner, "GET", "")).json.usage.rowsWrittenThisMonth).toBe(12);
  expect({ status: capped.status, code: code(capped) }).toEqual({
    status: 413,
    code: "quota_exceeded",
  });
  expect(capped.json.error.details.quota).toBe("rows_written_per_month");
  // Exports and the owner's own management still work past the cap, without counting toward it.
  expect((await s.request(f.owner, "GET", "/export?format=json")).status).toBe(200);
  const managed = await s.request(f.owner, "POST", "/execute", {
    sql: "UPDATE notes SET body = upper(body)",
  });
  expect(managed.status, managed.text).toBe(200);
  expect(managed.json.rowsWritten).toBeGreaterThan(0);
  expect((await s.request(f.owner, "GET", "")).json.usage.rowsWrittenThisMonth).toBe(12);

  const g = await fixture({
    ...SQL_SETTINGS,
    sitesSqlFreeStorageBytes: 256 * 1024,
  } as Partial<Settings>);
  const t = g.sql(await g.publish("Small"));
  await t.enable(g.owner);
  expect((await t.migrate(g.owner, "init", "CREATE TABLE blobs (body TEXT);")).status).toBe(201);
  await t.define(g.owner, "add", { sql: "INSERT INTO blobs (body) VALUES (:body)" });
  // The write that would pass the cap is rolled back in the Durable Object.
  let stored = 0;
  let big = await t.run(g.member, "add", { body: "x".repeat(60_000) });
  while (big.status === 200 && stored < 10) {
    stored += 1;
    big = await t.run(g.member, "add", { body: "x".repeat(60_000) });
  }
  expect({ status: big.status, code: code(big) }, big.text).toEqual({
    status: 413,
    code: "quota_exceeded",
  });
  expect(stored).toBeGreaterThan(0);
  expect(stored).toBeLessThan(5);
  const counted = await t.request(g.owner, "POST", "/query", {
    sql: "SELECT count(*) AS n FROM blobs",
  });
  expect(counted.json.rows).toEqual([{ n: stored }]);
}, 120_000);

test("standard, credits and unlimited profiles shape the limits", () => {
  const settings = testSettings({ sitesCreditsLimitMultiplier: 10 } as Partial<Settings>);
  const standard = siteSqlLimits(settings, "standard");
  // Rows are platform usage per workspace now: no per-Site row quotas by default.
  expect(standard).toMatchObject({
    storageBytesPerSite: 5 * 1024 * 1024 * 1024,
    rowsReadPerSitePerMonth: null,
    rowsWrittenPerSitePerMonth: null,
    callsPerMinutePerViewer: 60,
    maxRowsPerCall: 1_000,
  });
  expect(siteSqlLimits(settings, "free")).toEqual(standard);
  expect(siteSqlLimits(settings, "credits")).toMatchObject({
    rowsWrittenPerSitePerMonth: null,
    callsPerMinutePerViewer: 600,
  });
  expect(siteSqlLimits(settings, "unlimited")).toMatchObject({
    rowsReadPerSitePerMonth: null,
    rowsWrittenPerSitePerMonth: null,
    storageBytesPerSite: 5 * 1024 * 1024 * 1024,
    callsPerMinutePerViewer: 600,
  });
  expect(siteSqlLimits(settings, "custom")).toEqual(standard);
  // Optional per-Site quotas still apply when configured, multiplied by credits.
  const quotas = testSettings({
    sitesCreditsLimitMultiplier: 10,
    sitesSqlFreeRowsReadPerMonth: 5_000_000,
    sitesSqlFreeRowsWrittenPerMonth: 100_000,
    sitesSqlFreeStorageBytes: 50 * 1024 * 1024,
  } as Partial<Settings>);
  expect(siteSqlLimits(quotas, "standard")).toMatchObject({
    rowsReadPerSitePerMonth: 5_000_000,
    rowsWrittenPerSitePerMonth: 100_000,
  });
  expect(siteSqlLimits(quotas, "credits")).toMatchObject({
    storageBytesPerSite: 500 * 1024 * 1024,
    rowsWrittenPerSitePerMonth: 1_000_000,
  });
});

test("published hosts run named queries as the verified viewer; guests only everyone", async () => {
  const f = await fixture({
    ...SQL_SETTINGS,
    sitesDomain: DOMAIN,
    sitesFreeGuestWritesPerMinute: 2,
  } as Partial<Settings>);
  const siteId = await f.publish("Lunch poll");
  const s = f.sql(siteId);
  expect((await s.enable(f.owner)).status).toBe(200);
  expect(
    (
      await s.migrate(
        f.owner,
        "create_votes",
        "CREATE TABLE votes (poll TEXT NOT NULL, voter TEXT NOT NULL, choice TEXT NOT NULL, PRIMARY KEY (poll, voter));",
      )
    ).status,
  ).toBe(201);
  for (const [name, definition] of [
    [
      "cast_vote",
      {
        sql: "INSERT INTO votes (poll, voter, choice) VALUES (:poll, :viewer, :choice) ON CONFLICT (poll, voter) DO UPDATE SET choice = excluded.choice",
      },
    ],
    [
      "results",
      {
        sql: "SELECT choice, count(*) AS votes FROM votes WHERE poll = :poll GROUP BY choice ORDER BY choice",
        audience: "everyone",
      },
    ],
    ["my_vote", { sql: "SELECT choice, :viewer_kind AS kind FROM votes WHERE voter = :viewer" }],
    ["everything", { sql: "SELECT * FROM votes", audience: "managers" }],
    [
      "sign_guestbook",
      {
        sql: "INSERT INTO votes (poll, voter, choice) VALUES ('guestbook', :viewer, :note) ON CONFLICT (poll, voter) DO UPDATE SET choice = excluded.choice",
        audience: "everyone",
      },
    ],
  ] as const) {
    const defined = await s.define(f.owner, name, definition);
    expect({ name, status: defined.status }).toEqual({ name, status: 201 });
  }

  const published = await f.app.request(`${f.base}/${siteId}/publication`, {
    method: "PUT",
    headers: f.owner.headers,
    body: JSON.stringify({ access: "public" }),
  });
  expect(published.status, await published.clone().text()).toBe(201);
  const host = String(((await published.json()) as { hostname: string }).hostname);

  /** A request signed as the gateway signs it. */
  const gateway = async (
    method: string,
    path: string,
    options: {
      body?: unknown;
      visitor?: string;
      session?: string;
      clientIp?: string;
      sentBody?: string;
    } = {},
  ) => {
    const pathWithQuery = `/v1/site-runtime${path}`;
    const body = options.body === undefined ? "" : JSON.stringify(options.body);
    const signed = signSiteGatewayRequest({
      secret: SECRET,
      method,
      pathWithQuery,
      host,
      body,
      ...(options.visitor ? { visitor: options.visitor } : {}),
      ...(options.session ? { session: options.session } : {}),
      clientIp: options.clientIp ?? "198.51.100.7",
    });
    // `sentBody` replaces the signed body on the wire (a tampered request).
    const sent = options.sentBody ?? body;
    const response = await f.app.request(pathWithQuery, {
      method,
      headers: { ...signed, ...(sent ? { "content-type": "application/json" } : {}) },
      ...(sent ? { body: sent } : {}),
    });
    return { status: response.status, json: (await response.json().catch(() => null)) as any };
  };
  const run = (
    name: string,
    params: Record<string, unknown>,
    who: { visitor?: string; session?: string; clientIp?: string; sentBody?: string },
  ) =>
    gateway("POST", `/published-artifacts/current/sql/queries/${name}`, {
      body: { params },
      ...who,
    });

  // A signed-in viewer: sign in on the host, then vote as themselves.
  const verifier = randomBytes(32).toString("base64url");
  const authorized = await f.app.request("/v1/site-auth/authorize", {
    method: "POST",
    headers: f.member.headers,
    body: JSON.stringify({
      host,
      state: randomBytes(16).toString("base64url"),
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
      redirectUri: `https://${host}${SITE_GATEWAY_CALLBACK_PATH}`,
    }),
  });
  expect(authorized.status, await authorized.clone().text()).toBe(200);
  const authCode = new URL(
    ((await authorized.json()) as { redirectTo: string }).redirectTo,
  ).searchParams.get("code");
  const exchanged = await gateway("POST", "/auth/exchange", {
    body: {
      code: authCode,
      codeVerifier: verifier,
      redirectUri: `https://${host}${SITE_GATEWAY_CALLBACK_PATH}`,
    },
  });
  expect(exchanged.status, JSON.stringify(exchanged.json)).toBe(200);
  const signedIn = { session: String(exchanged.json.sessionToken) };
  const guest = { visitor: randomBytes(18).toString("base64url") };

  const voted = await run("cast_vote", { poll: "lunch", choice: "tacos" }, signedIn);
  expect(voted.status, JSON.stringify(voted.json)).toBe(200);
  // SQLite counts the row and its primary-key index entry.
  expect(voted.json.rowsWritten).toBeGreaterThanOrEqual(1);
  const mine = await run("my_vote", {}, signedIn);
  expect(mine.json.rows).toEqual([{ choice: "tacos", kind: "user" }]);

  // Guests run only `everyone` queries and never supply the viewer.
  const results = await run("results", { poll: "lunch" }, guest);
  expect(results.status, JSON.stringify(results.json)).toBe(200);
  expect(results.json.rows).toEqual([{ choice: "tacos", votes: 1 }]);
  const guestVote = await run("cast_vote", { poll: "lunch", choice: "soup" }, guest);
  expect(guestVote.status).toBe(403);
  expect(guestVote.json.error.details).toMatchObject({
    code: "not_available_for_viewer",
    feature: "site_sql",
    reason: "sign_in_required",
    legacyCode: "forbidden",
  });
  const guestMine = await run("my_vote", {}, guest);
  expect(guestMine.status).toBe(403);
  const spoofed = await run("results", { poll: "lunch", viewer: "user:someone-else" }, guest);
  expect(spoofed.status).toBe(422);
  expect(spoofed.json.error.details).toMatchObject({ code: "validation", param: "viewer" });
  // Managers-only queries never run from a Site page, signed in or not.
  expect((await run("everything", {}, signedIn)).status).toBe(403);
  expect((await run("missing", {}, signedIn)).status).toBe(404);
  // Only the allowlisted operation reaches Site SQL from a Site.
  const listQueries = await gateway("GET", "/published-artifacts/current/sql", signedIn);
  expect(listQueries.status).toBe(404);

  // The stored voter is the verified principal, not anything the page sent.
  const stored = await s.request(f.owner, "POST", "/query", { sql: "SELECT voter FROM votes" });
  expect(stored.json.rows).toEqual([{ voter: `user:${f.member.subjectId}` }]);

  // Guests' write queries share the Site's guest write limit with Site Data.
  expect((await run("sign_guestbook", { note: "hi" }, guest)).status).toBe(200);
  expect((await run("sign_guestbook", { note: "hello" }, guest)).status).toBe(200);
  const flooded = await run("sign_guestbook", { note: "again" }, guest);
  expect(flooded.status, JSON.stringify(flooded.json)).toBe(429);
  expect(flooded.json.error.details).toMatchObject({ bucket: "guest_writes" });
  // Reads and signed-in writes are not guest writes.
  expect((await run("results", { poll: "lunch" }, guest)).status).toBe(200);
  expect((await run("sign_guestbook", { note: "member" }, signedIn)).status).toBe(200);
  // New visitor ids from the same client address share its guest write budget
  // (SITE_GUEST_IP_LIMIT_FACTOR times the per-visitor limit).
  let addressFlooded: Awaited<ReturnType<typeof run>> | null = null;
  for (let attempt = 0; attempt < 12 && !addressFlooded; attempt += 1) {
    const fresh = { visitor: randomBytes(18).toString("base64url") };
    const signed = await run("sign_guestbook", { note: `fresh ${attempt}` }, fresh);
    if (signed.status === 429) addressFlooded = signed;
    else expect(signed.status, JSON.stringify(signed.json)).toBe(200);
  }
  expect(addressFlooded?.json.error.details).toMatchObject({ bucket: "guest_writes" });
  // IPv6 clients count per /64: new addresses in the same /64 share one budget.
  let prefixFlooded: Awaited<ReturnType<typeof run>> | null = null;
  for (let attempt = 0; attempt < 12 && !prefixFlooded; attempt += 1) {
    const fresh = {
      visitor: randomBytes(18).toString("base64url"),
      clientIp: `2001:db8:7:1:${(attempt + 1).toString(16)}::${attempt + 2}`,
    };
    const signed = await run("sign_guestbook", { note: `v6 ${attempt}` }, fresh);
    if (signed.status === 429) prefixFlooded = signed;
    else expect(signed.status, JSON.stringify(signed.json)).toBe(200);
  }
  expect(prefixFlooded?.json.error.details).toMatchObject({ bucket: "guest_writes" });

  // sql.run goes through the gateway signature like every site-runtime call:
  // a body that is not the signed one is refused before anything runs.
  const tampered = await run(
    "results",
    { poll: "lunch" },
    {
      ...guest,
      sentBody: JSON.stringify({ params: { poll: "dinner" } }),
    },
  );
  expect(tampered.status, JSON.stringify(tampered.json)).toBe(401);
  expect(tampered.json.error.details).toMatchObject({ reason: "body_mismatch" });

  // The publication's limit profile decides the Site SQL limits.
  expect((await s.request(f.owner, "GET", "")).json.limits).toMatchObject({
    rowsReadPerSitePerMonth: null,
    storageBytesPerSite: 5 * 1024 * 1024 * 1024,
    callsPerMinutePerSite: 600,
  });
  const unlimited = await f.app.request(`${f.base}/${siteId}/publication`, {
    method: "PUT",
    headers: f.admin.headers,
    body: JSON.stringify({ limitProfile: { kind: "unlimited" } }),
  });
  expect(unlimited.status, await unlimited.clone().text()).toBe(200);
  expect((await s.request(f.owner, "GET", "")).json.limits).toMatchObject({
    rowsReadPerSitePerMonth: null,
    rowsWrittenPerSitePerMonth: null,
    callsPerMinutePerSite: 6_000,
  });
}, 120_000);

test("the gateway refuses internal calls the API did not sign", async () => {
  const body = JSON.stringify({ requestId: crypto.randomUUID() });
  const siteId = crypto.randomUUID();
  for (const secret of [SECRET, "not-the-gateway-secret-0123456789abcdef"]) {
    const signed = signSiteDbRequest({ origin: ORIGIN, secret }, siteId, "inspect", body);
    const response = (await mf!.dispatchFetch(signed.url, {
      method: "POST",
      headers: { ...signed.headers, "MF-Original-URL": signed.url },
      body,
    })) as Response;
    expect({ secret, status: response.status }).toEqual({
      secret,
      status: secret === SECRET ? 200 : 401,
    });
    await response.text();
  }
});

const SQL_TOOLS = [
  "site_sql_inspect",
  "site_sql_enable",
  "site_sql_migrate",
  "site_sql_define_query",
  "site_sql_query",
  "site_sql_run",
  "site_sql_execute",
  "site_sql_export",
  "site_sql_import",
  "site_sql_reset",
];

/**
 * An agent attempt acting for the owner with the Site SQL tools. `metadata`
 * (a Site origin), `surface` and `parentSessionId` make it an agent started
 * from a Site page.
 */
async function agentTools(
  f: Awaited<ReturnType<typeof fixture>>,
  options: {
    metadata?: Record<string, unknown>;
    surface?: string | null;
    parentSessionId?: string;
    /** Attach to this existing session (a Site agent conversation) and its first turn. */
    existingSessionId?: string;
    /** The session's first-party tool selection (SQL_TOOLS by default). */
    tools?: readonly string[];
    permissions?: AccessGrant["permissions"];
  } = {},
) {
  if (options.existingSessionId)
    return await attachAgentTools(f, options.existingSessionId, options);
  const session = await createSession(db.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    initialMessage: "Build a dashboard",
    resources: [],
    tools: [],
    metadata: options.metadata ?? {},
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const [turn] = await shared.admin<{ id: string }[]>`
    INSERT INTO session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend,
      execution_generation, initiator_kind, initiator_subject_id, initiator_context, surface
    ) VALUES (
      ${f.accountId}, ${f.workspace.id}, ${session.id}, gen_random_uuid(),
      ${`site-sql-wf-${crypto.randomUUID()}`}, 'running', 0, 'Build a dashboard',
      'gpt-5.6-sol', 'medium', 'none', 1, 'subject', ${f.owner.subjectId}, '{"accepted":true}'::jsonb,
      ${options.surface ?? null}
    ) RETURNING id`;
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
        'running', 'site-sql-wf', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });
  if (options.parentSessionId) {
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`UPDATE sessions SET parent_session_id = ${options.parentSessionId!}
        WHERE id = ${session.id}`;
    });
  }
  return await connectAgentTools(f, { id: session.id }, turn!.id, attemptId, 1, options);
}

/** An agent attempt on an existing session: its first turn runs this attempt. */
async function attachAgentTools(
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  options: { tools?: readonly string[]; permissions?: AccessGrant["permissions"] },
) {
  const [turn] = await shared.admin<{ id: string }[]>`
    select id from session_turns where session_id = ${sessionId} order by position limit 1`;
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    // Stage the queued turn as running in generation 1, as the worker would.
    await tx`set local session_replication_role = replica`;
    await tx`UPDATE session_turns SET status = 'running', execution_generation = 1
      WHERE id = ${turn!.id}`;
  });
  await shared.admin.begin(async (tx) => {
    await tx`UPDATE sessions SET active_turn_id = ${turn!.id} WHERE id = ${sessionId}`;
    await tx`UPDATE session_turns SET active_attempt_id = ${attemptId} WHERE id = ${turn!.id}`;
    await tx`
      INSERT INTO session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) VALUES (
        ${attemptId}, ${f.accountId}, ${f.workspace.id}, ${sessionId}, ${turn!.id}, 1,
        'running', 'site-sql-wf', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });
  return await connectAgentTools(f, { id: sessionId }, turn!.id, attemptId, 1, options);
}

async function connectAgentTools(
  f: Awaited<ReturnType<typeof fixture>>,
  session: { id: string },
  turnId: string,
  attemptId: string,
  executionGeneration: number,
  options: { tools?: readonly string[]; permissions?: AccessGrant["permissions"] },
) {
  const grant: AccessGrant = {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    subjectId: "worker:first-party-mcp",
    permissions: options.permissions ?? ["artifacts:read", "artifacts:publish"],
    principalKind: "agent_attempt",
    metadata: {
      sessionId: session.id,
      turnId,
      attemptId,
      executionGeneration,
      firstPartyMcpTools: options.tools ?? SQL_TOOLS,
    },
  };
  const server = buildOpenGeniMcpServer(f.deps as unknown as ApiRouteDeps, grant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "site-sql-test", version: "1" });
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
  return { session, grant, mcp, callTool };
}

test("an agent acting for the owner manages Site SQL with the tools", async () => {
  const f = await fixture();
  const siteId = await f.publish("Agent dashboard");
  const { grant, mcp, callTool } = await agentTools(f);
  try {
    expect((await mcp.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
      [...SQL_TOOLS].sort(),
    );
    const ok = async (name: string, args: Record<string, unknown>) => {
      const result = await callTool(name, { siteId, ...args });
      expect({ name, isError: result.isError, value: result.value }).toMatchObject({
        name,
        isError: false,
      });
      return result.value;
    };
    expect((await ok("site_sql_inspect", {})).database).toBeNull();
    await ok("site_sql_enable", { enabled: true });
    await ok("site_sql_migrate", {
      name: "init",
      sql: "CREATE TABLE metrics (day TEXT PRIMARY KEY, visits INTEGER NOT NULL);",
    });
    await ok("site_sql_import", {
      format: "json",
      table: "metrics",
      rows: [
        { day: "2026-10-13", visits: 10 },
        { day: "2026-10-14", visits: 12 },
      ],
    });
    await ok("site_sql_execute", {
      sql: "UPDATE metrics SET visits = visits + :n WHERE day = :day",
      params: { n: 1, day: "2026-10-14" },
    });
    expect(
      (await ok("site_sql_query", { sql: "SELECT sum(visits) AS total FROM metrics" })).rows,
    ).toEqual([{ total: 23 }]);
    await ok("site_sql_define_query", {
      name: "recent",
      sql: "SELECT day, visits FROM metrics ORDER BY day DESC LIMIT :limit",
      audience: "everyone",
    });
    // The agent runs a named query as a page would.
    expect((await ok("site_sql_run", { name: "recent", params: { limit: 1 } })).rows).toEqual([
      { day: "2026-10-14", visits: 13 },
    ]);
    const inspected = await ok("site_sql_inspect", {});
    expect(inspected.database.tables[0]).toMatchObject({ name: "metrics", rowCount: 2 });
    expect(inspected.queries[0]).toMatchObject({ name: "recent", params: ["limit"] });
    const exported = await ok("site_sql_export", { format: "csv", table: "metrics" });
    expect(exported.content).toBe("day,visits\n2026-10-13,10\n2026-10-14,13\n");
    expect(exported.nextCursor).toBeNull();
    // Small pieces through the tool, continued with the cursor.
    const firstPiece = await ok("site_sql_export", {
      format: "csv",
      table: "metrics",
      maxBytes: 1024,
    });
    expect(firstPiece.content.startsWith("day,visits\n")).toBe(true);
    const refused = await callTool("site_sql_execute", { siteId, sql: "DROP TABLE metrics" });
    expect(refused.isError).toBe(true);
    expect(refused.value.error.code).toBe("validation");
    expect((await ok("site_sql_reset", { confirm: true })).applied).toEqual(["init"]);
    // The page's query runs for a member through the same service.
    const page = await f.sql(siteId).run(f.member, "recent", { limit: 5 });
    expect(page.json.rows).toEqual([]);
  } finally {
    await mcp.close();
  }
  // Without a configured gateway the tools are not offered at all.
  const bare = buildOpenGeniMcpServer(
    {
      ...(f.deps as unknown as ApiRouteDeps),
      settings: { ...f.settings, sitesGatewayInternalOrigin: undefined },
    } as unknown as ApiRouteDeps,
    grant,
  );
  expect(
    Object.keys(
      (bare as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    ).filter((name) => name.startsWith("site_sql_")),
  ).toEqual([]);
}, 120_000);

test("agents started from a Site page run only the queries the page could", async () => {
  const f = await fixture();
  const siteId = await f.publish("Notes");
  const otherId = await f.publish("Other notes");
  for (const id of [siteId, otherId]) {
    const s = f.sql(id);
    expect((await s.enable(f.owner)).status).toBe(200);
    expect(
      (await s.migrate(f.owner, "init", "CREATE TABLE notes (who TEXT NOT NULL, note TEXT);"))
        .status,
    ).toBe(201);
    for (const [name, definition] of [
      [
        "add",
        { sql: "INSERT INTO notes (who, note) VALUES (:viewer, :note)", audience: "signed_in" },
      ],
      ["mine", { sql: "SELECT note FROM notes WHERE who = :viewer ORDER BY rowid" }],
      ["everything", { sql: "SELECT who, note FROM notes ORDER BY rowid", audience: "managers" }],
    ] as const)
      expect((await s.define(f.owner, name, definition)).status).toBe(201);
  }
  const s = f.sql(siteId);
  expect((await s.run(f.member, "add", { note: "member" })).status).toBe(200);
  const origin = { _opengeniSiteOrigin: { siteId, title: "Notes" } };

  const checkClamped = async (agent: Awaited<ReturnType<typeof agentTools>>, note: string) => {
    // Every management tool refuses an agent started from the page.
    for (const [tool, args] of [
      ["site_sql_inspect", {}],
      ["site_sql_enable", { enabled: false }],
      ["site_sql_migrate", { name: "more", sql: "CREATE TABLE more (a);" }],
      ["site_sql_define_query", { name: "x", sql: "SELECT 1 AS one" }],
      ["site_sql_query", { sql: "SELECT * FROM notes" }],
      ["site_sql_execute", { sql: "DELETE FROM notes" }],
      ["site_sql_export", { format: "json" }],
      ["site_sql_import", { format: "json", table: "notes", rows: [{ who: "x", note: "y" }] }],
      ["site_sql_reset", { confirm: true }],
    ] as const) {
      const refused = await agent.callTool(tool, { siteId, ...args });
      expect({ tool, isError: refused.isError, code: refused.value?.error?.code }).toEqual({
        tool,
        isError: true,
        code: "forbidden",
      });
    }
    // Named queries run with the page's reach: :viewer is the agent's person.
    const added = await agent.callTool("site_sql_run", {
      siteId,
      name: "add",
      params: { note },
    });
    expect(added.isError, JSON.stringify(added.value)).toBe(false);
    expect(added.value.rowsWritten).toBe(1);
    const mine = await agent.callTool("site_sql_run", { siteId, name: "mine" });
    expect(mine.isError, JSON.stringify(mine.value)).toBe(false);
    expect(mine.value.rows.map((row: { note: string }) => row.note)).toContain(note);
    expect(mine.value.rows.map((row: { note: string }) => row.note)).not.toContain("member");
    // Managers-only queries stay out of reach, as on the page.
    const everything = await agent.callTool("site_sql_run", { siteId, name: "everything" });
    expect(everything.isError).toBe(true);
    expect(everything.value.error.code).toBe("forbidden");
    // Another Site is out of reach.
    const elsewhere = await agent.callTool("site_sql_run", { siteId: otherId, name: "mine" });
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.value.error.code).toBe("forbidden");
  };

  // A session the page created.
  const fromPage = await agentTools(f, { metadata: origin });
  try {
    await checkClamped(fromPage, "from the page");
  } finally {
    await fromPage.mcp.close();
  }
  // A worker spawned by that session inherits the clamp through its lineage.
  const worker = await agentTools(f, { parentSessionId: fromPage.session.id });
  try {
    await checkClamped(worker, "from a worker");
  } finally {
    await worker.mcp.close();
  }
  // A message the page sent into a session without a Site origin reaches no Site SQL.
  const sent = await agentTools(f, { surface: "site" });
  try {
    const refused = await sent.callTool("site_sql_run", { siteId, name: "mine" });
    expect(refused.isError).toBe(true);
    expect(refused.value.error.code).toBe("forbidden");
  } finally {
    await sent.mcp.close();
  }
  // The same owner's agent outside any Site keeps manager reach.
  const plain = await agentTools(f);
  try {
    const everything = await plain.callTool("site_sql_run", { siteId, name: "everything" });
    expect(everything.isError, JSON.stringify(everything.value)).toBe(false);
    expect(everything.value.rows.map((row: { note: string }) => row.note)).toEqual([
      "member",
      "from the page",
      "from a worker",
    ]);
  } finally {
    await plain.mcp.close();
  }
}, 120_000);

test("a Site's own agent gets the Site's data tools, pinned to the Site and acting as the viewer", async () => {
  const f = await fixture({
    ...SQL_SETTINGS,
    sitesDomain: DOMAIN,
    delegationSecret: randomBytes(32).toString("hex"),
    sessionUsageLimitsEnabled: true,
  } as Partial<Settings>);
  const siteId = await f.publish("Team notes");
  const otherId = await f.publish("Other team notes");
  for (const id of [siteId, otherId]) {
    const s = f.sql(id);
    expect((await s.enable(f.owner)).status).toBe(200);
    expect(
      (await s.migrate(f.owner, "init", "CREATE TABLE notes (who TEXT NOT NULL, note TEXT);"))
        .status,
    ).toBe(201);
    for (const [name, definition] of [
      [
        "add",
        { sql: "INSERT INTO notes (who, note) VALUES (:viewer, :note)", audience: "signed_in" },
      ],
      ["mine", { sql: "SELECT note FROM notes WHERE who = :viewer ORDER BY rowid" }],
      ["board", { sql: "SELECT note FROM notes ORDER BY rowid", audience: "everyone" }],
      ["everything", { sql: "SELECT who, note FROM notes ORDER BY rowid", audience: "managers" }],
    ] as const)
      expect((await s.define(f.owner, name, definition)).status).toBe(201);
  }
  // A per-viewer collection guests may add to and read their own records of.
  const defined = await f.app.request(`${f.base}/${siteId}/data/collections/wishes`, {
    method: "PUT",
    headers: f.owner.headers,
    body: JSON.stringify({ accessMode: "per_viewer", guestAccess: "own" }),
  });
  expect(defined.status, await defined.clone().text()).toBeLessThan(300);

  const invitedEmail = "invited@example.com";
  const published = await f.app.request(`${f.base}/${siteId}/publication`, {
    method: "PUT",
    headers: f.admin.headers,
    body: JSON.stringify({
      access: "public",
      invitedEmails: [invitedEmail],
      agent: { enabled: true },
    }),
  });
  expect(published.status, await published.clone().text()).toBe(201);
  const host = String(((await published.json()) as { hostname: string }).hostname);
  const gateway = async (
    method: string,
    path: string,
    who: { visitor?: string; session?: string },
    body?: unknown,
  ) => {
    const pathWithQuery = `/v1/site-runtime${path}`;
    const text = body === undefined ? "" : JSON.stringify(body);
    const signed = signSiteGatewayRequest({
      secret: SECRET,
      method,
      pathWithQuery,
      host,
      body: text,
      ...who,
      clientIp: "198.51.100.9",
    });
    const response = await f.app.request(pathWithQuery, {
      method,
      headers: { ...signed, ...(text ? { "content-type": "application/json" } : {}) },
      ...(text ? { body: text } : {}),
    });
    return { status: response.status, json: (await response.json().catch(() => null)) as any };
  };
  // A workspace member signs in on the Site.
  const verifier = randomBytes(32).toString("base64url");
  const authorized = await f.app.request("/v1/site-auth/authorize", {
    method: "POST",
    headers: f.member.headers,
    body: JSON.stringify({
      host,
      state: randomBytes(16).toString("base64url"),
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
      redirectUri: `https://${host}${SITE_GATEWAY_CALLBACK_PATH}`,
    }),
  });
  expect(authorized.status, await authorized.clone().text()).toBe(200);
  const exchanged = await gateway(
    "POST",
    "/auth/exchange",
    {},
    {
      code: new URL(
        ((await authorized.json()) as { redirectTo: string }).redirectTo,
      ).searchParams.get("code"),
      codeVerifier: verifier,
      redirectUri: `https://${host}${SITE_GATEWAY_CALLBACK_PATH}`,
    },
  );
  expect(exchanged.status, JSON.stringify(exchanged.json)).toBe(200);
  // An invited person from outside the workspace.
  const invitedSubject = `site-invited-${crypto.randomUUID()}`;
  const invitedToken = randomBytes(32).toString("base64url");
  await createSiteViewerSession(
    db.db,
    { accountId: f.accountId, workspaceId: f.workspace.id },
    {
      siteId,
      tokenHash: createHash("sha256").update(invitedToken).digest("hex"),
      subjectId: invitedSubject,
      kind: "invited",
      email: invitedEmail,
      displayName: "Invited",
      absoluteSeconds: 3_600,
    },
  );
  const guestVisitor = randomBytes(18).toString("base64url");
  const viewers = {
    member: {
      who: { session: String(exchanged.json.sessionToken) },
      principal: `user:${f.member.subjectId}`,
      tools: ["site_data_query", "site_data_write", "site_sql_query", "site_sql_run"],
    },
    invited: {
      who: { session: invitedToken },
      principal: `user:${invitedSubject}`,
      tools: ["site_data_query", "site_data_write", "site_sql_run"],
    },
    guest: {
      who: { visitor: guestVisitor },
      principal: `guest:${guestVisitor}`,
      tools: ["site_data_query", "site_data_write", "site_sql_run"],
    },
  };
  const MANAGEMENT: [string, Record<string, unknown>][] = [
    ["site_sql_inspect", {}],
    ["site_sql_enable", { enabled: false }],
    ["site_sql_migrate", { name: "more", sql: "CREATE TABLE more (a);" }],
    ["site_sql_define_query", { name: "x", sql: "SELECT 1 AS one" }],
    ["site_sql_execute", { sql: "DELETE FROM notes" }],
    ["site_sql_export", { format: "json" }],
    ["site_sql_reset", { confirm: true }],
    ["site_data_describe", {}],
    ["site_data_define_collection", { name: "x", accessMode: "shared" }],
    ["site_data_export", { collection: "wishes" }],
    ["site_data_reset", { collection: "wishes", confirm: true }],
    ["site_files_list", {}],
  ];
  for (const [kind, viewer] of Object.entries(viewers)) {
    const created = await gateway("POST", "/sessions", viewer.who, { initialMessage: "Hello" });
    expect({ kind, status: created.status, body: created.json }).toMatchObject({
      kind,
      status: 202,
    });
    const sessionId = String(created.json.id);
    const [row] = await shared.admin`select first_party_mcp_tools, first_party_mcp_permissions,
        sandbox_backend from sessions where id = ${sessionId}`;
    // Exactly the Site's own data tools for this viewer, and no sandbox.
    expect({ kind, tools: [...row!.first_party_mcp_tools].sort() }).toEqual({
      kind,
      tools: viewer.tools,
    });
    expect(row!.sandbox_backend).toBe("none");
    expect([...(row!.first_party_mcp_permissions ?? [])].sort()).toEqual([
      "artifacts:publish",
      "artifacts:read",
    ]);

    // The agent's tools, as the worker would hold them; management tools are
    // also listed here to prove the server refuses them for a Site agent.
    const agent = await agentTools(f, {
      existingSessionId: sessionId,
      tools: [
        ...SQL_TOOLS,
        ...MANAGEMENT.map(([tool]) => tool),
        "site_data_query",
        "site_data_write",
      ],
    });
    try {
      const ok = async (tool: string, args: Record<string, unknown>) => {
        const result = await agent.callTool(tool, { siteId, ...args });
        expect({ kind, tool, isError: result.isError, value: result.value }).toMatchObject({
          kind,
          tool,
          isError: false,
        });
        return result.value;
      };
      const refused = async (tool: string, args: Record<string, unknown>, site = siteId) => {
        const result = await agent.callTool(tool, { siteId: site, ...args });
        expect({ kind, tool, isError: result.isError }).toEqual({ kind, tool, isError: true });
        return result.value?.error;
      };
      // Named queries run as the viewer: :viewer is the conversation's viewer.
      if (kind === "guest") {
        const signInFirst = await refused("site_sql_run", { name: "add", params: { note: "x" } });
        expect(signInFirst).toMatchObject({ code: "forbidden" });
        expect(JSON.stringify(signInFirst)).toContain("sign_in_required");
      } else {
        await ok("site_sql_run", { name: "add", params: { note: `from ${kind}` } });
        expect((await ok("site_sql_run", { name: "mine" })).rows).toEqual([
          { note: `from ${kind}` },
        ]);
      }
      expect((await ok("site_sql_run", { name: "board" })).rows.length).toBeGreaterThan(0);
      expect(await refused("site_sql_run", { name: "everything" })).toMatchObject({
        code: "forbidden",
      });
      // Members also read the database with SQL; nobody writes with it.
      if (kind === "member") {
        expect(
          (await ok("site_sql_query", { sql: "SELECT count(*) AS n FROM notes" })).rows,
        ).toEqual([{ n: 1 }]);
        expect(await refused("site_sql_query", { sql: "DELETE FROM notes" })).toMatchObject({
          code: "validation",
        });
      } else {
        expect(await refused("site_sql_query", { sql: "SELECT 1 AS one" })).toMatchObject({
          code: "forbidden",
        });
      }
      // Site Data under the viewer's own access rules: records belong to the viewer.
      await ok("site_data_write", {
        operations: [{ op: "insert", collection: "wishes", data: { wish: kind } }],
      });
      const wishes = await ok("site_data_query", { collection: "wishes" });
      expect(wishes.records.map((record: { owner: string }) => record.owner)).toEqual([
        viewer.principal,
      ]);
      // Never another Site, never management.
      for (const tool of ["site_sql_run", "site_data_query"])
        expect(
          await refused(
            tool,
            tool === "site_sql_run" ? { name: "board" } : { collection: "wishes" },
            otherId,
          ),
        ).toMatchObject({ code: "forbidden" });
      for (const [tool, args] of MANAGEMENT)
        expect({ tool, error: await refused(tool, args) }).toMatchObject({
          tool,
          error: { code: "forbidden" },
        });
    } finally {
      await agent.mcp.close();
    }
  }
  // The members' and invited person's notes carry their own principals.
  const stored = await f.sql(siteId).request(f.owner, "POST", "/query", {
    sql: "SELECT who FROM notes ORDER BY rowid",
  });
  expect(stored.json.rows).toEqual([
    { who: viewers.member.principal },
    { who: viewers.invited.principal },
  ]);
  // An ordinary agent of the owner is unaffected: manager reach on any Site.
  const plain = await agentTools(f);
  try {
    const everything = await plain.callTool("site_sql_run", { siteId, name: "everything" });
    expect(everything.isError, JSON.stringify(everything.value)).toBe(false);
  } finally {
    await plain.mcp.close();
  }
}, 180_000);

/** Calls the API makes to the gateway while `fn` runs: the operation and its JSON body. */
async function gatewayCalls(fn: () => Promise<unknown>) {
  const original = siteSqlTransport.fetch;
  const calls: Array<{ operation: string; body: any }> = [];
  siteSqlTransport.fetch = async (input, init) => {
    calls.push({
      operation: new URL(String(input)).pathname.split("/").at(-1) ?? "",
      body: JSON.parse(String(init.body)),
    });
    return original(input, init);
  };
  try {
    await fn();
  } finally {
    siteSqlTransport.fetch = original;
  }
  return calls;
}

test("with the flag off, export, inspect and dropping data still work", async () => {
  const f = await fixture();
  const s = f.sql(await f.publish("Flag off"));
  await s.enable(f.owner);
  await s.migrate(f.owner, "init", "CREATE TABLE notes (body TEXT);");
  await s.define(f.owner, "add", {
    sql: "INSERT INTO notes (body) VALUES (:body)",
    audience: "everyone",
  });
  expect((await s.run(f.member, "add", { body: "kept" })).status).toBe(200);

  (f.settings as { sitesCloudflareStorageEnabled: boolean }).sitesCloudflareStorageEnabled = false;
  try {
    expect((await s.request(f.owner, "GET", "")).json).toMatchObject({
      available: false,
      enabled: true,
    });
    expect(code(await s.run(f.member, "add", { body: "refused" }))).toBe("unavailable");
    expect(code(await s.migrate(f.owner, "more", "CREATE TABLE more (x);"))).toBe("unavailable");
    expect(code(await s.enable(f.owner))).toBe("unavailable");
    expect(code(await s.request(f.owner, "POST", "/reset", { confirm: true }))).toBe("unavailable");
    const exported = await s.request(f.owner, "GET", "/export?format=json");
    expect(exported.status, exported.text).toBe(200);
    expect(exported.json.tables.notes.rows).toEqual([{ body: "kept" }]);
    const inspected = await s.request(f.owner, "GET", "/inspect");
    expect(inspected.status, inspected.text).toBe(200);
    expect(inspected.json.tables.map((table: any) => [table.name, table.rowCount])).toEqual([
      ["notes", 1],
    ]);
    const dropped = await s.request(f.owner, "POST", "/reset", { confirm: true, schema: "drop" });
    expect(dropped.status, dropped.text).toBe(200);
    expect((await s.request(f.owner, "GET", "/inspect")).json.tables).toEqual([]);
  } finally {
    (f.settings as { sitesCloudflareStorageEnabled: boolean }).sitesCloudflareStorageEnabled = true;
  }
}, 120_000);

test("a rebuild that fails part way says so and a second reset finishes it", async () => {
  const f = await fixture();
  const s = f.sql(await f.publish("Half built"));
  await s.enable(f.owner);
  await s.migrate(f.owner, "init", "CREATE TABLE notes (body TEXT);");
  const original = siteSqlTransport.fetch;
  siteSqlTransport.fetch = async (input, init) => {
    if (String(input).endsWith("/migrate")) throw new TypeError("connection reset");
    return original(input, init);
  };
  try {
    const failed = await s.request(f.owner, "POST", "/reset", { confirm: true });
    expect(failed.status, failed.text).toBe(503);
    expect(failed.json.error.details).toMatchObject({ code: "unavailable", partialRebuild: true });
    expect(failed.json.error.message).toContain("run the reset again");
  } finally {
    siteSqlTransport.fetch = original;
  }
  const again = await s.request(f.owner, "POST", "/reset", { confirm: true });
  expect(again.json).toEqual({ applied: ["init"], droppedSchema: false });
}, 120_000);

test("large exports come in pieces that re-import as one dump, triggers last", async () => {
  const f = await fixture();
  const s = f.sql(await f.publish("Pieces"));
  await s.enable(f.owner);
  const migrated = await s.migrate(
    f.owner,
    "init",
    `CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT);
     CREATE TABLE audit (item INTEGER);
     CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN INSERT INTO audit (item) VALUES (NEW.id); END;`,
  );
  expect(migrated.status, migrated.text).toBe(201);
  const rows = Array.from({ length: 3_000 }, (_, index) => ({
    id: index + 1,
    body: `item ${index + 1} ${"x".repeat(150)}`,
  }));
  const loaded = await s.request(f.owner, "POST", "/import", {
    format: "json",
    table: "items",
    rows,
  });
  expect(loaded.json).toMatchObject({ imported: 3_000 });

  // A later migration sends only what the database is missing.
  const calls = await gatewayCalls(async () => {
    const second = await s.migrate(f.owner, "second", "CREATE INDEX items_body ON items (body);");
    expect(second.status, second.text).toBe(201);
  });
  const migrateCalls = calls.filter((call) => call.operation === "migrate");
  expect(migrateCalls).toHaveLength(1);
  expect(
    migrateCalls[0]!.body.migrations.map((entry: any) => [entry.name, entry.position]),
  ).toEqual([["second", 2]]);

  const pieces: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const piece = await s.request(f.owner, "GET", `/export?format=sql&maxBytes=100000${query}`);
    expect(piece.status, piece.text).toBe(200);
    pieces.push(piece.text);
    cursor = piece.headers.get("X-OpenGeni-Export-Next-Cursor");
    expect(piece.headers.get("X-OpenGeni-Export-Truncated")).toBe(cursor ? "true" : "false");
  } while (cursor && pieces.length < 100);
  expect(pieces.length).toBeGreaterThan(2);
  expect(pieces.filter((piece) => piece.includes("-- Schema"))).toHaveLength(1);
  expect(pieces[0]).toContain("CREATE TABLE items");
  expect(pieces.filter((piece) => piece.includes("CREATE TRIGGER"))).toHaveLength(1);
  expect(pieces.at(-1)).toContain("CREATE TRIGGER items_audit");

  // CSV pieces carry the header once.
  const csvFirst = await s.request(f.owner, "GET", "/export?format=csv&table=items&maxBytes=4096");
  const csvCursor = csvFirst.headers.get("X-OpenGeni-Export-Next-Cursor");
  expect(csvFirst.text.startsWith("id,body\n")).toBe(true);
  expect(csvCursor).toBeTruthy();
  const csvNext = await s.request(
    f.owner,
    "GET",
    `/export?format=csv&table=items&maxBytes=4096&cursor=${encodeURIComponent(csvCursor!)}`,
  );
  expect(csvNext.text.startsWith("id,body")).toBe(false);
  expect(csvNext.text.length).toBeGreaterThan(0);

  // The pieces, imported in order into a dropped database, restore it; the
  // trigger is applied after the data, so it did not fire on imported rows.
  await s.request(f.owner, "POST", "/reset", { confirm: true, schema: "drop" });
  const recorded: string[] = [];
  for (const piece of pieces) {
    const imported = await s.request(f.owner, "POST", "/import", { format: "sql", sql: piece });
    expect(imported.status, imported.text.slice(0, 500)).toBe(200);
    recorded.push(...imported.json.migrations);
  }
  expect(recorded).toHaveLength(2);
  expect(recorded[0]).toMatch(/^import_[0-9]+_[0-9a-f]{4}$/u);
  expect(recorded[1]).toMatch(/^import_[0-9]+_[0-9a-f]{4}_triggers$/u);
  const count = async (table: string) =>
    (await s.request(f.owner, "POST", "/query", { sql: `SELECT count(*) AS n FROM ${table}` })).json
      .rows[0].n;
  expect(await count("items")).toBe(3_000);
  expect(await count("audit")).toBe(3_000);
  await s.request(f.owner, "POST", "/execute", {
    sql: "INSERT INTO items (id, body) VALUES (5000, 'new')",
  });
  expect(await count("audit")).toBe(3_001);
}, 180_000);

test("rebuilds send migrations in bounded calls and a Site's migration SQL is capped", async () => {
  const f = await fixture();
  const s = f.sql(await f.publish("Big migrations"));
  await s.enable(f.owner);
  // About 1.9 MB of SQL each, in statements under the Durable Object's 100 KB limit.
  const big = Array.from({ length: 20 }, () => `SELECT '${"x".repeat(95_000)}';`).join("\n");
  for (const name of ["big_1", "big_2", "big_3"]) {
    const migrated = await s.migrate(f.owner, name, big);
    expect(migrated.status, migrated.text.slice(0, 500)).toBe(201);
  }
  const capped = await s.migrate(f.owner, "big_4", big);
  expect({ status: capped.status, code: code(capped) }).toEqual({
    status: 413,
    code: "quota_exceeded",
  });
  expect(capped.json.error.details.quota).toBe("migration_bytes_per_site");

  let reset: any = null;
  const calls = await gatewayCalls(async () => {
    reset = await s.request(f.owner, "POST", "/reset", { confirm: true });
  });
  expect(reset.status, reset.text?.slice(0, 500)).toBe(200);
  expect(reset.json.applied).toEqual(["big_1", "big_2", "big_3"]);
  const migrateCalls = calls.filter((call) => call.operation === "migrate");
  expect(migrateCalls.length).toBeGreaterThan(1);
  expect(migrateCalls.map((call) => call.body.rebuild === true)).toEqual([
    true,
    ...migrateCalls.slice(1).map(() => false),
  ]);
  for (const call of migrateCalls)
    expect(JSON.stringify(call.body).length).toBeLessThan(8 * 1024 * 1024);
}, 180_000);

test("signed_in needs a person; managers run everything; guests only everyone", () => {
  const refuse = (
    audience: "everyone" | "signed_in" | "managers",
    caller: { manager: boolean; guest: boolean; person: boolean },
  ) =>
    siteSqlAudienceRefusal(audience, caller)?.details.reason ??
    siteSqlAudienceRefusal(audience, caller)?.code ??
    null;
  const manager = { manager: true, guest: false, person: false };
  const person = { manager: false, guest: false, person: true };
  const service = { manager: false, guest: false, person: false };
  const guest = { manager: false, guest: true, person: false };
  expect(
    [manager, person, service, guest].map((caller) => [
      refuse("everyone", caller),
      refuse("signed_in", caller),
      refuse("managers", caller),
    ]),
  ).toEqual([
    [null, null, null],
    [null, null, "forbidden"],
    [null, "sign_in_required", "forbidden"],
    [null, "sign_in_required", "forbidden"],
  ]);
});

test("a deleted workspace's Site databases are dropped from their Durable Objects", async () => {
  const f = await fixture();
  const siteId = await f.publish("Doomed");
  const s = f.sql(siteId);
  await s.enable(f.owner);
  await s.migrate(f.owner, "init", "CREATE TABLE notes (body TEXT);");
  await s.request(f.owner, "POST", "/execute", { sql: "INSERT INTO notes (body) VALUES ('x')" });
  const scope = { accountId: f.accountId, workspaceId: f.workspace.id };
  const sites = await siteSqlSitesOfWorkspace(f.deps as unknown as ApiRouteDeps, scope);
  expect(sites).toEqual([siteId]);
  // Nothing to list or drop without a configured gateway.
  expect(
    await siteSqlSitesOfWorkspace(
      { db: db.db, settings: { ...f.settings, sitesGatewaySecret: undefined } },
      scope,
    ),
  ).toEqual([]);
  // A gateway that refuses the call leaves the database and reports it.
  const refused = await dropSiteSqlDatabases(
    { settings: { ...f.settings, sitesGatewaySecret: "x".repeat(48) } },
    sites,
    { workspaceId: f.workspace.id },
  );
  expect(refused).toEqual({ dropped: [], failed: [siteId], skipped: [] });
  expect((await s.request(f.owner, "GET", "/inspect")).json.tables).toHaveLength(1);
  const other = crypto.randomUUID();
  const dropped = await dropSiteSqlDatabases({ settings: f.settings }, [...sites, other]);
  expect(dropped.dropped.toSorted()).toEqual([siteId, other].toSorted());
  expect(dropped.failed).toEqual([]);
  expect((await s.request(f.owner, "GET", "/inspect")).json.tables).toEqual([]);
}, 120_000);
