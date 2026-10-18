// Regression (production, October 15-16, 2026): a worker rollout interrupted a
// turn during sandbox setup and the setup's provider Start outcome was unknown.
// The turn parked recovering until the box was proven gone, while the idle
// drain refused to capture or stop the box because that setup request never
// settled. Neither could move, so the box (no holder) ran until the provider
// deadline, and because a lease that was already draining never gets a
// provider-deadline rotation stamped, the mandatory pre-deadline save did not
// apply either: the box died uncaptured and the resumed turn failed with
// "recovery is unrecoverable". Drives the real drain activity and lease ledger
// against PostgreSQL; only the provider snapshot + stop and the liveness probe
// are faked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { sandboxDeadlineMandatoryCaptureLeadMs, type Settings } from "@opengeni/config";
import {
  advanceWorkspaceGeneration,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listEndedEpochSandboxSetupUncertainties,
  readLease,
  reconcileCompletedSandboxSetup,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import { createSandboxLeaseActivities, type TerminateBoxFn } from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";
import { sandboxLeaseHolderIdForAttempt } from "../src/sandbox-resume";

const EPOCH = 41;
const IDLE_GRACE_MS = 15 * 60_000;
const SETTINGS = testSettings({
  sandboxBackend: "modal",
  webSearchEnabled: false,
  sandboxOwnershipEnabled: true,
  sandboxIdleGraceMs: IDLE_GRACE_MS,
  sandboxLeaseReaperPeriodMs: 30_000,
});
const MANDATORY_LEAD_MS = sandboxDeadlineMandatoryCaptureLeadMs(SETTINGS);

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-abandoned-setup-drain");
  if (!shared) throw new Error("Real PostgreSQL required for abandoned setup drain regressions");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function services(settings: Settings = SETTINGS): () => Promise<ActivityServices> {
  return async () => ({
    settings,
    db,
    bus: null as never,
    runtime: null as never,
    objectStorage: null,
    documentServices: null as never,
    observability: createObservability(settings, { component: "worker-test" }),
    wakeSessionWorkflow: null,
  });
}

function archiveDescriptor(archive: string) {
  const bytes = Buffer.from(archive, "base64");
  const archiveSha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return {
    version: 1 as const,
    revision: `wa1:1900000000000:${archiveSha256}`,
    archiveSha256,
    archiveBytes: bytes.length,
    capturedAt: new Date(1_900_000_000_000).toISOString(),
    workspace: {
      algorithm: "sha256" as const,
      sha256: archiveSha256,
      entryCount: 1,
      fileCount: 1,
      totalFileBytes: bytes.length,
    },
  };
}

/** Provider seam spy: verified capture through the real publication CAS, then
 * "stop", in production order. */
function terminateSpy() {
  const persisted: boolean[] = [];
  const fn: TerminateBoxFn = async (_settings, _lease, _observability, persistArchive) => {
    const archive = Buffer.from("ABANDONED_SETUP_ARCHIVE").toString("base64");
    const { wrote } = await persistArchive(archive, archiveDescriptor(archive));
    persisted.push(wrote);
    return wrote;
  };
  return { fn, persisted };
}

/** A turn whose setup Start outcome was unknown on a live Modal box: the setup
 * request never settled, the attempt closed `interrupted_recoverable` without a
 * quiescence receipt, the turn waits on the setup marker, and the box has no
 * holder left (draining). */
async function unknownSetupOnLiveBox(
  options: {
    closedMinutesAgo: number;
    marker?: boolean | "other_attempt";
    deadlineMinutes?: number;
    /** Modal directory snapshot (point-in-time, the production default) or a
     * file-by-file tar capture. */
    persistence?: "snapshot_directory" | "tar";
    /** Another open request of the same attempt besides its setup. */
    alsoExec?: boolean;
  } = { closedMinutesAgo: 30 },
) {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('abandoned-setup') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'abandoned-setup')
    returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  const session = await createSession(db, {
    ...ids,
    initialMessage: "create the resource group",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    ...ids,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, ids.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `abandoned-setup-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`fixture turn not claimed: ${claim.reason}`);
  const attempt = {
    sessionId: session.id,
    turnId: claim.turn.id,
    executionGeneration: claim.turn.executionGeneration,
    attemptId,
    sandboxGroupId: session.sandboxGroupId,
    holderId: sandboxLeaseHolderIdForAttempt(attemptId),
  };
  const instanceId = `sb-${crypto.randomUUID()}`;
  const [lease] = await admin<{ id: string }[]>`
    insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch, resume_backend_id,
      resume_state, expires_at, provider_created_at, provider_deadline_at)
    values (${ids.accountId}, ${ids.workspaceId}, ${attempt.sandboxGroupId}, 'warm', 1, 1, 0,
      ${instanceId}, 'modal', ${EPOCH}, 'modal',
      ${JSON.stringify({
        backendId: "modal",
        sessionState: {
          providerState: {
            sandboxId: instanceId,
            workspacePersistence: options.persistence ?? "snapshot_directory",
          },
        },
      })}::text::jsonb,
      now() + interval '10 minutes', now() - interval '1 hour',
      now() + (${options.deadlineMinutes ?? 23 * 60} * interval '1 minute'))
    returning id`;
  await admin`insert into sandbox_lease_holders
    (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
    values (${ids.accountId}, ${lease!.id}, ${ids.workspaceId}, 'turn', ${attempt.holderId},
      ${attempt.sessionId}, now())`;
  const admit = (operation: string) =>
    advanceWorkspaceGeneration(db, {
      ...ids,
      ...attempt,
      expectedEpoch: EPOCH,
      expectedInstanceId: instanceId,
      operation,
      routeKind: "home",
      routeTargetId: null,
      routeEpoch: 0,
    });
  const setup = await admit("eagerOwnedSandboxSetup");
  if (options.alsoExec) await admit("execCommand");
  await admin`update session_turn_attempts set state = 'closed',
    outcome = 'interrupted_recoverable',
    closed_at = now() - (${options.closedMinutesAgo} * interval '1 minute'), quiesced_at = null
    where id = ${attemptId}`;
  if (options.marker !== false) {
    await admin`update session_turns set status = 'recovering', active_attempt_id = null,
      metadata = metadata || ${admin.json({
        sandboxSetupOutcomeUnknown: {
          version: 1,
          turnId: attempt.turnId,
          attemptId: options.marker === "other_attempt" ? crypto.randomUUID() : attemptId,
          reason: "sandbox_command_start_outcome_unknown",
        },
      })}
      where id = ${attempt.turnId}`;
    await admin`update sessions set status = 'recovering' where id = ${attempt.sessionId}`;
  } else {
    // A turn that moved on: its request is not an unknown setup wait.
    await admin`update session_turns set status = 'completed', finished_at = now(),
      active_attempt_id = null where id = ${attempt.turnId}`;
    await admin`update sessions set status = 'idle', active_turn_id = null
      where id = ${attempt.sessionId}`;
  }
  // The dead turn holder is reaped; the lease drains with no holder.
  await admin`delete from sandbox_lease_holders where lease_id = ${lease!.id}`;
  await admin`update sandbox_leases set refcount = 0, turn_holders = 0, liveness = 'draining',
    expires_at = now() - interval '1 second' where id = ${lease!.id}`;
  return {
    ...ids,
    attempt,
    instanceId,
    leaseId: lease!.id,
    sandboxGroupId: attempt.sandboxGroupId,
    setupId: setup.id,
  };
}

type Fixture = Awaited<ReturnType<typeof unknownSetupOnLiveBox>>;

async function drain(fixture: Fixture) {
  const spy = terminateSpy();
  const probes: string[] = [];
  const activities = createSandboxLeaseActivities(services(), {
    terminateBox: spy.fn,
    // The provider is alive, as in production.
    probeDrainableProvider: async () => {
      probes.push("alive");
      return "alive" as never;
    },
  });
  const result = await activities.drainSandboxLease({
    target: {
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
      instanceId: fixture.instanceId,
      leaseEpoch: EPOCH,
    },
    timeoutClass: "fast",
    snapshotTimeoutMs: 60_000,
    captureTimeoutMs: 120_000,
    operationId: crypto.randomUUID(),
  });
  return { result, persisted: spy.persisted, probes };
}

async function setupRow(fixture: Fixture) {
  const [row] = await admin<{ provider_outcome: string | null; settled_at: Date | null }[]>`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where id = ${fixture.setupId}`;
  return row!;
}

async function expectSavedAndStopped(fixture: Fixture, drained: Awaited<ReturnType<typeof drain>>) {
  expect(drained.persisted).toEqual([true]);
  expect(drained.result.status).toBe("terminated");
  expect(await readLease(db, fixture.workspaceId, fixture.sandboxGroupId)).toMatchObject({
    liveness: "cold",
  });
  // Settled only after the box was terminated, never as an exit.
  const setup = await setupRow(fixture);
  expect(setup.settled_at).not.toBeNull();
  expect(setup.provider_outcome).toBe("rejected");
  const [lease] = await admin<{ forced: string[] | null; archive_generation: string | null }[]>`
    select deadline_forced_admission_ids as forced, archive_generation
    from sandbox_leases where id = ${fixture.leaseId}`;
  expect(lease!.forced).toBeNull();
  // A saved workspace exists for the resumed turn to restore.
  expect(lease!.archive_generation).not.toBeNull();
}

describe("an unknown-outcome setup request on a draining box", () => {
  test("pins the box only for the idle grace, then is captured around and stopped", async () => {
    const fixture = await unknownSetupOnLiveBox({ closedMinutesAgo: 1 });
    // Inside the abandonment window the drain still waits, as before.
    const early = await drain(fixture);
    expect(early.persisted).toEqual([]);
    expect(early.result.status).toBe("skipped");
    expect((await setupRow(fixture)).settled_at).toBeNull();

    await admin`update session_turn_attempts set closed_at = now() - interval '16 minutes'
      where id = ${fixture.attempt.attemptId}`;
    const late = await drain(fixture);
    // The live provider is not taken as proof of anything; the capture runs.
    expect(late.probes).toEqual([]);
    await expectSavedAndStopped(fixture, late);
    // The turn still waits for the ended-epoch proof; nothing was replayed.
    const [turn] = await admin<{ status: string; marker: unknown }[]>`
      select status, metadata -> 'sandboxSetupOutcomeUnknown' as marker from session_turns
      where id = ${fixture.attempt.turnId}`;
    expect(turn!.status).toBe("recovering");
    expect(turn!.marker).not.toBeNull();
  }, 60_000);

  test("the saved workspace lets the waiting turn resume through ended-epoch recovery", async () => {
    const fixture = await unknownSetupOnLiveBox({ closedMinutesAgo: 30 });
    await expectSavedAndStopped(fixture, await drain(fixture));
    // The cold commit wakes the owner workflow, whose quiescence check now
    // finds no pending writer; stand in for that receipt here.
    await admin`update session_turn_attempts set quiesced_at = now()
      where id = ${fixture.attempt.attemptId}`;
    const listed = (await listEndedEpochSandboxSetupUncertainties(db, { limit: 500 })).filter(
      (row) => row.workspaceId === fixture.workspaceId,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]!.box).toEqual({
      leaseId: fixture.leaseId,
      leaseEpoch: EPOCH,
      providerBackend: "modal",
      providerInstanceId: fixture.instanceId,
    });
    const reconciled = await reconcileCompletedSandboxSetup(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.attempt.sessionId,
      turnId: fixture.attempt.turnId,
      attemptId: fixture.attempt.attemptId,
      terminatedBox: listed[0]!.box,
    });
    expect(reconciled.reconciled).toBe(true);
    const [turn] = await admin<{ marker: unknown }[]>`
      select metadata -> 'sandboxSetupOutcomeUnknown' as marker from session_turns
      where id = ${fixture.attempt.turnId}`;
    expect(turn!.marker).toBeNull();
    // The resumed turn restores the saved workspace instead of failing as
    // unrecoverable.
    const lease = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    expect(lease?.recovery.archive.status).toBe("available");
  }, 60_000);

  test("anything beyond the abandoned setup request still blocks", async () => {
    const cases = [
      // Another open request of the same attempt (not setup).
      { closedMinutesAgo: 30, alsoExec: true },
      // The marker names a different attempt.
      { closedMinutesAgo: 30, marker: "other_attempt" as const },
      // A tar capture could read a box that is still writing.
      { closedMinutesAgo: 30, persistence: "tar" as const },
    ];
    for (const options of cases) {
      const fixture = await unknownSetupOnLiveBox(options);
      const drained = await drain(fixture);
      expect(drained.persisted).toEqual([]);
      expect(drained.result.status).toBe("skipped");
      expect((await setupRow(fixture)).settled_at).toBeNull();
    }
    // An active turn attempt or a newer generation is not abandoned either.
    for (const change of ["active_attempt", "generation"] as const) {
      const fixture = await unknownSetupOnLiveBox({ closedMinutesAgo: 30 });
      if (change === "active_attempt") {
        await admin`update session_turns set active_attempt_id = ${fixture.attempt.attemptId}
          where id = ${fixture.attempt.turnId}`;
      } else {
        await admin`update session_turns set execution_generation = execution_generation + 1
          where id = ${fixture.attempt.turnId}`;
      }
      const drained = await drain(fixture);
      expect(drained.persisted).toEqual([]);
      expect((await setupRow(fixture)).settled_at).toBeNull();
    }
  }, 120_000);

  test("an ordinary unsettled request of a finished turn still waits for the deadline", async () => {
    const fixture = await unknownSetupOnLiveBox({ closedMinutesAgo: 60, marker: false });
    const drained = await drain(fixture);
    expect(drained.persisted).toEqual([]);
    expect(drained.result.status).toBe("skipped");
    expect((await setupRow(fixture)).settled_at).toBeNull();
  }, 60_000);

  test("a draining box without a stamped rotation is saved inside the mandatory window", async () => {
    // Due rotations are stamped only on warm leases; this one was already
    // draining, so rotation_requested_at stays null.
    const fixture = await unknownSetupOnLiveBox({
      closedMinutesAgo: 60,
      marker: false,
      deadlineMinutes: Math.floor(MANDATORY_LEAD_MS / 60_000) - 1,
    });
    const [lease] = await admin<{ rotation: Date | null }[]>`
      select rotation_requested_at as rotation from sandbox_leases where id = ${fixture.leaseId}`;
    expect(lease!.rotation).toBeNull();
    await expectSavedAndStopped(fixture, await drain(fixture));
  }, 60_000);
});
