import { execFile, spawn } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat as statPath,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";

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
// concurrent-container count from ~15 to 1. A lock-guarded holder set tracks
// exact acquisitions against the current container id. The container stays up
// for the test command (and can be reused by the next command); removing and
// immediately rebinding its fixed port is racy on Docker Desktop/OrbStack.
//
// Tests connect as the NON-superuser `opengeni_app` login role (so FORCE RLS is
// genuinely enforced, exactly as before), with a separate superuser `admin`
// handle used to seed accounts/workspaces (bypassing RLS).
//
// OPENGENI_TEST_PG_URL explicitly selects an existing native PostgreSQL cluster
// with pgvector installed. It must name a superuser maintenance connection:
// this harness creates isolated test databases and restricted roles there, but
// never starts/stops the server or changes the supplied maintenance database.
//
// REAPING ORPHANS
// ---------------
// A test process that is killed or crashes never drops its database, and the
// server outlives every run, so orphans used to pile up until the disk filled.
// Every database the harness creates now carries its owner (host, boot id, pid
// namespace, pid, process start time) as its database comment, and every
// acquisition stamps the template it clones with a last-used time. At most
// once per REAP_INTERVAL_MS per state directory, an acquisition (or the last
// holder's release) starts one detached background reaper (`--reap` below,
// logic in reapOrphanedTestDatabases) that drops, without FORCE:
//   - per-test `og_<label>_<12 hex>` databases with no connections whose owner
//     provably died on this machine;
//   - unowned ones (older checkouts) idle with no connections and no
//     transactions across a 15-minute window of reaper passes;
//   - templates unused for 7 days, except this checkout's own (a clone whose
//     template vanished rebuilds it under the lock).
// Reaping is best effort: it never blocks or fails a test, and its notes go to
// `reaper.log` in the state directory. OPENGENI_TEST_PG_REAP=0 turns it off.
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
const IMAGE = "pgvector/pgvector:pg16";
const NATIVE_PG_URL = process.env.OPENGENI_TEST_PG_URL?.trim() || undefined;
const ADMIN_URL = NATIVE_PG_URL ?? `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const adminConnection = new URL(ADMIN_URL);
if (!["postgres:", "postgresql:"].includes(adminConnection.protocol)) {
  throw new Error("shared-pg: OPENGENI_TEST_PG_URL must be a PostgreSQL connection URL");
}

/** Replace only the database/role, preserving native TLS and connection options. */
function databaseUrl(database: string, role?: string, password?: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (role !== undefined) url.username = role;
  if (password !== undefined) url.password = password;
  return url.toString();
}
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
// The name carries a FINGERPRINT of every input that defines the template:
// migration files, the migration runner, and the runtime-role provisioning
// contract. The container OUTLIVES checkouts — it persists across sessions and
// is shared by every worktree on the machine — so a bare name would freeze the
// schema/ACLs at whichever checkout first built it. Baking every template input
// into the name gives each exact contract its own immutable template.
const TEMPLATE_DB_PREFIX = "og_test_template_";

/** The migrations dir this checkout's `migrate()` applies (@opengeni/db). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/drizzle", import.meta.url));
const TEMPLATE_CONTRACT_FILES = [
  fileURLToPath(new URL("../../db/src/migrate.ts", import.meta.url)),
  fileURLToPath(new URL("../../db/src/migration-postgres-compatibility.ts", import.meta.url)),
  fileURLToPath(new URL("../../db/src/knowledge-migration.ts", import.meta.url)),
  fileURLToPath(new URL("../../db/src/provision-roles.ts", import.meta.url)),
  fileURLToPath(new URL("../../db/src/runtime-posture.ts", import.meta.url)),
] as const;

let templateDbNameMemo: string | undefined;

/**
 * Migrations a variant template records in its ledger without applying, for
 * test files that characterize the world before a maintenance cutover (for
 * example a provider's legacy runtime before its drained subscription-core
 * cutover). Every other migration applies as usual.
 */
export type SharedTestDatabaseOptions = {
  withheldMigrations?: readonly string[];
};

/** `og_test_template_<12-hex>` — the fingerprint of THIS checkout's migration
 *  chain, plus `_w<8-hex>` for a variant that withholds migrations. Memoized
 *  (the chain cannot change within a process lifetime). */
async function templateDbName(withheld: readonly string[] = []): Promise<string> {
  const base = await baseTemplateDbName();
  if (withheld.length === 0) return base;
  const variant = new Bun.CryptoHasher("sha256")
    .update([...new Set(withheld)].sort().join("\0"))
    .digest("hex")
    .slice(0, 8);
  return `${base}_w${variant}`;
}

async function baseTemplateDbName(): Promise<string> {
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
  for (const file of TEMPLATE_CONTRACT_FILES) {
    hasher.update(file);
    hasher.update("\0");
    hasher.update(await readFile(file));
    hasher.update("\0");
  }
  templateDbNameMemo = `${TEMPLATE_DB_PREFIX}${hasher.digest("hex").slice(0, 12)}`;
  return templateDbNameMemo;
}

const STATE_DIR = join(
  tmpdir(),
  NATIVE_PG_URL
    ? `opengeni-native-test-pg-${Bun.hash(`${adminConnection.hostname}:${adminConnection.port || "5432"}`).toString(16)}`
    : `opengeni-shared-pg-${PORT}`,
);
const LOCK_DIR = join(STATE_DIR, "lock");
const LOCK_OWNER_FILE = join(LOCK_DIR, "owner.json");
const CONTAINER_STATE_FILE = join(STATE_DIR, "container.json");
const REAPER_MARKER_FILE = join(STATE_DIR, "reaper.json");
const REAPER_OBSERVATIONS_FILE = join(STATE_DIR, "reaper-observations.json");
const REAPER_LOG_FILE = join(STATE_DIR, "reaper.log");
const REAP_INTERVAL_MS = 5 * 60_000;
const TEMPLATE_STAMP_REFRESH_MS = 60 * 60_000;

type LockOwner = {
  pid: number;
  token: string;
};

type ContainerHandle = {
  generation: string;
  token: string;
  native?: true;
};

type ContainerState = {
  generation: string;
  holders: Record<string, { pid: number }>;
};

export type SharedTestDatabase = {
  /** Superuser connection scoped to this file's own database (bypasses RLS). */
  admin: postgres.Sql;
  /** Superuser URL for this file's database (e.g. to pass to migrate()). */
  adminUrl: string;
  /** opengeni_app (non-superuser) URL for createDb() — FORCE RLS applies. */
  appUrl: string;
  /** Release this file's exact holder and close its admin pool. */
  release: () => Promise<void>;
};

export type BlankTestDatabase = {
  /** Superuser URL for this file's pristine (un-migrated) database. */
  databaseUrl: string;
  /**
   * The shared cluster's real app-role password. Pass this to `provisionRoles`
   * instead of rotating the cluster-wide `opengeni_app` role from one test.
   */
  appPassword?: string;
  /** Release this file's handle: drops the database + decrements the refcount. */
  release: () => Promise<void>;
};

export type OwnerMigratedTestDatabase = {
  /**
   * URL of the NOSUPERUSER NOBYPASSRLS role that OWNS this database. Drive
   * `migrate()` through this URL to reproduce Opengeni's production migration
   * principal, for whom `FORCE ROW LEVEL SECURITY` genuinely engages.
   */
  ownerUrl: string;
  /** Name of that owner role (useful for catalog assertions). */
  ownerRole: string;
  /** Superuser URL for the same database — seeding + RLS-free ground truth. */
  adminUrl: string;
  /** Superuser pool scoped to the same database. */
  admin: postgres.Sql;
  /**
   * The password the shared container's `opengeni_app` role actually has.
   *
   * PostgreSQL roles are CLUSTER-wide, not per-database, so `provisionRoles`
   * with `rlsStrategy: "force"` issues `ALTER ROLE opengeni_app … PASSWORD` that
   * takes effect for EVERY database in the container - including the shared
   * template every other test file connects to. Passing a fresh password there
   * makes concurrent shared-harness tests fail `28P01`, and passes in isolation,
   * so pass this value instead and keep the ALTER an idempotent re-assertion.
   */
  appPassword: string;
  /** Drops the database, then the owner role, and decrements the refcount. */
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

async function startSharedContainer(args: string[], minimumAttempts = 1): Promise<string | null> {
  const attempts = Math.max(process.env.OPENGENI_REQUIRE_REAL_DB === "1" ? 5 : 1, minimumAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = await docker(args).catch(() => null);
    const startedId = started?.stdout.trim() ?? "";
    if (/^[a-f0-9]{64}$/u.test(startedId)) {
      return startedId;
    }

    // `docker run` is outcome-ambiguous when the daemon briefly stops
    // answering: the named container may have been created despite the failed
    // client call. Re-probe that exact name before attempting another create.
    const probe = await probeContainer();
    if (probe.available && probe.id) {
      if (probe.status === "running" || probe.status === "restarting") {
        return probe.id;
      }
      const resumed =
        probe.status === "paused"
          ? await dockerOk(["unpause", probe.id])
          : await dockerOk(["start", probe.id]);
      if (resumed) {
        return probe.id;
      }
      await dockerOk(["rm", "-f", "-v", probe.id]);
    }

    if (attempt < attempts) {
      await Bun.sleep(250 * attempt);
    }
  }
  return null;
}

async function readLockOwner(): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(LOCK_OWNER_FILE, "utf8")) as Partial<LockOwner>;
    return typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === "string"
      ? { pid: parsed.pid, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Cooperative cross-process lock via atomic mkdir.
 *
 * A migration-template build can legitimately take minutes on a loaded CI host.
 * Lock age therefore cannot prove abandonment: only a missing/dead owner may be
 * reclaimed. The token also prevents an old holder from deleting a successor's
 * lock during cleanup.
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(STATE_DIR, { recursive: true });
  const deadline = Date.now() + 600_000;
  const token = crypto.randomUUID();
  for (;;) {
    let acquired = false;
    try {
      await mkdir(LOCK_DIR); // atomic: fails if another holder exists
      acquired = true;
    } catch {
      // Reclaim only a lock whose owner is provably gone. A holder can remain
      // healthy past any wall-clock threshold while it builds the template.
      try {
        const stat = await import("node:fs/promises").then((m) => m.stat(LOCK_DIR));
        const owner = await readLockOwner();
        const ownerGone = owner ? !processIsAlive(owner.pid) : Date.now() - stat.mtimeMs > 30_000;
        if (ownerGone) {
          await rm(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        // lock vanished between checks — retry the mkdir
      }
    }
    if (acquired) {
      try {
        await writeFile(LOCK_OWNER_FILE, JSON.stringify({ pid: process.pid, token }), "utf8");
      } catch (error) {
        await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      break;
    }
    if (Date.now() > deadline) {
      throw new Error("shared-pg: timed out acquiring the container lock");
    }
    await Bun.sleep(50 + Math.random() * 100);
  }
  try {
    return await fn();
  } finally {
    const owner = await readLockOwner();
    if (owner?.token === token) {
      await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function readContainerState(): Promise<ContainerState | null> {
  let source: string;
  try {
    source = await readFile(CONTAINER_STATE_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: Partial<ContainerState>;
  try {
    parsed = JSON.parse(source) as Partial<ContainerState>;
  } catch (error) {
    throw new Error("shared-pg: container holder state is malformed", { cause: error });
  }
  if (
    typeof parsed.generation !== "string" ||
    !/^[a-f0-9]{64}$/u.test(parsed.generation) ||
    !parsed.holders ||
    typeof parsed.holders !== "object" ||
    Array.isArray(parsed.holders)
  ) {
    throw new Error("shared-pg: container holder state has an invalid shape");
  }
  const holders: ContainerState["holders"] = {};
  for (const [token, holder] of Object.entries(parsed.holders)) {
    if (
      !/^[0-9a-f-]{36}$/iu.test(token) ||
      !holder ||
      typeof holder !== "object" ||
      typeof (holder as { pid?: unknown }).pid !== "number" ||
      !Number.isSafeInteger((holder as { pid: number }).pid) ||
      (holder as { pid: number }).pid <= 0
    ) {
      throw new Error("shared-pg: container holder state has an invalid holder");
    }
    holders[token] = { pid: (holder as { pid: number }).pid };
  }
  return { generation: parsed.generation, holders };
}

async function writeContainerState(state: ContainerState): Promise<void> {
  const temporaryPath = join(STATE_DIR, `.container-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
    await rename(temporaryPath, CONTAINER_STATE_FILE);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

