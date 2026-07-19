import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { migrate } from "@opengeni/db/migrate";
import { TEST_SERVICE_IMAGES } from "./service-images";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared single-container postgres harness for the DB/API/worker integration
// tests.
//
// WHY THIS EXISTS
// ---------------
// CI runs the whole suite as one parallel `bun test` from the repo root: every
// `*.test.ts` is launched in its own process, all at once. The sandbox/BYO-compute
// integration tests each used to `docker run` their OWN pgvector container on a
// fixed host port. Under full parallelism ~15+ heavy postgres containers spun up
// simultaneously and exhausted the runner (CPU/mem/docker-daemon) — DB ops went
// slow/failed, producing wrong state and flaky assertion failures. (Some fixed
// ports also collided across files, so the second `-p PORT:5432` bind failed.)
//
// THE FIX
// -------
// All of these files now share ONE pgvector container (deterministic name +
// port), started exactly once across the parallel worker processes via a
// filesystem lock, and each test FILE gets its own freshly-created DATABASE
// inside that container. Per-database isolation preserves the previous
// per-container data isolation (separate schema + rows) while collapsing the
// concurrent-container count from ~15 to 1. A lock-guarded refcount file tracks
// how many files are using the container; the last one out removes it.
//
// Tests connect as the NON-superuser `opengeni_app` login role (so FORCE RLS is
// genuinely enforced, exactly as before), with a separate superuser `admin`
// handle used to seed accounts/workspaces (bypassing RLS).
// ---------------------------------------------------------------------------

// Keep the fixed cross-process listener outside Linux's default ephemeral client
// range (32768-60999). A long-lived outbound HTTPS connection can otherwise own
// the same source port and make Docker fail before PostgreSQL ever starts.
const PORT = 61440;
// The container and lock identities include the listener contract. Otherwise a
// long-lived container created by an older worktree on another port can be
// mistaken for this harness merely because its old name still exists.
const CONTAINER = `opengeni-shared-test-pg-${PORT}`;
const PASSWORD = "x";
const APP_PASSWORD = "apppw";
const IMAGE = TEST_SERVICE_IMAGES.pgvectorPg16;
const ADMIN_BASE_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}`;
// A once-migrated database every test file clones from via `CREATE DATABASE ...
// TEMPLATE`. Postgres clones a template with a file-level copy, so each file
// gets a fully-migrated + app-granted database in ~100ms instead of replaying
// the whole 55-migration chain (seconds) per file. Built exactly once per
// container (lock-guarded); `datistemplate=true` is the "ready" sentinel.
//
// INVARIANT: after its one-time build the template is NEVER connected to or
// mutated again — every test file reads/writes only its own clone. This is
// load-bearing: `CREATE DATABASE ... TEMPLATE` requires that no session is
// connected to the source during the copy, so keeping the template quiescent
// is what lets concurrent clones proceed (they serialize on the source but do
// not error) and guarantees every clone is byte-identical to the migrated schema.
//
// The name carries a FINGERPRINT of the migration chain (sorted file names +
// contents). The container OUTLIVES checkouts — it persists across sessions and
// is shared by every worktree on the machine — so a bare name would freeze the
// schema at whichever migration chain first built it: a branch that ADDS a
// migration would then run all its tests against clones missing the new
// column, failing on every touched table. Baking the fingerprint into the name
// gives each distinct chain its own template (built on first use, coexisting
// with older ones), with no rebuild races between checkouts.
const TEMPLATE_DB_PREFIX = "og_test_template_";

/** The migrations dir this checkout's `migrate()` applies (@opengeni/db). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/drizzle", import.meta.url));

let templateDbNameMemo: string | undefined;

/** `og_test_template_<12-hex>` — the fingerprint of THIS checkout's migration
 *  chain. Memoized (the chain cannot change within a process lifetime). */
async function templateDbName(): Promise<string> {
  if (templateDbNameMemo) {
    return templateDbNameMemo;
  }
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    hasher.update(file);
    hasher.update("\0");
    hasher.update(await readFile(join(MIGRATIONS_DIR, file)));
    hasher.update("\0");
  }
  templateDbNameMemo = `${TEMPLATE_DB_PREFIX}${hasher.digest("hex").slice(0, 12)}`;
  return templateDbNameMemo;
}

const STATE_DIR = join(tmpdir(), `opengeni-shared-pg-${PORT}`);
const LOCK_DIR = join(STATE_DIR, "lock");
const REFCOUNT_FILE = join(STATE_DIR, "refcount");
const SHARED_POSTGRES_STARTUP_ATTEMPTS = 3;
const SHARED_POSTGRES_STARTUP_RETRY_DELAY_MS = 250;

