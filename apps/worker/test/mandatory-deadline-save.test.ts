// Regression: close to a finite provider deadline the save is
// mandatory. Before, the deadline backstop waited for every command's stop
// grace and reconciliation, owner quiescence and sibling inactivity, and the
// zero-holder drain waited for every open request; when any of them could not
// finish, the provider killed the box uncaptured. Drives the real reaper
// activities and lease ledger against PostgreSQL; only the provider snapshot +
// stop and the readiness probe are faked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { sandboxDeadlineMandatoryCaptureLeadMs, type Settings } from "@opengeni/config";
import {
  advanceWorkspaceGeneration,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enrollRetainedCommandContainment,
  initializeSessionStartAtomically,
  readLease,
  retainWorkspaceMutationProcess,
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

const WINDOW_MS = 30 * 60_000;
const EPOCH = 31;
const MODAL_PROVIDER_BINDING = {
  key: '{"version":1,"serverUrl":"https://modal.test","workspaceName":"opengeni-test","environment":"test"}',
  binding: {
    version: 1 as const,
    serverUrl: "https://modal.test",
    workspaceName: "opengeni-test",
    environment: "test",
  },
};
const SETTINGS = testSettings({
  sandboxBackend: "modal",
  webSearchEnabled: false,
  sandboxOwnershipEnabled: true,
  sandboxViewerHolderTtlMs: 90_000,
  sandboxIdleGraceMs: 15 * 60_000,
  sandboxIdleCommandContainmentMs: WINDOW_MS,
  sandboxLeaseReaperPeriodMs: 30_000,
});

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-mandatory-deadline-save");
  if (!shared) throw new Error("Real PostgreSQL required for orphaned request regressions");
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
    const archive = Buffer.from("ORPHAN_REQUEST_ARCHIVE").toString("base64");
    const { wrote } = await persistArchive(archive, archiveDescriptor(archive));
    persisted.push(wrote);
    return wrote;
  };
  return { fn, persisted };
}

/** A session whose turn attempt crashed on a warm Modal box: one exec request
 * was dispatched and never settled, the attempt was closed lease-lost without a
 * quiescence receipt, and its turn holder was reaped as dead. Optionally the
 * same attempt had already started a background command that keeps running. */
