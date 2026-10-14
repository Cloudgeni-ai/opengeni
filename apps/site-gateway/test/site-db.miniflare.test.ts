/**
 * Integration: the built Worker with the `SiteDatabase` SQLite Durable
 * Object runs in workerd (Miniflare). Requests to the internal Site database
 * route are signed here independently (node:crypto) the way the API signs
 * them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_TIMESTAMP_HEADER,
  SITE_GATEWAY_VISITOR_HEADER,
  siteDbInternalPath,
  siteGatewayCanonicalString,
  type SiteDbExportResponse,
  type SiteDbInspectResponse,
  type SiteDbOperation,
  type SiteDbRunResponse,
} from "@opengeni/contracts";
import { Miniflare } from "miniflare";
import { TEST_SECRET } from "./helpers";

const PREVIOUS_SECRET = "previous-gateway-secret-0123456789abcdefgh";
const ORIGIN = "https://internal.sites.test";
const SITE = "33333333-3333-4333-8333-333333333333";
const OTHER_SITE = "44444444-4444-4444-8444-444444444444";
const MAX_DB = 50 * 1024 * 1024;

let mf: Miniflare | null = null;

type Signed = {
  secret?: string;
  timestamp?: number;
  headers?: Record<string, string>;
  method?: string;
  tamper?: boolean;
  requestId?: string;
  instance?: Miniflare;
};

async function call(
  siteId: string,
  operation: SiteDbOperation | string,
  payload: Record<string, unknown>,
  options: Signed = {},
) {
  const path = `/_og/internal/site-db/${siteId}/${operation}`;
  const body = JSON.stringify({ requestId: options.requestId ?? crypto.randomUUID(), ...payload });
  const method = options.method ?? "POST";
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const canonical = siteGatewayCanonicalString({
    method,
    pathWithQuery: path,
    timestamp,
    bodySha256: createHash("sha256")
      .update(method === "POST" ? body : "")
      .digest("hex"),
    host: new URL(ORIGIN).host,
    session: "",
    visitor: "",
    clientIp: "",
    human: "",
  });
  const signature = `v1=${createHmac("sha256", options.secret ?? TEST_SECRET)
    .update(canonical)
    .digest("base64url")}`;
  const url = `${ORIGIN}${path}`;
  return await (options.instance ?? mf!).dispatchFetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      [SITE_GATEWAY_TIMESTAMP_HEADER]: String(timestamp),
      [SITE_GATEWAY_SIGNATURE_HEADER]: options.tamper ? `${signature.slice(0, -2)}AA` : signature,
      ...options.headers,
      "MF-Original-URL": url,
    },
    ...(method === "POST" ? { body } : {}),
  });
}

async function ok<T>(response: { status: number; json(): Promise<unknown> }): Promise<T> {
  const value = await response.json();
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value as T;
}

async function failure(response: { status: number; json(): Promise<unknown> }) {
  const value = (await response.json()) as { error: { code: string; message: string } };
  return { status: response.status, code: value.error.code, message: value.error.message };
}

function run(siteId: string, sql: string, params: Record<string, unknown> = {}, extra = {}) {
  return call(siteId, "run", {
    sql,
    profile: "named",
    params,
    maxRows: 100,
    maxResponseBytes: 1024 * 1024,
    maxDatabaseBytes: MAX_DB,
    ...extra,
  });
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function migration(name: string, sql: string, position?: number) {
  return { name, sql, checksum: checksum(sql), ...(position === undefined ? {} : { position }) };
}

const MIGRATIONS = [
  migration(
    "create_votes",
    "CREATE TABLE votes (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, choice TEXT NOT NULL, UNIQUE(owner)); CREATE INDEX votes_choice ON votes (choice);",
  ),
  migration("create_notes", "CREATE TABLE notes (k TEXT PRIMARY KEY, body BLOB) WITHOUT ROWID;"),
];

async function startWorker(
  bindings: Record<string, string> = {},
  options: { siteDb?: boolean } = {},
): Promise<Miniflare> {
  const buildDir = mkdtempSync(join(tmpdir(), "site-gateway-db-test-"));
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../src/index.ts")],
      outdir: buildDir,
      target: "browser",
      format: "esm",
      naming: "worker.js",
    });
    if (!build.success) throw new AggregateError(build.logs, "Worker build failed");
    const instance = new Miniflare({
      modules: true,
      scriptPath: join(buildDir, "worker.js"),
      modulesRoot: buildDir,
      compatibilityDate: "2026-07-01",
      bindings: {
        SITES_DOMAIN: "sites.test",
        API_ORIGIN: "http://127.0.0.1:18786",
        APP_ORIGIN: "https://app.test",
        GATEWAY_SECRET: TEST_SECRET,
        GATEWAY_SECRET_PREVIOUS: PREVIOUS_SECRET,
        ENVIRONMENT: "production",
        ...bindings,
      },
      ...(options.siteDb === false
        ? {}
        : { durableObjects: { SITE_DB: { className: "SiteDatabase", useSQLite: true } } }),
    });
    await instance.ready;
    return instance;
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  mf = await startWorker();
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  mf = null;
});

describe("internal Site database route", () => {
  test("accepts only signed POSTs from the API, current or previous secret", async () => {
    const inspect = (options: Signed) => call(SITE, "inspect", {}, options);
    expect((await inspect({})).status).toBe(200);
    expect((await inspect({ secret: PREVIOUS_SECRET })).status).toBe(200);
    expect(await failure(await inspect({ secret: `${TEST_SECRET}x` }))).toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    expect((await inspect({ tamper: true })).status).toBe(401);
    expect((await inspect({ timestamp: Math.floor(Date.now() / 1000) - 120 })).status).toBe(401);
    // 30 s either way, with either secret.
    const now = Math.floor(Date.now() / 1000);
    for (const secret of [TEST_SECRET, PREVIOUS_SECRET]) {
      expect((await inspect({ secret, timestamp: now - 20 })).status).toBe(200);
      expect((await inspect({ secret, timestamp: now + 20 })).status).toBe(200);
      expect((await inspect({ secret, timestamp: now - 45 })).status).toBe(401);
      expect((await inspect({ secret, timestamp: now + 45 })).status).toBe(401);
    }
    expect((await inspect({ timestamp: now + 3_600 })).status).toBe(401);
    // A viewer field never travels on an internal request.
    expect((await inspect({ headers: { [SITE_GATEWAY_VISITOR_HEADER]: "v" } })).status).toBe(401);
    const unsigned = await mf!.dispatchFetch(`${ORIGIN}${siteDbInternalPath(SITE, "inspect")}`, {
      method: "POST",
      body: JSON.stringify({ requestId: crypto.randomUUID() }),
      headers: { "MF-Original-URL": `${ORIGIN}${siteDbInternalPath(SITE, "inspect")}` },
    });
    expect(unsigned.status).toBe(401);
    expect((await call(SITE, "drop", {})).status).toBe(404);
    expect((await call("not-a-uuid", "inspect", {})).status).toBe(404);
    // Site ids are lowercase UUIDs; another spelling would name another object.
    const lettered = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    expect((await call(lettered, "inspect", {})).status).toBe(200);
    expect((await call(lettered.toUpperCase(), "inspect", {})).status).toBe(404);
    expect((await call(SITE, "inspect", {}, { method: "GET" })).status).toBe(405);
  });

  test("without the SITE_DB binding the route does not exist", async () => {
    const bare = await startWorker({}, { siteDb: false });
    try {
      expect((await call(SITE, "inspect", {}, { instance: bare })).status).toBe(404);
    } finally {
      await bare.dispose();
    }
  }, 60_000);

  test("a replayed request id is refused", async () => {
    const requestId = crypto.randomUUID();
    expect((await call(SITE, "inspect", { requestId })).status).toBe(200);
    expect(await failure(await call(SITE, "inspect", { requestId }))).toMatchObject({
      status: 409,
      code: "replayed",
    });
  });

  test("migrations apply once, record checksums and refuse changed SQL", async () => {
    const first = await ok<{ applied: string[] }>(
      await call(SITE, "migrate", { migrations: MIGRATIONS, maxDatabaseBytes: MAX_DB }),
    );
    expect(first.applied).toEqual(["create_votes", "create_notes"]);
    const again = await ok<{ applied: string[] }>(
      await call(SITE, "migrate", { migrations: MIGRATIONS, maxDatabaseBytes: MAX_DB }),
    );
    expect(again.applied).toEqual([]);
    const changed = [migration("create_votes", "CREATE TABLE votes2 (a);")];
    expect(
      await failure(await call(SITE, "migrate", { migrations: changed, maxDatabaseBytes: MAX_DB })),
    ).toMatchObject({ status: 409, code: "conflict" });
    // The checksum is recomputed from the SQL.
    const mislabelled = [{ ...migration("other", "CREATE TABLE other (a);"), checksum: "c1" }];
    expect(
      await failure(
        await call(SITE, "migrate", { migrations: mislabelled, maxDatabaseBytes: MAX_DB }),
      ),
    ).toMatchObject({ status: 422, code: "validation" });
    const refused = [migration("bad", "ATTACH 'x' AS y")];
    expect(
      await failure(await call(SITE, "migrate", { migrations: refused, maxDatabaseBytes: MAX_DB })),
    ).toMatchObject({ status: 422, code: "validation" });
    // Bookkeeping lives in key-value storage, not in tables user SQL can reach.
    const master = await ok<SiteDbRunResponse>(
      await run(SITE, "SELECT name FROM sqlite_master ORDER BY name", {}, { profile: "agent" }),
    );
    expect(master.rows.map((row) => row.name)).not.toContainEqual(expect.stringMatching(/^_og_/u));
  });

  test("named queries bind parameters, meter rows and stay in one transaction", async () => {
    const insert = await ok<SiteDbRunResponse>(
      await run(
        SITE,
        "INSERT INTO votes (owner, choice) VALUES (:viewer, :choice) RETURNING id, owner, choice",
        { viewer: "user:ada", choice: "red'); DROP TABLE votes; --" },
        { expect: "write" },
      ),
    );
    expect(insert.rows).toEqual([
      { id: 1, owner: "user:ada", choice: "red'); DROP TABLE votes; --" },
    ]);
    expect(insert.rowsWritten).toBeGreaterThan(0);
    expect(insert.databaseBytes).toBeGreaterThan(0);
    for (const owner of ["user:bob", "guest:1", "guest:2"])
      await ok(
        await run(SITE, "INSERT INTO votes (owner, choice) VALUES (:viewer, 'blue')", {
          viewer: owner,
        }),
      );
    const read = await ok<SiteDbRunResponse>(
      await run(
        SITE,
        "SELECT choice, count(*) AS n FROM votes GROUP BY choice ORDER BY n DESC",
        {},
        { expect: "read" },
      ),
    );
    expect(read.columns).toEqual(["choice", "n"]);
    expect(read.rows[0]).toEqual({ choice: "blue", n: 3 });
    expect(read.rowsRead).toBeGreaterThan(0);
    expect(read.rowsWritten).toBe(0);
    // A unique violation rolls the statement back as a conflict.
    expect(
      await failure(
        await run(SITE, "INSERT INTO votes (owner, choice) VALUES (:viewer, 'x')", {
          viewer: "user:ada",
        }),
      ),
    ).toMatchObject({ status: 409, code: "conflict" });
    expect(await failure(await run(SITE, "SELECT * FROM nope"))).toMatchObject({
      status: 422,
      code: "sql_error",
    });
  });

  test("the statement allowlist holds inside the Durable Object", async () => {
    for (const sql of [
      "SELECT 1; DELETE FROM votes",
      "ATTACH DATABASE 'x' AS y",
      "PRAGMA writable_schema = 1",
      "VACUUM INTO 'x'",
      "SELECT load_extension('x')",
      "DROP TABLE votes",
      "SELECT * FROM votes WHERE owner = ?",
      "SELECT * FROM votes WHERE owner = #owner",
      "SELECT * FROM _og_migrations",
      "SELECT * FROM '_og_migrations'",
      "SELECT * FROM '_cf_KV'",
      "SELECT * FROM pragma_compile_options",
      "WITH c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
    ])
      expect(await failure(await run(SITE, sql))).toMatchObject({
        status: 422,
        code: "validation",
      });
    const schemaChange = await failure(
      await run(SITE, "CREATE TABLE sneaky (a)", {}, { profile: "agent" }),
    );
    expect(schemaChange).toMatchObject({ status: 422, code: "validation" });
    expect(schemaChange.message).toContain("site_sql_migrate");
    expect(
      await failure(
        await call(SITE, "script", {
          sql: "CREATE TRIGGER t1 AFTER INSERT ON votes BEGIN DELETE FROM '_og_requests'; END;",
          maxDatabaseBytes: MAX_DB,
        }),
      ),
    ).toMatchObject({ code: "validation" });
    expect(
      await failure(
        await call(SITE, "script", {
          sql: "CREATE TRIGGER t2 AFTER INSERT ON votes BEGIN UPDATE votes SET begin = 1; END; INSERT INTO votes (owner, choice) VALUES ('t', 't'); PRAGMA foreign_keys = OFF;",
          maxDatabaseBytes: MAX_DB,
        }),
      ),
    ).toMatchObject({ code: "validation" });
    // A WITH table named like a statement keyword is still a read.
    const named = await ok<SiteDbRunResponse>(
      await run(
        SITE,
        "WITH replace AS (SELECT 1 AS n) SELECT n FROM replace",
        {},
        { expect: "read" },
      ),
    );
    expect(named.rows).toEqual([{ n: 1 }]);
    expect(
      await failure(await run(SITE, "DELETE FROM votes", {}, { expect: "read" })),
    ).toMatchObject({ code: "validation" });
    expect(
      await failure(await run(SITE, "PRAGMA foreign_keys = OFF", {}, { profile: "agent" })),
    ).toMatchObject({ code: "validation" });
    const agent = await ok<SiteDbRunResponse>(
      await run(SITE, "PRAGMA table_info(votes)", {}, { profile: "agent" }),
    );
    expect(agent.rows.map((row) => row.name)).toEqual(["id", "owner", "choice"]);
    const count = await ok<SiteDbRunResponse>(await run(SITE, "SELECT count(*) AS n FROM votes"));
    expect(count.rows).toEqual([{ n: 4 }]);
  });

  test("rows and response size are bounded", async () => {
    const rows = await ok<SiteDbRunResponse>(
      await run(SITE, "SELECT owner FROM votes ORDER BY id", {}, { maxRows: 2 }),
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.truncated).toBe(true);
    const bytes = await ok<SiteDbRunResponse>(
      await run(SITE, "SELECT owner FROM votes ORDER BY id", {}, { maxResponseBytes: 110 }),
    );
    expect(bytes.rows.length).toBeLessThan(4);
    expect(bytes.truncated).toBe(true);
  });

  test("a write that would exceed the storage cap is rolled back", async () => {
    const before = await ok<SiteDbRunResponse>(await run(SITE, "SELECT count(*) AS n FROM votes"));
    const refused = await failure(
      await run(
        SITE,
        "INSERT INTO votes (owner, choice) SELECT 'bulk:' || value, hex(randomblob(2000)) FROM json_each(:list)",
        { list: JSON.stringify(Array.from({ length: 200 }, (_, i) => i)) },
        { maxDatabaseBytes: 64 * 1024 },
      ),
    );
    expect(refused).toMatchObject({ status: 413, code: "quota_exceeded" });
    const after = await ok<SiteDbRunResponse>(await run(SITE, "SELECT count(*) AS n FROM votes"));
    expect(after.rows).toEqual(before.rows);
  });

  test("insert, script and paginated export round-trip the data", async () => {
    const inserted = await ok<{ rowsWritten: number }>(
      await call(SITE, "insert", {
        table: "notes",
        columns: ["k", "body"],
        rows: [
          ["a", "first"],
          ["b", null],
          ["c", "third"],
        ],
        onConflict: "fail",
        maxDatabaseBytes: MAX_DB,
      }),
    );
    expect(inserted.rowsWritten).toBeGreaterThanOrEqual(3);
    expect(
      await failure(
        await call(SITE, "insert", {
          table: "_og_migrations",
          columns: ["name"],
          rows: [["x"]],
          onConflict: "fail",
          maxDatabaseBytes: MAX_DB,
        }),
      ),
    ).toMatchObject({ code: "validation" });
    await ok(
      await call(SITE, "script", {
        sql: "INSERT INTO notes (k, body) VALUES ('d', x'00ff'); UPDATE notes SET body = 'second' WHERE k = 'b';",
        maxDatabaseBytes: MAX_DB,
      }),
    );
    const pages: SiteDbExportResponse[] = [];
    let cursor: string | null = null;
    do {
      const page: SiteDbExportResponse = await ok<SiteDbExportResponse>(
        await call(SITE, "export", { cursor, maxRows: 3, maxBytes: 1024 * 1024 }),
      );
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor && pages.length < 10);
    expect(pages[0]!.schema.map((entry) => entry.name)).toEqual(["votes", "votes_choice", "notes"]);
    // Every page carries the schema, so the API can end a dump on any page.
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.schema.length === pages[0]!.schema.length)).toBe(true);
    const rowsByTable = new Map<string, unknown[][]>();
    for (const page of pages)
      for (const table of page.tables)
        rowsByTable.set(table.name, [...(rowsByTable.get(table.name) ?? []), ...table.rows]);
    expect(rowsByTable.get("votes")).toHaveLength(4);
    expect(rowsByTable.get("notes")).toEqual([
      ["a", "first"],
      ["b", "second"],
      ["c", "third"],
      ["d", { $base64: "AP8=" }],
    ]);
  });

  test("inspect describes tables, columns, row counts and applied migrations", async () => {
    const inspect = await ok<SiteDbInspectResponse>(await call(SITE, "inspect", {}));
    expect(inspect.tables.map((table) => [table.name, table.rowCount])).toEqual([
      ["votes", 4],
      ["notes", 4],
    ]);
    expect(inspect.tables[0]!.columns[1]).toMatchObject({
      name: "owner",
      type: "TEXT",
      notNull: true,
    });
    expect(inspect.indexes.map((entry) => entry.name)).toEqual(["votes_choice"]);
    expect(inspect.migrations.map((entry) => entry.name)).toEqual(["create_votes", "create_notes"]);
    const migrationsOnly = await ok<SiteDbInspectResponse>(
      await call(SITE, "inspect", { migrationsOnly: true }),
    );
    expect(migrationsOnly.tables).toEqual([]);
    expect(migrationsOnly.migrations.map((entry) => entry.name)).toEqual([
      "create_votes",
      "create_notes",
    ]);
  });

  test("each Site has its own database", async () => {
    const other = await ok<SiteDbInspectResponse>(await call(OTHER_SITE, "inspect", {}));
    expect(other.tables).toEqual([]);
    expect(await failure(await run(OTHER_SITE, "SELECT * FROM votes"))).toMatchObject({
      code: "sql_error",
    });
  });

  test("rebuild re-applies every migration on an empty database; reset wipes it", async () => {
    const rebuilt = await ok<{ applied: string[] }>(
      await call(SITE, "migrate", {
        migrations: MIGRATIONS,
        rebuild: true,
        maxDatabaseBytes: MAX_DB,
      }),
    );
    expect(rebuilt.applied).toEqual(["create_votes", "create_notes"]);
    const empty = await ok<SiteDbRunResponse>(await run(SITE, "SELECT count(*) AS n FROM votes"));
    expect(empty.rows).toEqual([{ n: 0 }]);
    await ok(await call(SITE, "reset", {}));
    const inspect = await ok<SiteDbInspectResponse>(await call(SITE, "inspect", {}));
    expect(inspect.tables).toEqual([]);
    expect(inspect.migrations).toEqual([]);
    // Migrations sent in separate calls keep their Postgres positions.
    const [first, second] = MIGRATIONS;
    await ok(
      await call(SITE, "migrate", {
        migrations: [{ ...first!, position: 1 }],
        rebuild: true,
        maxDatabaseBytes: MAX_DB,
      }),
    );
    const added = await ok<{ applied: string[] }>(
      await call(SITE, "migrate", {
        migrations: [{ ...second!, position: 2 }],
        maxDatabaseBytes: MAX_DB,
      }),
    );
    expect(added.applied).toEqual(["create_notes"]);
    const positioned = await ok<SiteDbInspectResponse>(
      await call(SITE, "inspect", { migrationsOnly: true }),
    );
    expect(positioned.migrations.map((entry) => entry.name)).toEqual([
      "create_votes",
      "create_notes",
    ]);
    expect(
      await failure(
        await call(SITE, "migrate", {
          migrations: [{ ...second!, position: -1 }],
          maxDatabaseBytes: MAX_DB,
        }),
      ),
    ).toMatchObject({ code: "validation" });
    await ok(await call(SITE, "reset", {}));
  });

  test("a reset keeps its request id across the wipe", async () => {
    const requestId = crypto.randomUUID();
    await ok(await call(SITE, "reset", {}, { requestId }));
    expect(await failure(await call(SITE, "reset", {}, { requestId }))).toMatchObject({
      status: 409,
      code: "replayed",
    });
    expect(await failure(await call(SITE, "inspect", {}, { requestId }))).toMatchObject({
      code: "replayed",
    });
  });

  test("migrations keep their order and a failed one leaves nothing behind", async () => {
    const site = "55555555-5555-4555-8555-555555555555";
    const first = migration("m1", "CREATE TABLE a (x);", 1);
    const third = migration("m3", "CREATE TABLE c (x);", 3);
    await ok(await call(site, "migrate", { migrations: [first, third], maxDatabaseBytes: MAX_DB }));
    // A migration positioned before one already applied cannot run out of order.
    const middle = migration("m2", "CREATE TABLE b (x);", 2);
    const outOfOrder = await failure(
      await call(site, "migrate", { migrations: [middle], maxDatabaseBytes: MAX_DB }),
    );
    expect(outOfOrder).toMatchObject({ status: 409, code: "conflict" });
    expect(outOfOrder.message).toContain("rebuild");
    // A migration that fails part way rolls back its statements and its record.
    const broken = migration("m4", "CREATE TABLE d (x); INSERT INTO missing VALUES (1);", 4);
    const failed = await failure(
      await call(site, "migrate", { migrations: [broken], maxDatabaseBytes: MAX_DB }),
    );
    expect(failed).toMatchObject({ status: 422, code: "sql_error" });
    expect(failed.message).toContain("m4");
    const inspect = await ok<SiteDbInspectResponse>(await call(site, "inspect", {}));
    expect(inspect.tables.map((table) => table.name)).toEqual(["a", "c"]);
    expect(inspect.migrations.map((entry) => entry.name)).toEqual(["m1", "m3"]);
    expect(inspect.migrations[0]!.checksum).toBe(first.checksum);
    const fixed = migration("m4", "CREATE TABLE d (x);", 4);
    const applied = await ok<{ applied: string[] }>(
      await call(site, "migrate", { migrations: [fixed], maxDatabaseBytes: MAX_DB }),
    );
    expect(applied.applied).toEqual(["m4"]);
    // Rebuilding applies them all in order.
    const rebuilt = await ok<{ applied: string[] }>(
      await call(site, "migrate", {
        migrations: [first, middle, third, fixed],
        rebuild: true,
        maxDatabaseBytes: MAX_DB,
      }),
    );
    expect(rebuilt.applied).toEqual(["m1", "m2", "m3", "m4"]);
    await ok(await call(site, "reset", {}));
  });

  test("writes with RETURNING finish past the row and response caps", async () => {
    const site = "66666666-6666-4666-8666-666666666666";
    await ok(
      await call(site, "migrate", {
        migrations: [migration("items", "CREATE TABLE items (id INTEGER PRIMARY KEY, v TEXT);")],
        maxDatabaseBytes: MAX_DB,
      }),
    );
    const list = JSON.stringify(Array.from({ length: 6 }, (_, i) => `v${i}`));
    const capped = await ok<SiteDbRunResponse>(
      await run(
        site,
        "INSERT INTO items (v) SELECT value FROM json_each(:list) RETURNING id",
        { list },
        { maxRows: 2 },
      ),
    );
    expect(capped.rows).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    const bytes = await ok<SiteDbRunResponse>(
      await run(
        site,
        "UPDATE items SET v = v || '!' RETURNING id, v",
        {},
        { maxResponseBytes: 100 },
      ),
    );
    expect(bytes.truncated).toBe(true);
    const count = await ok<SiteDbRunResponse>(
      await run(site, "SELECT count(*) AS n, sum(v LIKE '%!') AS changed FROM items"),
    );
    expect(count.rows).toEqual([{ n: 6, changed: 6 }]);
    // Scripts run every statement to completion too.
    await ok(
      await call(site, "script", {
        sql: "INSERT INTO items (v) VALUES ('a'), ('b') RETURNING id; SELECT * FROM items;",
        maxDatabaseBytes: MAX_DB,
      }),
    );
    // Response size counts UTF-8 bytes: 100 two-byte characters do not fit in 200 bytes.
    const wide = await ok<SiteDbRunResponse>(
      await run(site, "SELECT :s AS s", { s: "é".repeat(100) }, { maxResponseBytes: 200 }),
    );
    expect(wide.rows).toEqual([]);
    expect(wide.truncated).toBe(true);
    await ok(await call(site, "reset", {}));
  });

  test("repeated and __proto__ column names keep their values", async () => {
    const result = await ok<SiteDbRunResponse>(
      await run(OTHER_SITE, 'SELECT 1 AS a, 2 AS a, 3 AS a_2, 4 AS "__proto__"'),
    );
    expect(result.columns).toEqual(["a", "a_3", "a_2", "__proto__"]);
    const row = result.rows[0]!;
    expect(Object.keys(row)).toEqual(["a", "a_3", "a_2", "__proto__"]);
    expect([row.a, row.a_3, row.a_2]).toEqual([1, 2, 3]);
    expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe(4);
  });

  test("the storage cap allows writes that do not grow the database", async () => {
    const site = "77777777-7777-4777-8777-777777777777";
    await ok(
      await call(site, "migrate", {
        migrations: [migration("blobs", "CREATE TABLE blobs (id INTEGER PRIMARY KEY, v TEXT);")],
        maxDatabaseBytes: MAX_DB,
      }),
    );
    const filled = await ok<SiteDbRunResponse>(
      await run(site, "INSERT INTO blobs (v) SELECT hex(randomblob(2000)) FROM json_each(:list)", {
        list: JSON.stringify(Array.from({ length: 50 }, (_, i) => i)),
      }),
    );
    const cap = Math.floor(filled.databaseBytes / 2);
    // Over the cap now: growing is refused, deleting and shrinking updates are not.
    expect(
      await failure(
        await run(
          site,
          "INSERT INTO blobs (v) SELECT hex(randomblob(4000)) FROM json_each(:list)",
          { list: JSON.stringify(Array.from({ length: 50 }, (_, i) => i)) },
          { maxDatabaseBytes: cap },
        ),
      ),
    ).toMatchObject({ code: "quota_exceeded" });
    await ok(
      await run(site, "UPDATE blobs SET v = 'x' WHERE id <= 10", {}, { maxDatabaseBytes: cap }),
    );
    await ok(await run(site, "DELETE FROM blobs WHERE id > 25", {}, { maxDatabaseBytes: cap }));
    await ok(await call(site, "reset", {}));
  });

  test("export pages through tables whose columns shadow rowid", async () => {
    const site = "88888888-8888-4888-8888-888888888888";
    await ok(
      await call(site, "migrate", {
        migrations: [
          migration(
            "shadows",
            "CREATE TABLE one (rowid TEXT, v INTEGER); CREATE TABLE every (rowid TEXT, _rowid_ TEXT, oid TEXT);",
          ),
        ],
        maxDatabaseBytes: MAX_DB,
      }),
    );
    await ok(
      await call(site, "script", {
        sql: "INSERT INTO one VALUES ('z', 1), ('a', 2), ('m', 3), ('b', 4); INSERT INTO every VALUES ('1', '2', '3'), ('4', '5', '6'), ('7', '8', '9');",
        maxDatabaseBytes: MAX_DB,
      }),
    );
    const rows = new Map<string, unknown[][]>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: SiteDbExportResponse = await ok<SiteDbExportResponse>(
        await call(site, "export", { cursor, maxRows: 1, maxBytes: 1024 * 1024 }),
      );
      for (const table of page.tables) {
        rows.set(table.name, [...(rows.get(table.name) ?? []), ...table.rows]);
        expect(table.columns).toEqual(
          table.name === "one" ? ["rowid", "v"] : ["rowid", "_rowid_", "oid"],
        );
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(rows.get("one")).toEqual([
      ["z", 1],
      ["a", 2],
      ["m", 3],
      ["b", 4],
    ]);
    expect(rows.get("every")).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
      ["7", "8", "9"],
    ]);
    await ok(await call(site, "reset", {}));
  });
});
