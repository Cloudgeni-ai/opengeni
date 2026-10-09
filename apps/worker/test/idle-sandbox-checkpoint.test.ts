// Regression: a warm Modal box that no turn holds, but that something else
// keeps warm, was never checkpointed: a running background command (the agent
// started a build, then ended its turn with wait_for_input or a pending
// approval), or an open desktop/terminal tab or computer controller after a
// short turn. Turn heartbeats only run inside a turn (and skipped while a tab
// was open), the zero-holder drain never sees the box, and idle command
// containment keeps an awaited command running. Its only save was the
// mandatory pre-deadline save, so an unplanned box loss before that lost every
// write since the last turn. Drives the real reaper sweep, the real
// warm-checkpoint path and the real lease/process ledger against PostgreSQL;
// only the provider resume-by-id and snapshot RPC are faked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import type { Settings } from "@opengeni/config";
import {
  acquireLease,
  acquireSandboxLeaseReaperHold,
  advanceWorkspaceGeneration,
  claimSessionWorkForAttempt,
  claimWorkspaceArchiveCapture,
  createDb,
  createSession,
  enrollRetainedCommandContainment,
  getRetainedProcess,
  initializeSessionStartAtomically,
  listIdleCheckpointCandidates,
  readLease,
  releaseLeaseHolder,
  requestDueSandboxRotationsGlobal,
  retainedProcessSettlementIdentity,
  retainWorkspaceMutationProcess,
  settleRetainedProcess,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { createProviderCommandRetainer } from "@opengeni/db/retained-provider-commands";
import { createObservability } from "@opengeni/observability";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import { createSandboxLeaseActivities } from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";
import {
  maybePersistWarmWorkspaceSnapshot,
  sandboxLeaseHolderIdForAttempt,
} from "../src/sandbox-resume";

const WINDOW_MS = 30 * 60_000;
const INTERVAL_MS = 15 * 60_000;
const EPOCH = 41;
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
  sandboxSnapshotIntervalMs: INTERVAL_MS,
  sandboxSnapshotTimeoutMs: 5_000,
});

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-idle-sandbox-checkpoint");
  if (!shared) throw new Error("Real PostgreSQL required for idle checkpoint regressions");
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

/** A Modal native filesystem snapshot provider. Only the RPC is faked.
 * `during` runs while the provider is "reading" the paused box. */
function modalProvider(during?: () => Promise<void>) {
  let snapshots = 0;
  let resumes = 0;
  const session = {
    state: { workspacePersistence: "snapshot_filesystem" },
    modal: {
      cpClient: {
        workspaceNameLookup: async () => ({ workspaceName: "opengeni-test", username: "" }),
      },
      profile: { serverUrl: "https://modal.test" },
      environmentName: () => "main",
    },
    persistWorkspace: async () => {
      snapshots += 1;
      await during?.();
      return new TextEncoder().encode(
        `MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-idle-${crypto.randomUUID()}","workspace_persistence":"snapshot_filesystem"}`,
      );
    },
  };
  return {
    session,
    resume: async () => {
      resumes += 1;
      return session;
    },
    snapshots: () => snapshots,
    resumes: () => resumes,
  };
}

/** One sandbox group whose turn wrote files, started a background build on a
 * warm Modal box, then ended while the session waits for that build. The
 * command keeps its process holder and parent admission, so the box stays warm
 * with no turn on it. */
