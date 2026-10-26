import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import {
  acquireBlankTestDatabase,
  type BlankTestDatabase,
  checkoutTemplateDbName,
  currentDatabaseOwner,
  DB_RETAINED_COMMENT,
  currentProcessIdentity,
  type DatabaseOwner,
  databaseOwnerComment,
  isPerTestDatabaseName,
  isTemplateDatabaseName,
  ownerStatus,
  parseDatabaseOwnerComment,
  parseTemplateStamp,
  processStartTime,
  type ProcessIdentity,
  quoteIdent,
  quoteLiteral,
  reapOrphanedTestDatabases,
  templateSourceFiles,
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
    expect(parseTemplateStamp(templateStampComment(123))).toEqual({
      lastUsedAt: 123,
      by: "harness",
    });
    expect(parseTemplateStamp(templateStampComment(5, "reaper"))?.by).toBe("reaper");
    // Stamps written before the author was recorded count as the reaper's.
    expect(parseTemplateStamp('opengeni-test-template:v1 {"lastUsedAt":7}')).toEqual({
      lastUsedAt: 7,
      by: "reaper",
    });
    expect(parseTemplateStamp(null)).toBeNull();
    expect(parseTemplateStamp('opengeni-test-template:v1 {"lastUsedAt":"x"}')).toBeNull();
  });
});

