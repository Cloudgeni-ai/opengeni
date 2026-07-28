import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  testSettings,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  advanceWorkspaceGeneration,
  advanceWorkspaceGenerationForDirectRequest,
  claimSessionWorkForAttempt,
  claimTerminalRetainedProcesses,
  countActiveRetainedProcessesByOwnerState,
  countExpiredDrainingSandboxLeases,
  createDb,
  createSession,
  getRetainedProcess,
  initializeSessionStartAtomically,
  readLease,
  recordRetainedProcessReconciliationProof,
  releaseLeaseHolder,
  retainedProcessSettlementIdentity,
  retainWorkspaceMutationProcess,
  SandboxWorkspaceMutationFencedError,
  settleRetainedProcess,
  type Database,
  type DbClient,
  type RetainedProcessProviderProof,
  type SandboxRetainedProcess,
  type SandboxRetainedProcessIdentity,
} from "@opengeni/db";
import { createObservability, type Observability } from "@opengeni/observability";
import {
  classifyRetainedProcessPollResult,
  createSandboxLeaseActivities,
  probeRetainedProcessAtProvider,
  type RetainedProcessProbeFn,
} from "../src/activities/sandbox-lease";
import {
  recordExpiredDrainingSandboxLeaseGauges,
  recordRetainedProcessInventoryGauges,
  recordRetainedProcessReconciliation,
} from "../src/observability-metrics";
import { sandboxLeaseHolderIdForAttempt } from "../src/sandbox-resume";
import type { ActivityServices } from "../src/activities/types";

const SETTINGS = testSettings({
  sandboxBackend: "local",
  webSearchEnabled: false,
  sandboxOwnershipEnabled: true,
  sandboxViewerHolderTtlMs: 90_000,
  sandboxIdleGraceMs: 45_000,
  sandboxLeaseReaperPeriodMs: 30_000,
});

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const cleanupRows: Array<{ accountId: string; workspaceId: string }> = [];

type WorkspaceIds = {
  accountId: string;
  workspaceId: string;
  groupId: string;
};

type TurnFixture = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  holderId: `turn-attempt:${string}`;
};

type ProcessFixture = WorkspaceIds & {
  leaseId: string;
  sessionId: string;
  process: SandboxRetainedProcess;
  providerSessionId: number;
  admissionId: string;
  attempt?: TurnFixture;
};

async function freshWorkspace(): Promise<WorkspaceIds> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('retained-process-test') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'retained-process-test') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  cleanupRows.push({ accountId: account!.id, workspaceId: workspace!.id });
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    groupId: crypto.randomUUID(),
  };
}