export type SharedTestDatabase = {
  /** Superuser connection scoped to this file's own database (bypasses RLS). */
  admin: postgres.Sql;
  /** Superuser URL for this file's database (e.g. to pass to migrate()). */
  adminUrl: string;
  /** opengeni_app (non-superuser) URL for createDb() — FORCE RLS applies. */
  appUrl: string;
  /** Release this file's handle: closes admin + decrements the shared refcount. */
  release: () => Promise<void>;
};

export type BlankTestDatabase = {
  /** Superuser URL for this file's pristine (un-migrated) database. */
  databaseUrl: string;
  /** Release this file's handle: drops the database + decrements the refcount. */
  release: () => Promise<void>;
};

function docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("docker", args, { encoding: "utf8" });
}

async function dockerOk(args: string[]): Promise<boolean> {
  try {
    await docker(args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retry only the shared PostgreSQL container's bounded startup boundary. Test
 * files must not retry migrations or assertions: a persistent Docker failure
 * still leaves the service unavailable, while a short daemon/image race gets
 * three deterministic chances to recover.
 */
export async function retrySharedPostgresStartup(
  attempt: () => Promise<boolean>,
  options: { sleep?: (delayMs: number) => Promise<void> } = {},
): Promise<boolean> {
  const sleep = options.sleep ?? Bun.sleep;
  for (let number = 1; number <= SHARED_POSTGRES_STARTUP_ATTEMPTS; number += 1) {
    if (await attempt().catch(() => false)) {
      return true;
    }
    if (number < SHARED_POSTGRES_STARTUP_ATTEMPTS) {
      await sleep(number * SHARED_POSTGRES_STARTUP_RETRY_DELAY_MS);
    }
  }
  return false;
}

/** A cooperative cross-process lock via atomic mkdir, with stale-lock breaking. */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(STATE_DIR, { recursive: true });
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await mkdir(LOCK_DIR); // atomic: fails if another holder exists
      break;
    } catch {
      // Break a stale lock left by a crashed process (older than 60s).
      try {
        const stat = await import("node:fs/promises").then((m) => m.stat(LOCK_DIR));
        if (Date.now() - stat.mtimeMs > 60_000) {
          await rm(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        // lock vanished between checks — retry the mkdir
      }
      if (Date.now() > deadline) {
        throw new Error("shared-pg: timed out acquiring the container lock");
      }
      await Bun.sleep(50 + Math.random() * 100);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readRefcount(): Promise<number> {
  try {
    return Number.parseInt(await readFile(REFCOUNT_FILE, "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

async function writeRefcount(n: number): Promise<void> {
  await writeFile(REFCOUNT_FILE, String(n), "utf8");
}

async function containerRunning(): Promise<boolean> {
  const { stdout } = await docker([
    "ps",
    "--filter",
    `name=^${CONTAINER}$`,
    "--format",
    "{{.Names}}",
  ]).catch(() => ({ stdout: "" }));
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .includes(CONTAINER);
}

async function waitForReady(url: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        return;
      } finally {
        await probe.end();
      }
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`shared-pg: postgres did not become ready in time: ${String(err)}`, {
          cause: err,
        });
      }
      await Bun.sleep(500);
    }
  }
}

/** Is the migrated template database present and marked ready? */
async function templateReady(): Promise<boolean> {
  const root = postgres(`${ADMIN_BASE_URL}/postgres`, { max: 1 });
  try {
    const rows = await root`
      SELECT 1 FROM pg_database WHERE datname = ${await templateDbName()} AND datistemplate`;
    return rows.length > 0;
  } catch {
    return false;
  } finally {
    await root.end().catch(() => undefined);
  }
}

/**
 * Build the once-per-container template database: CREATE it, run the full
 * migration chain, apply the opengeni_app GRANTs, then flip datistemplate=true
 * as the ready sentinel. Every test file's database is later cloned from it via
 * `CREATE DATABASE ... TEMPLATE`, which skips the migration replay entirely.
 * Called only inside the container lock, so exactly one process builds it; the
 * `datistemplate` guard makes it idempotent and self-healing after a crash
 * mid-build (a leftover non-template DB of the same name is dropped + rebuilt).
 */
async function ensureTemplateBuilt(): Promise<void> {
  if (await templateReady()) {
    return;
  }
  // Drop a partial/crashed leftover (not yet marked as a template) and rebuild.
  const TEMPLATE_DB = await templateDbName();
  const root = postgres(`${ADMIN_BASE_URL}/postgres`, { max: 1 });
  try {
    await root.unsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await root.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`);
  } finally {
    await root.end().catch(() => undefined);
  }

  const templateUrl = `${ADMIN_BASE_URL}/${TEMPLATE_DB}`;
  // Apply the full migration chain once (pgvector extension is created by
  // 0000_initial inside migrate()).
  await migrate(templateUrl);

  // Grant the non-superuser login role the same way each per-file database used
  // to be granted (the migrations' grants are IF EXISTS-guarded and skipped in a
  // fresh database); clones inherit these object grants from the template.
  const grantsSql = postgres(templateUrl, { max: 1 });
  try {
    await grantsSql.unsafe(`
      GRANT USAGE ON SCHEMA public TO opengeni_app;
      GRANT USAGE ON SCHEMA opengeni_private TO opengeni_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO opengeni_app;
    `);
  } finally {
    await grantsSql.end().catch(() => undefined);
  }

  // Flip the ready sentinel. This must run with NO open connections to the
  // template; the migrate + grant pools above are already closed. Marking it a
  // template also lets the subsequent `CREATE DATABASE ... TEMPLATE` proceed.
  const marker = postgres(`${ADMIN_BASE_URL}/postgres`, { max: 1 });
  try {
    await marker.unsafe(
      `UPDATE pg_database SET datistemplate = true WHERE datname = '${TEMPLATE_DB}'`,
    );
  } finally {
    await marker.end().catch(() => undefined);
  }
}

/**
 * Ensure the single shared container is up and the cluster-global opengeni_app
 * role exists, then bump the refcount. Lock-guarded so exactly one parallel
 * worker starts it. Returns false (and does NOT bump the refcount) if docker is
 * unavailable, so callers can skip gracefully — mirroring the old per-file
 * `available = false` behaviour.
 */
async function ensureContainerAndAcquire(): Promise<boolean> {
  return withLock(async () => {
    const startedContainer = !(await containerRunning());
    if (startedContainer) {
      // Clear any stale refcount left over from a previous crashed run.
      await writeRefcount(0);
      // Remove a stopped leftover of the same name, then start fresh. NOT --rm:
      // the container must survive across the many test-file processes that
      // share it; the last file out removes it explicitly.
      // The postgres image declares an anonymous data volume. Remove it with
      // the container or every test-file lifecycle leaks a full migrated
      // cluster into the shared Docker filesystem.
      // ONE container is shared by every DB/API/worker integration test FILE in
      // the parallel `bun test` run. Each file opens its own connection pool (the
      // createDb pool + a superuser admin pool), so dozens of files together can
      // demand many hundreds of simultaneous server connections. Default
      // postgres max_connections=100 would be exhausted ("too many clients"),
      // which surfaces as silently-wrong RLS reads (a freshly-written row not
      // visible) rather than a clean error. Give the throwaway test server a
      // generous ceiling so the whole suite fits. `MAX_CONNECTIONS` keeps the
      // per-file pools small as a second line of defence.
      const started = await retrySharedPostgresStartup(async () => {
        await dockerOk(["rm", "-f", "-v", CONTAINER]);
        return dockerOk([
          "run",
          "-d",
          "-e",
          `POSTGRES_PASSWORD=${PASSWORD}`,
          "-p",
          `${PORT}:5432`,
          "--name",
          CONTAINER,
          IMAGE,
          "-c",
          "max_connections=1000",
          "-c",
          "shared_buffers=256MB",
        ]);
      });
      if (!started) {
        return false; // docker unavailable
      }
    }
    try {
      await waitForReady(`${ADMIN_BASE_URL}/postgres`);
      // A killed test process can leave Docker's independently-running
      // container alive after `docker run` but before cluster bootstrap. Repair
      // the cluster-global role on EVERY acquisition, not only the fresh-start
      // branch; otherwise the running container looks healthy while every
      // FORCE-RLS clone fails with `role opengeni_app does not exist`.
      const admin = postgres(`${ADMIN_BASE_URL}/postgres`, { max: 1 });
      try {
        await admin.unsafe(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
              CREATE ROLE opengeni_app LOGIN PASSWORD '${APP_PASSWORD}';
            END IF;
          END $$;`);
      } finally {
        await admin.end().catch(() => undefined);
      }
    } catch (err) {
      if (startedContainer) await dockerOk(["rm", "-f", "-v", CONTAINER]);
      throw err;
    }
    // Build the once-per-container migrated template (idempotent; self-heals a
    // crashed partial). Inside the lock so exactly one process pays the
    // migration; every acquire after that just clones from it.
    await ensureTemplateBuilt();
    await writeRefcount((await readRefcount()) + 1);
    return true;
  });
}

