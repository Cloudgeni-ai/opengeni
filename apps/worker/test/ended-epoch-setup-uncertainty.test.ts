// Regression: a turn whose sandbox setup start outcome was unknown waited for
// the setup's retained process to exit. A start that failed before any process
// was recorded left nothing to exit, so once the reaper stopped its box the
// turn stayed recovering forever. A terminated observation of the exact
// historical box is physical proof that nothing it started can still run.
// Drives the real turn/attempt/admission/lease ledger, the reaper's
// maintenance pass and the session work peek against PostgreSQL.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type Settings } from "@opengeni/config";
import * as dbApi from "@opengeni/db";
import {
  advanceWorkspaceGeneration,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  peekSessionWork,
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
import {
  createSandboxLeaseActivities,
  type HistoricalModalSandboxLifecycleProbeFn,
} from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";
import { sandboxLeaseHolderIdForAttempt } from "../src/sandbox-resume";

const EPOCH = 11;
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
  sandboxLeaseReaperPeriodMs: 30_000,
});

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-ended-epoch-setup-uncertainty");
  if (!shared) throw new Error("Real PostgreSQL required for ended-epoch setup regressions");
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

/** A turn whose lazy setup start outcome was unknown: its setup request on a
 * warm Modal box physically settled, but no process was ever recorded. The
 * attempt closed and quiesced, and the turn waits on the setup marker. */