async function freshTurn(ids: WorkspaceIds): Promise<TurnFixture> {
  const session = await createSession(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    initialMessage: "retain this process",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  ids.groupId = session.sandboxGroupId;
  await initializeSessionStartAtomically(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
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
    dispatchId: `retained-process-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed")
    throw new Error(`Could not claim retained-process fixture: ${claim.reason}`);
  return {
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
    holderId: sandboxLeaseHolderIdForAttempt(attemptId),
  };
}

async function insertWarmLease(
  ids: WorkspaceIds,
  input: { sessionId: string; holderId: string; holderKind: "turn" | "direct" },
): Promise<{ leaseId: string; instanceId: string }> {
  const instanceId = `retained-process-box-${crypto.randomUUID()}`;
  const [lease] = await admin<{ id: string }[]>`
    insert into sandbox_leases (
      account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch,
      resume_backend_id, resume_state, expires_at
    ) values (
      ${ids.accountId}, ${ids.workspaceId}, ${ids.groupId}, 'warm', 1,
      ${input.holderKind === "turn" ? 1 : 0}, 0, ${instanceId}, 'modal', 7,
      'modal', ${JSON.stringify({
        backendId: "modal",
        sessionState: { providerState: { sandboxId: instanceId } },
        workspaceArchive: "UNCHANGED_ARCHIVE",
      })}::text::jsonb, now() + interval '10 minutes'
    ) returning id`;
  await admin`
    insert into sandbox_lease_holders (
      account_id, workspace_id, lease_id, kind, holder_id, subject_id
    ) values (
      ${ids.accountId}, ${ids.workspaceId}, ${lease!.id}, ${input.holderKind},
      ${input.holderId}, ${input.sessionId}
    )`;
  return { leaseId: lease!.id, instanceId };
}

const ownerTurnStatus = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  superseded: "superseded",
  interrupted_recoverable: "recovering",
  lease_lost_recoverable: "recovering",
} as const;

type ClosedAttemptOutcome = keyof typeof ownerTurnStatus;

async function closeTurnOwner(
  ids: WorkspaceIds,
  attempt: TurnFixture,
  outcome: ClosedAttemptOutcome,
): Promise<void> {
  await admin`
    update session_turn_attempts set
      state = 'closed', outcome = ${outcome}, closed_at = now(), updated_at = now()
    where workspace_id = ${ids.workspaceId} and id = ${attempt.attemptId}`;
  await admin`
    update session_turns set
      status = ${ownerTurnStatus[outcome]}, active_attempt_id = null,
      finished_at = case when ${ownerTurnStatus[outcome]} in
        ('completed', 'failed', 'cancelled', 'superseded') then now() else finished_at end,
      updated_at = now()
    where workspace_id = ${ids.workspaceId} and id = ${attempt.turnId}`;
  await releaseLeaseHolder(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    kind: "turn",
    holderId: attempt.holderId,
    idleGraceMs: SETTINGS.sandboxIdleGraceMs,
  });
}

async function promoteTurnProcess(
  input: {
    outcome?: ClosedAttemptOutcome;
    providerSessionId?: number;
  } = {},
): Promise<ProcessFixture> {
  const ids = await freshWorkspace();
  const attempt = await freshTurn(ids);
  const { leaseId, instanceId } = await insertWarmLease(ids, {
    sessionId: attempt.sessionId,
    holderId: attempt.holderId,
    holderKind: "turn",
  });
  const operation = `retainedProcessTurn-${crypto.randomUUID()}`;
  const admission = await advanceWorkspaceGeneration(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    executionGeneration: attempt.executionGeneration,
    attemptId: attempt.attemptId,
    holderId: attempt.holderId,
    sandboxGroupId: ids.groupId,
    expectedEpoch: 7,
    expectedInstanceId: instanceId,
    operation,
  });
  const processId = crypto.randomUUID();
  const providerSessionId = input.providerSessionId ?? 71;
  const process = await retainWorkspaceMutationProcess(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sessionId: attempt.sessionId,
    processId,
    providerSessionId,
    admissionId: admission.id,
    admittedWorkspaceGeneration: admission.workspaceGeneration,
    operation,
    owner: {
      kind: "turn",
      turnId: attempt.turnId,
      executionGeneration: attempt.executionGeneration,
      attemptId: attempt.attemptId,
      holderId: attempt.holderId,
      sandboxGroupId: ids.groupId,
      expectedEpoch: 7,
      expectedInstanceId: instanceId,
    },
  });
  if (input.outcome) await closeTurnOwner(ids, attempt, input.outcome);
  return {
    ...ids,
    leaseId,
    sessionId: attempt.sessionId,
    process,
    providerSessionId,
    admissionId: admission.id,
    attempt,
  };
}

async function promoteDirectProcess(): Promise<ProcessFixture> {
  const ids = await freshWorkspace();
  const session = await createSession(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    initialMessage: "direct retained process",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  ids.groupId = session.sandboxGroupId;
  const requestId = crypto.randomUUID();
  const holderId = `direct:${requestId}`;
  const { leaseId, instanceId } = await insertWarmLease(ids, {
    sessionId: session.id,
    holderId,
    holderKind: "direct",
  });
  const operation = `retainedProcessDirect-${crypto.randomUUID()}`;
  const admission = await advanceWorkspaceGenerationForDirectRequest(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sessionId: session.id,
    requestId,
    holderId,
    sandboxGroupId: ids.groupId,
    expectedEpoch: 7,
    expectedInstanceId: instanceId,
    routeTargetId: null,
    routeEpoch: 0,
    operation,
  });
  const processId = crypto.randomUUID();
  const process = await retainWorkspaceMutationProcess(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sessionId: session.id,
    processId,
    providerSessionId: 81,
    admissionId: admission.id,
    admittedWorkspaceGeneration: admission.workspaceGeneration,
    operation,
    owner: {
      kind: "direct",
      requestId,
      holderId,
      sandboxGroupId: ids.groupId,
      expectedEpoch: 7,
      expectedInstanceId: instanceId,
      routeTargetId: null,
      routeEpoch: 0,
    },
  });
  await releaseLeaseHolder(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    kind: "direct",
    holderId,
    idleGraceMs: SETTINGS.sandboxIdleGraceMs,
  });
  return {
    ...ids,
    leaseId,
    sessionId: session.id,
    process,
    providerSessionId: 81,
    admissionId: admission.id,
  };
}

function reaperServices(observability: Observability): () => Promise<ActivityServices> {
  return async () => ({
    settings: SETTINGS,
    db,
    bus: null as never,
    runtime: null as never,
    objectStorage: null,
    documentServices: null as never,
    observability,
    wakeSessionWorkflow: null,
  });
}

async function runReaper(probe: RetainedProcessProbeFn): Promise<Observability> {
  const observability = createObservability(SETTINGS, {
    component: "worker-retained-process-test",
  });
  const activities = createSandboxLeaseActivities(reaperServices(observability), {
    probeRetainedProcess: probe,
    terminateBox: async () => {
      throw new Error("retained-process reconciliation must not terminate a provider instance");
    },
    sweepModalOrphans: async () => 0,
  });
  await activities.reapSandboxLeases();
  return observability;
}

async function durableProcess(fixture: ProcessFixture): Promise<SandboxRetainedProcess> {
  const process = await getRetainedProcess(db, {
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    processId: fixture.process.id,
  });
  if (!process) throw new Error("Expected durable retained process");
  return process;
}

async function settlementProjection(fixture: ProcessFixture) {
  const [row] = await admin<
    {
      processState: string;
      processReason: string | null;
      admissionOutcome: string | null;
      admissionSettled: boolean;
      processHolders: number;
      refcount: number;
      liveness: string;
      leaseEpoch: number;
      instanceId: string | null;
      resumeState: unknown;
      workspaceGeneration: number;
      archiveGeneration: number;
    }[]
  >`
    select process.state as "processState", process.settlement_reason as "processReason",
      admission.provider_outcome as "admissionOutcome",
      admission.settled_at is not null as "admissionSettled",
      (select count(*)::integer from sandbox_lease_holders holder
        where holder.lease_id = lease.id and holder.kind = 'process'
          and holder.holder_id = process.holder_id) as "processHolders",
      lease.refcount, lease.liveness, lease.lease_epoch as "leaseEpoch",
      lease.instance_id as "instanceId", lease.resume_state as "resumeState",
      lease.workspace_generation as "workspaceGeneration",
      lease.archive_generation as "archiveGeneration"
    from sandbox_retained_processes process
    join sandbox_workspace_mutation_admissions admission
      on admission.id = process.parent_admission_id
    join sandbox_leases lease on lease.id = process.lease_id
    where process.id = ${fixture.process.id}`;
  return row!;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-retained-process-reconciliation");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable");
    }
    available = false;
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterEach(async () => {
  if (!available) return;
  for (const ids of cleanupRows.splice(0).reverse()) {
    await admin`delete from workspaces where id = ${ids.workspaceId}`;
    await admin`delete from managed_accounts where id = ${ids.accountId}`;
  }
});

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    // noop
  }
  await shared?.release();
}, 180_000);

describe("retained-process terminal-owner reconciliation", () => {
  test("classifies only exact provider exit/loss banners and defers running or malformed output", () => {
    expect(
      classifyRetainedProcessPollResult(
        "Chunk ID: abc\nWall time: 0.05 seconds\nProcess exited with code 67\nOutput:\ndone",
        9,
      ),
    ).toEqual({
      status: "proved",
      proof: {
        outcome: "exited",
        exitCode: 67,
        reason: "provider_exit_banner",
      },
    });
    expect(classifyRetainedProcessPollResult("session not found: 9", 9)).toEqual({
      status: "proved",
      proof: {
        outcome: "lost",
        exitCode: null,
        reason: "provider_session_lost_banner",
      },
    });
    expect(
      classifyRetainedProcessPollResult(
        "Process running with session ID 9\n\nOutput:\nstill working",
        9,
      ),
    ).toEqual({ status: "deferred", reason: "provider_running" });
    expect(classifyRetainedProcessPollResult("session not found: 10", 9)).toEqual({
      status: "deferred",
      reason: "provider_unknown",
    });
    expect(classifyRetainedProcessPollResult("Output:\nProcess exited with code 0", 9)).toEqual({
      status: "deferred",
      reason: "provider_unknown",
    });
    expect(classifyRetainedProcessPollResult({ exitCode: 0 }, 9)).toEqual({
      status: "deferred",
      reason: "provider_unknown",
    });
  });

  test("refuses provider proof when the resume envelope names a different instance", async () => {
    if (!available) return;
    const fixture = await promoteTurnProcess({ outcome: "completed" });
    await admin`
      update sandbox_leases set resume_state = jsonb_set(
        resume_state,
        '{sessionState,providerState,sandboxId}',
        to_jsonb('different-provider-instance'::text)
      )
      where id = ${fixture.leaseId}`;
    const lease = await readLease(db, fixture.workspaceId, fixture.groupId);
    if (!lease) throw new Error("Expected retained-process lease");
    expect(
      await probeRetainedProcessAtProvider(SETTINGS, lease, await durableProcess(fixture)),
    ).toEqual({ status: "deferred", reason: "identity_mismatch" });
    expect(await settlementProjection(fixture)).toMatchObject({
      processState: "active",
      admissionOutcome: "retained",
      processHolders: 1,
    });
  });

  test("claims every closed terminal/recovery attempt and direct owner, but not a live attempt", async () => {
    if (!available) return;
    const expected = new Map<string, string>();
    for (const outcome of Object.keys(ownerTurnStatus) as ClosedAttemptOutcome[]) {
      const fixture = await promoteTurnProcess({ outcome });
      expected.set(fixture.process.id, outcome);
    }
    const direct = await promoteDirectProcess();
    expected.set(direct.process.id, "direct");
    const active = await promoteTurnProcess();

    const claims = await claimTerminalRetainedProcesses(db, {
      claimId: crypto.randomUUID(),
      limit: 100,
      claimTtlMs: 300_000,
    });
    const selected = claims.filter((claim) => expected.has(claim.process.id));
    expect(selected).toHaveLength(expected.size);
    expect(claims.some((claim) => claim.process.id === active.process.id)).toBe(false);
    for (const claim of selected) {
      const expectedOutcome = expected.get(claim.process.id)!;
      if (expectedOutcome === "direct") {
        expect(claim.ownerState).toBe("direct");
        expect(claim.ownerAttemptOutcome).toBeNull();
      } else {
        expect(claim.ownerAttemptOutcome).toBe(expectedOutcome);
      }
    }
  }, 60_000);

  test("restricted app TEMP shadows cannot influence privileged claims or inventories", async () => {
    if (!available) return;
    const fixture = await promoteDirectProcess();
    const restricted = postgres(shared!.appUrl, { max: 1, prepare: false });
    try {
      const result = await restricted.begin(async (tx) => {
        await tx`set local search_path = pg_temp, public, opengeni_private, pg_catalog`;
        const [identity] = await tx<
          {
            currentUser: string;
            superuser: boolean;
            bypassRls: boolean;
            hasTemp: boolean;
            forceRls: boolean;
          }[]
        >`
          select current_user as "currentUser", role.rolsuper as "superuser",
            role.rolbypassrls as "bypassRls",
            has_database_privilege(current_user, current_database(), 'TEMP') as "hasTemp",
            retained.relforcerowsecurity as "forceRls"
          from pg_catalog.pg_roles role
          cross join pg_catalog.pg_class retained
          join pg_catalog.pg_namespace namespace on namespace.oid = retained.relnamespace
          where role.rolname = current_user
            and namespace.nspname = 'public'
            and retained.relname = 'sandbox_retained_processes'`;

        await tx.unsafe(`
          CREATE TEMP TABLE privileged_hijack_calls (helper text NOT NULL);
          CREATE FUNCTION pg_temp.now() RETURNS timestamptz LANGUAGE plpgsql AS $shadow$
          BEGIN
            INSERT INTO pg_temp.privileged_hijack_calls VALUES ('now');
            RETURN '1900-01-01 00:00:00+00'::timestamptz;
          END $shadow$;
          CREATE FUNCTION pg_temp.set_config(text, text, boolean) RETURNS text
          LANGUAGE plpgsql AS $shadow$
          BEGIN
            INSERT INTO pg_temp.privileged_hijack_calls VALUES ('set_config');
            RETURN $2;
          END $shadow$;
          CREATE FUNCTION pg_temp.make_interval(secs double precision) RETURNS interval
          LANGUAGE plpgsql AS $shadow$
          BEGIN
            INSERT INTO pg_temp.privileged_hijack_calls VALUES ('make_interval');
            RETURN interval '100 years';
          END $shadow$;

          CREATE TEMP TABLE sandbox_retained_processes (
            id uuid PRIMARY KEY,
            account_id uuid,
            workspace_id uuid,
            session_id uuid,
            state text,
            reconcile_after timestamptz,
            started_at timestamptz,
            owner_actor_kind text,
            owner_turn_id uuid,
            owner_attempt_id uuid,
            reconcile_claim_id uuid,
            reconcile_claimed_at timestamptz,
            reconcile_attempts integer,
            last_reconcile_outcome text
          );
          CREATE TEMP TABLE session_turns (workspace_id uuid, id uuid, status text);
          CREATE TEMP TABLE session_turn_attempts (
            workspace_id uuid, id uuid, state text, outcome text
          );
          CREATE TEMP TABLE sandbox_leases (backend text, liveness text, expires_at timestamptz);
          INSERT INTO sandbox_retained_processes VALUES (
            '00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-000000000002',
            '00000000-0000-0000-0000-000000000003',
            '00000000-0000-0000-0000-000000000004',
            'active', pg_catalog.now() - interval '1 day',
            pg_catalog.now() - interval '1 day',
            'direct', NULL, NULL, NULL, NULL, 0, NULL
          );
          INSERT INTO sandbox_leases VALUES (
            'shadow', 'draining', pg_catalog.now() - interval '1 day'
          );
        `);

        const functions = await tx<{ name: string; config: string[] | null; definition: string }[]>`
          select procedure.proname as name, procedure.proconfig as config,
            pg_catalog.pg_get_functiondef(procedure.oid) as definition
          from pg_catalog.pg_proc procedure
          join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'opengeni_private'
            and procedure.proname in (
              'claim_terminal_retained_processes',
              'count_active_retained_processes_by_owner_state',
              'count_expired_draining_sandbox_leases',
              'validate_sandbox_retained_process_v2'
            )
          order by procedure.proname`;
        const owners = await tx<
          { ownerState: string; activeCount: number; terminalOwnerCount: number }[]
        >`
          select owner_state as "ownerState", active_count::integer as "activeCount",
            terminal_owner_count::integer as "terminalOwnerCount"
          from opengeni_private.count_active_retained_processes_by_owner_state()`;
        const expired = await tx`
          select * from opengeni_private.count_expired_draining_sandbox_leases()`;
        const claims = await tx<{ processId: string }[]>`
          select process_id as "processId"
          from opengeni_private.claim_terminal_retained_processes(
            ${crypto.randomUUID()}::uuid, 1, 300000
          )`;
        const [shadow] = await tx<{ outcome: string | null }[]>`
          select last_reconcile_outcome as outcome
          from pg_temp.sandbox_retained_processes`;
        const [hijackCalls] = await tx<{ count: number }[]>`
          select count(*)::integer as count from pg_temp.privileged_hijack_calls`;
        return { identity, functions, owners, expired, claims, shadow, hijackCalls };
      });

      expect(result.identity).toEqual({
        currentUser: "opengeni_app",
        superuser: false,
        bypassRls: false,
        hasTemp: true,
        forceRls: true,
      });
      expect(result.functions).toHaveLength(4);
      for (const fn of result.functions) {
        expect(fn.config).toContain("search_path=pg_catalog");
        expect(fn.definition).not.toContain("pg_temp");
      }
      expect(result.owners).toContainEqual({
        ownerState: "direct",
        activeCount: 1,
        terminalOwnerCount: 1,
      });
      expect(result.expired).toHaveLength(0);
      expect(result.claims).toEqual([{ processId: fixture.process.id }]);
      expect(result.shadow).toEqual({ outcome: null });
      expect(result.hijackCalls).toEqual({ count: 0 });
    } finally {
      await restricted.end().catch(() => undefined);
    }
  }, 60_000);

  test("large corpus keeps candidate joins batch-capped and inventories on live-subset indexes", async () => {
    if (!available) return;
    const fixtures: ProcessFixture[] = [];
    for (let offset = 0; offset < 128; offset += 8) {
      fixtures.push(
        ...(await Promise.all(
          Array.from({ length: 8 }, () => promoteTurnProcess({ outcome: "completed" })),
        )),
      );
    }
    await admin`
      update sandbox_leases set liveness = 'draining', expires_at = now() - interval '2 hours'
      where id = ${fixtures[0]!.leaseId}`;

    const plans = await admin.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const candidates = await tx`
        explain (analyze, buffers, format json, costs off, summary off, timing off)
        with candidate_window as materialized (
          select process.id, process.workspace_id, process.owner_actor_kind,
            process.owner_turn_id, process.owner_attempt_id,
            process.reconcile_after as due_at, process.started_at
          from sandbox_retained_processes process
          where process.state = 'active' and process.reconcile_after <= pg_catalog.now()
          order by process.reconcile_after, process.started_at, process.id
          for update of process skip locked
          limit 7
        )
        select candidate.id, turn_row.status, attempt.state, attempt.outcome
        from candidate_window candidate
        left join lateral (
          select source_turn.status from session_turns source_turn
          where source_turn.workspace_id = candidate.workspace_id
            and source_turn.id = candidate.owner_turn_id
          limit 1
        ) turn_row on true
        left join lateral (
          select source_attempt.state, source_attempt.outcome
          from session_turn_attempts source_attempt
          where source_attempt.workspace_id = candidate.workspace_id
            and source_attempt.id = candidate.owner_attempt_id
          limit 1
        ) attempt on true`;
      await tx`set local enable_bitmapscan = off`;
      await tx`set local enable_sort = off`;
      const retainedInventory = await tx`
        explain (format json, costs off)
        select process.owner_actor_kind, process.workspace_id,
          process.owner_turn_id, process.owner_attempt_id
        from sandbox_retained_processes process
        where process.state = 'active' and process.owner_actor_kind = 'turn'
        order by process.owner_actor_kind, process.workspace_id,
          process.owner_turn_id, process.owner_attempt_id`;
      const leaseInventory = await tx`
        explain (format json, costs off)
        select lease.backend, lease.expires_at
        from sandbox_leases lease
        where lease.liveness = 'draining' and lease.expires_at < pg_catalog.now()`;
      return { candidates, retainedInventory, leaseInventory };
    });

    const candidatePlan = JSON.stringify(plans.candidates);
    expect(candidatePlan).toContain("sandbox_retained_processes_reconcile_due_idx");
    expect(candidatePlan).toContain('"Node Type":"Limit"');
    expect(candidatePlan).toContain('"Actual Rows":7');
    expect(candidatePlan).toMatch(/session_turn_attempts_(?:workspace_id_uq|pkey)/);
    expect(candidatePlan).not.toContain('"Actual Loops":128');
    expect(JSON.stringify(plans.retainedInventory)).toContain(
      "sandbox_retained_processes_active_inventory_idx",
    );
    expect(JSON.stringify(plans.leaseInventory)).toContain(
      "sandbox_leases_expired_draining_inventory_idx",
    );

    const claimId = crypto.randomUUID();
    const claims = await claimTerminalRetainedProcesses(db, {
      claimId,
      limit: 7,
      claimTtlMs: 300_000,
    });
    expect(claims).toHaveLength(7);
    const [mutationCount] = await admin<{ count: number }[]>`
      select count(*)::integer as count from sandbox_retained_processes
      where reconcile_claim_id = ${claimId}`;
    expect(mutationCount).toEqual({ count: 7 });
  }, 120_000);

  test("running, timeout, unknown, and probe errors fail closed without workspace or snapshot loss", async () => {
    if (!available) return;
    const fixture = await promoteTurnProcess({ outcome: "completed" });
    const before = await settlementProjection(fixture);
    const observations = [
      { status: "deferred", reason: "provider_running" },
      { status: "deferred", reason: "provider_timeout" },
      { status: "deferred", reason: "provider_unknown" },
    ] as const;
    for (const observation of observations) {
      await admin`
        update sandbox_retained_processes set reconcile_after = now()
        where id = ${fixture.process.id}`;
      await runReaper(async () => observation);
      const after = await settlementProjection(fixture);
      expect(after).toEqual(before);
    }
    await admin`
      update sandbox_retained_processes set reconcile_after = now()
      where id = ${fixture.process.id}`;
    await runReaper(async () => {
      throw new Error("transient provider transport failure");
    });
    expect(await settlementProjection(fixture)).toEqual(before);
    expect(await durableProcess(fixture)).toMatchObject({
      state: "active",
      lastReconcileOutcome: "provider_error",
      reconcileClaimId: null,
      reconcileProofOutcome: null,
    });
  }, 60_000);

  test("definitive exit proof atomically closes PTY/admission/holder and drains the exact lease", async () => {
    if (!available) return;
    const fixture = await promoteTurnProcess({ outcome: "failed" });
    const before = await settlementProjection(fixture);
    const ptyId = crypto.randomUUID();
    await admin`
      insert into sandbox_pty_sessions (
        id, account_id, workspace_id, session_id, lease_id, sandbox_group_id,
        retained_process_id, open_admission_id, exec_session_id, lease_epoch,
        provider_backend, provider_instance_id, route_kind, route_target_id,
        route_epoch, cols, rows, shell, cwd, status, opened_by
      ) values (
        ${ptyId}, ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.sessionId},
        ${fixture.leaseId}, ${fixture.groupId}, ${fixture.process.id},
        ${fixture.admissionId}, ${fixture.providerSessionId},
        ${fixture.process.leaseEpoch}, ${fixture.process.providerBackend},
        ${fixture.process.providerInstanceId}, ${fixture.process.routeKind},
        ${fixture.process.routeTargetId}, ${fixture.process.routeEpoch}, 120, 40,
        '/bin/bash', '/workspace', 'open', 'retained-process-test'
      )`;
    const proof: RetainedProcessProviderProof = {
      outcome: "exited",
      exitCode: 23,
      reason: "provider_exit_banner",
    };
    const observability = await runReaper(async () => ({
      status: "proved",
      proof,
    }));
    const after = await settlementProjection(fixture);
    expect(after).toMatchObject({
      processState: "exited",
      processReason: "provider_exit_banner",
      admissionOutcome: "resolved",
      admissionSettled: true,
      processHolders: 0,
      refcount: 0,
      liveness: "draining",
    });
    expect(after.resumeState).toEqual(before.resumeState);
    expect(after.workspaceGeneration).toBe(before.workspaceGeneration);
    expect(after.archiveGeneration).toBe(before.archiveGeneration);
    const [pty] = await admin<{ status: string; closedAt: Date | null }[]>`
      select status, closed_at as "closedAt" from sandbox_pty_sessions where id = ${ptyId}`;
    expect(pty?.status).toBe("closed");
    expect(pty?.closedAt).toBeInstanceOf(Date);

    const terminal = await durableProcess(fixture);
    const replay = await settleRetainedProcess(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      processId: fixture.process.id,
      expected: retainedProcessSettlementIdentity(terminal),
      outcome: "exited",
      exitCode: 23,
      reason: "provider_exit_banner",
      idleGraceMs: SETTINGS.sandboxIdleGraceMs,
    });
    expect(replay.settled).toBe(false);
    await expect(
      settleRetainedProcess(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        processId: fixture.process.id,
        expected: retainedProcessSettlementIdentity(terminal),
        outcome: "lost",
        exitCode: null,
        reason: "provider_session_lost_banner",
        idleGraceMs: SETTINGS.sandboxIdleGraceMs,
      }),
    ).rejects.toBeInstanceOf(SandboxWorkspaceMutationFencedError);
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_retained_process_reconciliation_total\{[^}]*outcome="settled_exited"[^}]*\} 1/,
    );
  }, 60_000);

  test("full copied identity, claim, admission, and successor lease fences reject without partial writes", async () => {
    if (!available) return;
    const fixture = await promoteTurnProcess({ outcome: "superseded" });
    const claimId = crypto.randomUUID();
    const [claim] = await claimTerminalRetainedProcesses(db, {
      claimId,
      limit: 1,
      claimTtlMs: 300_000,
    });
    expect(claim?.process.id).toBe(fixture.process.id);
    const expected = retainedProcessSettlementIdentity(claim!.process);
    const proof: RetainedProcessProviderProof = {
      outcome: "lost",
      exitCode: null,
      reason: "provider_instance_not_found",
    };
    await recordRetainedProcessReconciliationProof(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      processId: fixture.process.id,
      expected,
      claimId,
      proof,
    });
    const before = await settlementProjection(fixture);
    const wrongIdentities: SandboxRetainedProcessIdentity[] = [
      { ...expected, leaseId: crypto.randomUUID() },
      { ...expected, sandboxGroupId: crypto.randomUUID() },
      { ...expected, parentAdmissionId: crypto.randomUUID() },
      { ...expected, holderId: `process:${crypto.randomUUID()}` },
      { ...expected, leaseEpoch: expected.leaseEpoch + 1 },
      { ...expected, providerBackend: "local" },
      { ...expected, providerInstanceId: "successor-provider" },
      { ...expected, routeKind: "active" },
      { ...expected, routeTargetId: crypto.randomUUID() },
      { ...expected, routeEpoch: expected.routeEpoch + 1 },
      { ...expected, providerSessionId: expected.providerSessionId + 1 },
    ];
    for (const wrong of wrongIdentities) {
      await expect(
        settleRetainedProcess(db, {
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          processId: fixture.process.id,
          expected: wrong,
          reconciliationClaimId: claimId,
          ...proof,
          idleGraceMs: SETTINGS.sandboxIdleGraceMs,
        }),
      ).rejects.toBeInstanceOf(SandboxWorkspaceMutationFencedError);
      expect(await settlementProjection(fixture)).toEqual(before);
    }
    await expect(
      settleRetainedProcess(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        processId: fixture.process.id,
        expected,
        reconciliationClaimId: crypto.randomUUID(),
        ...proof,
        idleGraceMs: SETTINGS.sandboxIdleGraceMs,
      }),
    ).rejects.toBeInstanceOf(SandboxWorkspaceMutationFencedError);
    expect(await settlementProjection(fixture)).toEqual(before);

    await admin`
      update sandbox_workspace_mutation_admissions set route_epoch = route_epoch + 1
      where id = ${fixture.admissionId}`;
    await expect(
      settleRetainedProcess(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        processId: fixture.process.id,
        expected,
        reconciliationClaimId: claimId,
        ...proof,
        idleGraceMs: SETTINGS.sandboxIdleGraceMs,
      }),
    ).rejects.toBeInstanceOf(SandboxWorkspaceMutationFencedError);
    await admin`
      update sandbox_workspace_mutation_admissions set route_epoch = route_epoch - 1
      where id = ${fixture.admissionId}`;
    expect(await settlementProjection(fixture)).toEqual(before);

    await admin`
      update sandbox_leases set lease_epoch = lease_epoch + 1,
        instance_id = 'retained-process-successor'
      where id = ${fixture.leaseId}`;
    await expect(
      settleRetainedProcess(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        processId: fixture.process.id,
        expected,
        reconciliationClaimId: claimId,
        ...proof,
        idleGraceMs: SETTINGS.sandboxIdleGraceMs,
      }),
    ).rejects.toBeInstanceOf(SandboxWorkspaceMutationFencedError);
    const successor = await settlementProjection(fixture);
    expect(successor).toMatchObject({
      processState: "active",
      admissionOutcome: "retained",
      processHolders: 1,
      leaseEpoch: expected.leaseEpoch + 1,
      instanceId: "retained-process-successor",
    });
  }, 60_000);

  test("durable proof survives worker death and is reused after claim expiry without another probe", async () => {
    if (!available) return;
    const fixture = await promoteTurnProcess({
      outcome: "interrupted_recoverable",
    });
    const claimId = crypto.randomUUID();
    const [claim] = await claimTerminalRetainedProcesses(db, {
      claimId,
      limit: 1,
      claimTtlMs: 300_000,
    });
    const expected = retainedProcessSettlementIdentity(claim!.process);
    const proof: RetainedProcessProviderProof = {
      outcome: "lost",
      exitCode: null,
      reason: "provider_session_lost_banner",
    };
    await recordRetainedProcessReconciliationProof(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      processId: fixture.process.id,
      expected,
      claimId,
      proof,
    });
    await expect(
      recordRetainedProcessReconciliationProof(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        processId: fixture.process.id,
        expected,
        claimId,
        proof: {
          outcome: "exited",
          exitCode: 0,
          reason: "provider_exit_banner",
        },
      }),
    ).rejects.toBeInstanceOf(SandboxWorkspaceMutationFencedError);

    // Model a worker crash after proof COMMIT and before settlement. The persisted
    // reconcile_after claim expiry restores coordination only; the checkpointed
    // exact proof remains authority.
    await admin`
      update sandbox_retained_processes set
        reconcile_claimed_at = now() - interval '6 minutes',
        reconcile_after = now() - interval '1 minute'
      where id = ${fixture.process.id}`;
    let probes = 0;
    await runReaper(async () => {
      probes += 1;
      return { status: "deferred", reason: "provider_unknown" };
    });
    expect(probes).toBe(0);
    expect(await settlementProjection(fixture)).toMatchObject({
      processState: "lost",
      processReason: "provider_session_lost_banner",
      admissionOutcome: "rejected",
      admissionSettled: true,
      processHolders: 0,
    });
  }, 60_000);

  test("bounded oldest-first claims are fair and concurrent claimers remain disjoint", async () => {
    if (!available) return;
    const fixtures: ProcessFixture[] = [];
    for (let index = 0; index < 5; index += 1) {
      const fixture = await promoteTurnProcess({
        outcome: "lease_lost_recoverable",
      });
      fixtures.push(fixture);
      await admin`
        update sandbox_retained_processes set
          reconcile_after = now() - (${String(50 - index)} || ' seconds')::interval,
          started_at = now() - (${String(100 - index)} || ' seconds')::interval
        where id = ${fixture.process.id}`;
    }
    const oldest = await claimTerminalRetainedProcesses(db, {
      claimId: crypto.randomUUID(),
      limit: 2,
      claimTtlMs: 300_000,
    });
    expect(oldest.map((claim) => claim.process.id)).toEqual(
      fixtures.slice(0, 2).map((fixture) => fixture.process.id),
    );
    await admin`
      update sandbox_retained_processes set reconcile_claim_id = null,
        reconcile_claimed_at = null,
        reconcile_after = now() - interval '1 minute'
      where id in (${fixtures[0]!.process.id}, ${fixtures[1]!.process.id})`;

    const [left, right] = await Promise.all([
      claimTerminalRetainedProcesses(db, {
        claimId: crypto.randomUUID(),
        limit: 2,
        claimTtlMs: 300_000,
      }),
      claimTerminalRetainedProcesses(db, {
        claimId: crypto.randomUUID(),
        limit: 2,
        claimTtlMs: 300_000,
      }),
    ]);
    const leftIds = new Set(left.map((claim) => claim.process.id));
    const rightIds = new Set(right.map((claim) => claim.process.id));
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    expect([...leftIds].some((id) => rightIds.has(id))).toBe(false);
  }, 60_000);

  test("inventory functions report terminal owners and fixed expired-draining buckets", async () => {
    if (!available) return;
    const fixture = await promoteTurnProcess({ outcome: "completed" });
    await admin`
      update sandbox_leases set liveness = 'draining', expires_at = now() - interval '2 hours'
      where id = ${fixture.leaseId}`;
    const owners = await countActiveRetainedProcessesByOwnerState(db);
    expect(owners).toContainEqual({
      ownerState: "completed",
      activeCount: 1,
      terminalOwnerCount: 1,
    });
    const expired = await countExpiredDrainingSandboxLeases(db);
    expect(expired).toContainEqual({
      backend: "modal",
      ageBucket: "1h_1d",
      count: 1,
    });
  });
});

describe("retained-process metric contracts", () => {
  test("normalizes fixed labels, zeros absent series, records growth, failures, and expired drain state", async () => {
    const observability = createObservability(SETTINGS, {
      component: "worker-retained-process-metrics",
    });
    recordRetainedProcessInventoryGauges(observability, [
      { ownerState: "completed", activeCount: 2, terminalOwnerCount: 2 },
      { ownerState: "future-state", activeCount: 3, terminalOwnerCount: 1 },
    ]);
    recordRetainedProcessInventoryGauges(observability, [
      { ownerState: "completed", activeCount: 4, terminalOwnerCount: 4 },
      { ownerState: "future-state", activeCount: 3, terminalOwnerCount: 2 },
    ]);
    recordExpiredDrainingSandboxLeaseGauges(observability, [
      { backend: "modal", ageBucket: "1h_1d", count: 7 },
      { backend: "future-backend", ageBucket: "gte_1d", count: 2 },
    ]);
    recordRetainedProcessReconciliation(observability, "settlement_failed");
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_retained_processes_active\{[^}]*owner_state="completed"[^}]*\} 4/,
    );
    expect(metrics).toMatch(
      /opengeni_retained_processes_active\{[^}]*owner_state="running"[^}]*\} 0/,
    );
    expect(metrics).toMatch(
      /opengeni_retained_processes_active\{[^}]*owner_state="unknown"[^}]*\} 3/,
    );
    expect(metrics).toMatch(
      /opengeni_retained_process_terminal_owner_backlog_growth_total\{[^}]*\} 3/,
    );
    expect(metrics).toMatch(
      /opengeni_retained_process_reconciliation_total\{[^}]*outcome="settlement_failed"[^}]*\} 1/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_leases_expired_draining\{[^}]*age_bucket="1h_1d"[^}]*backend="modal"[^}]*\} 7/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_leases_expired_draining\{[^}]*age_bucket="gte_1d"[^}]*backend="unknown"[^}]*\} 2/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_leases_expired_draining\{[^}]*age_bucket="lt_5m"[^}]*backend="modal"[^}]*\} 0/,
    );
  });
});