type ContainerProbe =
  | { available: true; id: string | null; status: string | null }
  | { available: false };

async function probeContainer(): Promise<ContainerProbe> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await docker([
        "inspect",
        "--type",
        "container",
        "--format",
        "{{.Id}}\t{{.State.Status}}",
        CONTAINER,
      ]);
      const [id, status, ...extra] = result.stdout.trim().split("\t");
      if (extra.length > 0 || !id || !/^[a-f0-9]{64}$/u.test(id) || !status) {
        throw new Error("shared-pg: Docker returned an invalid container inspection");
      }
      return { available: true, id, status };
    } catch (error) {
      const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
      if (/no such (object|container)/iu.test(stderr)) {
        return { available: true, id: null, status: null };
      }
    }
    await Bun.sleep(100 * (attempt + 1));
  }
  return { available: false };
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
async function templateReady(withheld: readonly string[] = []): Promise<boolean> {
  const root = postgres(ADMIN_URL, { max: 1 });
  try {
    const rows = await root`
      SELECT 1 FROM pg_database WHERE datname = ${await templateDbName(withheld)} AND datistemplate`;
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
async function ensureTemplateBuilt(withheld: readonly string[] = []): Promise<void> {
  if (await templateReady(withheld)) {
    return;
  }
  const { migrate } = await import("@opengeni/db/migrate");
  const { provisionRoles } = await import("@opengeni/db/provision-roles");
  // Drop a partial/crashed leftover (not yet marked as a template) and rebuild.
  const TEMPLATE_DB = await templateDbName(withheld);
  const root = postgres(ADMIN_URL, { max: 1 });
  try {
    await root.unsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await root.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`);
  } finally {
    await root.end().catch(() => undefined);
  }

  const templateUrl = databaseUrl(TEMPLATE_DB);
  if (withheld.length > 0) {
    // A variant records its withheld migrations as applied so migrate()
    // skips exactly those (same ledger shape migrate() creates).
    const known = new Set((await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")));
    const unknown = withheld.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(`shared-pg: unknown withheld migrations: ${unknown.join(", ")}`);
    }
    const ledger = postgres(templateUrl, { max: 1, onnotice: () => undefined });
    try {
      await ledger.unsafe(
        `CREATE TABLE "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,
      );
      for (const name of new Set(withheld)) {
        await ledger`INSERT INTO "schema_migrations" ("name") VALUES (${name})`;
      }
    } finally {
      await ledger.end().catch(() => undefined);
    }
  }
  // Apply the full migration chain once (pgvector extension is created by
  // 0000_initial inside migrate()).
  await migrate(templateUrl);

  // Apply the exact production role/DML contract. Clones inherit these object
  // grants from the template, including the intentional absence of access to
  // schema_migrations and one-time repair-audit tables.
  await provisionRoles(templateUrl, {
    appRole: "opengeni_app",
    appPassword: APP_PASSWORD,
    rlsStrategy: "force",
  });

  // Flip the ready sentinel. This must run with NO open connections to the
  // template; the migrate + grant pools above are already closed. Marking it a
  // template also lets the subsequent `CREATE DATABASE ... TEMPLATE` proceed.
  const marker = postgres(ADMIN_URL, { max: 1 });
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
 * role exists, then register one exact holder. Lock-guarded so exactly one
 * parallel worker starts it. Returns null (and registers no holder) if Docker is
 * unavailable and PostgreSQL is optional. Required database runs fail instead
 * of reporting unexecuted assertions as passing. An explicit OPENGENI_TEST_PG_URL uses the
 * externally owned cluster instead and fails on unavailable/invalid fixtures.
 */
async function ensureContainerAndAcquire(): Promise<ContainerHandle | null> {
  return withLock(async () => {
    if (NATIVE_PG_URL) {
      const admin = postgres(ADMIN_URL, { max: 1, connect_timeout: 5 });
      try {
        const [role] = await admin`
          SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
        if (!role?.rolsuper) {
          throw new Error(
            "shared-pg: OPENGENI_TEST_PG_URL requires a superuser test-cluster login",
          );
        }
        const [vector] = await admin`
          SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`;
        if (!vector) {
          throw new Error("shared-pg: native PostgreSQL requires the pgvector extension installed");
        }
      } finally {
        await admin.end().catch(() => undefined);
      }
      await ensureAppRole();
      await ensureTemplateBuilt();
      await maybeStartReaper();
      // Native servers are externally owned, not Docker generations. Release
      // drops only the database allocated by this acquisition, never the server.
      return { generation: "native", token: crypto.randomUUID(), native: true };
    }
    const priorState = await readContainerState();
    // Explicitly opt into a prestarted, disposable native PostgreSQL fixture
    // with this harness's loopback port and role/password contract. Never
    // control or remove that server through Docker.
    const native = process.env.OPENGENI_TEST_PG_NATIVE === "1";
    let replacedStaleContainer = false;
    if (!native) {
      const liveHolders = priorState
        ? Object.values(priorState.holders).filter((holder) => processIsAlive(holder.pid)).length
        : 0;
      if (liveHolders === 0) {
        const running = await probeContainerSpec();
        if (
          running &&
          sharedTestContainerNeedsReplacement({ runningSpec: running.spec, liveHolders })
        ) {
          replacedStaleContainer = await dockerOk(["rm", "-f", "-v", running.id]);
        }
      }
    }
    // A warm fixture's data plane is the authoritative fast path. Docker
    // Desktop/OrbStack's control API can briefly stop answering under a heavily
    // parallel suite even while PostgreSQL remains completely healthy. The
    // fingerprinted immutable template proves this is our exact fixture, so a
    // transient `docker inspect` outage must not turn into skipped DB tests.
    let generation = native
      ? new Bun.CryptoHasher("sha256").update(`native:${ADMIN_URL}`).digest("hex")
      : priorState && !replacedStaleContainer && (await templateReady())
        ? priorState.generation
        : null;
    if (!generation) {
      const probe = await probeContainer();
      if (!probe.available) {
        return unavailableSharedTestDatabase();
      }
      generation = probe.id;
      if (generation && probe.status !== "running" && probe.status !== "restarting") {
        const resumed =
          probe.status === "paused"
            ? await dockerOk(["unpause", generation])
            : await dockerOk(["start", generation]);
        if (!resumed) {
          await dockerOk(["rm", "-f", "-v", generation]);
          generation = null;
        }
      }
    }
    if (!generation) {
      // Remove only an inspect-confirmed stopped leftover, then start fresh.
      // NOT --rm: the container must survive across test-file waves and later
      // commands so the fixed port is never rebound while its proxy tears down.
      // The postgres image declares an anonymous data volume. Remove it with
      // an unusable leftover so failed generations do not leak full clusters.
      await dockerOk(["rm", "-f", "-v", CONTAINER]);
      // ONE container is shared by every DB/API/worker integration test FILE in
      // the parallel `bun test` run. Each file opens its own connection pool (the
      // createDb pool + a superuser admin pool), so dozens of files together can
      // demand many hundreds of simultaneous server connections. Default
      // postgres max_connections=100 would be exhausted ("too many clients"),
      // which surfaces as silently-wrong RLS reads (a freshly-written row not
      // visible) rather than a clean error. Give the throwaway test server a
      // generous ceiling so the whole suite fits. `MAX_CONNECTIONS` keeps the
      // per-file pools small as a second line of defence.
      // A just-replaced container's port can take a moment to free up.
      generation = await startSharedContainer(
        sharedTestContainerRunArgs(),
        replacedStaleContainer ? 5 : 1,
      );
      if (!generation) {
        return unavailableSharedTestDatabase();
      }
    }
    if (!generation) {
      throw new Error("shared-pg: running container has no generation id");
    }
    await waitForReady(ADMIN_URL);
    // A killed test process can leave Docker's independently-running container
    // alive after `docker run` but before cluster bootstrap. Repair the
    // cluster-global role on EVERY acquisition, not only the fresh-start branch;
    // otherwise the running container looks healthy while every FORCE-RLS clone
    // fails with `role opengeni_app does not exist`.
    await ensureAppRole();
    // Build the once-per-container migrated template (idempotent; self-heals a
    // crashed partial). Inside the lock so exactly one process pays the
    // migration; every acquire after that just clones from it.
    await ensureTemplateBuilt();
    await maybeStartReaper();
    const latestState = await readContainerState();
    const holders = latestState?.generation === generation ? latestState.holders : {};
    for (const [token, holder] of Object.entries(holders)) {
      if (!processIsAlive(holder.pid)) {
        delete holders[token];
      }
    }
    const token = crypto.randomUUID();
    holders[token] = { pid: process.pid };
    await writeContainerState({ generation, holders });
    return { generation, token };
  });
}

async function ensureAppRole(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await admin.unsafe(`
            DO $$ BEGIN
              IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
                CREATE ROLE opengeni_app WITH LOGIN NOSUPERUSER NOBYPASSRLS
                  NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT PASSWORD '${APP_PASSWORD}';
              ELSE
                ALTER ROLE opengeni_app WITH LOGIN NOSUPERUSER NOBYPASSRLS
                  NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT PASSWORD '${APP_PASSWORD}';
              END IF;
            END $$;`);
        break;
      } catch (error) {
        const details = error as { code?: unknown; message?: unknown; routine?: unknown };
        const concurrentCatalogUpdate =
          details.code === "XX000" &&
          details.message === "tuple concurrently updated" &&
          details.routine === "simple_heap_update";
        const concurrentRoleCreate =
          details.code === "42710" &&
          typeof details.message === "string" &&
          /^role ".+" already exists$/u.test(details.message);
        if ((!concurrentCatalogUpdate && !concurrentRoleCreate) || attempt === 20) throw error;
        await Bun.sleep(Math.min(25 * attempt, 250));
      }
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function releaseContainer(handle: ContainerHandle): Promise<void> {
  if (handle.native) return;
  await withLock(async () => {
    const state = await readContainerState();
    if (state?.generation !== handle.generation || !state.holders[handle.token]) {
      return;
    }
    delete state.holders[handle.token];
    // Keep the exact generation warm even when the holder set becomes empty.
    // A later file/command can safely reuse its immutable fingerprinted
    // template. Eager removal made the next `docker run -p 61440:5432` race the
    // desktop runtime's asynchronous port-proxy teardown, causing every later
    // PostgreSQL test to report the database unavailable.
    await writeContainerState(state);
    // The last live holder leaving is a good moment to tidy up.
    if (Object.values(state.holders).every((holder) => !processIsAlive(holder.pid))) {
      await maybeStartReaper();
    }
  });
}

/** CREATE a uniquely-named database in the shared container. */
async function createDatabase(dbName: string): Promise<void> {
  // CREATE DATABASE cannot run in a transaction and is safe to issue
  // concurrently from many processes.
  const root = postgres(ADMIN_URL, { max: 1 });
  try {
    await root.unsafe(`CREATE DATABASE "${dbName}"`);
    await recordDatabaseOwner(root, dbName);
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
async function cloneFromTemplate(dbName: string, withheld: readonly string[] = []): Promise<void> {
  const root = postgres(ADMIN_URL, { max: 1 });
  try {
    const deadline = Date.now() + 30_000;
    let rebuilt = false;
    for (;;) {
      try {
        await root.unsafe(
          `CREATE DATABASE "${dbName}" TEMPLATE "${await templateDbName(withheld)}"`,
        );
        await recordDatabaseOwner(root, dbName);
        await stampTemplateUse(root, await templateDbName(withheld));
        return;
      } catch (err) {
        const message = String((err as { message?: string })?.message ?? err);
        if (!rebuilt && isMissingTemplateError(err)) {
          // The reaper pruned a long-unused template (or someone dropped it)
          // after this process checked it: rebuild it under the lock, once.
          rebuilt = true;
          await withLock(() => ensureTemplateBuilt(withheld));
          continue;
        }
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

/** Best-effort DROP of this file's database, then release its exact holder. */
async function dropDatabaseAndRelease(dbName: string, handle: ContainerHandle): Promise<void> {
  const dropper = postgres(ADMIN_URL, { max: 1 });
  await dropper.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
  await dropper.end().catch(() => undefined);
  await releaseContainer(handle);
}

/**
 * Record this process as the database's owner so the reaper can tell an
 * orphan (owner provably dead) from a database a live test is using. Best
 * effort: without the record the reaper falls back to its idle-window rule.
 */
async function recordDatabaseOwner(root: postgres.Sql, dbName: string): Promise<void> {
  await root
    .unsafe(`COMMENT ON DATABASE ${quoteIdent(dbName)} IS ${quoteLiteral(databaseOwnerComment())}`)
    .catch(
      (error: unknown) => void reaperNote(`could not record owner of ${dbName}: ${String(error)}`),
    );
}

function isMissingTemplateError(error: unknown): boolean {
  const details = error as { code?: unknown; message?: unknown };
  return (
    details?.code === "3D000" &&
    typeof details.message === "string" &&
    /template database .* does not exist/iu.test(details.message)
  );
}

const stampedTemplates = new Set<string>();

/**
 * Refresh the template's last-used stamp (once per process, and only when it
 * is over an hour old) so the reaper keeps templates checkouts still use.
 * Writes only the shared catalog comment; it never connects to the template.
 * Best effort.
 */
async function stampTemplateUse(root: postgres.Sql, template: string): Promise<void> {
  if (stampedTemplates.has(template)) return;
  stampedTemplates.add(template);
  try {
    const [row] = await root`
      SELECT shobj_description(oid, 'pg_database') AS comment
        FROM pg_database WHERE datname = ${template} AND datistemplate`;
    if (!row) return;
    const stamp = parseTemplateStamp(row.comment as string | null);
    if (stamp && Date.now() - stamp.lastUsedAt < TEMPLATE_STAMP_REFRESH_MS) return;
    await root.unsafe(
      `COMMENT ON DATABASE ${quoteIdent(template)} IS ${quoteLiteral(templateStampComment(Date.now()))}`,
    );
  } catch (error) {
    void reaperNote(`could not stamp template ${template}: ${String(error)}`);
  }
}

function reaperNote(note: string): Promise<void> {
  return (async () => {
    await mkdir(STATE_DIR, { recursive: true });
    const size = await statPath(REAPER_LOG_FILE).then(
      (info) => info.size,
      () => 0,
    );
    if (size > 256 * 1024) await rm(REAPER_LOG_FILE, { force: true });
    await appendFile(
      REAPER_LOG_FILE,
      `${new Date().toISOString()} pid=${process.pid} ${note.split("\n")[0]}\n`,
    );
  })().catch(() => undefined);
}

/**
 * Start the detached reaper unless one ran within REAP_INTERVAL_MS or is still
 * running. Called under the container lock, which makes the marker check and
 * update atomic across this state directory's processes. Never throws.
 */
async function maybeStartReaper(): Promise<void> {
  if (process.env.OPENGENI_TEST_PG_REAP === "0") return;
  try {
    const marker = await readFile(REAPER_MARKER_FILE, "utf8")
      .then((source) => JSON.parse(source) as { pid?: unknown; startedAt?: unknown })
      .catch(() => null);
    if (
      marker &&
      typeof marker.startedAt === "number" &&
      (Date.now() - marker.startedAt < REAP_INTERVAL_MS ||
        // A previous pass still running (bounded by its own deadline; past
        // that the pid has most likely been reused by something else).
        (Date.now() - marker.startedAt < 4 * REAP_INTERVAL_MS &&
          typeof marker.pid === "number" &&
          marker.pid > 0 &&
          processIsAlive(marker.pid)))
    ) {
      return;
    }
    const child = spawn(process.execPath, ["--no-env-file", SHARED_PG_MODULE, "--reap"], {
      cwd: STATE_DIR,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.on("error", (error) => void reaperNote(`could not start the reaper: ${String(error)}`));
    child.unref();
    await writeFile(
      REAPER_MARKER_FILE,
      JSON.stringify({ pid: child.pid ?? 0, startedAt: Date.now() }),
      "utf8",
    );
  } catch (error) {
    void reaperNote(`could not start the reaper: ${String(error)}`);
  }
}

const SHARED_PG_MODULE = fileURLToPath(import.meta.url);

/** One reaper pass for this harness's cluster; see reapOrphanedTestDatabases. */
export async function reapSharedTestDatabases(
  options: { dryRun?: boolean } = {},
): Promise<ReapResult> {
  // Test-only: confine a pass to one uniquely named scope so regression tests
  // never touch other runs' databases on a shared server.
  const scope = process.env.OPENGENI_TEST_PG_REAP_SCOPE?.trim();
  const scoped = scope && /^og_[a-z0-9_]+$/u.test(scope) ? scope : undefined;
  const result = await reapOrphanedTestDatabases({
    ...options,
    ...(scoped ? { scopePrefix: scoped, templatePrefix: `${scoped}template_` } : {}),
    adminUrl: ADMIN_URL,
    observationsPath: REAPER_OBSERVATIONS_FILE,
    protectedTemplates: [await templateDbName().catch(() => "")],
    withTemplateLock: withLock,
  });
  if (
    !options.dryRun &&
    (result.dropped.length > 0 || result.templatesDropped.length > 0 || result.errors.length > 0)
  ) {
    await reaperNote(
      `reaped ${result.dropped.length} database(s) and ${result.templatesDropped.length} template(s), kept ${result.kept}` +
        (result.errors.length > 0
          ? `; ${result.errors.length} note(s): ${result.errors.slice(0, 5).join("; ")}`
          : ""),
    );
  }
  return result;
}

function unavailableSharedTestDatabase(): null {
  if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but disposable PostgreSQL is unavailable");
  }
  return null;
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
 * skip, unless OPENGENI_REQUIRE_REAL_DB=1 makes missing PostgreSQL fatal.
 * OPENGENI_TEST_PG_URL opts into an existing PostgreSQL test cluster instead;
 * an unavailable native fixture throws rather than falling back to Docker.
 *
 * The returned database has: the full migration chain applied, the
 * `opengeni_app` role GRANTed on its public/opengeni_private schemas, and a
 * superuser `admin` handle scoped to it. Call `release()` in afterAll.
 */
export async function acquireSharedTestDatabase(
  label = "test",
  options: SharedTestDatabaseOptions = {},
): Promise<SharedTestDatabase | null> {
  const acquired = await ensureContainerAndAcquire();
  if (!acquired) {
    return null;
  }
  const withheld = options.withheldMigrations ?? [];

  const dbName = uniqueDbName(label);
  const adminUrl = databaseUrl(dbName);
  const appUrl = databaseUrl(dbName, "opengeni_app", APP_PASSWORD);

  try {
    // Clone this file's database from the once-migrated template. Postgres does a
    // file-level copy, so the fully-migrated schema + opengeni_app grants land in
    // ~100ms instead of replaying the whole migration chain per file.
    if (withheld.length > 0) await withLock(() => ensureTemplateBuilt(withheld));
    await cloneFromTemplate(dbName, withheld);

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
        await dropDatabaseAndRelease(dbName, acquired);
      },
    };
  } catch (err) {
    await releaseContainer(acquired).catch(() => undefined);
    throw err;
  }
}

/**
 * Grant the runtime role what a migration withholds until the previous
 * release knows it (runtime-posture DEFERRED_RUNTIME_PRIVATE_ROUTINES): EXECUTE
 * on the personal-machine owner lookup (0978) and the connected-command re-arm
 * (0984). Tests that exercise them run as they will once they are granted.
 */
export async function grantDeferredRuntimeAccess(
  admin: postgres.Sql,
  role = "opengeni_app",
): Promise<void> {
  await admin.unsafe(`
    GRANT EXECUTE ON FUNCTION opengeni_private.session_machine_owner_subject_v1(uuid, uuid, uuid)
      TO "${role.replaceAll('"', '""')}";
    GRANT EXECUTE ON FUNCTION opengeni_private.rearm_unanswered_connected_commands(uuid, uuid, text)
      TO "${role.replaceAll('"', '""')}";
  `);
}

/**
 * Acquire a fresh, PRISTINE (un-migrated, no app role grants) database in the
 * shared container. For tests that drive the migration chain themselves (e.g.
 * applying individual .sql files to assert a single migration's behaviour). The
 * caller owns connecting to `databaseUrl` (as the superuser) and applying
 * whatever schema it wants. Returns `null` if docker is unavailable, unless
 * OPENGENI_REQUIRE_REAL_DB=1 requires failure; an explicit
 * OPENGENI_TEST_PG_URL selects the native fixture and fails if unavailable.
 */
export async function acquireBlankTestDatabase(label = "blank"): Promise<BlankTestDatabase | null> {
  const acquired = await ensureContainerAndAcquire();
  if (!acquired) {
    return null;
  }

  const dbName = uniqueDbName(label);
  const url = databaseUrl(dbName);

  try {
    await createDatabase(dbName);
    let released = false;
    return {
      databaseUrl: url,
      appPassword: APP_PASSWORD,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        await dropDatabaseAndRelease(dbName, acquired);
      },
    };
  } catch (err) {
    await releaseContainer(acquired).catch(() => undefined);
    throw err;
  }
}

/**
 * Acquire a fresh, pristine database whose OWNER is a dedicated
 * `NOSUPERUSER NOBYPASSRLS` login role - Opengeni's documented production
 * migration principal (`docs/deployment.md`).
 *
 * Why this exists: `acquireSharedTestDatabase` and
 * `acquireBlankTestDatabase` both hand out the container SUPERUSER, for whom
 * `FORCE ROW LEVEL SECURITY` never engages. A migration-time backfill over a
 * FORCE-RLS table therefore looks correct in CI while matching ZERO rows on a
 * real deployment, because FORCE RLS binds the table owner and no tenant GUC is
 * set during a migration. Drive `migrate()` through `ownerUrl` to reproduce the
 * real boundary; seed fixtures and read ground truth through `admin`.
 *
 * The superuser pre-installs `pgcrypto` and `vector` (a non-superuser owner
 * cannot `CREATE EXTENSION`), exactly as a managed-Postgres operator does, and
 * grants the owner `CREATE, USAGE` on `public`. Returns `null` when docker is
 * unavailable so callers can skip, unless OPENGENI_REQUIRE_REAL_DB=1 requires
 * failure. OPENGENI_TEST_PG_URL uses the same role and
 * extension posture on an existing native test cluster without Docker.
 */
export async function acquireOwnerMigratedTestDatabase(
  label = "owner-migrated",
): Promise<OwnerMigratedTestDatabase | null> {
  const acquired = await ensureContainerAndAcquire();
  if (!acquired) {
    return null;
  }

  const dbName = uniqueDbName(label);
  const ownerRole = `${dbName}_owner`.slice(0, 63);
  const ownerPassword = crypto.randomUUID().replace(/-/g, "");
  const adminUrl = databaseUrl(dbName);
  const ownerUrl = databaseUrl(dbName, ownerRole, ownerPassword);

  const root = postgres(ADMIN_URL, { max: 1 });
  let admin: postgres.Sql | null = null;
  try {
    // NOCREATEROLE/NOCREATEDB/NOREPLICATION mirror `provision-roles`' posture for
    // the app role; the owner additionally needs nothing beyond object ownership
    // because the superuser creates the database and the extensions for it.
    await root.unsafe(
      `CREATE ROLE "${ownerRole}" WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE
         NOCREATEDB NOREPLICATION PASSWORD '${ownerPassword}'`,
    );
    await root.unsafe(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
    await recordDatabaseOwner(root, dbName);
    await root.end().catch(() => undefined);

    admin = postgres(adminUrl, { max: 2 });
    await admin.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await admin.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await admin.unsafe(`GRANT CREATE, USAGE ON SCHEMA public TO "${ownerRole}"`);

    let released = false;
    return {
      ownerUrl,
      ownerRole,
      adminUrl,
      admin,
      appPassword: APP_PASSWORD,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        await admin?.end().catch(() => undefined);
        // The database must go first: a role cannot be dropped while it owns one.
        await dropDatabaseAndRelease(dbName, acquired);
        const dropper = postgres(ADMIN_URL, { max: 1 });
        await dropper.unsafe(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(() => undefined);
        await dropper.end().catch(() => undefined);
      },
    };
  } catch (err) {
    await admin?.end().catch(() => undefined);
    await root.end().catch(() => undefined);
    const cleanup = postgres(ADMIN_URL, { max: 1 });
    await cleanup.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    await cleanup.unsafe(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(() => undefined);
    await cleanup.end().catch(() => undefined);
    await releaseContainer(acquired).catch(() => undefined);
    throw err;
  }
}

export type RestrictedRuntimeTestDatabase = {
  /** Dedicated data schema the migration owner migrated into. */
  schema: string;
  /** opengeni_app URL; pass `{ searchPath: schema }` to createDb. */
  appUrl: string;
  /** Superuser pool on the same database with `search_path` set to the schema. */
  admin: postgres.Sql;
  /** Name of the NOSUPERUSER NOBYPASSRLS migration owner. */
  ownerRole: string;
  release: () => Promise<void>;
};

/**
 * The production database posture in one call: a NOSUPERUSER NOBYPASSRLS
 * migration owner, a dedicated (non-public) data schema migrated by that
 * owner, and the restricted application role provisioned with FORCE RLS.
 * SECURITY DEFINER routines then run as a role that FORCE RLS binds, exactly
 * as deployed, unlike the superuser-owned shared template. Returns null when
 * no test PostgreSQL is available.
 */
export async function acquireRestrictedRuntimeTestDatabase(
  label = "restricted-runtime",
  schema = "og_data",
): Promise<RestrictedRuntimeTestDatabase | null> {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) throw new Error("Invalid test schema name");
  const owner = await acquireOwnerMigratedTestDatabase(label);
  if (!owner) return null;
  let admin: postgres.Sql | null = null;
  try {
    const { migrate } = await import("@opengeni/db/migrate");
    const { provisionRoles } = await import("@opengeni/db/provision-roles");
    await owner.admin.unsafe(
      `CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION "${owner.ownerRole}"`,
    );
    await owner.admin.unsafe(`ALTER EXTENSION vector SET SCHEMA ${schema}`);
    await migrate(owner.ownerUrl, schema, { applicationDatabaseRoles: ["opengeni_app"] });
    await provisionRoles(owner.adminUrl, {
      targetSchema: schema,
      appRole: "opengeni_app",
      appPassword: owner.appPassword,
      rlsStrategy: "force",
    });
    const appUrl = new URL(owner.adminUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = owner.appPassword;
    admin = postgres(owner.adminUrl, { max: 4, connection: { search_path: schema } });
    const pool = admin;
    return {
      schema,
      appUrl: appUrl.toString(),
      admin: pool,
      ownerRole: owner.ownerRole,
      release: async () => {
        await pool.end().catch(() => undefined);
        await owner.release();
      },
    };
  } catch (error) {
    await admin?.end().catch(() => undefined);
    await owner.release();
    throw error;
  }
}

// Re-export so callers don't need to import the constant from elsewhere.
export const SHARED_TEST_PG_IMAGE = IMAGE;

const SHARED_TEST_CONTAINER_SPEC_LABEL = "com.opengeni.shared-pg-spec";

/*
 * Parallel queries allocate dynamic shared memory in /dev/shm, and Docker's
 * 64 MB default is too small for hundreds of concurrent test connections: a
 * single parallel hash can ask for 32 MB, the allocation fails with "No space
 * left on device", and a FORCE drop issued right after such a failure has
 * crashed the whole server into recovery. 1 GB is a tmpfs ceiling, not a
 * reservation; only used pages count.
 */
function sharedTestContainerOptions(): string[] {
  return [
    "--shm-size=1g",
    "-e",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "-p",
    `${PORT}:5432`,
    "--name",
    CONTAINER,
  ];
}

const SHARED_TEST_SERVER_ARGS = ["-c", "max_connections=1000", "-c", "shared_buffers=256MB"];

/** Fingerprint of everything that shapes the container; stamped on it as a label. */
export function sharedTestContainerSpec(): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([sharedTestContainerOptions(), IMAGE, SHARED_TEST_SERVER_ARGS]))
    .digest("hex")
    .slice(0, 16);
}

/** `docker run` arguments for the shared test server. */
export function sharedTestContainerRunArgs(): string[] {
  return [
    "run",
    "-d",
    ...sharedTestContainerOptions(),
    "--label",
    `${SHARED_TEST_CONTAINER_SPEC_LABEL}=${sharedTestContainerSpec()}`,
    IMAGE,
    ...SHARED_TEST_SERVER_ARGS,
  ];
}

/**
 * The container is kept warm indefinitely, so a changed run spec (for example
 * more shared memory) would otherwise never reach a long-lived machine. Replace
 * a container built from another spec, but only while nobody holds it: a
 * container in use is never disturbed, and the next idle acquire upgrades it.
 */
export function sharedTestContainerNeedsReplacement(input: {
  runningSpec: string | null;
  liveHolders: number;
}): boolean {
  return (
    input.liveHolders === 0 &&
    input.runningSpec !== null &&
    input.runningSpec !== sharedTestContainerSpec()
  );
}

/**
 * The spec label of the running container, "" for a container without one, or
 * null when there is no container or Docker cannot answer (never replace then).
 */
async function probeContainerSpec(): Promise<{ id: string; spec: string } | null> {
  try {
    const result = await docker([
      "inspect",
      "--type",
      "container",
      "--format",
      "{{.Id}}\t{{json .Config.Labels}}",
      CONTAINER,
    ]);
    const [id, labelsJson, ...extra] = result.stdout.trim().split("\t");
    if (extra.length > 0 || !id || !/^[a-f0-9]{64}$/u.test(id) || labelsJson === undefined) {
      return null;
    }
    const labels = JSON.parse(labelsJson) as Record<string, unknown> | null;
    const spec = labels?.[SHARED_TEST_CONTAINER_SPEC_LABEL];
    return { id, spec: typeof spec === "string" ? spec : "" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Best-effort reaping of orphaned per-test databases and stale templates in
// the shared test PostgreSQL (see REAPING ORPHANS in the header).
//
// Every per-test database is created by a live test process and normally
// dropped by its `release()`. A process that is killed, crashes or times out
// never drops it, and on a long-lived shared server those orphans fill the
// disk. The reaper finds them and drops them, with one safety rule: never
// drop a database a live test may be using or about to use.
//
// - Ownership. Right after creating a database the harness records its owner
//   (host, boot id, pid namespace, pid and process start time) as the
//   database comment. A database whose owner ran on this same host, boot and
//   pid namespace and is no longer running (or whose pid now belongs to a
//   different process) is an orphan.
// - Everything else (no owner record, for example a database made by an
//   older checkout, or one owned by a process we cannot see) is an orphan only
//   after it stays without connections and without any transaction activity
//   across several reaper passes spanning `idleWindowMs`.
// - Drops never use FORCE, so a database that gains a connection is skipped
//   instead of broken. Only `og_<label>_<12 hex>` names are considered;
//   templates, `postgres` and every other database are never per-test
//   candidates.
// - Templates carry a last-used stamp written on each acquisition. A
//   template whose stamp is older than `templateRetentionMs` is pruned, except
//   the templates this checkout uses. A clone whose template vanished rebuilds
//   it (cloneFromTemplate), and the template build is lock-guarded.
// Every failure is reported in the result and never thrown.
// ---------------------------------------------------------------------------

export const DB_OWNER_COMMENT_PREFIX = "opengeni-test-db:v1 ";
export const TEMPLATE_COMMENT_PREFIX = "opengeni-test-template:v1 ";

export type ProcessIdentity = {
  host: string;
  /** Linux boot id; "" where unavailable. */
  boot: string;
  /** Linux pid namespace (`pid:[inode]`); "" where unavailable. */
  pidns: string;
};

export type DatabaseOwner = ProcessIdentity & {
  pid: number;
  /** Process start time in clock ticks since boot (Linux); "" where unavailable. */
  start: string;
};

function readTrimmed(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** The machine-and-namespace identity a pid is meaningful in. */
export function currentProcessIdentity(): ProcessIdentity {
  let pidns = "";
  try {
    pidns = readlinkSync("/proc/self/ns/pid");
  } catch {
    // not Linux
  }
  return { host: hostname(), boot: readTrimmed("/proc/sys/kernel/random/boot_id"), pidns };
}

/** Start time of `pid` (field 22 of /proc/<pid>/stat), "" if unknown. */
export function processStartTime(pid: number): string {
  const stat = readTrimmed(`/proc/${pid}/stat`);
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[19] ?? "";
}

export function currentDatabaseOwner(): DatabaseOwner {
  return {
    ...currentProcessIdentity(),
    pid: process.pid,
    start: processStartTime(process.pid),
  };
}

export function databaseOwnerComment(owner: DatabaseOwner = currentDatabaseOwner()): string {
  return `${DB_OWNER_COMMENT_PREFIX}${JSON.stringify(owner)}`;
}

export function parseDatabaseOwnerComment(comment: string | null): DatabaseOwner | null {
  if (!comment?.startsWith(DB_OWNER_COMMENT_PREFIX)) return null;
  try {
    const value = JSON.parse(comment.slice(DB_OWNER_COMMENT_PREFIX.length)) as Partial<
      Record<keyof DatabaseOwner, unknown>
    >;
    if (
      typeof value.host !== "string" ||
      typeof value.boot !== "string" ||
      typeof value.pidns !== "string" ||
      typeof value.start !== "string" ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0
    ) {
      return null;
    }
    return {
      host: value.host,
      boot: value.boot,
      pidns: value.pidns,
      pid: value.pid,
      start: value.start,
    };
  } catch {
    return null;
  }
}

export type OwnerStatus = "alive" | "dead" | "unknown";

/**
 * "dead" only when the owner provably ran in this exact host, boot and pid
 * namespace and its pid is gone or now belongs to a different process.
 * Anything we cannot see from here is "unknown", never "dead".
 */
export function ownerStatus(
  owner: DatabaseOwner,
  here: ProcessIdentity = currentProcessIdentity(),
  probe: { alive: (pid: number) => boolean; startTime: (pid: number) => string } = {
    alive: processIsAlive,
    startTime: processStartTime,
  },
): OwnerStatus {
  if (owner.host !== here.host || owner.boot !== here.boot || owner.pidns !== here.pidns) {
    return "unknown";
  }
  if (!probe.alive(owner.pid)) return "dead";
  if (owner.start !== "") {
    const start = probe.startTime(owner.pid);
    // A readable, different start time means the pid was reused.
    if (start !== "" && start !== owner.start) return "dead";
  }
  return "alive";
}

export type TemplateStamp = { lastUsedAt: number };

export function templateStampComment(now: number): string {
  return `${TEMPLATE_COMMENT_PREFIX}${JSON.stringify({ lastUsedAt: now })}`;
}

export function parseTemplateStamp(comment: string | null): TemplateStamp | null {
  if (!comment?.startsWith(TEMPLATE_COMMENT_PREFIX)) return null;
  try {
    const value = JSON.parse(comment.slice(TEMPLATE_COMMENT_PREFIX.length)) as {
      lastUsedAt?: unknown;
    };
    return typeof value.lastUsedAt === "number" && Number.isFinite(value.lastUsedAt)
      ? { lastUsedAt: value.lastUsedAt }
      : null;
  } catch {
    return null;
  }
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** `og_<label up to 24>_<12 hex>`, the harness's per-test naming scheme. */
export function isPerTestDatabaseName(
  name: string,
  scopePrefix = "og_",
  templatePrefix = "og_test_template_",
): boolean {
  if (!scopePrefix.startsWith("og_") || !name.startsWith(scopePrefix)) return false;
  if (name.startsWith(templatePrefix)) return false;
  return /^og_[a-z0-9_]{0,24}_[0-9a-f]{12}$/u.test(name);
}

export function isTemplateDatabaseName(
  name: string,
  templatePrefix = "og_test_template_",
): boolean {
  return new RegExp(`^${escapeRegExp(templatePrefix)}[0-9a-f]{12}(_w[0-9a-f]{8})?$`, "u").test(
    name,
  );
}

type Observation = { oid: string; xacts: string; since: number };
type ObservationState = { databases: Record<string, Observation> };

async function readObservations(path: string): Promise<ObservationState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ObservationState>;
    if (parsed.databases && typeof parsed.databases === "object") {
      const databases: Record<string, Observation> = {};
      for (const [name, entry] of Object.entries(parsed.databases)) {
        if (
          entry &&
          typeof entry.oid === "string" &&
          typeof entry.xacts === "string" &&
          typeof entry.since === "number"
        ) {
          databases[name] = entry;
        }
      }
      return { databases };
    }
  } catch {
    // missing or unreadable: start over (only delays legacy reaping)
  }
  return { databases: {} };
}

async function writeObservations(path: string, state: ObservationState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state), "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export type ReapOptions = {
  /** Superuser maintenance URL of the shared cluster. */
  adminUrl: string;
  /** Where idle observations of unowned databases persist between passes. */
  observationsPath: string;
  /** Only databases whose names start with this (and match the scheme). */
  scopePrefix?: string;
  templatePrefix?: string;
  /** Templates never pruned (this checkout's). */
  protectedTemplates?: readonly string[];
  /** Run template pruning under the harness's container lock. */
  withTemplateLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  pruneTemplates?: boolean;
  /** Classify and report without dropping or stamping anything. */
  dryRun?: boolean;
  idleWindowMs?: number;
  templateRetentionMs?: number;
  maxDrops?: number;
  deadlineMs?: number;
  now?: () => number;
  here?: ProcessIdentity;
  probe?: { alive: (pid: number) => boolean; startTime: (pid: number) => string };
};

export type ReapResult = {
  /** Dropped (or, in a dry run, would drop). */
  dropped: string[];
  kept: number;
  templatesDropped: string[];
  errors: string[];
};

export const DEFAULT_IDLE_WINDOW_MS = 15 * 60_000;
export const DEFAULT_TEMPLATE_RETENTION_MS = 7 * 24 * 60 * 60_000;

type DatabaseRow = {
  oid: string;
  datname: string;
  datistemplate: boolean;
  invalid: boolean;
  comment: string | null;
  connections: number;
  xacts: string;
};

function short(error: unknown): string {
  const message = String((error as { message?: unknown })?.message ?? error);
  return message.split("\n")[0]!.slice(0, 200);
}

/**
 * One reaping pass. Never throws: every failure (unreachable server, failed
 * drop, lock timeout, missing privilege) is recorded in `errors`.
 */
export async function reapOrphanedTestDatabases(options: ReapOptions): Promise<ReapResult> {
  const result: ReapResult = { dropped: [], kept: 0, templatesDropped: [], errors: [] };
  const now = options.now ?? Date.now;
  const started = now();
  const scopePrefix = options.scopePrefix ?? "og_";
  const templatePrefix = options.templatePrefix ?? "og_test_template_";
  const idleWindowMs = options.idleWindowMs ?? DEFAULT_IDLE_WINDOW_MS;
  const maxDrops = options.maxDrops ?? 200;
  const deadline = started + (options.deadlineMs ?? 5 * 60_000);
  const here = options.here ?? currentProcessIdentity();
  let sql: postgres.Sql | null = null;
  try {
    sql = postgres(options.adminUrl, {
      max: 1,
      connect_timeout: 10,
      onnotice: () => undefined,
      // Never wait on a database someone is creating, cloning or dropping.
      connection: { lock_timeout: 2000, statement_timeout: 120_000, application_name: "og-reaper" },
    });
    const rows = (await sql`
      SELECT d.oid::text AS oid, d.datname, d.datistemplate,
             d.datconnlimit = -2 AS invalid,
             shobj_description(d.oid, 'pg_database') AS comment,
             (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid = d.oid) AS connections,
             coalesce(s.xact_commit + s.xact_rollback, 0)::text AS xacts
        FROM pg_database d
        LEFT JOIN pg_stat_database s ON s.datid = d.oid
       WHERE starts_with(d.datname, ${scopePrefix})
    `) as unknown as DatabaseRow[];

    const observations = await readObservations(options.observationsPath);
    const nextObservations: ObservationState = { databases: {} };
    const candidates: DatabaseRow[] = [];
    for (const row of rows) {
      if (row.datistemplate || !isPerTestDatabaseName(row.datname, scopePrefix, templatePrefix)) {
        continue;
      }
      if (row.connections > 0) {
        result.kept += 1;
        continue;
      }
      if (row.invalid) {
        // A half-dropped database nobody can connect to.
        candidates.push(row);
        continue;
      }
      const owner = parseDatabaseOwnerComment(row.comment);
      const status = owner ? ownerStatus(owner, here, options.probe) : "unknown";
      if (status === "dead") {
        candidates.push(row);
        continue;
      }
      if (status === "alive") {
        result.kept += 1;
        continue;
      }
      // Unknown owner: orphan only after staying idle across the window.
      const previous = observations.databases[row.datname];
      const since =
        previous && previous.oid === row.oid && previous.xacts === row.xacts
          ? previous.since
          : now();
      nextObservations.databases[row.datname] = { oid: row.oid, xacts: row.xacts, since };
      if (now() - since >= idleWindowMs) {
        candidates.push(row);
      } else {
        result.kept += 1;
      }
    }

    for (const row of candidates) {
      if (result.dropped.length >= maxDrops || now() > deadline) {
        result.kept += 1;
        continue;
      }
      if (options.dryRun) {
        result.dropped.push(row.datname);
        continue;
      }
      try {
        // No FORCE: a database that gained a connection fails here and is kept.
        await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(row.datname)}`);
        result.dropped.push(row.datname);
        delete nextObservations.databases[row.datname];
      } catch (error) {
        result.kept += 1;
        result.errors.push(`${row.datname}: ${short(error)}`);
        continue;
      }
      // acquireOwnerMigratedTestDatabase's per-database login role.
      const ownerRole = `${row.datname}_owner`.slice(0, 63);
      try {
        const [role] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${ownerRole}`;
        if (role) await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(ownerRole)}`);
      } catch (error) {
        result.errors.push(`${ownerRole}: ${short(error)}`);
      }
    }

    try {
      if (!options.dryRun) await writeObservations(options.observationsPath, nextObservations);
    } catch (error) {
      result.errors.push(`observations: ${short(error)}`);
    }

    if (options.pruneTemplates !== false && !options.dryRun) {
      await pruneStaleTemplates(sql, rows, {
        templatePrefix,
        protectedTemplates: new Set(options.protectedTemplates ?? []),
        retentionMs: options.templateRetentionMs ?? DEFAULT_TEMPLATE_RETENTION_MS,
        withLock: options.withTemplateLock ?? ((fn) => fn()),
        now,
        deadline,
        result,
      });
    }
  } catch (error) {
    result.errors.push(short(error));
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => undefined);
  }
  return result;
}

