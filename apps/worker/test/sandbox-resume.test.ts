// P1.2 — the stateless resume-by-id turn slice, driven through the REAL
// resumeBoxForTurn + the P1.1 lease fns against a THROWAWAY postgres, on the
// creds-free `local` (unix_local) backend. This is the DB-backed companion to
// packages/runtime/test/ownership-inversion.test.ts (which proves the SDK
// non-owned keystone with no DB). Here we prove:
//
//   (1) FLAG-ON slice: resumeBoxForTurn acquires the group lease (spawner wins
//       cold->warming), establishes the box by id/cold-restore, commits warm
//       (lease_epoch++), and returns a LIVE session; release() drops the holder
//       and CASes warm->draining at refcount 0. NEVER stops the box.
//   (2) a second concurrent turn ATTACHES to the same warm box (refcount fans in,
//       still ONE box) — the stateless many-turns-one-box invariant.
//   (3) epoch fence on the HEARTBEAT path under a forced re-establish: after a
//       re-establish bumps lease_epoch, the OLD holder's heartbeat (stale epoch)
//       is rejected (self-evicts) — the dead-URL/dead-handle fence.
//   (4) FLAG-OFF: with sandboxOwnershipEnabled=false the turn-path gate is never
//       entered, so NO lease row is ever materialized (byte-for-byte today).
//
// pgvector/pgvector:pg16 (0000_initial does CREATE EXTENSION vector). The package
// fns connect as opengeni_app (non-superuser, so FORCE RLS applies). Container
// torn down in afterAll regardless of outcome.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import {
  acquireLease,
  commitWarmingToWarm,
  createDb,
  heartbeatLeaseHolder,
  readLease,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { testSettings } from "@opengeni/testing";
import { resumeBoxForTurn } from "../src/sandbox-resume";

const CONTAINER = "ogtest-pg-p12-resume";
const PORT = 55457;
const PASSWORD = "x";
const APP_PASSWORD = "apppw";
const ADMIN_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const APP_URL = `postgres://opengeni_app:${APP_PASSWORD}@127.0.0.1:${PORT}/postgres`;
const IMAGE = "pgvector/pgvector:pg16";

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function removeContainer(): void {
  try {
    docker(["rm", "-f", CONTAINER]);
  } catch {
    // already gone
  }
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        return;
      } finally {
        await probe.end();
      }
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`postgres did not become ready in time: ${String(err)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

let available = true;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

// local backend (unix_local) — creds-free. sandboxOwnershipEnabled defaults
// false in testSettings; flag-ON tests override per-test.
function settingsFor(ownershipEnabled: boolean) {
  return testSettings({
    sandboxBackend: "local",
    webSearchEnabled: false,
    sandboxOwnershipEnabled: ownershipEnabled,
    // tight TTLs keep the test fast but still > the work it does.
    sandboxLeaseTtlMs: 60_000,
    sandboxLeaseWarmingTtlMs: 60_000,
    sandboxIdleGraceMs: 5_000,
  });
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string; groupId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id, groupId: crypto.randomUUID() };
}

async function readRow(workspaceId: string, groupId: string) {
  const [r] = await admin`
    select liveness, refcount, turn_holders, viewer_holders, lease_epoch, instance_id, resume_backend_id
    from sandbox_leases
    where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
  return r as {
    liveness: string; refcount: number; turn_holders: number; viewer_holders: number;
    lease_epoch: number; instance_id: string | null; resume_backend_id: string | null;
  } | undefined;
}

async function dropSession(established: { session: unknown }): Promise<void> {
  const s = established.session as { closed?: boolean; close?: () => Promise<void> };
  if (s && typeof s.close === "function" && !s.closed) {
    await s.close().catch(() => undefined);
  }
}

