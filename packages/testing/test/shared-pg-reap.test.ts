import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import {
  acquireBlankTestDatabase,
  type BlankTestDatabase,
  currentDatabaseOwner,
  currentProcessIdentity,
  type DatabaseOwner,
  databaseOwnerComment,
  isPerTestDatabaseName,
  isTemplateDatabaseName,
  ownerStatus,
  parseDatabaseOwnerComment,
  parseTemplateStamp,
  quoteIdent,
  quoteLiteral,
  reapOrphanedTestDatabases,
  templateStampComment,
} from "../src/shared-pg";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const DAY = 24 * 60 * 60_000;
// Creating and dropping databases is slow on a busy shared server.
const DB_TEST_TIMEOUT_MS = 120_000;

function hex12(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

describe("ownership records", () => {
  const here = { host: "h", boot: "b", pidns: "pid:[1]" };
  const owner: DatabaseOwner = { ...here, pid: 4242, start: "100" };
  const probe = (alive: boolean, start: string) => ({
    alive: () => alive,
    startTime: () => start,
  });

  test("round-trips through the database comment", () => {
    const mine = currentDatabaseOwner();
    expect(mine.pid).toBe(process.pid);
    expect(parseDatabaseOwnerComment(databaseOwnerComment(mine))).toEqual(mine);
    expect(parseDatabaseOwnerComment(null)).toBeNull();
    expect(parseDatabaseOwnerComment("hand-written note")).toBeNull();
    expect(parseDatabaseOwnerComment("opengeni-test-db:v1 {not json")).toBeNull();
    expect(parseDatabaseOwnerComment('opengeni-test-db:v1 {"pid":-1}')).toBeNull();
  });

  test("a dead owner on this machine is dead; anything unprovable is not", () => {
    expect(ownerStatus(owner, here, probe(false, ""))).toBe("dead");
    expect(ownerStatus(owner, here, probe(true, "100"))).toBe("alive");
    // The pid now belongs to a different process.
    expect(ownerStatus(owner, here, probe(true, "999"))).toBe("dead");
    // Start time unreadable: trust the pid.
    expect(ownerStatus(owner, here, probe(true, ""))).toBe("alive");
    expect(ownerStatus({ ...owner, start: "" }, here, probe(true, "999"))).toBe("alive");
    // Another host, boot or pid namespace: the pid means nothing here.
    for (const other of [{ host: "x" }, { boot: "x" }, { pidns: "pid:[2]" }]) {
      expect(ownerStatus(owner, { ...here, ...other }, probe(false, ""))).toBe("unknown");
    }
  });

  test("this process is alive to itself", () => {
    expect(ownerStatus(currentDatabaseOwner(), currentProcessIdentity())).toBe("alive");
  });
});

describe("naming scheme", () => {
  test("only og_<label>_<12 hex> per-test names are candidates", () => {
    expect(isPerTestDatabaseName("og_test_0123456789ab")).toBe(true);
    expect(isPerTestDatabaseName("og_migration_0107_current_m_e2c21454659f")).toBe(true);
    expect(isPerTestDatabaseName("og__0123456789ab")).toBe(true);
    for (const name of [
      "postgres",
      "template1",
      "opengeni",
      "og_test_template_0123456789ab",
      "og_test_template_0123456789ab_w01234567",
      "og_test_0123456789",
      "og_test_0123456789AB",
      "og_this_label_is_far_too_long_to_be_ours_0123456789ab",
      "xog_test_0123456789ab",
    ]) {
      expect(isPerTestDatabaseName(name)).toBe(false);
    }
    expect(isPerTestDatabaseName("og_a_x_0123456789ab", "og_a_")).toBe(true);
    expect(isPerTestDatabaseName("og_b_x_0123456789ab", "og_a_")).toBe(false);
    // A scope outside the og_ namespace never matches anything.
    expect(isPerTestDatabaseName("og_test_0123456789ab", "x")).toBe(false);
  });

  test("templates are recognised by their fingerprinted names", () => {
    expect(isTemplateDatabaseName("og_test_template_0123456789ab")).toBe(true);
    expect(isTemplateDatabaseName("og_test_template_0123456789ab_w01234567")).toBe(true);
    expect(isTemplateDatabaseName("og_test_template_x")).toBe(false);
    expect(isTemplateDatabaseName("postgres")).toBe(false);
  });

  test("template stamps parse defensively", () => {
    expect(parseTemplateStamp(templateStampComment(123))).toEqual({ lastUsedAt: 123 });
    expect(parseTemplateStamp(null)).toBeNull();
    expect(parseTemplateStamp('opengeni-test-template:v1 {"lastUsedAt":"x"}')).toBeNull();
  });
});

test("reaping errors are reported, never thrown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "og-reap-unreachable-"));
  try {
    const result = await reapOrphanedTestDatabases({
      // Nothing listens on port 1.
      adminUrl: "postgres://postgres:x@127.0.0.1:1/postgres",
      observationsPath: join(directory, "observations.json"),
    });
    expect(result.dropped).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Against the real test PostgreSQL, confined to a unique name scope so other
// runs' databases on a shared server are never considered.
describe("reaping a real cluster", () => {
  let blank: BlankTestDatabase | null = null;
  let adminUrl = "";
  let admin: postgres.Sql | null = null;
  let directory = "";
  const scope = `og_rp${hex12().slice(0, 8)}_`;
  const here = currentProcessIdentity();
  const deadOwner: DatabaseOwner = {
    ...here,
    pid: 0x3fff_fff0, // above any pid_max: never a live process
    start: "1",
  };

  beforeAll(async () => {
    blank = await acquireBlankTestDatabase("reap-admin");
    if (!blank) return;
    const url = new URL(blank.databaseUrl);
    url.pathname = "/postgres";
    adminUrl = url.toString();
    admin = postgres(adminUrl, { max: 2, onnotice: () => undefined });
    directory = await mkdtemp(join(tmpdir(), "og-reap-"));
  }, 120_000);

  afterAll(async () => {
    if (admin) {
      const leftovers = await admin<{ datname: string; datistemplate: boolean }[]>`
        SELECT datname, datistemplate FROM pg_database WHERE starts_with(datname, ${scope})`;
      for (const { datname, datistemplate } of leftovers) {
        if (datistemplate) {
          await admin`UPDATE pg_database SET datistemplate = false WHERE datname = ${datname}`;
        }
        await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(datname)} WITH (FORCE)`);
      }
      const roles = await admin<{ rolname: string }[]>`
        SELECT rolname FROM pg_roles WHERE starts_with(rolname, ${scope})`;
      for (const { rolname } of roles)
        await admin.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(rolname)}`);
      await admin.end();
    }
    await blank?.release();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 120_000);

  async function createDatabase(name: string, comment?: string): Promise<string> {
    await admin!.unsafe(`CREATE DATABASE ${quoteIdent(name)}`);
    if (comment !== undefined) {
      await admin!.unsafe(`COMMENT ON DATABASE ${quoteIdent(name)} IS ${quoteLiteral(comment)}`);
    }
    return name;
  }

  async function exists(name: string): Promise<boolean> {
    const rows = await admin!`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    return rows.length > 0;
  }

  // Each test works in its own sub-scope so leftovers never cross tests.
  function subScope(id: string) {
    const sub = `${scope}${id}_`;
    return {
      sub,
      templatePrefix: `${sub}template_`,
      reap: (overrides: Partial<Parameters<typeof reapOrphanedTestDatabases>[0]> = {}) =>
        reapOrphanedTestDatabases({
          adminUrl,
          observationsPath: join(directory, `${id}.json`),
          scopePrefix: sub,
          templatePrefix: `${sub}template_`,
          ...overrides,
        }),
    };
  }

  test(
    "drops a dead owner's database, keeps a live owner's and a connected one",
    async () => {
      if (!admin) return;
      const { sub, reap } = subScope("o");
      const dead = await createDatabase(`${sub}dead_${hex12()}`, databaseOwnerComment(deadOwner));
      const live = await createDatabase(`${sub}live_${hex12()}`, databaseOwnerComment());
      const connected = await createDatabase(
        `${sub}conn_${hex12()}`,
        databaseOwnerComment(deadOwner),
      );
      const foreign = await createDatabase(
        `${sub}foreign_${hex12()}`,
        databaseOwnerComment({ ...deadOwner, host: `${here.host}-elsewhere` }),
      );
      const offScheme = await createDatabase(`${sub}notours`, databaseOwnerComment(deadOwner));
      // acquireOwnerMigratedTestDatabase's per-database role goes with it.
      await admin.unsafe(`CREATE ROLE ${quoteIdent(`${dead}_owner`.slice(0, 63))} NOLOGIN`);

      const holder = postgres(adminUrl.replace(/\/postgres(\?|$)/u, `/${connected}$1`), { max: 1 });
      try {
        await holder`SELECT 1`;
        const result = await reap();
        expect(result.errors).toEqual([]);
        expect(result.dropped).toEqual([dead]);
        expect(await exists(dead)).toBe(false);
        for (const kept of [live, connected, foreign, offScheme]) {
          expect(await exists(kept)).toBe(true);
        }
        const roles =
          await admin`SELECT 1 FROM pg_roles WHERE rolname = ${`${dead}_owner`.slice(0, 63)}`;
        expect(roles).toHaveLength(0);
      } finally {
        await holder.end();
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "an unowned database is dropped only after staying idle across the window",
    async () => {
      if (!admin) return;
      const { sub, reap } = subScope("i");
      let now = Date.now();
      const clock = { now: () => now, idleWindowMs: 15 * 60_000, pruneTemplates: false };
      const observationsPath = join(directory, "idle.json");
      const idle = await createDatabase(`${sub}idle_${hex12()}`);
      const busy = await createDatabase(`${sub}busy_${hex12()}`);

      // First sighting starts the clock: nothing is dropped yet.
      expect((await reap({ ...clock, observationsPath })).dropped).toEqual([]);

      // The busy one does work in between, so its clock restarts.
      const worker = postgres(adminUrl.replace(/\/postgres(\?|$)/u, `/${busy}$1`), { max: 1 });
      for (let i = 0; i < 3; i += 1) await worker`SELECT 1`;
      await worker.end();
      await Bun.sleep(1_500); // let the server publish the transaction counters

      now += 10 * 60_000;
      expect((await reap({ ...clock, observationsPath })).dropped).toEqual([]);
      now += 10 * 60_000;
      const result = await reap({ ...clock, observationsPath });
      expect(result.dropped).toEqual([idle]);
      expect(await exists(busy)).toBe(true);
      const remembered = JSON.parse(await readFile(observationsPath, "utf8")) as {
        databases: Record<string, unknown>;
      };
      expect(Object.keys(remembered.databases)).toEqual([busy]);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "a failed drop, a lock failure or unwritable state never fails the pass",
    async () => {
      if (!admin) return;
      const { sub, templatePrefix, reap } = subScope("e");
      const dead = await createDatabase(`${sub}dead_${hex12()}`, databaseOwnerComment(deadOwner));
      const stale = await createDatabase(`${templatePrefix}${hex12()}`, templateStampComment(0));
      await admin`UPDATE pg_database SET datistemplate = true WHERE datname = ${stale}`;
      const notADirectory = join(directory, "file");
      await writeFile(notADirectory, "");
      const result = await reap({
        observationsPath: join(notADirectory, "observations.json"),
        withTemplateLock: async () => {
          throw new Error("lock unavailable");
        },
      });
      expect(result.dropped).toEqual([dead]);
      expect(result.templatesDropped).toEqual([]);
      expect(result.errors.some((error) => error.startsWith("observations:"))).toBe(true);
      expect(result.errors.some((error) => error.includes("lock unavailable"))).toBe(true);
      expect(await exists(stale)).toBe(true);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "drops at most maxDrops per pass",
    async () => {
      if (!admin) return;
      const { sub, reap } = subScope("m");
      for (let i = 0; i < 3; i += 1) {
        await createDatabase(`${sub}bulk_${hex12()}`, databaseOwnerComment(deadOwner));
      }
      const first = await reap({ maxDrops: 2, pruneTemplates: false });
      expect(first.dropped).toHaveLength(2);
      const second = await reap({ maxDrops: 2, pruneTemplates: false });
      expect(second.dropped).toHaveLength(1);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "prunes only long-unused templates that this checkout does not need",
    async () => {
      if (!admin) return;
      const { templatePrefix, reap } = subScope("t");
      const now = Date.now();
      const make = async (comment?: string) => {
        const name = await createDatabase(`${templatePrefix}${hex12()}`, comment);
        await admin!`UPDATE pg_database SET datistemplate = true WHERE datname = ${name}`;
        return name;
      };
      const stale = await make(templateStampComment(now - 8 * DAY));
      const recent = await make(templateStampComment(now - DAY));
      const unstamped = await make();
      const mine = await make(templateStampComment(now - 30 * DAY));
      const locks: string[] = [];
      const result = await reap({
        protectedTemplates: [mine],
        withTemplateLock: async (fn) => {
          locks.push("held");
          return fn();
        },
      });
      expect(result.errors).toEqual([]);
      expect(result.templatesDropped).toEqual([stale]);
      expect(locks).toEqual(["held"]);
      expect(await exists(stale)).toBe(false);
      for (const kept of [recent, unstamped, mine]) expect(await exists(kept)).toBe(true);
      // An unstamped (older checkout's) template starts its retention clock now.
      const [row] = await admin`
      SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database
       WHERE datname = ${unstamped}`;
      expect(parseTemplateStamp(row!.comment as string)?.lastUsedAt).toBeGreaterThanOrEqual(now);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test("the harness records its owner and a detached reaper cleans up after a killed run", async () => {
    if (!admin) return;
    const state = await mkdtemp(join(tmpdir(), "og-reap-harness-"));
    try {
      const env = {
        ...process.env,
        TMPDIR: state,
        OPENGENI_TEST_PG_URL: adminUrl,
        OPENGENI_TEST_PG_NATIVE: undefined,
        OPENGENI_TEST_PG_REAP: "0",
        OPENGENI_TEST_PG_REAP_SCOPE: scope,
      };
      // A test process that acquires a database and dies without releasing it.
      const victim = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `const { acquireBlankTestDatabase } = await import("@opengeni/testing/shared-pg");
           const db = await acquireBlankTestDatabase(${JSON.stringify(scope.slice(3) + "victim")});
           console.log(new URL(db.databaseUrl).pathname.slice(1));
           process.exit(0);`,
        ],
        { cwd: root, env, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(victim.stdout).text(),
        new Response(victim.stderr).text(),
        victim.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const orphan = stdout.trim();
      expect(orphan.startsWith(scope)).toBe(true);
      const [row] = await admin`
        SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database
         WHERE datname = ${orphan}`;
      expect(parseDatabaseOwnerComment(row!.comment as string)?.pid).toBe(victim.pid);

      // The next acquisition starts the background reaper, which drops it.
      const next = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `const { acquireBlankTestDatabase } = await import("@opengeni/testing/shared-pg");
           const db = await acquireBlankTestDatabase("reap-next");
           await db.release();`,
        ],
        {
          cwd: root,
          env: { ...env, OPENGENI_TEST_PG_REAP: undefined },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await next.exited).toBe(0);
      const deadline = Date.now() + 60_000;
      while ((await exists(orphan)) && Date.now() < deadline) await Bun.sleep(250);
      expect(await exists(orphan)).toBe(false);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  }, 240_000);
});
