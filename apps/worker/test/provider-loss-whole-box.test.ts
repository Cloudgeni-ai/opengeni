// Regression: after Modal ended a box at its 24h deadline, staging
// session 5040c525 settled its 35 retained commands one probe at a time, at
// most 20 per 30 s sweep: 11 extra minutes of a session waiting on a box that
// was already gone, and 35 separate "result unavailable" notices. The first
// exact "sandbox not found" already proves the whole box is gone. Drives the
// real reaper reconciliation and lease ledger against PostgreSQL; only the
// provider probe is faked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  advanceWorkspaceGeneration,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  readLease,
  releaseLeaseHolder,
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
import {
  createSandboxLeaseActivities,
  type RetainedProcessProbeFn,
} from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";
import { sandboxLeaseHolderIdForAttempt } from "../src/sandbox-resume";

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
  sandboxLeaseReaperPeriodMs: 30_000,
});

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-provider-loss-whole-box");
  if (!shared) throw new Error("Real PostgreSQL required for provider loss regressions");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

/** A warm Modal box whose finished turn left several
 * background commands running. */
async function boxWithCommands(count: number) {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('provider-loss') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'provider-loss') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  const session = await createSession(db, {
    ...ids,
    initialMessage: "run the benchmarks",
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
    dispatchId: `provider-loss-${crypto.randomUUID()}`,
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
      resume_state, expires_at, rotation_requested_at, rotation_reason,
      provider_created_at, provider_deadline_at)
    values (${ids.accountId}, ${ids.workspaceId}, ${attempt.sandboxGroupId}, 'warm', 1, 1, 0,
      ${instanceId}, 'modal', ${EPOCH}, 'modal',
      ${JSON.stringify({ backendId: "modal", sessionState: { providerState: { sandboxId: instanceId, workspacePersistence: "snapshot_directory" } } })}::text::jsonb,
      now() + interval '10 minutes', null, null,
      now() - interval '20 hours', now() + interval '4 hours')
    returning id`;
  await admin`insert into sandbox_lease_holders
    (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
    values (${ids.accountId}, ${lease!.id}, ${ids.workspaceId}, 'turn', ${attempt.holderId},
      ${attempt.sessionId}, now())`;
  const processIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const admission = await advanceWorkspaceGeneration(db, {
      ...ids,
      ...attempt,
      expectedEpoch: EPOCH,
      expectedInstanceId: instanceId,
      operation: "execCommand",
      routeKind: "home",
      routeTargetId: null,
      routeEpoch: 0,
    });
    const processId = crypto.randomUUID();
    processIds.push(processId);
    await retainWorkspaceMutationProcess(db, {
      ...ids,
      sessionId: attempt.sessionId,
      processId,
      providerSessionId: 100 + index,
      admissionId: admission.id,
      admittedWorkspaceGeneration: admission.workspaceGeneration,
      operation: "execCommand",
      providerBinding: MODAL_PROVIDER_BINDING,
      backgroundCommand: { commandId: processId, command: `python bench.py --case ${index}` },
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
  }
  await releaseLeaseHolder(db, {
    ...ids,
    sandboxGroupId: attempt.sandboxGroupId,
    kind: "turn",
    holderId: attempt.holderId,
    idleGraceMs: 60_000,
    workspaceWritersQuiesced: true,
  });
  await admin`update session_turn_attempts set state = 'closed', outcome = 'completed',
    closed_at = now(), quiesced_at = now() where id = ${attempt.attemptId}`;
  await admin`update session_turns set status = 'completed', finished_at = now(),
    active_attempt_id = null where id = ${attempt.turnId}`;
  await admin`update sessions set status = 'idle', active_turn_id = null where id = ${attempt.sessionId}`;
  await admin`update sandbox_retained_processes set reconcile_after = now() - interval '1 second'
    where lease_id = ${lease!.id}`;
  return { ...ids, attempt, instanceId, leaseId: lease!.id, processIds };
}

function services(): () => Promise<ActivityServices> {
  return async () => ({
    settings: SETTINGS,
    db,
    bus: null as never,
    runtime: null as never,
    objectStorage: null,
    documentServices: null as never,
    observability: createObservability(SETTINGS, { component: "worker-test" }),
    wakeSessionWorkflow: null,
  });
}

describe("provider loss settles the whole box at once", () => {
  test("the first exact NotFound retires every command, request and holder of the box", async () => {
    const fixture = await boxWithCommands(5);
    let probes = 0;
    const probe: RetainedProcessProbeFn = async () => {
      probes += 1;
      return {
        status: "proved",
        proof: { outcome: "lost", exitCode: null, reason: "provider_instance_not_found" },
      };
    };
    const activities = createSandboxLeaseActivities(services(), {
      probeRetainedProcess: probe,
      terminateBox: async () => {
        throw new Error("a lost box is never terminated");
      },
      sweepModalOrphans: async () => 0,
    });
    await activities.reapSandboxLeases();
    // One probe proved the box gone; nothing waited for later sweeps.
    expect(probes).toBe(1);
    const lease = await readLease(db, fixture.workspaceId, fixture.attempt.sandboxGroupId);
    expect(lease).toMatchObject({ liveness: "cold", leaseEpoch: EPOCH + 1, instanceId: null });
    const processes = await admin<{ state: string }[]>`
      select state from sandbox_retained_processes where lease_id = ${fixture.leaseId}`;
    expect(processes.map((row) => row.state)).toEqual(Array(5).fill("lost"));
    const [open] = await admin<{ count: number }[]>`
      select count(*)::integer as count from sandbox_workspace_mutation_admissions
      where lease_id = ${fixture.leaseId} and settled_at is null`;
    expect(open!.count).toBe(0);
    const [holders] = await admin<{ count: number }[]>`
      select count(*)::integer as count from sandbox_lease_holders where lease_id = ${fixture.leaseId}`;
    expect(holders!.count).toBe(0);
    const updates = await admin<{ summary: string }[]>`
      select summary from session_system_updates
      where session_id = ${fixture.attempt.sessionId} and kind = 'background_command_result'
      order by summary`;
    expect(updates).toHaveLength(5);
    for (const update of updates) {
      expect(update.summary).toContain(
        "is no longer running because its sandbox was shut down or lost",
      );
    }
  }, 60_000);
});
