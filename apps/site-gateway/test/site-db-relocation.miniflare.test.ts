/**
 * Integration: Site databases move from their legacy Durable Object (plain
 * `idFromName(siteId)`) to their EU object, in workerd (Miniflare). workerd
 * has no jurisdictions, so the gateway emulates the EU namespace with
 * `eu:<siteId>` names (src/site-db-location.ts); everything else runs as
 * deployed. The test Worker (fixtures/legacy-gateway-worker.ts) also reaches
 * a legacy object directly, as an earlier gateway release did.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_TIMESTAMP_HEADER,
  siteGatewayCanonicalString,
  type SiteDbExportResponse,
  type SiteDbInspectResponse,
  type SiteDbRunResponse,
} from "@opengeni/contracts";
import { Miniflare } from "miniflare";
import { moveSiteDatabases } from "../scripts/move-site-databases-to-eu";
import { TEST_SECRET } from "./helpers";

const ORIGIN = "https://internal.sites.test";
const MAX_DB = 50 * 1024 * 1024;
const LOCATION = "x-og-site-db-location";
const RELOCATION_ERROR = "x-og-site-db-relocation-error";

let mf: Miniflare | null = null;

function newSiteId(): string {
  return crypto.randomUUID();
}

/** Through the gateway's signed internal route, as the API calls it. */
async function call(site: string, operation: string, payload: Record<string, unknown>) {
  const path = `/_og/internal/site-db/${site}/${operation}`;
  const body = JSON.stringify({ requestId: crypto.randomUUID(), ...payload });
  const timestamp = Math.floor(Date.now() / 1000);
  const canonical = siteGatewayCanonicalString({
    method: "POST",
    pathWithQuery: path,
    timestamp,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    host: new URL(ORIGIN).host,
    session: "",
    visitor: "",
    clientIp: "",
    human: "",
  });
  const signature = `v1=${createHmac("sha256", TEST_SECRET).update(canonical).digest("base64url")}`;
  return await mf!.dispatchFetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SITE_GATEWAY_TIMESTAMP_HEADER]: String(timestamp),
      [SITE_GATEWAY_SIGNATURE_HEADER]: signature,
      "MF-Original-URL": `${ORIGIN}${path}`,
    },
    body,
  });
}

/** Straight to the legacy object: no role (an earlier gateway) or as its EU object (`relay`). */
async function legacy(
  site: string,
  path: string,
  payload: Record<string, unknown>,
  role?: "relay",
) {
  const url = `${ORIGIN}/_test/legacy/${site}/${path}`;
  return await mf!.dispatchFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(role ? { "x-test-role": role } : {}),
      "MF-Original-URL": url,
    },
    body: JSON.stringify({ requestId: crypto.randomUUID(), ...payload }),
  });
}

async function ok<T>(response: { status: number; json(): Promise<unknown> }): Promise<T> {
  const value = await response.json();
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value as T;
}

type LegacyStatus = {
  moved: { site: string; at: string; erased?: boolean } | null;
  fenced: boolean;
  empty: boolean;
  tables: Array<{ name: string; rows: number }>;
};