async function heldBoxFixture(
  options: {
    supervised?: boolean;
    heldBy?: "command" | "viewer" | "interaction";
    /** Stop while the turn still holds the box (viewer/interaction only). */
    keepTurn?: boolean;
  } = {},
) {
  const heldBy = options.heldBy ?? "command";
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('idle-checkpoint') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'idle-checkpoint')
    returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  const session = await createSession(db, {
    ...ids,
    initialMessage: "build the release and tell me when it is done",
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
    dispatchId: `idle-checkpoint-${crypto.randomUUID()}`,
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
      ${JSON.stringify({
        backendId: "modal",
        sessionState: {
          providerState: { sandboxId: instanceId, workspacePersistence: "snapshot_filesystem" },
        },
      })}::text::jsonb,
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
  // The turn's file edits: settled writes no checkpoint has captured.
  const edit = await admit("write_file");
  await admin`update sandbox_workspace_mutation_admissions
    set settled_at = now(), provider_outcome = 'resolved' where id = ${edit.id}`;
  const processId = crypto.randomUUID();
  if (heldBy !== "command") {
    // The person kept the desktop or terminal tab open (a viewer), or a
    // computer/browser controller stays attached, after a short turn.
    await addHolder(
      {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        leaseId: lease!.id,
        sessionId: attempt.sessionId,
      },
      heldBy,
    );
    const held = {
      ...ids,
      attempt,
      instanceId,
      leaseId: lease!.id,
      sandboxGroupId: attempt.sandboxGroupId,
      processId: null as string | null,
    };
    if (options.keepTurn) return held;
    await releaseLeaseHolder(db, {
      ...ids,
      sandboxGroupId: attempt.sandboxGroupId,
      kind: "turn",
      holderId: attempt.holderId,
      idleGraceMs: SETTINGS.sandboxIdleGraceMs,
      workspaceWritersQuiesced: true,
    });
    await admin`update session_turn_attempts set state = 'closed', outcome = 'completed',
      closed_at = now(), quiesced_at = now() where id = ${attempt.attemptId}`;
    await admin`update session_turns set status = 'completed', finished_at = now(),
      active_attempt_id = null where id = ${attempt.turnId}`;
    await admin`update sessions set status = 'idle', active_turn_id = null
      where id = ${attempt.sessionId}`;
    return held;
  }
  const build = await admit("exec_command");
  const retain = options.supervised
    ? createProviderCommandRetainer(retainWorkspaceMutationProcess, () => null)
    : retainWorkspaceMutationProcess;
  await retain(db, {
    ...ids,
    sessionId: attempt.sessionId,
    processId,
    providerSessionId: 11,
    admissionId: build.id,
    admittedWorkspaceGeneration: build.workspaceGeneration,
    operation: "exec_command",
    providerBinding: MODAL_PROVIDER_BINDING,
    backgroundCommand: { commandId: processId, command: "bun run build:release" },
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
    ...(options.supervised
      ? {
          providerCommand: {
            kind: "modal-router-v1" as const,
            sandboxId: instanceId,
            taskId: "task",
            execId: crypto.randomUUID(),
            supervision: {
              protocol: "native-subreaper-v1" as const,
              invocationId: crypto.randomUUID(),
              nonce: "b".repeat(64),
              controlPath: `/tmp/opengeni-supervision/${crypto.randomUUID()}.sock`,
            },
            streams: {
              stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
              stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
            },
          },
        }
      : {}),
  });
  await admin`update sandbox_retained_processes set
    last_reconcile_outcome = 'provider_running', reconcile_attempts = 3
    where id = ${processId}`;
  // Turn finalization: writers quiesced, turn holder released, attempt closed,
  // and the session holds wait_for_input for the build.
  await releaseLeaseHolder(db, {
    ...ids,
    sandboxGroupId: attempt.sandboxGroupId,
    kind: "turn",
    holderId: attempt.holderId,
    idleGraceMs: SETTINGS.sandboxIdleGraceMs,
    workspaceWritersQuiesced: true,
  });
  await admin`update session_turn_attempts set state = 'closed', outcome = 'completed',
    closed_at = now(), quiesced_at = now() where id = ${attempt.attemptId}`;
  await admin`update session_turns set status = 'completed', finished_at = now(),
    active_attempt_id = null where id = ${attempt.turnId}`;
  await admin`update sessions set status = 'idle', active_turn_id = null,
    input_wait_turn_id = ${attempt.turnId}, input_wait_until = now() + interval '6 hours',
    input_wait_reason = 'waiting for the release build', input_wait_set_at = now()
    where id = ${attempt.sessionId}`;
  return {
    ...ids,
    attempt,
    instanceId,
    leaseId: lease!.id,
    sandboxGroupId: attempt.sandboxGroupId,
    processId: processId as string | null,
  };
}

/** Attach one more holder the way its owner does: the row plus the lease
 * counters the reaper recomputes. */
async function addHolder(
  fixture: { accountId: string; workspaceId: string; leaseId: string; sessionId: string },
  kind: "turn" | "viewer" | "interaction" | "direct",
) {
  let holderId =
    kind === "turn" ? `turn-attempt:${crypto.randomUUID()}` : `${kind}:${crypto.randomUUID()}`;
  if (kind === "interaction") {
    // A controller holder lives exactly as long as its ComputerSession.
    const computerId = crypto.randomUUID();
    const createOperationId = crypto.randomUUID();
    await admin`insert into interaction_operations (
        operation_id, account_id, workspace_id, resource_kind, resource_id, kind,
        request_digest, state, controller_generation, actor_subject_id, dispatched_at, settled_at)
      values (${createOperationId}, ${fixture.accountId}, ${fixture.workspaceId},
        'computer_session', ${computerId}, 'create', ${"a".repeat(64)}, 'completed', 1,
        'idle-checkpoint', now(), now())`;
    await admin`insert into computer_sessions (
        id, account_id, workspace_id, name, lifecycle, placement_kind,
        sandbox_group_id, controller_id, controller_generation,
        placement_instance_id, platform, adapter, seat_id, display_id,
        capabilities, create_operation_id, created_by_subject_id, controller_heartbeat_at)
      select ${computerId}, account_id, workspace_id, 'Desktop', 'active', 'sandbox_group',
        sandbox_group_id, 'browserd:idle-checkpoint', 1, instance_id, 'linux', 'native',
        'seat-1', 'display-1', '{}'::jsonb, ${createOperationId}, 'idle-checkpoint', now()
      from sandbox_leases where id = ${fixture.leaseId}`;
    holderId = `computer-session:${computerId}`;
  }
  await admin`insert into sandbox_lease_holders
    (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
    values (${fixture.accountId}, ${fixture.leaseId}, ${fixture.workspaceId}, ${kind},
      ${holderId}, ${fixture.sessionId}, now())`;
  await admin`update sandbox_leases set refcount = refcount + 1,
    turn_holders = turn_holders + ${kind === "turn" ? 1 : 0},
    viewer_holders = viewer_holders + ${kind === "viewer" ? 1 : 0}
    where id = ${fixture.leaseId}`;
  return holderId;
}

async function removeHolder(fixture: { leaseId: string }, holderId: string) {
  const [removed] = await admin<{ kind: string }[]>`
    delete from sandbox_lease_holders where lease_id = ${fixture.leaseId}
      and holder_id = ${holderId} returning kind`;
  await admin`update sandbox_leases set refcount = refcount - 1,
    turn_holders = turn_holders - ${removed!.kind === "turn" ? 1 : 0},
    viewer_holders = viewer_holders - ${removed!.kind === "viewer" ? 1 : 0}
    where id = ${fixture.leaseId}`;
}

function holderScope(fixture: Fixture) {
  return {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    leaseId: fixture.leaseId,
    sessionId: fixture.attempt.sessionId,
  };
}

type Fixture = Awaited<ReturnType<typeof heldBoxFixture>>;

/** Move every durable idleness and capture fact of the fixture back in time. */
async function idleFor(fixture: Fixture, minutes: number) {
  const ago = `${minutes} minutes`;
  await admin`update session_turns set finished_at = now() - ${ago}::interval
    where workspace_id = ${fixture.workspaceId} and finished_at is not null`;
  await admin`update session_turn_attempts set closed_at = now() - ${ago}::interval,
    updated_at = now() - ${ago}::interval, quiesced_at = now() - ${ago}::interval
    where workspace_id = ${fixture.workspaceId} and state = 'closed'`;
  await admin`update sandbox_workspace_mutation_admissions
    set admitted_at = now() - ${ago}::interval,
      settled_at = case when settled_at is null then null else now() - ${ago}::interval end
    where lease_id = ${fixture.leaseId} and not exists (
      select 1 from sandbox_retained_processes supervised
      where supervised.parent_admission_id = sandbox_workspace_mutation_admissions.id
        and supervised.provider_command ? 'supervision')`;
  await admin`update sandbox_leases set holders_changed_at = now() - ${ago}::interval,
    archive_capture_last_attempt_at = case when archive_capture_last_attempt_at is null then null
      else archive_capture_last_attempt_at - ${ago}::interval end,
    idle_checkpoint_attempted_at = case when idle_checkpoint_attempted_at is null then null
      else idle_checkpoint_attempted_at - ${ago}::interval end,
    resume_state = case
      when resume_state #>> '{sessionState,workspaceArchiveAt}' is null then resume_state
      else jsonb_set(resume_state, '{sessionState,workspaceArchiveAt}', to_jsonb(
        to_char((((resume_state #>> '{sessionState,workspaceArchiveAt}')::timestamptz
          - ${ago}::interval) at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    end
    where id = ${fixture.leaseId}`;
}

/** One reaper schedule tick as the workflows run it: the drain inventory,
 * then the idle checkpoint sweep's inventory and one durable child per target. */
async function reaperTick(provider: ReturnType<typeof modalProvider>, fixture: Fixture) {
  const activities = createSandboxLeaseActivities(services(), {
    terminateBox: async () => {
      throw new Error("a held box must never be terminated");
    },
    resumeIdleCheckpointSession: provider.resume,
  });
  const plan = await activities.prepareSandboxLeaseSweep();
  const sweep = await activities.listIdleSandboxCheckpoints();
  const checkpoints = sweep.targets;
  const results = [];
  // Other tests' boxes share this database; run only this fixture's child.
  for (const target of checkpoints) {
    if (target.sandboxGroupId !== fixture.sandboxGroupId) continue;
    results.push(
      await activities.checkpointIdleSandboxLease({ target, timeoutClass: sweep.timeoutClass }),
    );
  }
  return { plan, checkpoints, results };
}

function targetOf(fixture: Fixture) {
  return {
    workspaceId: fixture.workspaceId,
    sandboxGroupId: fixture.sandboxGroupId,
    instanceId: fixture.instanceId,
    leaseEpoch: EPOCH,
  };
}

async function checkpointNow(fixture: Fixture, provider: ReturnType<typeof modalProvider>) {
  const activities = createSandboxLeaseActivities(services(), {
    resumeIdleCheckpointSession: provider.resume,
  });
  return await activities.checkpointIdleSandboxLease({
    target: targetOf(fixture),
    timeoutClass: "fast",
  });
}

describe("checkpoints of held boxes between turns", () => {
  test("a box held by an awaited background command is checkpointed by the reaper", async () => {
    const fixture = await heldBoxFixture();
    const provider = modalProvider();
    await idleFor(fixture, 45);

    // The existing lifecycle leaves it alone: not drainable, not contained.
    expect(
      await enrollRetainedCommandContainment(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sandboxGroupId: fixture.sandboxGroupId,
        idleCommandContainmentMs: WINDOW_MS,
      }),
    ).toBeNull();
    const before = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    expect(before).toMatchObject({ liveness: "warm", archiveGeneration: null });

    const tick = await reaperTick(provider, fixture);
    expect(tick.plan.drainable.map((row) => row.sandboxGroupId)).not.toContain(
      fixture.sandboxGroupId,
    );
    // Previously nothing captured the box until the provider deadline.
    expect(tick.checkpoints.map((row) => row.sandboxGroupId)).toContain(fixture.sandboxGroupId);
    expect(provider.snapshots()).toBe(1);
    const after = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    expect(after).toMatchObject({ liveness: "warm", archiveCapture: null });
    expect(after?.currentCheckpointArtifactId).not.toBeNull();
    // The build may write after the provider read the box: a real recovery
    // point, kept one generation behind so it never claims to be complete.
    expect(after!.archiveGeneration).toBe(after!.workspaceGeneration - 1);
    expect(after!.archiveComplete).toBe(false);
    // The command keeps running with its holder and admission.
    const [process] = await admin<{ state: string }[]>`
      select state from sandbox_retained_processes where id = ${fixture.processId}`;
    expect(process!.state).toBe("active");
    const [holders] = await admin<{ count: number }[]>`
      select count(*)::integer as count from sandbox_lease_holders
      where lease_id = ${fixture.leaseId} and kind = 'process'`;
    expect(holders!.count).toBe(1);
  }, 60_000);

  test("checkpoints coalesce on the snapshot interval and a clean box is never captured", async () => {
    const fixture = await heldBoxFixture();
    const provider = modalProvider();
    await idleFor(fixture, 45);
    expect(
      (await reaperTick(provider, fixture)).checkpoints.map((row) => row.sandboxGroupId),
    ).toContain(fixture.sandboxGroupId);
    expect(provider.snapshots()).toBe(1);

    // Later ticks inside the interval neither list nor capture the box, and a
    // racing delivery is refused before it reaches the provider.
    for (let tick = 0; tick < 3; tick += 1) {
      expect(
        (await reaperTick(provider, fixture)).checkpoints.map((row) => row.sandboxGroupId),
      ).not.toContain(fixture.sandboxGroupId);
    }
    expect((await checkpointNow(fixture, provider)).status).toBe("skipped");
    expect(provider.snapshots()).toBe(1);

    // Once the interval has passed with the build still running, capture again.
    await idleFor(fixture, 16);
    expect(
      (await reaperTick(provider, fixture)).checkpoints.map((row) => row.sandboxGroupId),
    ).toContain(fixture.sandboxGroupId);
    expect(provider.snapshots()).toBe(2);

    // Once the build exits, nothing keeps the box warm: the ordinary
    // zero-holder drain captures it, not the idle checkpoint.
    const processScope = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.attempt.sessionId,
      processId: fixture.processId!,
    };
    const process = await getRetainedProcess(db, processScope);
    expect(
      (
        await settleRetainedProcess(db, {
          ...processScope,
          expected: retainedProcessSettlementIdentity(process!),
          outcome: "exited",
          exitCode: 0,
          reason: "provider_exit_banner",
          idleGraceMs: SETTINGS.sandboxIdleGraceMs,
        })
      ).settled,
    ).toBe(true);
    await idleFor(fixture, 16);
    expect(
      (await listIdleCheckpointCandidates(db, { limit: 100, intervalMs: INTERVAL_MS })).map(
        (row) => row.sandboxGroupId,
      ),
    ).not.toContain(fixture.sandboxGroupId);
  }, 60_000);

  test("a turn, direct request, supervised command or in-flight request on the box holds the checkpoint off", async () => {
    const holders = {
      turn: async (fixture: Fixture) => {
        await addHolder(holderScope(fixture), "turn");
      },
      // A direct API request holds the box while its admitted write runs.
      direct: async (fixture: Fixture) => {
        await addHolder(holderScope(fixture), "direct");
      },
    };
    for (const [kind, add] of Object.entries({
      ...holders,
      supervised: async () => undefined,
    })) {
      const fixture = await heldBoxFixture({ supervised: kind === "supervised" });
      const provider = modalProvider();
      await idleFor(fixture, 45);
      await add(fixture);
      expect(
        (await listIdleCheckpointCandidates(db, { limit: 100, intervalMs: INTERVAL_MS })).map(
          (row) => row.sandboxGroupId,
        ),
        kind,
      ).not.toContain(fixture.sandboxGroupId);
      expect((await checkpointNow(fixture, provider)).status, kind).toBe("skipped");
      expect(provider.snapshots(), kind).toBe(0);
    }
    // A request in flight on the box (here a stdin write) fences the capture.
    const fixture = await heldBoxFixture();
    const provider = modalProvider();
    await idleFor(fixture, 45);
    // A direct API write (e.g. a file upload) admitted on the box, still open.
    const [generation] = await admin<{ workspace_generation: number }[]>`
      update sandbox_leases set workspace_generation = workspace_generation + 1
      where id = ${fixture.leaseId} returning workspace_generation`;
    await admin`insert into sandbox_workspace_mutation_admissions (account_id, workspace_id,
        lease_id, sandbox_group_id, session_id, actor_kind, actor_id, holder_kind, holder_id,
        lease_epoch, provider_backend, provider_instance_id, route_kind, route_target_id,
        route_epoch, workspace_generation, operation, admitted_at)
      select account_id, workspace_id, lease_id, sandbox_group_id, session_id, 'direct',
        gen_random_uuid(), 'direct', 'direct:' || gen_random_uuid()::text, lease_epoch,
        provider_backend, provider_instance_id, route_kind, route_target_id, route_epoch,
        ${generation!.workspace_generation}, 'upload_file', now()
      from sandbox_workspace_mutation_admissions
      where lease_id = ${fixture.leaseId} and operation = 'exec_command'`;
    const [open] = await admin<{ count: number }[]>`
      select count(*)::integer as count from sandbox_workspace_mutation_admissions admission
      where lease_id = ${fixture.leaseId} and settled_at is null
        and not exists (select 1 from sandbox_retained_processes process
          where process.parent_admission_id = admission.id)`;
    expect(open!.count).toBeGreaterThan(0);
    const listed = async () =>
      (await listIdleCheckpointCandidates(db, { limit: 100, intervalMs: INTERVAL_MS })).map(
        (row) => row.sandboxGroupId,
      );
    // The inventory cannot see the request; the claim refuses it.
    expect(await listed()).toContain(fixture.sandboxGroupId);
    expect((await checkpointNow(fixture, provider)).status).toBe("skipped");
    expect(provider.snapshots()).toBe(0);
    // The refused attempt still counts: the box yields its batch slot to
    // others until the interval passes, instead of heading every sweep.
    expect(await listed()).not.toContain(fixture.sandboxGroupId);
    await idleFor(fixture, 16);
    expect(await listed()).toContain(fixture.sandboxGroupId);
  }, 120_000);

  test("a hold installed after inventory fences the idle child before its snapshot RPC", async () => {
    for (const timing of ["after_inventory", "during_resume"] as const) {
      const fixture = await heldBoxFixture();
      await idleFor(fixture, 45);
      const holdId = crypto.randomUUID();
      const hold = async () => {
        const receipt = await acquireSandboxLeaseReaperHold(db, {
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          sandboxGroupId: fixture.sandboxGroupId,
          expectedEpoch: EPOCH,
          expectedInstanceId: fixture.instanceId,
          holdId,
          ttlMs: 60_000,
          providerDeadlineHeadroomMs: 60_000,
          reason: "preserve synthetic idle checkpoint fixture",
        });
        expect(receipt.status).toBe("held");
      };
      const provider = modalProvider();
      const activities = createSandboxLeaseActivities(services(), {
        resumeIdleCheckpointSession: async () => {
          if (timing === "during_resume") await hold();
          return await provider.resume();
        },
      });
      const inventory = await activities.listIdleSandboxCheckpoints();
      const target = inventory.targets.find((row) => row.sandboxGroupId === fixture.sandboxGroupId);
      expect(target).toBeDefined();
      if (timing === "after_inventory") await hold();

      const result = await activities.checkpointIdleSandboxLease({
        target: target!,
        timeoutClass: inventory.timeoutClass,
      });
      expect(provider.snapshots(), timing).toBe(0);
      expect(result.status).toBe("skipped");
      const lease = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
      expect(lease).toMatchObject({
        liveness: "warm",
        archiveCapture: null,
        archiveGeneration: null,
        reaperHold: { id: holdId },
      });
    }
  }, 60_000);

  test("a rotation requested after inventory fences the idle child before its snapshot RPC", async () => {
    for (const timing of ["after_inventory", "during_resume"] as const) {
      const fixture = await heldBoxFixture();
      await idleFor(fixture, 45);
      const rotate = async () => {
        await admin`update sandbox_leases set provider_created_at = now() - interval '23 hours',
          provider_deadline_at = now() + interval '5 minutes'
          where id = ${fixture.leaseId}`;
        await requestDueSandboxRotationsGlobal(db, 10 * 60_000, 100);
        const lease = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
        expect(lease?.rotationRequestedAt).not.toBeNull();
        expect(lease?.rotationReason).toBe("provider_deadline");
      };
      const provider = modalProvider();
      const activities = createSandboxLeaseActivities(services(), {
        resumeIdleCheckpointSession: async () => {
          if (timing === "during_resume") await rotate();
          return await provider.resume();
        },
      });
      const inventory = await activities.listIdleSandboxCheckpoints();
      const target = inventory.targets.find((row) => row.sandboxGroupId === fixture.sandboxGroupId);
      expect(target).toBeDefined();
      if (timing === "after_inventory") await rotate();

      const result = await activities.checkpointIdleSandboxLease({
        target: target!,
        timeoutClass: inventory.timeoutClass,
      });
      expect(provider.snapshots(), timing).toBe(0);
      expect(result.status).toBe("skipped");
      expect(await readLease(db, fixture.workspaceId, fixture.sandboxGroupId)).toMatchObject({
        liveness: "warm",
        archiveCapture: null,
        archiveGeneration: null,
        rotationReason: "provider_deadline",
      });
    }
  }, 60_000);

  test("a capture claim orphaned by a dead worker is taken over after its deadline", async () => {
    const fixture = await heldBoxFixture();
    const provider = modalProvider();
    await idleFor(fixture, 45);
    // An earlier checkpoint worker claimed the box and died mid-capture.
    const orphaned = await claimWorkspaceArchiveCapture(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
      captureId: crypto.randomUUID(),
      expectedEpoch: EPOCH,
      expectedInstanceId: fixture.instanceId,
      liveness: "warm",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
      providerReplaySafe: true,
      takeoverSafe: true,
      pointInTimeCapture: true,
      idleCheckpoint: true,
    });
    expect(orphaned.status).toBe("claimed");
    // Before its deadline the claim is respected.
    expect((await checkpointNow(fixture, provider)).status).toBe("skipped");
    expect(provider.snapshots()).toBe(0);
    await admin`update sandbox_leases set
      archive_capture_started_at = now() - interval '20 minutes',
      archive_capture_last_attempt_at = now() - interval '20 minutes',
      idle_checkpoint_attempted_at = now() - interval '20 minutes',
      archive_capture_deadline_at = now() - interval '1 minute'
      where id = ${fixture.leaseId}`;
    const tick = await reaperTick(provider, fixture);
    expect(tick.checkpoints.map((row) => row.sandboxGroupId)).toContain(fixture.sandboxGroupId);
    expect(provider.snapshots()).toBe(1);
    const lease = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    expect(lease).toMatchObject({ liveness: "warm", archiveCapture: null });
    expect(lease!.archiveGeneration).toBe(lease!.workspaceGeneration - 1);
  }, 60_000);
  test("a dirty box kept warm only by an open viewer or controller is checkpointed each interval", async () => {
    for (const heldBy of ["viewer", "interaction"] as const) {
      const fixture = await heldBoxFixture({ heldBy });
      const provider = modalProvider();
      await idleFor(fixture, 45);

      // The existing lifecycle leaves it alone: not drainable, nothing to contain.
      const tick = await reaperTick(provider, fixture);
      expect(
        tick.plan.drainable.map((row) => row.sandboxGroupId),
        heldBy,
      ).not.toContain(fixture.sandboxGroupId);
      expect(
        tick.checkpoints.map((row) => row.sandboxGroupId),
        heldBy,
      ).toContain(fixture.sandboxGroupId);
      expect(provider.snapshots(), heldBy).toBe(1);
      const after = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
      expect(after, heldBy).toMatchObject({ liveness: "warm", archiveCapture: null });
      // The tab can write through its tunnel without an admission, so the
      // checkpoint is a recovery point but never claims to be complete.
      expect(after!.archiveGeneration, heldBy).toBe(after!.workspaceGeneration - 1);

      // Coalesced on the interval, then repeated while the writer stays.
      expect(
        (await reaperTick(provider, fixture)).checkpoints.map((row) => row.sandboxGroupId),
      ).not.toContain(fixture.sandboxGroupId);
      expect(provider.snapshots(), heldBy).toBe(1);
      await idleFor(fixture, 16);
      expect(
        (await reaperTick(provider, fixture)).checkpoints.map((row) => row.sandboxGroupId),
      ).toContain(fixture.sandboxGroupId);
      expect(provider.snapshots(), heldBy).toBe(2);
    }
  }, 120_000);

  test("a viewer that detached before the next capture still leaves the box dirty", async () => {
    const fixture = await heldBoxFixture({ heldBy: "viewer", keepTurn: true });
    const provider = modalProvider();
    const ids = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
    };
    const turnCheckpoint = async () => {
      const capture = maybePersistWarmWorkspaceSnapshot(
        {
          db,
          settings: SETTINGS,
          objectStorage: null,
          observability: createObservability(SETTINGS, { component: "worker-test" }),
        },
        {
          ...ids,
          sessionId: fixture.attempt.sessionId,
          turnId: fixture.attempt.turnId,
          attemptId: fixture.attempt.attemptId,
        },
        provider.session,
        EPOCH,
      );
      const captured = await capture;
      await capture.settled;
      return captured;
    };
    // The first tab closes; the turn's next checkpoint, with nothing else
    // attached, completes the archive.
    const [tab] = await admin<{ holder_id: string }[]>`
      select holder_id from sandbox_lease_holders where lease_id = ${fixture.leaseId}
        and kind = 'viewer'`;
    await removeHolder(fixture, tab!.holder_id);
    expect(await turnCheckpoint()).toBe(true);
    const complete = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    expect(complete).toMatchObject({ archiveComplete: true, untrackedWriterSince: null });

    // A terminal tab opens mid-turn, types into /workspace (no generation
    // admission) and closes before the next checkpoint.
    const viewerId = `viewer-${crypto.randomUUID()}`;
    const attached = await acquireLease(db, {
      ...ids,
      kind: "viewer",
      holderId: viewerId,
      backend: "modal",
      leaseTtlMs: 90_000,
    });
    expect(attached.role).toBe("attached");
    expect(attached.lease.untrackedWriterSince).not.toBeNull();
    await releaseLeaseHolder(db, {
      ...ids,
      kind: "viewer",
      holderId: viewerId,
      idleGraceMs: SETTINGS.sandboxIdleGraceMs,
    });
    const detached = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    // The generation never moved, so the archive still looks complete...
    expect(detached).toMatchObject({ archiveComplete: true, viewerHolders: 0 });
    // ...but the box is not clean. Before, the turn's checkpoint stopped at
    // the complete archive and the tab's writes waited for the next drain.
    expect(detached!.untrackedWriterSince).not.toBeNull();
    await idleFor(fixture, 16);
    expect(await turnCheckpoint()).toBe(true);
    expect(provider.snapshots()).toBe(2);
    const covered = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    expect(covered).toMatchObject({ archiveComplete: true, untrackedWriterSince: null });

    // A complete archive with nothing attached since is clean: the claim
    // refuses before any provider call.
    const claim = await claimWorkspaceArchiveCapture(db, {
      ...ids,
      captureId: crypto.randomUUID(),
      expectedEpoch: EPOCH,
      expectedInstanceId: fixture.instanceId,
      liveness: "warm",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
      providerReplaySafe: true,
      takeoverSafe: true,
      pointInTimeCapture: true,
      warmAttempt: {
        sessionId: fixture.attempt.sessionId,
        turnId: fixture.attempt.turnId,
        attemptId: fixture.attempt.attemptId,
        holderId: fixture.attempt.holderId,
      },
    });
    expect(claim.status).toBe("clean");

    // A new lease epoch is a new box restored from the archive.
    await acquireLease(db, {
      ...ids,
      kind: "viewer",
      holderId: viewerId,
      backend: "modal",
      leaseTtlMs: 90_000,
    });
    const [rolled] = await admin<{ untracked_writer_since: Date | null }[]>`
      update sandbox_leases set lease_epoch = lease_epoch + 1 where id = ${fixture.leaseId}
      returning untracked_writer_since`;
    expect(rolled!.untracked_writer_since).toBeNull();
  }, 60_000);

  test("a turn's heartbeat checkpoint runs around an open viewer instead of skipping", async () => {
    const fixture = await heldBoxFixture({ heldBy: "viewer", keepTurn: true });
    const provider = modalProvider();
    const capture = maybePersistWarmWorkspaceSnapshot(
      {
        db,
        settings: SETTINGS,
        objectStorage: null,
        observability: createObservability(SETTINGS, { component: "worker-test" }),
      },
      {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sandboxGroupId: fixture.sandboxGroupId,
        sessionId: fixture.attempt.sessionId,
        turnId: fixture.attempt.turnId,
        attemptId: fixture.attempt.attemptId,
      },
      provider.session,
      EPOCH,
    );
    // Previously refused as holder_in_progress for as long as the tab stayed open.
    expect(await capture).toBe(true);
    await capture.settled;
    expect(provider.snapshots()).toBe(1);
    const lease = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    expect(lease).toMatchObject({ liveness: "warm", archiveCapture: null });
    expect(lease!.archiveGeneration).toBe(lease!.workspaceGeneration - 1);
    const [viewers] = await admin<{ count: number }[]>`
      select count(*)::integer as count from sandbox_lease_holders
      where lease_id = ${fixture.leaseId} and kind = 'viewer'`;
    expect(viewers!.count).toBe(1);
  }, 60_000);
});