async function unknownSetupFixture(options: { secondBox?: boolean } = {}) {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('ended-epoch-setup') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ended-epoch-setup')
    returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  const session = await createSession(db, {
    ...ids,
    initialMessage: "take over the existing work",
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
    dispatchId: `ended-epoch-setup-${crypto.randomUUID()}`,
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
      resume_state, expires_at)
    values (${ids.accountId}, ${ids.workspaceId}, ${attempt.sandboxGroupId}, 'warm', 1, 1, 0,
      ${instanceId}, 'modal', ${EPOCH}, 'modal',
      ${JSON.stringify({
        backendId: "modal",
        sessionState: {
          providerState: {
            sandboxId: instanceId,
            workspacePersistence: "snapshot_directory",
          },
        },
      })}::text::jsonb,
      now() + interval '10 minutes')
    returning id`;
  await admin`insert into sandbox_lease_holders
    (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
    values (${ids.accountId}, ${lease!.id}, ${ids.workspaceId}, 'turn', ${attempt.holderId},
      ${attempt.sessionId}, now())`;
  const admitSetup = async (epoch: number, instance: string) =>
    await advanceWorkspaceGeneration(db, {
      ...ids,
      ...attempt,
      expectedEpoch: epoch,
      expectedInstanceId: instance,
      operation: "lazyOwnedSandboxSetup",
      routeKind: "home",
      routeTargetId: null,
      routeEpoch: 0,
    });
  const setupIds = [(await admitSetup(EPOCH, instanceId)).id];
  if (options.secondBox) {
    // The same attempt's setup also reached a later box of the same lease.
    const laterInstance = `sb-${crypto.randomUUID()}`;
    await admin`update sandbox_leases set lease_epoch = ${EPOCH + 1},
      instance_id = ${laterInstance} where id = ${lease!.id}`;
    setupIds.push((await admitSetup(EPOCH + 1, laterInstance)).id);
  }
  // The Start call's outcome was unknown, but its request settled physically.
  await admin`update sandbox_workspace_mutation_admissions set settled_at = now(),
    provider_outcome = 'resolved' where id in ${admin(setupIds)}`;
  const setupMarker = {
    version: 1,
    turnId: attempt.turnId,
    attemptId,
    reason: "sandbox_command_start_outcome_unknown",
  };
  await admin`update session_turn_attempts set state = 'closed', outcome = 'failed',
    closed_at = now(), quiesced_at = now() where id = ${attemptId}`;
  await admin`update session_turns set status = 'recovering', active_attempt_id = null,
    metadata = metadata || ${admin.json({ sandboxSetupOutcomeUnknown: setupMarker })}
    where id = ${attempt.turnId}`;
  await admin`update sessions set status = 'recovering' where id = ${attempt.sessionId}`;
  await admin`delete from sandbox_lease_holders where lease_id = ${lease!.id}`;
  await admin`update sandbox_leases set refcount = 0, turn_holders = 0 where id = ${lease!.id}`;
  return {
    ...ids,
    attempt,
    instanceId,
    leaseId: lease!.id,
    epoch: options.secondBox ? EPOCH + 1 : EPOCH,
    setupScope: {
      ...ids,
      sessionId: attempt.sessionId,
      turnId: attempt.turnId,
      attemptId,
    },
  };
}

type Fixture = Awaited<ReturnType<typeof unknownSetupFixture>>;

/** The reaper drained the idle box and committed the lease cold. */
async function drainCold(fixture: Fixture) {
  await admin`update sandbox_leases set liveness = 'cold', instance_id = null,
    lease_epoch = ${fixture.epoch + 1} where id = ${fixture.leaseId}`;
}

function terminatedBox(fixture: Fixture) {
  return {
    leaseId: fixture.leaseId,
    leaseEpoch: EPOCH,
    providerBackend: "modal" as const,
    providerInstanceId: fixture.instanceId,
  };
}

async function marker(fixture: Fixture) {
  const [row] = await admin<{ marker: unknown }[]>`
    select metadata -> 'sandboxSetupOutcomeUnknown' as marker from session_turns
    where id = ${fixture.attempt.turnId}`;
  return row?.marker ?? null;
}

async function wakeReason(fixture: Fixture) {
  const [row] = await admin<{ reason: string }[]>`
    select reason from session_workflow_wake_outbox where session_id = ${fixture.attempt.sessionId}`;
  return row?.reason ?? null;
}

async function listedFor(fixture: Fixture) {
  return (await dbApi.listEndedEpochSandboxSetupUncertainties(db, { limit: 500 })).filter(
    (row) => row.workspaceId === fixture.workspaceId,
  );
}

async function maintenanceDue() {
  const [row] = await admin<{ due: boolean }[]>`
    select opengeni_private.sandbox_ended_epoch_blockers_due_v1() as due`;
  return row!.due;
}

type HistoricalStatus = "terminated" | "running" | "not_found";

function historicalProbe(status: HistoricalStatus, probed: string[] = []) {
  return (async (_settings: Settings, sandboxId: string) => {
    probed.push(sandboxId);
    if (status === "not_found") return { status: "not_found" };
    return {
      status,
      ...(status === "terminated" ? { exitCode: 137 } : {}),
      providerBindingKey: MODAL_PROVIDER_BINDING.key,
      providerBinding: MODAL_PROVIDER_BINDING.binding,
    };
  }) as unknown as HistoricalModalSandboxLifecycleProbeFn;
}

async function runReaper(status: HistoricalStatus, probed: string[] = []) {
  const activities = createSandboxLeaseActivities(services(), {
    sweepModalOrphans: async () => 0,
    inspectOpenSandboxKubernetesInventory: async () => null as never,
    inspectHistoricalModalSandbox: historicalProbe(status, probed),
  });
  await activities.maintainSandboxLeaseSweep({
    examined: 0,
    started: 0,
    alreadyRunning: 0,
    startFailed: 0,
    rotationsRequested: 0,
  });
}

describe("unknown sandbox setup on an ended lease epoch", () => {
  test("the reaper resumes the turn once the exact box is observed terminated", async () => {
    const fixture = await unknownSetupFixture();
    await drainCold(fixture);
    // Before: nothing could ever settle this wait.
    expect(await reconcileCompletedSandboxSetup(db, fixture.setupScope)).toEqual({
      reconciled: false,
      events: [],
    });
    expect(await peekSessionWork(db, fixture.workspaceId, fixture.attempt.sessionId)).toMatchObject(
      {
        kind: "admission-blocked",
        reason: "sandbox_setup_outcome_unknown",
      },
    );

    // Running or NotFound is no proof the box is gone.
    for (const status of ["running", "not_found"] as const) {
      const probed: string[] = [];
      await runReaper(status, probed);
      expect(probed).toContain(fixture.instanceId);
      expect(await marker(fixture)).not.toBeNull();
    }

    await runReaper("terminated");
    expect(await marker(fixture)).toBeNull();
    expect(await wakeReason(fixture)).toBe("sandbox_setup_physically_settled");
    const [event] = await admin<{ type: string; payload: unknown }[]>`
      select type, payload from session_events where session_id = ${fixture.attempt.sessionId}
      order by sequence desc limit 1`;
    expect(event).toMatchObject({
      type: "turn.recovery.requested",
      payload: { reason: "sandbox_setup_physically_settled", retryable: true },
    });
    expect((await peekSessionWork(db, fixture.workspaceId, fixture.attempt.sessionId)).kind).toBe(
      "runnable",
    );
    // The same turn, generation and trigger are retried; nothing is replayed.
    const [turn] = await admin<{ status: string; execution_generation: number }[]>`
      select status, execution_generation from session_turns where id = ${fixture.attempt.turnId}`;
    expect(turn).toMatchObject({
      status: "recovering",
      execution_generation: fixture.attempt.executionGeneration,
    });
  }, 60_000);

  test("it is listed only once the lease has moved past the box", async () => {
    const fixture = await unknownSetupFixture();
    expect(await listedFor(fixture)).toEqual([]);
    expect(
      await reconcileCompletedSandboxSetup(db, {
        ...fixture.setupScope,
        terminatedBox: terminatedBox(fixture),
      }),
    ).toEqual({ reconciled: false, events: [] });
    expect(await maintenanceDue()).toBe(true);
    await drainCold(fixture);
    expect(await listedFor(fixture)).toEqual([
      {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.attempt.sessionId,
        turnId: fixture.attempt.turnId,
        attemptId: fixture.attempt.attemptId,
        sandboxGroupId: fixture.attempt.sandboxGroupId,
        box: terminatedBox(fixture),
      },
    ]);
  }, 60_000);

  test("a paused session is neither listed nor resumed until it is resumed", async () => {
    const fixture = await unknownSetupFixture();
    await drainCold(fixture);
    await admin`update sessions set direct_control_state = 'paused', direct_pause_revision = 1,
      control_version = control_version + 1 where id = ${fixture.attempt.sessionId}`;
    expect(await listedFor(fixture)).toEqual([]);
    expect(
      await reconcileCompletedSandboxSetup(db, {
        ...fixture.setupScope,
        terminatedBox: terminatedBox(fixture),
      }),
    ).toEqual({ reconciled: false, events: [] });
    await admin`update sessions set direct_control_state = 'active', direct_pause_revision = null,
      control_version = control_version + 1 where id = ${fixture.attempt.sessionId}`;
    expect(await listedFor(fixture)).toHaveLength(1);
    const reconciled = await reconcileCompletedSandboxSetup(db, {
      ...fixture.setupScope,
      terminatedBox: terminatedBox(fixture),
    });
    expect(reconciled.reconciled).toBe(true);
    expect(reconciled.events).toHaveLength(1);
    expect(await listedFor(fixture)).toEqual([]);
  }, 60_000);

  test("setup that also ran on another box needs proof for every box", async () => {
    const fixture = await unknownSetupFixture({ secondBox: true });
    await drainCold(fixture);
    expect(await listedFor(fixture)).toEqual([]);
    expect(
      await reconcileCompletedSandboxSetup(db, {
        ...fixture.setupScope,
        terminatedBox: terminatedBox(fixture),
      }),
    ).toEqual({ reconciled: false, events: [] });
    expect(await marker(fixture)).not.toBeNull();
  }, 60_000);

  test("a terminated observation of a different box proves nothing", async () => {
    const fixture = await unknownSetupFixture();
    await drainCold(fixture);
    expect(
      await reconcileCompletedSandboxSetup(db, {
        ...fixture.setupScope,
        terminatedBox: {
          ...terminatedBox(fixture),
          providerInstanceId: "sb-someone-else",
        },
      }),
    ).toEqual({ reconciled: false, events: [] });
    expect(
      await reconcileCompletedSandboxSetup(db, {
        ...fixture.setupScope,
        terminatedBox: { ...terminatedBox(fixture), leaseEpoch: EPOCH - 1 },
      }),
    ).toEqual({ reconciled: false, events: [] });
    expect(await marker(fixture)).not.toBeNull();
  }, 60_000);
});