test("checkouts at different paths with the same inputs share a template", async () => {
  const packages = join(root, "packages");
  const files = await templateSourceFiles(packages);
  expect(files).toContain("db/src/migrate.ts");
  expect(files).toContain("db/src/provision-roles.ts");
  expect(files.some((file) => file.startsWith("contracts/src/"))).toBe(true);
  // Only what the build loads: not the harness, and not packages (or files)
  // outside the migration runner's import closure.
  expect(files.some((file) => file.startsWith("testing/"))).toBe(false);
  expect(files.some((file) => file.startsWith("web/") || file.startsWith("worker/"))).toBe(false);
  const sources = [...new Set(files.map((file) => file.split("/").slice(0, 2).join("/")))];
  const directory = await mkdtemp(join(tmpdir(), "og-template-name-"));
  try {
    // A checkout elsewhere: same manifests, sources linked rather than copied.
    const checkout = async (name: string) => {
      const target = join(directory, name, "nested", "packages");
      for (const entry of await readdir(packages)) {
        const manifest = join(packages, entry, "package.json");
        if (!(await Bun.file(manifest).exists())) continue;
        await mkdir(join(target, entry), { recursive: true });
        await cp(manifest, join(target, entry, "package.json"));
      }
      await symlink(join(packages, "db/drizzle"), join(target, "db/drizzle"));
      for (const source of sources) await symlink(join(packages, source), join(target, source));
      return target;
    };
    const first = await checkout("worktree-a");
    const second = await checkout("somewhere-else");
    const name = await checkoutTemplateDbName(packages);
    expect(name).toMatch(/^og_test_template_[0-9a-f]{12}$/u);
    expect(await checkoutTemplateDbName(first)).toBe(name);
    expect(await checkoutTemplateDbName(second)).toBe(name);
    // A change to anything the migration runner can load is a new template,
    // including files in other packages it imports.
    await rm(join(second, "config/src"));
    await cp(join(packages, "config/src"), join(second, "config/src"), { recursive: true });
    expect(await checkoutTemplateDbName(second)).toBe(name);
    // A file it never loads changes nothing.
    await writeFile(join(second, "config/src", "unrelated-new-file.ts"), "export {};\n");
    expect(await checkoutTemplateDbName(second)).toBe(name);
    const file = files.find((entry) => entry.startsWith("config/src/") && entry.endsWith(".ts"));
    await appendFile(join(second, file!), "\n");
    expect(await checkoutTemplateDbName(second)).not.toBe(name);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

// Against the real test PostgreSQL, confined to a unique name scope and a
// made-up machine identity: every other reaper on a shared server sees these
// owners as foreign (never provably dead), and this test's passes only look
// at its own scope.
describe("reaping a real cluster", () => {
  let blank: BlankTestDatabase | null = null;
  let adminUrl = "";
  let admin: postgres.Sql | null = null;
  let directory = "";
  const scope = `og_rp${hex12().slice(0, 8)}_`;
  const here: ProcessIdentity = {
    host: `og-reap-test-${hex12()}`,
    boot: "reap-test-boot",
    pidns: "pid:[reap-test]",
  };
  const deadOwner: DatabaseOwner = {
    ...here,
    pid: 0x3fff_fff0, // above any pid_max: never a live process
    start: "1",
  };
  const liveOwner: DatabaseOwner = {
    ...here,
    pid: process.pid,
    start: processStartTime(process.pid),
  };

  beforeAll(async () => {
    blank = await acquireBlankTestDatabase("reap-admin");
    if (!blank) return;
    const url = new URL(blank.databaseUrl);
    url.pathname = "/postgres";
    adminUrl = url.toString();
    admin = postgres(adminUrl, { max: 4, onnotice: () => undefined });
    directory = await mkdtemp(join(tmpdir(), "og-reap-"));
  }, 120_000);

  afterAll(async () => {
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (admin) {
        const sql = admin;
        const leftovers = await sql<{ datname: string; datistemplate: boolean }[]>`
          SELECT datname, datistemplate FROM pg_database WHERE starts_with(datname, ${scope})`;
        // Each drop waits for a checkpoint; a few at a time keeps this short.
        const queue = [...leftovers];
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            for (let next = queue.shift(); next; next = queue.shift()) {
              try {
                if (next.datistemplate) {
                  await sql`UPDATE pg_database SET datistemplate = false WHERE datname = ${next.datname}`;
                }
                await sql.unsafe(
                  `DROP DATABASE IF EXISTS ${quoteIdent(next.datname)} WITH (FORCE)`,
                );
              } catch (error) {
                console.warn(`could not drop ${next.datname}: ${String(error)}`);
              }
            }
          }),
        );
        const roles = await sql<{ rolname: string }[]>`
          SELECT rolname FROM pg_roles WHERE starts_with(rolname, ${scope})`;
        for (const { rolname } of roles) {
          await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(rolname)}`).catch(() => undefined);
        }
      }
    } finally {
      await admin?.end().catch(() => undefined);
      await blank?.release();
    }
  }, 300_000);

  async function createDatabase(name: string, comment?: string): Promise<string> {
    await admin!.unsafe(`CREATE DATABASE ${quoteIdent(name)}`);
    if (comment !== undefined) {
      await admin!.unsafe(`COMMENT ON DATABASE ${quoteIdent(name)} IS ${quoteLiteral(comment)}`);
    }
    return name;
  }

  async function createTemplate(name: string, comment?: string): Promise<string> {
    await createDatabase(name, comment);
    await admin!`UPDATE pg_database SET datistemplate = true WHERE datname = ${name}`;
    return name;
  }

  async function exists(name: string): Promise<boolean> {
    const rows = await admin!`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    return rows.length > 0;
  }

  function databaseUrl(name: string): string {
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    return url.toString();
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
          here,
          ...overrides,
        }),
    };
  }

  test(
    "drops a dead owner's database and keeps live, connected, foreign and retained ones",
    async () => {
      if (!admin) return;
      const { sub, reap } = subScope("o");
      const dead = await createDatabase(`${sub}dead_${hex12()}`, databaseOwnerComment(deadOwner));
      const kept = [
        await createDatabase(`${sub}live_${hex12()}`, databaseOwnerComment(liveOwner)),
        await createDatabase(
          `${sub}foreign_${hex12()}`,
          databaseOwnerComment(currentDatabaseOwner()),
        ),
        await createDatabase(`${sub}retained_${hex12()}`, DB_RETAINED_COMMENT),
        await createDatabase(`${sub}noted_${hex12()}`, "kept by hand for a bisect"),
        await createDatabase(`${sub}notours`, databaseOwnerComment(deadOwner)),
      ];
      const connected = await createDatabase(
        `${sub}conn_${hex12()}`,
        databaseOwnerComment(deadOwner),
      );
      kept.push(connected);
      // acquireOwnerMigratedTestDatabase's per-database role goes with it.
      await admin.unsafe(`CREATE ROLE ${quoteIdent(`${dead}_owner`.slice(0, 63))} NOLOGIN`);

      const holder = postgres(databaseUrl(connected), { max: 1 });
      try {
        await holder`SELECT 1`;
        const result = await reap();
        expect(result.errors).toEqual([]);
        expect(result.dropped).toEqual([dead]);
        expect(await exists(dead)).toBe(false);
        for (const name of kept) expect(await exists(name)).toBe(true);
        const roles = await admin`
          SELECT 1 FROM pg_roles WHERE rolname = ${`${dead}_owner`.slice(0, 63)}`;
        expect(roles).toHaveLength(0);
      } finally {
        await holder.end();
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "unverifiable databases go only after staying idle across their window",
    async () => {
      if (!admin) return;
      const { sub, templatePrefix, reap } = subScope("i");
      let now = Date.now();
      const minute = 60_000;
      const clock = { now: () => now, pruneTemplates: false };
      const idle = await createDatabase(`${sub}idle_${hex12()}`);
      const busy = await createDatabase(`${sub}busy_${hex12()}`);
      // An owner on another machine may simply not have connected yet.
      const foreign = await createDatabase(
        `${sub}foreign_${hex12()}`,
        databaseOwnerComment({ ...deadOwner, host: `${here.host}-elsewhere` }),
      );
      // A template build that crashed, or a prune cut off after unmarking.
      const unmarked = await createDatabase(`${templatePrefix}${hex12()}`);

      // First sighting starts every clock: nothing is dropped yet.
      expect((await reap(clock)).dropped).toEqual([]);

      // A client connects to the busy one in between, so its clock restarts.
      const sessions = async () => {
        const [row] = await admin!`
          SELECT coalesce(sessions, 0)::text AS n
            FROM pg_stat_database WHERE datname = ${busy}`;
        return (row?.n as string | undefined) ?? "0";
      };
      const before = await sessions();
      const worker = postgres(databaseUrl(busy), { max: 1 });
      for (let i = 0; i < 3; i += 1) await worker`SELECT 1`;
      await worker.end();
      for (let i = 0; i < 100 && (await sessions()) === before; i += 1) await Bun.sleep(100);
      expect(await sessions()).not.toBe(before);

      now += 10 * minute;
      expect((await reap(clock)).dropped).toEqual([]);
      now += 10 * minute;
      expect((await reap(clock)).dropped.sort()).toEqual([idle, unmarked].sort());
      expect(await exists(busy)).toBe(true);
      expect(await exists(foreign)).toBe(true);

      now += 7 * 60 * minute;
      expect((await reap(clock)).dropped.sort()).toEqual([busy, foreign].sort());
      const remembered = JSON.parse(await readFile(join(directory, "i.json"), "utf8")) as {
        databases: Record<string, unknown>;
      };
      expect(remembered.databases).toEqual({});
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "a failed drop, a lock failure or unwritable state never fails the pass",
    async () => {
      if (!admin) return;
      const { sub, templatePrefix, reap } = subScope("e");
      const dead = await createDatabase(`${sub}dead_${hex12()}`, databaseOwnerComment(deadOwner));
      const stale = await createTemplate(`${templatePrefix}${hex12()}`, templateStampComment(0));
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
    "prunes long-unused templates under the lock and never this checkout's",
    async () => {
      if (!admin) return;
      const { templatePrefix, reap } = subScope("t");
      const now = Date.now();
      const stale = await createTemplate(
        `${templatePrefix}${hex12()}`,
        templateStampComment(now - 8 * DAY),
      );
      const recent = await createTemplate(
        `${templatePrefix}${hex12()}`,
        templateStampComment(now - DAY),
      );
      const unstamped = await createTemplate(`${templatePrefix}${hex12()}`);
      const mine = await createTemplate(
        `${templatePrefix}${hex12()}`,
        templateStampComment(now - 30 * DAY),
      );
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
      // An older checkout's unstamped template starts the reaper's clock now.
      const [row] = await admin`
        SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database
         WHERE datname = ${unstamped}`;
      const stamp = parseTemplateStamp(row!.comment as string);
      expect(stamp?.by).toBe("reaper");
      expect(stamp?.lastUsedAt).toBeGreaterThanOrEqual(now);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "keeps the most recently used templates, gives older checkouts' templates longer, and drops a few per pass",
    async () => {
      if (!admin) return;
      const { templatePrefix, reap } = subScope("c");
      const now = Date.now();
      const hour = 60 * 60_000;
      const make = (idleMs: number, by: "harness" | "reaper" = "harness") =>
        createTemplate(`${templatePrefix}${hex12()}`, templateStampComment(now - idleMs, by));
      const newest = await make(hour);
      const settling = await make(5 * hour);
      const idle = await make(10 * hour);
      const older = await make(2 * DAY);
      // Only the reaper ever stamped these (an older checkout uses them).
      const legacyInUse = await make(DAY, "reaper");
      const legacyGone = await make(3 * DAY, "reaper");
      const options = { templateKeep: 1, templateMinIdleMs: 6 * hour, maxTemplateDrops: 2 };

      const first = await reap(options);
      expect(first.errors).toEqual([]);
      // Longest idle first, two per pass.
      expect(first.templatesDropped).toEqual([legacyGone, older]);
      const second = await reap(options);
      expect(second.templatesDropped).toEqual([idle]);
      for (const kept of [newest, settling, legacyInUse]) expect(await exists(kept)).toBe(true);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test(
    "prunes idle templates sooner once there are more than the soft cap",
    async () => {
      if (!admin) return;
      const { templatePrefix, reap } = subScope("p");
      const now = Date.now();
      const hour = 60 * 60_000;
      const make = (idleMs: number, by: "harness" | "reaper" = "harness") =>
        createTemplate(`${templatePrefix}${hex12()}`, templateStampComment(now - idleMs, by));
      const newest = await make(2 * hour);
      const a = await make(2 * hour + 1000);
      const b = await make(3 * hour);
      const legacy = await make(3 * hour, "reaper");
      const options = {
        templateKeep: 1,
        templateMinIdleMs: 6 * hour,
        templatePressureIdleMs: hour,
        maxTemplateDrops: 5,
      };
      // Under the cap the 6-hour rule applies: nothing is idle long enough.
      const relaxed = await reap({ ...options, templateSoftCap: 10 });
      expect(relaxed.templatesDropped).toEqual([]);
      const pressed = await reap({ ...options, templateSoftCap: 2 });
      expect(pressed.errors).toEqual([]);
      expect(pressed.templatesDropped).toEqual([b, a]);
      // The most recent one, and an older checkout's, keep their own clocks.
      for (const kept of [newest, legacy]) expect(await exists(kept)).toBe(true);
    },
    DB_TEST_TIMEOUT_MS,
  );

  test("the harness records its owner and its own detached reaper cleans up after a killed run", async () => {
    if (!admin) return;
    const state = await mkdtemp(join(tmpdir(), "og-reap-harness-"));
    const stateDir = async () =>
      join(state, (await readdir(state)).find((entry) => entry.startsWith("opengeni-"))!);
    let reaperPid: number | null = null;
    const reaperExited = async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (reaperPid !== null && Date.now() < deadline) {
        try {
          process.kill(reaperPid, 0);
        } catch {
          return; // the reaper finished
        }
        await Bun.sleep(250);
      }
    };
    try {
      const env = {
        ...process.env,
        TMPDIR: state,
        OPENGENI_TEST_PG_URL: adminUrl,
        OPENGENI_TEST_PG_NATIVE: undefined,
        OPENGENI_TEST_PG_REAP: "0",
        // Scoped names and a scoped machine identity: only this test's own
        // reaper can judge the orphan's owner dead.
        OPENGENI_TEST_PG_REAP_SCOPE: scope,
        CI: undefined,
      };
      // A test process that acquires a database and dies without releasing it.
      const victim = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `const { acquireBlankTestDatabase } = await import("@opengeni/testing/shared-pg");
             const db = await acquireBlankTestDatabase(${JSON.stringify(`${scope.slice(3)}victim`)});
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
      const owner = parseDatabaseOwnerComment(row!.comment as string);
      expect(owner?.pid).toBe(victim.pid);
      expect(owner?.host.endsWith(`#${scope}`)).toBe(true);

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
      const marker = JSON.parse(await readFile(join(await stateDir(), "reaper.json"), "utf8")) as {
        pid: number;
      };
      reaperPid = marker.pid;
      await reaperExited(60_000);
      expect(await exists(orphan)).toBe(false);
      // Proof it was this harness's reaper, not another one on the server.
      const log = await readFile(join(await stateDir(), "reaper.log"), "utf8");
      expect(log).toContain(orphan);
    } finally {
      // A reaper still running would recreate its state directory.
      await reaperExited(30_000);
      await rm(state, { recursive: true, force: true });
    }
  }, 240_000);
});