async function pruneStaleTemplates(
  sql: postgres.Sql,
  rows: DatabaseRow[],
  context: {
    templatePrefix: string;
    protectedTemplates: Set<string>;
    retentionMs: number;
    withLock: <T>(fn: () => Promise<T>) => Promise<T>;
    now: () => number;
    deadline: number;
    result: ReapResult;
  },
): Promise<void> {
  const { result } = context;
  for (const row of rows) {
    if (
      !row.datistemplate ||
      !isTemplateDatabaseName(row.datname, context.templatePrefix) ||
      context.protectedTemplates.has(row.datname)
    ) {
      continue;
    }
    const stamp = parseTemplateStamp(row.comment);
    if (!stamp) {
      // Built by a checkout that predates stamping: start its clock now.
      try {
        await sql.unsafe(
          `COMMENT ON DATABASE ${quoteIdent(row.datname)} IS ${quoteLiteral(templateStampComment(context.now()))}`,
        );
      } catch (error) {
        result.errors.push(`${row.datname}: ${short(error)}`);
      }
      continue;
    }
    if (
      context.now() - stamp.lastUsedAt < context.retentionMs ||
      context.now() > context.deadline
    ) {
      continue;
    }
    try {
      const dropped = await context.withLock(() => dropTemplate(sql, row, context));
      if (dropped) result.templatesDropped.push(row.datname);
    } catch (error) {
      result.errors.push(`${row.datname}: ${short(error)}`);
    }
  }
}