async function legacyStatus(site: string): Promise<LegacyStatus> {
  return ok<LegacyStatus>(await legacy(site, "relocation/status", {}, "relay"));
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function migration(name: string, sql: string) {
  return { name, sql, checksum: checksum(sql) };
}

const SCHEMA = migration(
  "schema",
  [
    "CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, big INTEGER, ratio REAL, avatar BLOB, loose, doubled INTEGER GENERATED ALWAYS AS (big * 2) VIRTUAL)",
    "CREATE TABLE pets (owner INTEGER NOT NULL REFERENCES people (id), name TEXT NOT NULL, PRIMARY KEY (owner, name)) WITHOUT ROWID",
    "CREATE TABLE notes (body TEXT)",
    "CREATE TABLE audit (what TEXT)",
    "CREATE INDEX people_name ON people (name)",
    "CREATE VIEW pet_counts AS SELECT owner, count(*) AS n FROM pets GROUP BY owner",
    "CREATE TRIGGER people_audit AFTER INSERT ON people BEGIN INSERT INTO audit (what) VALUES ('person ' || NEW.name); END",
    "CREATE VIRTUAL TABLE search USING fts5(title, body)",
  ].join(";\n"),
);

const SEED = [
  "INSERT INTO people (name, big, ratio, avatar, loose) VALUES ('Ada', 9007199254740993, 0.1, x'00ff10', 'text'), ('Bob', -9223372036854775808, 9e999, NULL, 1.5), ('Cy', 9223372036854775807, -0.0, x'', x'cafe')",
  "INSERT INTO people (name) VALUES ('Gone')",
  "DELETE FROM people WHERE name = 'Gone'",
  "INSERT INTO pets (owner, name) VALUES (2, 'Rex'), (1, 'Tom'), (1, 'Ann')",
  "INSERT INTO notes (rowid, body) VALUES (5, 'five'), (9, 'nine'), (-3, 'minus three'), (12, 'twelve')",
  "DELETE FROM notes WHERE rowid = 9",
  "INSERT INTO search (rowid, title, body) VALUES (40, 'Hello', 'hello world'), (7, 'Other', 'nothing here')",
].join(";\n");

/** A legacy database as an earlier release left it. */
async function seedLegacy(site: string): Promise<void> {
  await ok(await legacy(site, "migrate", { migrations: [SCHEMA], maxDatabaseBytes: MAX_DB }));
  await ok(await legacy(site, "script", { sql: SEED, maxDatabaseBytes: MAX_DB }));
}

function agentRun(site: string, sql: string, params: Record<string, unknown> = {}) {
  return call(site, "run", {
    sql,
    profile: "agent",
    params,
    maxRows: 1000,
    maxResponseBytes: 1024 * 1024,
    maxDatabaseBytes: MAX_DB,
  });
}

const EXACT = `SELECT id, name, CAST(big AS TEXT) AS big, typeof(big) AS bt, quote(ratio) AS ratio, typeof(ratio) AS rt, hex(avatar) AS avatar, typeof(avatar) AS at, quote(loose) AS loose, CAST(doubled AS TEXT) AS doubled FROM people ORDER BY id`;

async function startWorker(): Promise<Miniflare> {
  const buildDir = mkdtempSync(join(tmpdir(), "site-gateway-relocation-test-"));
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "fixtures/legacy-gateway-worker.ts")],
      outdir: buildDir,
      target: "browser",
      format: "esm",
      naming: "worker.js",
    });
    if (!build.success) throw new AggregateError(build.logs, "Worker build failed");
    const instance = new Miniflare({
      port: 0,
      modules: true,
      scriptPath: join(buildDir, "worker.js"),
      modulesRoot: buildDir,
      compatibilityDate: "2026-07-01",
      bindings: {
        SITES_DOMAIN: "sites.test",
        API_ORIGIN: "http://127.0.0.1:18787",
        APP_ORIGIN: "https://app.test",
        GATEWAY_SECRET: TEST_SECRET,
        ENVIRONMENT: "test",
      },
      durableObjects: { SITE_DB: { className: "SiteDatabase", useSQLite: true } },
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

describe("Site database location", () => {
  test("a new Site's database starts in the EU; its legacy object keeps only a marker", async () => {
    const site = newSiteId();
    const response = await call(site, "inspect", {});
    expect(response.status).toBe(200);
    expect(response.headers.get(LOCATION)).toBe("eu");
    await ok(await call(site, "migrate", { migrations: [SCHEMA], maxDatabaseBytes: MAX_DB }));
    expect(await legacyStatus(site)).toEqual({
      moved: { site, at: expect.any(String), erased: true },
      fenced: false,
      empty: true,
      tables: [],
    });
    // An earlier gateway release reaching the legacy object writes to the EU database.
    const old = await legacy(site, "insert", {
      table: "notes",
      columns: ["body"],
      rows: [["from an earlier gateway"]],
      maxDatabaseBytes: MAX_DB,
    });
    expect(old.status).toBe(200);
    expect(old.headers.get(LOCATION)).toBe("eu");
    const rows = await ok<SiteDbRunResponse>(await agentRun(site, "SELECT body FROM notes"));
    expect(rows.rows).toEqual([{ body: "from an earlier gateway" }]);
    expect((await legacyStatus(site)).empty).toBe(true);
  });

  test("a legacy database moves exactly, keeps working and its legacy copy stays until a reset", async () => {
    const site = newSiteId();
    await seedLegacy(site);
    const before = await ok<SiteDbRunResponse>(
      await legacy(site, "run", {
        sql: EXACT,
        profile: "agent",
        params: {},
        maxRows: 100,
        maxResponseBytes: 1024 * 1024,
        maxDatabaseBytes: MAX_DB,
      }),
    );
    const legacyExport = await ok<SiteDbExportResponse>(
      await legacy(site, "export", { maxRows: 1000, maxBytes: 1024 * 1024 }),
    );

    // First use through the gateway moves it.
    const first = await call(site, "inspect", {});
    expect(first.status).toBe(200);
    expect(first.headers.get(LOCATION)).toBe("eu");
    expect(first.headers.get(RELOCATION_ERROR)).toBeNull();
    const inspected = (await first.json()) as SiteDbInspectResponse;
    expect(inspected.migrations.map((entry) => entry.name)).toEqual(["schema"]);

    // Every value with its storage class: 64-bit integers, reals (infinity
    // and negative zero included), blobs and mixed-type columns.
    const after = await ok<SiteDbRunResponse>(await agentRun(site, EXACT));
    expect(after.rows).toEqual(before.rows);
    expect(after.rows.map((row) => row.big)).toEqual([
      "9007199254740993",
      "-9223372036854775808",
      "9223372036854775807",
    ]);
    const euExport = await ok<SiteDbExportResponse>(
      await call(site, "export", { maxRows: 1000, maxBytes: 1024 * 1024 }),
    );
    // FTS5 rebuilds its index (the search_* shadow tables) in its own layout;
    // the indexed rows themselves are compared above and below.
    const data = (tables: SiteDbExportResponse["tables"]) =>
      tables.filter((table) => !table.name.startsWith("search_"));
    expect(data(euExport.tables)).toEqual(data(legacyExport.tables));
    expect(data(euExport.tables).map((table) => table.name)).toEqual([
      "people",
      "pets",
      "notes",
      "audit",
      "search",
    ]);
    expect(new Set(euExport.schema.map((entry) => JSON.stringify(entry)))).toEqual(
      new Set(legacyExport.schema.map((entry) => JSON.stringify(entry))),
    );
    // Implicit rowids are kept.
    const notes = await ok<SiteDbRunResponse>(
      await agentRun(site, "SELECT rowid AS r, body FROM notes ORDER BY rowid"),
    );
    expect(notes.rows).toEqual([
      { r: -3, body: "minus three" },
      { r: 5, body: "five" },
      { r: 12, body: "twelve" },
    ]);
    // Full-text search still finds rows by their rowid.
    const found = await ok<SiteDbRunResponse>(
      await agentRun(site, "SELECT rowid AS r FROM search WHERE search MATCH 'hello'"),
    );
    expect(found.rows).toEqual([{ r: 40 }]);
    // The AUTOINCREMENT counter moved (4 was used and deleted), the trigger
    // fires once per new row and foreign keys still hold.
    const added = await ok<SiteDbRunResponse>(
      await agentRun(site, "INSERT INTO people (name) VALUES ('Dee') RETURNING id"),
    );
    expect(added.rows).toEqual([{ id: 5 }]);
    const audit = await ok<SiteDbRunResponse>(
      await agentRun(site, "SELECT what FROM audit ORDER BY rowid"),
    );
    expect(audit.rows.map((row) => row.what)).toEqual([
      "person Ada",
      "person Bob",
      "person Cy",
      "person Gone",
      "person Dee",
    ]);
    const orphan = await agentRun(site, "INSERT INTO pets (owner, name) VALUES (99, 'x')");
    expect(orphan.status).toBe(422);

    // The legacy object keeps its rows, frozen, and is marked moved.
    const status = await legacyStatus(site);
    expect(status.moved?.site).toBe(site);
    expect(status.fenced).toBe(false);
    expect(status.tables).toContainEqual({ name: "people", rows: 3 });
    expect(status.tables).toContainEqual({ name: "pets", rows: 3 });
    // The frozen copy is never served, even to a relay.
    expect((await legacy(site, "inspect", {}, "relay")).status).toBe(503);

    // An earlier gateway release still reaching the legacy object is sent to the EU copy.
    const old = await legacy(site, "run", {
      sql: "INSERT INTO people (name) VALUES ('Old gateway') RETURNING id",
      profile: "agent",
      params: {},
      maxRows: 10,
      maxResponseBytes: 1024 * 1024,
      maxDatabaseBytes: MAX_DB,
    });
    expect(old.status).toBe(200);
    expect(old.headers.get(LOCATION)).toBe("eu");
    const names = await ok<SiteDbRunResponse>(
      await agentRun(site, "SELECT name FROM people ORDER BY id"),
    );
    expect(names.rows.map((row) => row.name)).toEqual(["Ada", "Bob", "Cy", "Dee", "Old gateway"]);
    expect((await legacyStatus(site)).tables).toContainEqual({ name: "people", rows: 3 });

    // A reset erases the frozen legacy copy too, and never brings it back.
    await ok(await call(site, "reset", {}));
    const empty = await call(site, "inspect", {});
    expect(empty.headers.get(LOCATION)).toBe("eu");
    expect(((await empty.json()) as SiteDbInspectResponse).tables).toEqual([]);
    expect(await legacyStatus(site)).toEqual({
      moved: { site, at: expect.any(String), erased: true },
      fenced: false,
      empty: true,
      tables: [],
    });
  });

  test("a reset or rebuild erases the legacy copy, and a reset before the move copies nothing", async () => {
    // Reset before the database moved: the legacy database is erased, not copied.
    const unmoved = newSiteId();
    await seedLegacy(unmoved);
    const reset = await call(unmoved, "reset", {});
    expect(reset.status).toBe(200);
    expect(reset.headers.get(LOCATION)).toBe("eu");
    expect(await legacyStatus(unmoved)).toMatchObject({
      moved: { site: unmoved, erased: true },
      empty: true,
      tables: [],
    });
    const after = await ok<SiteDbInspectResponse>(await call(unmoved, "inspect", {}));
    expect(after.tables).toEqual([]);

    // Rebuild after the move: the frozen legacy copy is erased first.
    const moved = newSiteId();
    await seedLegacy(moved);
    await ok(await call(moved, "inspect", {}));
    expect((await legacyStatus(moved)).empty).toBe(false);
    await ok(
      await call(moved, "migrate", {
        migrations: [SCHEMA],
        rebuild: true,
        maxDatabaseBytes: MAX_DB,
      }),
    );
    expect(await legacyStatus(moved)).toMatchObject({ moved: { erased: true }, empty: true });
    const rebuilt = await ok<SiteDbRunResponse>(
      await agentRun(moved, "SELECT count(*) AS n FROM people"),
    );
    expect(rebuilt.rows).toEqual([{ n: 0 }]);
  });

  test("text bytes, rowids, FTS5 settings and large values move exactly", async () => {
    const site = newSiteId();
    const odd = migration(
      "odd",
      [
        "CREATE TABLE odd (label TEXT DEFAULT 'WITHOUT ROWID', raw TEXT)",
        "CREATE TABLE wide (t TEXT)",
        "CREATE TABLE big (b BLOB)",
        "CREATE VIRTUAL TABLE s USING fts5(body)",
        // As wide as SQLite in a Durable Object allows a copy to read.
        `CREATE TABLE many (${Array.from({ length: 99 }, (_, index) => `c${index}`).join(", ")})`,
      ].join(";\n"),
    );
    await ok(await legacy(site, "migrate", { migrations: [odd], maxDatabaseBytes: MAX_DB }));
    await ok(
      await legacy(site, "script", {
        sql: [
          "INSERT INTO odd (rowid, raw) VALUES (7, CAST(x'ff80c3' AS TEXT)), (100, 'plain')",
          "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO wide (t) SELECT replace(hex(zeroblob(400)), '00', '漢') FROM n",
          "INSERT INTO big (b) VALUES (zeroblob(1900000))",
          "INSERT INTO s (s, rank) VALUES ('rank', 'bm25(10.0)')",
          "INSERT INTO s (s, rank) VALUES ('automerge', 2)",
          "INSERT INTO s (rowid, body) VALUES (3, 'hello there')",
          `INSERT INTO many VALUES (${Array.from({ length: 99 }, (_, index) => (index % 2 === 0 ? String(index) : `'v${index}'`)).join(", ")})`,
        ].join(";\n"),
        maxDatabaseBytes: MAX_DB,
      }),
    );
    const first = await call(site, "inspect", {});
    expect(first.headers.get(RELOCATION_ERROR)).toBeNull();
    expect(first.headers.get(LOCATION)).toBe("eu");
    const oddRows = await ok<SiteDbRunResponse>(
      await agentRun(
        site,
        "SELECT rowid AS r, label, hex(raw) AS raw, typeof(raw) AS t FROM odd ORDER BY rowid",
      ),
    );
    expect(oddRows.rows).toEqual([
      { r: 7, label: "WITHOUT ROWID", raw: "FF80C3", t: "text" },
      { r: 100, label: "WITHOUT ROWID", raw: "706C61696E", t: "text" },
    ]);
    const wide = await ok<SiteDbRunResponse>(
      await agentRun(site, "SELECT count(*) AS n, sum(length(t)) AS chars FROM wide"),
    );
    expect(wide.rows).toEqual([{ n: 2000, chars: 800_000 }]);
    const big = await ok<SiteDbRunResponse>(
      await agentRun(site, "SELECT length(b) AS n, typeof(b) AS t FROM big"),
    );
    expect(big.rows).toEqual([{ n: 1_900_000, t: "blob" }]);
    const many = await ok<SiteDbRunResponse>(
      await agentRun(site, "SELECT c0, c1, c97, c98, typeof(c98) AS t FROM many"),
    );
    expect(many.rows).toEqual([{ c0: 0, c1: "v1", c97: "v97", c98: 98, t: "integer" }]);
    const config = await ok<SiteDbRunResponse>(
      await agentRun(site, "SELECT k, v FROM s_config WHERE k <> 'version' ORDER BY k"),
    );
    expect(config.rows).toEqual([
      { k: "automerge", v: 2 },
      { k: "rank", v: "bm25(10.0)" },
    ]);
  });

  test("writes during the move wait for it and none is lost", async () => {
    const site = newSiteId();
    await seedLegacy(site);
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        call(site, "insert", {
          table: "notes",
          columns: ["body"],
          rows: [[`concurrent ${index}`]],
          maxDatabaseBytes: MAX_DB,
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(25).fill(200));
    expect(responses.every((response) => response.headers.get(LOCATION) === "eu")).toBe(true);
    const count = await ok<SiteDbRunResponse>(
      await agentRun(site, "SELECT count(*) AS n FROM notes WHERE body LIKE 'concurrent %'"),
    );
    expect(count.rows).toEqual([{ n: 25 }]);
    expect((await legacyStatus(site)).tables).toContainEqual({ name: "notes", rows: 3 });
  });

  test("a fenced legacy object refuses earlier gateways until it is released", async () => {
    const site = newSiteId();
    await seedLegacy(site);
    const token = crypto.randomUUID();
    await ok(await legacy(site, "relocation/begin", { token }, "relay"));
    const write = () =>
      legacy(site, "run", {
        sql: "INSERT INTO notes (body) VALUES ('while fenced')",
        profile: "agent",
        params: {},
        maxRows: 10,
        maxResponseBytes: 1024 * 1024,
        maxDatabaseBytes: MAX_DB,
      });
    const refused = await write();
    expect(refused.status).toBe(503);
    // Nothing ran, so the API may retry it.
    expect(await refused.json()).toMatchObject({
      error: { retryable: true, outcomeUnknown: false },
    });
    // Another token cannot take a page or commit while this one holds it.
    expect(
      (await legacy(site, "relocation/page", { token: crypto.randomUUID() }, "relay")).status,
    ).toBe(409);
    expect(
      (await legacy(site, "relocation/commit", { token: crypto.randomUUID() }, "relay")).status,
    ).toBe(409);
    await ok(await legacy(site, "relocation/release", { token }, "relay"));
    expect((await write()).status).toBe(200);
    // Relocation steps are only for the Site's EU object.
    expect((await legacy(site, "relocation/status", {})).status).toBe(404);
  });

  test("a database that cannot move stays on its legacy object and keeps working", async () => {
    const site = newSiteId();
    const contentless = migration(
      "contentless",
      "CREATE TABLE items (name TEXT); CREATE VIRTUAL TABLE item_index USING fts5(name, content='')",
    );
    await ok(
      await legacy(site, "migrate", { migrations: [contentless], maxDatabaseBytes: MAX_DB }),
    );
    await ok(
      await legacy(site, "script", {
        sql: "INSERT INTO items (name) VALUES ('kept')",
        maxDatabaseBytes: MAX_DB,
      }),
    );
    const first = await call(site, "inspect", {});
    expect(first.status).toBe(200);
    expect(first.headers.get(LOCATION)).toBe("legacy");
    expect(first.headers.get(RELOCATION_ERROR)).toContain("item_index");
    // Reads and writes keep going to the legacy object; nothing is lost.
    const written = await agentRun(site, "INSERT INTO items (name) VALUES ('after')");
    expect(written.status).toBe(200);
    expect(written.headers.get(LOCATION)).toBe("legacy");
    const rows = await ok<SiteDbRunResponse>(
      await agentRun(site, "SELECT name FROM items ORDER BY rowid"),
    );
    expect(rows.rows.map((row) => row.name)).toEqual(["kept", "after"]);
    const status = await legacyStatus(site);
    expect(status).toMatchObject({ moved: null, fenced: false, empty: false });
    expect(status.tables).toContainEqual({ name: "items", rows: 2 });
    // The failure is remembered: the next requests do not retry right away.
    const again = await call(site, "inspect", {});
    expect(again.headers.get(LOCATION)).toBe("legacy");
  });

  test("the post-deploy sweep moves idle databases and reports those that cannot move", async () => {
    const [idle, fresh, stuck] = [newSiteId(), newSiteId(), newSiteId()];
    await seedLegacy(idle);
    await ok(
      await legacy(stuck, "migrate", {
        migrations: [migration("stuck", "CREATE VIRTUAL TABLE t USING fts5(a, content='')")],
        maxDatabaseBytes: MAX_DB,
      }),
    );
    const sweep = () =>
      moveSiteDatabases({
        origin: ORIGIN,
        secret: TEST_SECRET,
        siteIds: [idle, fresh, stuck, "NOT-A-SITE"],
        fetch: (url, init) =>
          mf!.dispatchFetch(url, {
            ...(init as object),
            headers: { ...(init.headers as Record<string, string>), "MF-Original-URL": url },
          }) as unknown as Promise<Response>,
      });
    const results = await sweep();
    expect(results.map(({ siteId, status, location }) => ({ siteId, status, location }))).toEqual([
      { siteId: idle, status: 200, location: "eu" },
      { siteId: fresh, status: 200, location: "eu" },
      { siteId: stuck, status: 200, location: "legacy" },
      { siteId: "NOT-A-SITE", status: 0, location: null },
    ]);
    expect(results[2]!.error).toContain("without its own content");
    expect((await legacyStatus(idle)).moved?.site).toBe(idle);
    expect(await legacyStatus(fresh)).toMatchObject({ moved: { site: fresh }, empty: true });
    // Running it again changes nothing.
    expect((await sweep()).map((result) => result.location)).toEqual(["eu", "eu", "legacy", null]);
  });
});