async function releaseContainer(): Promise<void> {
  await withLock(async () => {
    const next = (await readRefcount()) - 1;
    if (next <= 0) {
      await writeRefcount(0);
      await dockerOk(["rm", "-f", "-v", CONTAINER]);
      await rm(STATE_DIR, { recursive: true, force: true }).catch(() => undefined);
    } else {
      await writeRefcount(next);
    }
  });
}

/** CREATE a uniquely-named database in the shared container. */
async function createDatabase(dbName: string): Promise<void> {
  // CREATE DATABASE cannot run in a transaction and is safe to issue
  // concurrently from many processes.
  const root = postgres(`${ADMIN_BASE_URL}/postgres`, { max: 1 });
  try {
    await root.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await root.end().catch(() => undefined);
  }
}

/**
 * CREATE a uniquely-named database as a clone of the migrated template. Under
 * parallel test-file processes two clones can race and Postgres briefly reports
 * the template as "being accessed by other users" — a transient that clears in
 * milliseconds — so retry a few times before giving up.
 */
async function cloneFromTemplate(dbName: string): Promise<void> {
  const root = postgres(`${ADMIN_BASE_URL}/postgres`, { max: 1 });
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await root.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${await templateDbName()}"`);
        return;
      } catch (err) {
        const message = String((err as { message?: string })?.message ?? err);
        if (
          /being accessed by other users|source database/i.test(message) &&
          Date.now() < deadline
        ) {
          await Bun.sleep(50 + Math.random() * 100);
          continue;
        }
        throw err;
      }
    }
  } finally {
    await root.end().catch(() => undefined);
  }
}