async function crashedAttemptFixture(
  options: { backgroundCommand?: boolean; outcome?: string; keepHolder?: boolean } = {},
) {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('orphan-request') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'orphan-request')
    returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  const session = await createSession(db, {
    ...ids,
    initialMessage: "run the benchmark",
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
    dispatchId: `orphan-${crypto.randomUUID()}`,
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
  const instanceId = `box-${crypto.randomUUID()}`;
  const [lease] = await admin<{ id: string }[]>`
    insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch, resume_backend_id,
      resume_state, expires_at)
    values (${ids.accountId}, ${ids.workspaceId}, ${attempt.sandboxGroupId}, 'warm', 1, 1, 0,
      ${instanceId}, 'modal', ${EPOCH}, 'modal',
      ${JSON.stringify({ backendId: "modal", sessionState: { providerState: { sandboxId: instanceId } } })}::text::jsonb,
      now() + interval '10 minutes')
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
  const processId = crypto.randomUUID();
  if (options.backgroundCommand) {
    const admission = await admit("execCommand");
    await retainWorkspaceMutationProcess(db, {
      ...ids,
      sessionId: attempt.sessionId,
      processId,
      providerSessionId: 5,
      admissionId: admission.id,
      admittedWorkspaceGeneration: admission.workspaceGeneration,
      operation: "execCommand",
      providerBinding: MODAL_PROVIDER_BINDING,
      backgroundCommand: { commandId: processId, command: "python bench.py" },
      owner: {
        kind: "turn",
        turnId: attempt.turnId,
        executionGeneration: attempt.executionGeneration,
        attemptId: attempt.attemptId,
        holderId: attempt.holderId,
        sandboxGroupId: attempt.sandboxGroupId,
        expectedEpoch: EPOCH,
        expectedInstanceId: instanceId,
        routeKind: "home",
        routeTargetId: null,
        routeEpoch: 0,
      },
    });
    await admin`update sandbox_retained_processes set
      last_reconcile_outcome = 'provider_running', reconcile_attempts = 3
      where id = ${processId}`;
  }
  // The exec the worker dispatched just before it died.
  const orphan = await admit("execCommand");
  // Worker death: the attempt is closed lease-lost with no quiescence receipt,
  // and the dead holder is reaped (turn holders are TTL-reaped as dead).
  await admin`update session_turn_attempts set state = 'closed',
    outcome = ${options.outcome ?? "lease_lost_recoverable"}, closed_at = now(), quiesced_at = null
    where id = ${attempt.attemptId}`;
  if (!options.keepHolder) {
    await admin`delete from sandbox_lease_holders where lease_id = ${lease!.id} and kind = 'turn'`;
    await admin`update sandbox_leases set
      refcount = refcount - 1, turn_holders = turn_holders - 1,
      liveness = case when refcount - 1 = 0 then 'draining' else liveness end,
      expires_at = case when refcount - 1 = 0 then now() - interval '1 second' else expires_at end
      where id = ${lease!.id}`;
  }
  // A later attempt of the same turn finished without touching the box.
  await admin`update session_turns set status = 'completed', finished_at = now(),
    active_attempt_id = null where id = ${attempt.turnId}`;
  await admin`update sessions set status = 'idle', active_turn_id = null
    where id = ${attempt.sessionId}`;
  return {
    ...ids,
    attempt,
    instanceId,
    leaseId: lease!.id,
    sandboxGroupId: attempt.sandboxGroupId,
    processId,
    orphanId: orphan.id,
  };
}

type Fixture = Awaited<ReturnType<typeof crashedAttemptFixture>>;

async function drain(fixture: Fixture) {
  const spy = terminateSpy();
  const probes: string[] = [];
  const activities = createSandboxLeaseActivities(services(), {
    terminateBox: spy.fn,
    // The provider is alive: only a capture may lead to termination.
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

async function orphanRow(fixture: Fixture) {
  const [row] = await admin<{ provider_outcome: string | null; settled_at: Date | null }[]>`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where id = ${fixture.orphanId}`;
  return row!;
}

const MANDATORY_LEAD_MS = sandboxDeadlineMandatoryCaptureLeadMs(SETTINGS);

/** Put the fixture's box under a requested provider-deadline rotation whose
 * deadline is `minutesLeft` away. */
async function deadlineIn(fixture: Fixture, minutesLeft: number) {
  await admin`update sandbox_leases set rotation_requested_at = now() - interval '50 minutes',
    rotation_reason = 'provider_deadline',
    provider_created_at = now() - interval '23 hours',
    provider_deadline_at = now() + (${minutesLeft} * interval '1 minute')
    where id = ${fixture.leaseId}`;
}

function enroll(fixture: Fixture, lead: number | null = MANDATORY_LEAD_MS) {
  return enrollRetainedCommandContainment(db, {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sandboxGroupId: fixture.sandboxGroupId,
    ...(lead === null ? {} : { deadlineMandatoryCaptureLeadMs: lead }),
  });
}

describe("mandatory pre-deadline save", () => {
  test("the mandatory window leaves the stop grace, capture budget and reaper periods", () => {
    expect(MANDATORY_LEAD_MS).toBeLessThanOrEqual(SETTINGS.sandboxRotationLeadMs);
    expect(MANDATORY_LEAD_MS).toBeGreaterThanOrEqual(
      120_000 + SETTINGS.sandboxSnapshotTimeoutMs + 2 * SETTINGS.sandboxLeaseReaperPeriodMs,
    );
  });

  test("a deadline with a blocked orderly drain is saved anyway inside the mandatory window", async () => {
    // A background command that never got its stop request, and a request of
    // a cancelled attempt whose owner never settled it (holder gone).
    const fixture = await crashedAttemptFixture({ backgroundCommand: true, outcome: "cancelled" });
    await deadlineIn(fixture, 50);
    // Outside the window the orderly rule still waits.
    expect(await enroll(fixture)).toBeNull();
    await deadlineIn(fixture, Math.floor(MANDATORY_LEAD_MS / 60_000) - 1);
    // Without the mandatory window (old configuration) nothing changes.
    expect(await enroll(fixture, null)).toBeNull();
    const enrolled = await enroll(fixture);
    expect(enrolled?.mode).toBe("forced_deadline");
    const [lease] = await admin<{ forced: string[] | null; reason: string | null }[]>`
      select deadline_forced_admission_ids as forced, command_containment_reason as reason
      from sandbox_leases where id = ${fixture.leaseId}`;
    expect(lease!.forced).toEqual([fixture.orphanId]);
    expect(lease!.reason).toBe("provider_deadline_containment");
    const { result, persisted } = await drain(fixture);
    expect(persisted).toEqual([true]);
    expect(result.status).toBe("terminated");
    expect(await readLease(db, fixture.workspaceId, fixture.sandboxGroupId)).toMatchObject({
      liveness: "cold",
    });
    const [process] = await admin<{ state: string; settlement_reason: string }[]>`
      select state, settlement_reason from sandbox_retained_processes where id = ${fixture.processId}`;
    expect(process).toEqual({ state: "lost", settlement_reason: "provider_deadline_containment" });
    expect((await orphanRow(fixture)).provider_outcome).toBe("rejected");
    const [cleared] = await admin<{ forced: string[] | null }[]>`
      select deadline_forced_admission_ids as forced from sandbox_leases where id = ${fixture.leaseId}`;
    expect(cleared!.forced).toBeNull();
  }, 60_000);

  test("the zero-holder deadline drain captures around a request that cannot finish", async () => {
    const fixture = await crashedAttemptFixture({ outcome: "cancelled" });
    await deadlineIn(fixture, 50);
    const early = await drain(fixture);
    expect(early.persisted).toEqual([]);
    expect(early.result.status).toBe("skipped");
    expect((await orphanRow(fixture)).settled_at).toBeNull();

    await deadlineIn(fixture, Math.floor(MANDATORY_LEAD_MS / 60_000) - 1);
    // An earlier operator rotation keeps the deadline rotation from being
    // stamped separately; the save is still mandatory.
    await admin`update sandbox_leases set rotation_reason = 'operator' where id = ${fixture.leaseId}`;
    const late = await drain(fixture);
    expect(late.probes).toEqual([]);
    expect(late.persisted).toEqual([true]);
    expect(late.result.status).toBe("terminated");
    expect(await readLease(db, fixture.workspaceId, fixture.sandboxGroupId)).toMatchObject({
      liveness: "cold",
    });
    expect((await orphanRow(fixture)).provider_outcome).toBe("rejected");
    const [cleared] = await admin<{ forced: string[] | null }[]>`
      select deadline_forced_admission_ids as forced from sandbox_leases where id = ${fixture.leaseId}`;
    expect(cleared!.forced).toBeNull();
  }, 60_000);

  test("a live holder still owns the box inside the mandatory window", async () => {
    const fixture = await crashedAttemptFixture({
      backgroundCommand: true,
      outcome: "cancelled",
      keepHolder: true,
    });
    await deadlineIn(fixture, Math.floor(MANDATORY_LEAD_MS / 60_000) - 1);
    expect(await enroll(fixture)).toBeNull();
  }, 60_000);
});