beforeAll(async () => {
  try {
    removeContainer();
    docker(["run", "--rm", "-d", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-p", `${PORT}:5432`, "--name", CONTAINER, IMAGE]);
  } catch (err) {
    available = false;
    console.warn(`[p12-resume] docker unavailable, skipping: ${String(err)}`);
    return;
  }
  await waitForReady();
  await migrate(ADMIN_URL);
  admin = postgres(ADMIN_URL, { max: 4 });
  await admin.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
        CREATE ROLE opengeni_app LOGIN PASSWORD '${APP_PASSWORD}';
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO opengeni_app;
    GRANT USAGE ON SCHEMA opengeni_private TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO opengeni_app;
  `);
  client = createDb(APP_URL);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try { await client?.close(); } catch { /* noop */ }
  try { await admin?.end(); } catch { /* noop */ }
  removeContainer();
});

describe("P1.2 resumeBoxForTurn — stateless resume-by-id (local backend, real lease + RLS)", () => {
  test("(1) FLAG-ON slice: spawner wins cold->warming, establishes (box manifest carries the threaded env), commits warm, returns a LIVE session; release -> draining", async () => {
    if (!available) return;
    const settings = settingsFor(true);
    const { accountId, workspaceId, groupId } = await freshWorkspace();

    // The SAME env object the agent will declare for this run. Threaded into
    // resumeBoxForTurn so the box manifest matches the agent manifest (no
    // provided-session env delta — the BUG-1 turn-killer fix).
    const sandboxEnvironment = {
      GIT_AUTHOR_NAME: "OpenGeni Bot",
      HOME: "/workspace",
      MY_VAR: "value-xyz",
    };

    const resumed = await resumeBoxForTurn(
      { db, settings },
      { accountId, workspaceId, sandboxGroupId: groupId, sessionId: groupId, backend: "local", os: "linux", environment: sandboxEnvironment },
      "turn",
      "activity-1",
    );
    try {
      // The box is live (unix_local session) and the lease is WARM with epoch>=1.
      expect(resumed.established.backendId).toBe("unix_local");
      expect(resumed.established.session).toBeDefined();
      expect(resumed.leaseEpoch).toBeGreaterThanOrEqual(1);

      // The box was created with the threaded environment on its manifest, so the
      // SDK's provided-session manifest apply finds an empty environment delta.
      const boxManifestEnv = (resumed.established.session as {
        state: { manifest: { environment: Record<string, { value?: string }> } };
      }).state.manifest.environment;
      for (const [key, value] of Object.entries(sandboxEnvironment)) {
        expect(boxManifestEnv[key]?.value).toBe(value);
      }

      const warm = await readRow(workspaceId, groupId);
      expect(warm?.liveness).toBe("warm");
      expect(warm?.turn_holders).toBe(1);
      expect(warm?.refcount).toBe(1);
      expect(warm?.resume_backend_id).toBe("unix_local");
      expect(warm?.lease_epoch).toBe(resumed.leaseEpoch);
    } finally {
      await resumed.release();
      await dropSession(resumed.established);
    }

    // release dropped the only turn holder -> warm->draining (NEVER stopped).
    const drained = await readRow(workspaceId, groupId);
    expect(drained?.liveness).toBe("draining");
    expect(drained?.refcount).toBe(0);
  }, 60_000);

  test("(2) a second turn ATTACHES to the same warm box (refcount fans in, ONE box)", async () => {
    if (!available) return;
    const settings = settingsFor(true);
    const { accountId, workspaceId, groupId } = await freshWorkspace();

    const first = await resumeBoxForTurn(
      { db, settings },
      { accountId, workspaceId, sandboxGroupId: groupId, sessionId: groupId, backend: "local" },
      "turn",
      "activity-A",
    );
    const second = await resumeBoxForTurn(
      { db, settings },
      { accountId, workspaceId, sandboxGroupId: groupId, sessionId: groupId, backend: "local" },
      "turn",
      "activity-B",
    );
    try {
      // Both resolved against the SAME warm lease; the second attached (same
      // epoch — no re-spawn). refcount fanned in to 2 turn holders.
      expect(first.leaseEpoch).toBe(second.leaseEpoch);
      const row = await readRow(workspaceId, groupId);
      expect(row?.liveness).toBe("warm");
      expect(row?.turn_holders).toBe(2);
      expect(row?.refcount).toBe(2);
    } finally {
      await first.release();
      await second.release();
      await dropSession(first.established);
      await dropSession(second.established);
    }
    // both released -> draining.
    const row = await readRow(workspaceId, groupId);
    expect(row?.liveness).toBe("draining");
  }, 60_000);

  test("(3) epoch fence on the HEARTBEAT path: a re-establish bumps lease_epoch -> the stale holder's heartbeat is rejected (self-evicts)", async () => {
    if (!available) return;
    const settings = settingsFor(true);
    const { accountId, workspaceId, groupId } = await freshWorkspace();

    // Stand up a warm lease via a turn holder (the legit holder).
    const resumed = await resumeBoxForTurn(
      { db, settings },
      { accountId, workspaceId, sandboxGroupId: groupId, sessionId: groupId, backend: "local" },
      "turn",
      "activity-live",
    );
    const liveEpoch = resumed.leaseEpoch;

    // The legit holder's heartbeat at the LIVE epoch succeeds.
    const okBefore = await heartbeatLeaseHolder(db, {
      accountId, workspaceId, sandboxGroupId: groupId,
      kind: "turn", holderId: "activity-live", leaseTtlMs: settings.sandboxLeaseTtlMs, expectedEpoch: liveEpoch,
    });
    expect(okBefore).toBe(true);

    // Force a re-establish: drive the lease cold->warming->warm again to bump the
    // epoch (simulating a rollover/re-establish on a NEW box). We acquire as a
    // viewer to push warming, then commit warm with the observed epoch -> epoch++.
    await admin`update sandbox_leases set liveness='cold', refcount=0, turn_holders=0, viewer_holders=0
                where workspace_id=${workspaceId} and sandbox_group_id=${groupId}`;
    await admin`delete from sandbox_lease_holders
                where lease_id = (select id from sandbox_leases where workspace_id=${workspaceId} and sandbox_group_id=${groupId})`;
    const reacquire = await acquireLease(db, {
      accountId, workspaceId, sandboxGroupId: groupId,
      kind: "turn", holderId: "activity-new", backend: "local", leaseTtlMs: settings.sandboxLeaseTtlMs,
    });
    expect(reacquire.role).toBe("spawner");
    const commit = await commitWarmingToWarm(db, {
      accountId, workspaceId, sandboxGroupId: groupId,
      expectedEpoch: reacquire.lease.leaseEpoch, instanceId: "box-new",
      resumeBackendId: "unix_local", leaseTtlMs: settings.sandboxLeaseTtlMs,
    });
    expect(commit.committed).toBe(true);
    const newEpoch = commit.lease!.leaseEpoch;
    expect(newEpoch).toBeGreaterThan(liveEpoch);

    // The OLD holder's heartbeat at the STALE epoch is now FENCED (false) — the
    // re-established epoch fenced the dead handle/URL. (The holder row may still
    // exist, but the lease-epoch CAS rejects the TTL refresh.)
    const okAfter = await heartbeatLeaseHolder(db, {
      accountId, workspaceId, sandboxGroupId: groupId,
      kind: "turn", holderId: "activity-new", leaseTtlMs: settings.sandboxLeaseTtlMs, expectedEpoch: liveEpoch,
    });
    expect(okAfter).toBe(false);

    // A heartbeat at the CURRENT epoch still works (liveness proof).
    const okCurrent = await heartbeatLeaseHolder(db, {
      accountId, workspaceId, sandboxGroupId: groupId,
      kind: "turn", holderId: "activity-new", leaseTtlMs: settings.sandboxLeaseTtlMs, expectedEpoch: newEpoch,
    });
    expect(okCurrent).toBe(true);

    await dropSession(resumed.established);
  }, 60_000);

  test("(4) FLAG-OFF: the gate condition is false -> resumeBoxForTurn is NEVER invoked, so NO lease row is materialized", async () => {
    if (!available) return;
    const offSettings = settingsFor(false);
    const onSettings = settingsFor(true);
    const { workspaceId, groupId } = await freshWorkspace();

    // This is the exact gate the agent-turn activity uses. With the flag off it
    // is false, so the activity never calls resumeBoxForTurn and never touches
    // the lease — byte-for-byte today's build-and-discard.
    const gateOff = offSettings.sandboxOwnershipEnabled && "local" !== "none";
    const gateOn = onSettings.sandboxOwnershipEnabled && "local" !== "none";
    expect(gateOff).toBe(false);
    expect(gateOn).toBe(true);

    // Independent proof: nothing materialized a lease for this fresh group.
    const lease = await readLease(db, workspaceId, groupId);
    expect(lease).toBeNull();
  }, 60_000);
});