/** Best-effort DROP of this file's database, then decrement the shared refcount. */
async function dropDatabaseAndRelease(dbName: string): Promise<void> {
  const dropper = postgres(`${ADMIN_BASE_URL}/postgres`, { max: 1 });
  await dropper.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
  await dropper.end().catch(() => undefined);
  await releaseContainer();
}

function uniqueDbName(label: string): string {
  return `og_${label
    .replace(/[^a-z0-9]/gi, "_")
    .toLowerCase()
    .slice(0, 24)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Acquire a fresh, fully-migrated database in the shared container for the
 * calling test file. Returns `null` if docker is unavailable so the caller can
 * skip (the same graceful degradation the per-file harness had).
 *
 * The returned database has: the full migration chain applied, the
 * `opengeni_app` role GRANTed on its public/opengeni_private schemas, and a
 * superuser `admin` handle scoped to it. Call `release()` in afterAll.
 */
export async function acquireSharedTestDatabase(
  label = "test",
): Promise<SharedTestDatabase | null> {
  const acquired = await ensureContainerAndAcquire();
  if (!acquired) {
    return null;
  }

  const dbName = uniqueDbName(label);
  const adminUrl = `${ADMIN_BASE_URL}/${dbName}`;
  const appUrl = `postgres://opengeni_app:${APP_PASSWORD}@127.0.0.1:${PORT}/${dbName}`;

  try {
    // Clone this file's database from the once-migrated template. Postgres does a
    // file-level copy, so the fully-migrated schema + opengeni_app grants land in
    // ~100ms instead of replaying the whole migration chain per file.
    await cloneFromTemplate(dbName);

    const admin = postgres(adminUrl, { max: 4 });

    let released = false;
    return {
      admin,
      adminUrl,
      appUrl,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        await admin.end().catch(() => undefined);
        await dropDatabaseAndRelease(dbName);
      },
    };
  } catch (err) {
    await releaseContainer().catch(() => undefined);
    throw err;
  }
}

/**
 * Acquire a fresh, PRISTINE (un-migrated, no app role grants) database in the
 * shared container. For tests that drive the migration chain themselves (e.g.
 * applying individual .sql files to assert a single migration's behaviour). The
 * caller owns connecting to `databaseUrl` (as the superuser) and applying
 * whatever schema it wants. Returns `null` if docker is unavailable.
 */
export async function acquireBlankTestDatabase(label = "blank"): Promise<BlankTestDatabase | null> {
  const acquired = await ensureContainerAndAcquire();
  if (!acquired) {
    return null;
  }

  const dbName = uniqueDbName(label);
  const databaseUrl = `${ADMIN_BASE_URL}/${dbName}`;

  try {
    await createDatabase(dbName);
    let released = false;
    return {
      databaseUrl,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        await dropDatabaseAndRelease(dbName);
      },
    };
  } catch (err) {
    await releaseContainer().catch(() => undefined);
    throw err;
  }
}

// Re-export so callers don't need to import the constant from elsewhere.
export const SHARED_TEST_PG_IMAGE = IMAGE;
