import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { migrate } from "@opengeni/db/migrate";

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

const CONTAINER = "opengeni-shared-test-pg";
const PORT = 55440;
const PASSWORD = "x";
const APP_PASSWORD = "apppw";
const IMAGE = "pgvector/pgvector:pg16";
const ADMIN_BASE_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}`;

const STATE_DIR = join(tmpdir(), "opengeni-shared-pg");
const LOCK_DIR = join(STATE_DIR, "lock");
const REFCOUNT_FILE = join(STATE_DIR, "refcount");

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

/**
 * Ensure the single shared container is up and the cluster-global opengeni_app
 * role exists, then bump the refcount. Lock-guarded so exactly one parallel
 * worker starts it. Returns false (and does NOT bump the refcount) if docker is
 * unavailable, so callers can skip gracefully — mirroring the old per-file
 * `available = false` behaviour.
 */
async function ensureContainerAndAcquire(): Promise<boolean> {
  return withLock(async () => {
    if (!(await containerRunning())) {
      // Clear any stale refcount left over from a previous crashed run.
      await writeRefcount(0);
      // Remove a stopped leftover of the same name, then start fresh. NOT --rm:
      // the container must survive across the many test-file processes that
      // share it; the last file out removes it explicitly.
      await dockerOk(["rm", "-f", CONTAINER]);
      // ONE container is shared by every DB/API/worker integration test FILE in
      // the parallel `bun test` run. Each file opens its own connection pool (the
      // createDb pool + a superuser admin pool), so dozens of files together can
      // demand many hundreds of simultaneous server connections. Default
      // postgres max_connections=100 would be exhausted ("too many clients"),
      // which surfaces as silently-wrong RLS reads (a freshly-written row not
      // visible) rather than a clean error. Give the throwaway test server a
      // generous ceiling so the whole suite fits. `MAX_CONNECTIONS` keeps the
      // per-file pools small as a second line of defence.
      const started = await dockerOk([
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
      if (!started) {
        return false; // docker unavailable
      }
      try {
        await waitForReady(`${ADMIN_BASE_URL}/postgres`);
        // Provision the cluster-global login role once (per-database GRANTs are
        // applied later, per file, after that file's migrations run).
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
        await dockerOk(["rm", "-f", CONTAINER]);
        throw err;
      }
    }
    await writeRefcount((await readRefcount()) + 1);
    return true;
  });
}

async function releaseContainer(): Promise<void> {
  await withLock(async () => {
    const next = (await readRefcount()) - 1;
    if (next <= 0) {
      await writeRefcount(0);
      await dockerOk(["rm", "-f", CONTAINER]);
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
    await createDatabase(dbName);

    // Apply the full migration chain to this file's database.
    await migrate(adminUrl);

    // Run the same per-database GRANT blocks the migrations would have (they are
    // IF EXISTS-guarded and were skipped while opengeni_app didn't exist at
    // migration time / in a fresh database). pgvector extension is created by
    // 0000_initial inside migrate().
    const admin = postgres(adminUrl, { max: 4 });
    await admin.unsafe(`
      GRANT USAGE ON SCHEMA public TO opengeni_app;
      GRANT USAGE ON SCHEMA opengeni_private TO opengeni_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO opengeni_app;
    `);

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