/**
 * Drop one stale template. Called under the container lock, so no harness
 * process is building templates meanwhile. Every step is pinned to the oid
 * observed earlier, and a template that was used again (fresh stamp), has a
 * connection or a clone in progress is kept.
 */
async function dropTemplate(
  sql: postgres.Sql,
  row: DatabaseRow,
  context: { retentionMs: number; now: () => number; result: ReapResult },
): Promise<boolean> {
  const [current] = await sql`
    SELECT shobj_description(d.oid, 'pg_database') AS comment,
           (SELECT count(*)::int FROM pg_stat_activity a
             WHERE a.datid = d.oid
                OR (position(d.datname IN coalesce(a.query, '')) > 0
                    AND a.state = 'active' AND a.pid <> pg_backend_pid())) AS busy
      FROM pg_database d
     WHERE d.oid = ${row.oid}::oid AND d.datname = ${row.datname} AND d.datistemplate`;
  if (!current) return false;
  const stamp = parseTemplateStamp(current.comment as string | null);
  if (!stamp || context.now() - stamp.lastUsedAt < context.retentionMs || current.busy > 0) {
    return false;
  }
  // PostgreSQL refuses to drop a template; unmark it first, and restore the
  // mark if the drop does not go through (for example a clone holds it).
  await sql`UPDATE pg_database SET datistemplate = false WHERE oid = ${row.oid}::oid AND datistemplate`;
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(row.datname)}`);
    return true;
  } catch (error) {
    await sql`UPDATE pg_database SET datistemplate = true WHERE oid = ${row.oid}::oid`.catch(
      () => undefined,
    );
    context.result.errors.push(`${row.datname}: ${short(error)}`);
    return false;
  }
}

// Detached reaper entry point, started by maybeStartReaper().
if (import.meta.main && process.argv.includes("--reap")) {
  const dryRun = process.argv.includes("--dry-run");
  await reapSharedTestDatabases({ dryRun }).then(
    (result) => {
      if (dryRun) console.log(JSON.stringify(result, null, 2));
    },
    (error: unknown) => reaperNote(`reaper failed: ${String(error)}`),
  );
  process.exit(0);
}
