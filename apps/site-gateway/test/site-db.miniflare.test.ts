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
};

async function call(
  siteId: string,
  operation: SiteDbOperation | string,
  payload: Record<string, unknown>,
  options: Signed = {},
) {
  const path = `/_og/internal/site-db/${siteId}/${operation}`;
  const body = JSON.stringify({ requestId: crypto.randomUUID(), ...payload });
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
  return await mf!.dispatchFetch(url, {
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

const MIGRATIONS = [
  {
    name: "create_votes",
    sql: "CREATE TABLE votes (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, choice TEXT NOT NULL, UNIQUE(owner)); CREATE INDEX votes_choice ON votes (choice);",
    checksum: "c1",
  },
  {
    name: "create_notes",
    sql: "CREATE TABLE notes (k TEXT PRIMARY KEY, body BLOB) WITHOUT ROWID;",
    checksum: "c2",
  },
];

async function startWorker(bindings: Record<string, string> = {}): Promise<void> {
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
    mf = new Miniflare({
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
      durableObjects: { SITE_DB: { className: "SiteDatabase", useSQLite: true } },
    });
    await mf.ready;
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  await startWorker();
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
    expect((await call(SITE, "inspect", {}, { method: "GET" })).status).toBe(405);
  });

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
    const changed = [{ ...MIGRATIONS[0]!, checksum: "other" }];
    expect(
      await failure(await call(SITE, "migrate", { migrations: changed, maxDatabaseBytes: MAX_DB })),
    ).toMatchObject({ status: 409, code: "conflict" });
    const refused = [{ name: "bad", sql: "ATTACH 'x' AS y", checksum: "c" }];
    expect(
      await failure(await call(SITE, "migrate", { migrations: refused, maxDatabaseBytes: MAX_DB })),
    ).toMatchObject({ status: 422, code: "validation" });
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
    // A unique violation rolls the statement back as a SQL error.
    expect(
      await failure(
        await run(SITE, "INSERT INTO votes (owner, choice) VALUES (:viewer, 'x')", {
          viewer: "user:ada",
        }),
      ),
    ).toMatchObject({ status: 422, code: "sql_error" });
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
      "SELECT * FROM _og_migrations",
    ])
      expect(await failure(await run(SITE, sql))).toMatchObject({
        status: 422,
        code: "validation",
      });
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
    expect(pages.slice(1).every((page) => page.schema.length === 0)).toBe(true);
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
  });
});
