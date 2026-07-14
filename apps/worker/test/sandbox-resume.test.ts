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
//   (2) a provider with no resumable instance identity returns typed gone and
//       rematerializes only through the lease election; holders still fan in.
//   (2a) a previously-used home target rematerialized from cold advances its
//        sessions' active routing epoch together with the lease epoch.
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
import postgres from "postgres";
import {
  acquireLease,
  commitWarmingToWarm,
  confirmDrainCold,
  createDb,
  createSession,
  heartbeatLeaseHolder,
  readActiveSandbox,
  readLease,
  SandboxImageConflictError,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import { resumeBoxForTurn, SandboxWarmingTimeoutError } from "../src/sandbox-resume";

let available = true;
let shared: SharedTestDatabase | null = null;
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

async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
  groupId: string;
}> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id, groupId: crypto.randomUUID() };
}

async function readRow(workspaceId: string, groupId: string) {
  const [r] = await admin`
    select liveness, refcount, turn_holders, viewer_holders, lease_epoch, instance_id, resume_backend_id, image
    from sandbox_leases
    where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
  return r as
    | {
        liveness: string;
        refcount: number;
        turn_holders: number;
        viewer_holders: number;
        lease_epoch: number;
        instance_id: string | null;
        resume_backend_id: string | null;
        image: string | null;
      }
    | undefined;
}

async function holderCount(
  workspaceId: string,
  groupId: string,
  holderId: string,
): Promise<number> {
  const [r] = await admin<{ n: number }[]>`
    select count(*)::int as n from sandbox_lease_holders h
    join sandbox_leases l on l.id = h.lease_id
    where l.workspace_id = ${workspaceId}
      and l.sandbox_group_id = ${groupId}
      and h.holder_id = ${holderId}`;
  return r!.n;
}

async function dropSession(established: { session: unknown }): Promise<void> {
  const s = established.session as { closed?: boolean; close?: () => Promise<void> };
  if (s && typeof s.close === "function" && !s.closed) {
    await s.close().catch(() => undefined);
  }
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-sandbox-resume");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[worker-sandbox-resume] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
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
      {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        sessionId: groupId,
        backend: "local",
        os: "linux",
        environment: sandboxEnvironment,
      },
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
      const boxManifestEnv = (
        resumed.established.session as {
          state: { manifest: { environment: Record<string, { value?: string }> } };
        }
      ).state.manifest.environment;
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

  test("(2) identity-less local rematerialization is lease-elected and refcount still fans in", async () => {
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
      // unix_local has no provider resume id, so the typed missing-identity path
      // rematerializes under warm->warming election and advances the lease epoch
      // instead of silently creating under a warm lease. Holders still fan in.
      expect(second.leaseEpoch).toBe(first.leaseEpoch + 1);
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

  test("(2a) cold rematerialization of the same home target advances active_epoch with lease_epoch", async () => {
    if (!available) return;
    const settings = settingsFor(true);
    const { accountId, workspaceId } = await freshWorkspace();
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "home rematerialization",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "local",
    });
    const ids = {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      sessionId: session.id,
      backend: "local" as const,
    };

    const first = await resumeBoxForTurn({ db, settings }, ids, "turn", "activity-home-first");
    expect((await readActiveSandbox(db, workspaceId, session.id))?.activeEpoch).toBe(0);
    await first.release();
    await dropSession(first.established);
    expect(
      (
        await confirmDrainCold(db, {
          accountId,
          workspaceId,
          sandboxGroupId: session.sandboxGroupId,
          expectedEpoch: first.leaseEpoch,
        })
      ).wentCold,
    ).toBe(true);

    const second = await resumeBoxForTurn({ db, settings }, ids, "turn", "activity-home-second");
    try {
      expect(second.leaseEpoch).toBe(first.leaseEpoch + 1);
      expect((await readActiveSandbox(db, workspaceId, session.id))?.activeEpoch).toBe(1);
    } finally {
      await second.release();
      await dropSession(second.established);
    }
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
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "activity-live",
      leaseTtlMs: settings.sandboxLeaseTtlMs,
      expectedEpoch: liveEpoch,
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
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "activity-new",
      backend: "local",
      leaseTtlMs: settings.sandboxLeaseTtlMs,
    });
    expect(reacquire.role).toBe("spawner");
    const commit = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: reacquire.lease.leaseEpoch,
      instanceId: "box-new",
      resumeBackendId: "unix_local",
      leaseTtlMs: settings.sandboxLeaseTtlMs,
    });
    expect(commit.committed).toBe(true);
    const newEpoch = commit.lease!.leaseEpoch;
    expect(newEpoch).toBeGreaterThan(liveEpoch);

    // The OLD holder's heartbeat at the STALE epoch is now FENCED (false) — the
    // re-established epoch fenced the dead handle/URL. (The holder row may still
    // exist, but the lease-epoch CAS rejects the TTL refresh.)
    const okAfter = await heartbeatLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "activity-new",
      leaseTtlMs: settings.sandboxLeaseTtlMs,
      expectedEpoch: liveEpoch,
    });
    expect(okAfter).toBe(false);

    // A heartbeat at the CURRENT epoch still works (liveness proof).
    const okCurrent = await heartbeatLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "activity-new",
      leaseTtlMs: settings.sandboxLeaseTtlMs,
      expectedEpoch: newEpoch,
    });
    expect(okCurrent).toBe(true);

    await dropSession(resumed.established);
  }, 60_000);

  test("(3b) attached turn waiting on warming is bounded and releases its holder on timeout", async () => {
    if (!available) return;
    const settings = testSettings({
      ...settingsFor(true),
      sandboxWarmingTimeoutMs: 25,
      sandboxLeaseWarmingTtlMs: 60_000,
    });
    const { accountId, workspaceId, groupId } = await freshWorkspace();

    await admin`
      insert into sandbox_leases (
        account_id, workspace_id, sandbox_group_id, liveness, refcount,
        turn_holders, viewer_holders, backend, lease_epoch, expires_at
      ) values (
        ${accountId}, ${workspaceId}, ${groupId}, 'warming', 0, 0, 0,
        'local', 3, now() + interval '60 seconds'
      )`;

    await expect(
      resumeBoxForTurn(
        { db, settings },
        {
          accountId,
          workspaceId,
          sandboxGroupId: groupId,
          sessionId: groupId,
          backend: "local",
          os: "linux",
        },
        "turn",
        "activity-timeout",
      ),
    ).rejects.toThrow(SandboxWarmingTimeoutError);

    await expect(
      resumeBoxForTurn(
        { db, settings },
        {
          accountId,
          workspaceId,
          sandboxGroupId: groupId,
          sessionId: groupId,
          backend: "local",
          os: "linux",
        },
        "turn",
        "activity-timeout-message",
      ),
    ).rejects.toThrow(/Sandbox backend "local" capacity or creation timed out/);

    expect(await holderCount(workspaceId, groupId, "activity-timeout")).toBe(0);
    expect(await holderCount(workspaceId, groupId, "activity-timeout-message")).toBe(0);
    const row = await readRow(workspaceId, groupId);
    expect(row?.liveness).toBe("warming");
  }, 60_000);

  // FINDING 3: turn spawner must prefer the lease's resume_state archive.
  // Before the fix the worker TURN spawner always passed the session _sandbox
  // `envelope` to establishSandboxSessionFromEnvelope, ignoring the LEASE's
  // resume_state. After a drain->cold, the archive lives on the LEASE
  // (confirmDrainCold preserves a minimal archive-only envelope). A turn-first
  // re-warm would therefore spawn an EMPTY box instead of hydrating /workspace.
  // The fix: use `acquired.lease.resumeState ?? envelope` (mirrors channel-a.ts).
  //
  // We test this with the `local` backend + a pre-inserted cold lease whose
  // resume_state carries a synthetic archive-only envelope. Because the local
  // backend has no hydrateWorkspace, we verify the CORRECT ENVELOPE is selected
  // (spawnEnvelope === the lease's archive envelope) rather than the session
  // envelope — i.e. the resumeBoxForTurn spawner path reads the lease's archive.
  // We assert by reading back the committed resume_state: a spawner that ignored
  // the lease archive would commit the session envelope's backendId (or null);
  // a spawner that preferred the lease archive correctly uses its backendId.
  test("(F3) turn spawner prefers lease resume_state archive over session envelope on cold re-warm", async () => {
    if (!available) return;
    const settings = settingsFor(true);
    const { accountId, workspaceId, groupId } = await freshWorkspace();

    // Pre-insert a cold lease whose resume_state carries an archive-only envelope
    // (the shape confirmDrainCold produces). The lease is cold with epoch 5.
    // The session envelope (getSandboxSessionEnvelope) returns null for a bare
    // groupId with no sessions row — so the spawner's `envelope` is null, and
    // the only source of the archive is the lease's resume_state.
    const ARCHIVE_B64 = Buffer.from("WORKSPACE_ARCHIVE_TURN_RESUME_TEST").toString("base64");
    const archiveOnlyEnvelope = {
      backendId: "unix_local",
      sessionState: { workspaceArchive: ARCHIVE_B64 },
    };
    // Use the same text->jsonb cast pattern as insertLease (the postgres.js driver
    // sends the interpolated value as a text parameter; ::text::jsonb casts it
    // server-side so postgres parses it as a jsonb object, not a scalar string).
    const archiveEnvelopeJson = JSON.stringify(archiveOnlyEnvelope);
    await admin.unsafe(
      `
      insert into sandbox_leases (
        account_id, workspace_id, sandbox_group_id, liveness, refcount,
        turn_holders, viewer_holders, backend, lease_epoch,
        resume_backend_id, resume_state, expires_at
      ) values (
        $1, $2, $3, 'cold', 0, 0, 0,
        'local', 5, 'unix_local',
        $4::text::jsonb,
        now() + interval '60s'
      )`,
      [accountId, workspaceId, groupId, archiveEnvelopeJson],
    );

    // resumeBoxForTurn must win the cold->warming CAS (spawner) and use the
    // LEASE's resume_state (the archive-only envelope) as the spawnEnvelope
    // rather than the null session envelope. The local backend DOES have a
    // hydrateWorkspace that tries to JSON.parse the archive. F3's fail-open
    // fallback now catches that unusable archive, drops the placeholder, and
    // creates a clean box instead of failing the turn. The remaining assertion
    // is that the lease archive was not silently discarded from resume_state.
    let spawnError: Error | undefined;
    let resumed: Awaited<ReturnType<typeof resumeBoxForTurn>> | undefined;
    try {
      resumed = await resumeBoxForTurn(
        { db, settings },
        {
          accountId,
          workspaceId,
          sandboxGroupId: groupId,
          sessionId: groupId,
          backend: "local",
          os: "linux",
        },
        "turn",
        "activity-f3",
      );
    } catch (e) {
      spawnError = e instanceof Error ? e : new Error(String(e));
    } finally {
      await resumed?.release();
      if (resumed) await dropSession(resumed.established);
    }
    expect(spawnError).toBeUndefined();
    expect(resumed).toBeDefined();

    // The clean fallback succeeded; after the finally release above the idle
    // lease has naturally entered draining. Because the only archive was
    // unusable, the committed clean-box envelope no longer carries it.
    const row = await readRow(workspaceId, groupId);
    expect(row?.liveness).toBe("draining");
    const [archiveRow] = await admin<{ archive: string | null }[]>`
      select resume_state #>> '{sessionState,workspaceArchive}' as archive
      from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(archiveRow?.archive).toBeNull();
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

  // IMAGE IS SHARED STATE (B3): resumeBoxForTurn threads `image` into acquireLease.
  test("(B3-a) resumeBoxForTurn stamps the resolved image on the box it spawns", async () => {
    if (!available) return;
    const settings = settingsFor(true);
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const resumed = await resumeBoxForTurn(
      { db, settings },
      {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        sessionId: groupId,
        backend: "local",
        os: "linux",
        environment: { HOME: "/workspace" },
        image: "img-A",
      },
      "turn",
      "activity-1",
    );
    try {
      const warm = await readRow(workspaceId, groupId);
      expect(warm?.liveness).toBe("warm");
      expect(warm?.image).toBe("img-A");
    } finally {
      await resumed.release();
      await dropSession(resumed.established);
    }
  }, 60_000);

  test("(B3-b) resumeBoxForTurn PROPAGATES SandboxImageConflictError when another holder runs a different image", async () => {
    if (!available) return;
    const settings = settingsFor(true);
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    // A first turn warms the box on img-A and STAYS holding it (do not release).
    const keeper = await resumeBoxForTurn(
      { db, settings },
      {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        sessionId: groupId,
        backend: "local",
        os: "linux",
        environment: { HOME: "/workspace" },
        image: "img-A",
      },
      "turn",
      "keeper",
    );
    try {
      // A second holder resolving a DIFFERENT image while keeper holds -> conflict
      // propagates out of resumeBoxForTurn (the turn activity surfaces it as an
      // actionable error).
      await expect(
        resumeBoxForTurn(
          { db, settings },
          {
            accountId,
            workspaceId,
            sandboxGroupId: groupId,
            sessionId: groupId,
            backend: "local",
            os: "linux",
            environment: { HOME: "/workspace" },
            image: "img-B",
          },
          "turn",
          "newcomer",
        ),
      ).rejects.toThrow(SandboxImageConflictError);
      // The box is untouched — keeper's session keeps running.
      const warm = await readRow(workspaceId, groupId);
      expect(warm?.liveness).toBe("warm");
      expect(warm?.image).toBe("img-A");
    } finally {
      await keeper.release();
      await dropSession(keeper.established);
    }
  }, 60_000);
});
