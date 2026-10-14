/**
 * Site SQL end to end: the real API routes and agent tools against
 * PostgreSQL (as the restricted application role), calling the real Site
 * gateway Worker and its `SiteDatabase` SQLite Durable Object in workerd
 * (Miniflare) through the signed internal route.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps, ObjectStorageDependency, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createSession,
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
import { signSiteDbRequest } from "../src/site-sql/gateway";
import { siteSqlLimits, siteSqlTransport } from "../src/site-sql/service";

const SECRET = "site-sql-gateway-secret-0123456789abcdef";
const ORIGIN = "https://internal.sites.test";
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
} as Partial<Settings>;

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
  return { app, deps, settings, accountId, workspace, owner, member, publish, sql };
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

  // Named queries: one statement, parameters only; :viewer is bound by OpenGeni.
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
  expect(described.json.usage.rowsWrittenThisMonth).toBeGreaterThanOrEqual(5);
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
  expect(restored.json).toMatchObject({ imported: 2, migration: null });
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
  // Every row counts, the migration's own included; calls stop once the cap is reached.
  let accepted = 0;
  let capped = await s.run(f.member, "add", { body: "first" });
  while (capped.status === 200 && accepted < 20) {
    accepted += 1;
    capped = await s.run(f.member, "add", { body: `row ${accepted}` });
  }
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThanOrEqual(12);
  expect((await s.request(f.owner, "GET", "")).json.usage.rowsWrittenThisMonth).toBe(12);
  expect({ status: capped.status, code: code(capped) }).toEqual({
    status: 413,
    code: "quota_exceeded",
  });
  expect(capped.json.error.details.quota).toBe("rows_written_per_month");
  // Exports still work past the cap.
  expect((await s.request(f.owner, "GET", "/export?format=json")).status).toBe(200);

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

test("free, credits and unlimited profiles shape the limits", () => {
  const settings = testSettings({ sitesCreditsLimitMultiplier: 10 } as Partial<Settings>);
  const free = siteSqlLimits(settings, "free");
  expect(free).toMatchObject({
    storageBytesPerSite: 50 * 1024 * 1024,
    rowsReadPerSitePerMonth: 5_000_000,
    rowsWrittenPerSitePerMonth: 100_000,
    callsPerMinutePerViewer: 60,
    maxRowsPerCall: 1_000,
  });
  expect(siteSqlLimits(settings, "credits")).toMatchObject({
    storageBytesPerSite: 500 * 1024 * 1024,
    rowsWrittenPerSitePerMonth: 1_000_000,
    callsPerMinutePerViewer: 600,
  });
  expect(siteSqlLimits(settings, "unlimited")).toMatchObject({
    rowsReadPerSitePerMonth: null,
    rowsWrittenPerSitePerMonth: null,
    storageBytesPerSite: 5 * 1024 * 1024 * 1024,
    callsPerMinutePerViewer: 600,
  });
  expect(siteSqlLimits(settings, "custom")).toEqual(free);
});

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
  "site_sql_execute",
  "site_sql_export",
  "site_sql_import",
  "site_sql_reset",
];

test("an agent acting for the owner manages Site SQL with the tools", async () => {
  const f = await fixture();
  const siteId = await f.publish("Agent dashboard");
  const session = await createSession(db.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    initialMessage: "Build a dashboard",
    resources: [],
    tools: [],
    metadata: {},
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const [turn] = await shared.admin<{ id: string }[]>`
    INSERT INTO session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend,
      execution_generation, initiator_kind, initiator_subject_id, initiator_context
    ) VALUES (
      ${f.accountId}, ${f.workspace.id}, ${session.id}, gen_random_uuid(),
      ${`site-sql-wf-${crypto.randomUUID()}`}, 'running', 0, 'Build a dashboard',
      'gpt-5.6-sol', 'medium', 'none', 1, 'subject', ${f.owner.subjectId}, '{"accepted":true}'::jsonb
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
  const grant: AccessGrant = {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    subjectId: "worker:first-party-mcp",
    permissions: ["artifacts:read", "artifacts:publish"],
    principalKind: "agent_attempt",
    metadata: {
      sessionId: session.id,
      turnId: turn!.id,
      attemptId,
      executionGeneration: 1,
      firstPartyMcpTools: SQL_TOOLS,
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
    const inspected = await ok("site_sql_inspect", {});
    expect(inspected.database.tables[0]).toMatchObject({ name: "metrics", rowCount: 2 });
    expect(inspected.queries[0]).toMatchObject({ name: "recent", params: ["limit"] });
    const exported = await ok("site_sql_export", { format: "csv", table: "metrics" });
    expect(exported.content).toBe("day,visits\n2026-10-13,10\n2026-10-14,13\n");
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
}, 120_000);
