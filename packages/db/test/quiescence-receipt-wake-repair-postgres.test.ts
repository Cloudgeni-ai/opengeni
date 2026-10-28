import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionAttemptActivityRef,
  initializeSessionStartAtomically,
  markSessionAttemptQuiesced,
  mutateWorkspaceControlInTransaction,
  peekSessionWork,
  reconcileSessionAttemptQuiescence,
  repairMissingQuiescenceReceiptWakes,
  requestSessionTurnRecovery,
  mutateSessionControlInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("quiescence-receipt-wake-repair");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/** A recovering session whose interrupted attempt closed `closedSecondsAgo`
 * and whose last workflow wake was delivered `wakeDeliveredSecondsAgo`. */
async function strandedRecovery(input: {
  closedSecondsAgo: number;
  wakeDeliveredSecondsAgo: number;
  quiesce?: boolean;
}) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Quiescence repair",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Quiescence repair",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
    initialMessage: "root",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`could not claim fixture: ${claimed.reason}`);
  const recovery = await requestSessionTurnRecovery(client.db, workspaceId, {
    sessionId: session.id,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId,
    reason: "worker_shutdown",
  });
  expect(recovery.action).toBe("recovering");
  if (input.quiesce) {
    await markSessionAttemptQuiesced(client.db, {
      workspaceId,
      sessionId: session.id,
      attemptId,
      temporalWorkflowId: `session-${session.id}`,
    });
  }
  // The closing activity died before its receipt; every wake it produced was
  // already delivered to a workflow run that has since closed.
  await shared.admin`
    update session_turn_attempts
    set closed_at = closed_at - make_interval(secs => ${input.closedSecondsAgo})
    where id = ${attemptId}
  `;
  await shared.admin`
    update session_workflow_wake_outbox
    set delivered_revision = wake_revision,
      updated_at = now() - make_interval(secs => ${input.wakeDeliveredSecondsAgo})
    where session_id = ${session.id}
  `;
  return {
    accountId: grant.accountId,
    subjectId: grant.subjectId,
    workspaceId,
    sessionId: session.id,
    attemptId,
  };
}

async function wakeOf(sessionId: string) {
  const [row] = await shared.admin<
    { wake_revision: string; delivered_revision: string; reason: string }[]
  >`
    select wake_revision::text, delivered_revision::text, reason
    from session_workflow_wake_outbox where session_id = ${sessionId}
  `;
  return {
    pending: Number(row!.wake_revision) > Number(row!.delivered_revision),
    reason: row!.reason,
  };
}

async function repairAll() {
  let cursor = null;
  do {
    const lap = await repairMissingQuiescenceReceiptWakes(client.db, 100, cursor);
    expect(lap.failed).toBe(0);
    cursor = lap.cursor;
  } while (cursor);
}

/** Whether the deployment-wide inventory currently discovers this session. */
async function discovered(sessionId: string) {
  let after: { workspaceId: string; sessionId: string } | null = null;
  for (;;) {
    const rows: { workspace_id: string; session_id: string }[] = await shared.admin`
      select workspace_id::text, session_id::text
      from opengeni_private.list_quiescence_receipt_wake_repairs_v1(
        100, ${after?.workspaceId ?? null}::uuid, ${after?.sessionId ?? null}::uuid)
    `;
    if (rows.some((row) => row.session_id === sessionId)) return true;
    if (rows.length < 100) return false;
    const last = rows.at(-1)!;
    after = { workspaceId: last.workspace_id, sessionId: last.session_id };
  }
}

async function ageDeliveredWake(sessionId: string) {
  await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision,
    updated_at = now() - interval '20 minutes' where session_id = ${sessionId}`;
}

async function sessionControl(
  target: { accountId: string; workspaceId: string; subjectId: string; sessionId: string },
  action: "pause" | "resume",
) {
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    target.workspaceId,
    target.subjectId,
    (db) =>
      mutateSessionControlInTransaction(db, {
        accountId: target.accountId,
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        operationKey: crypto.randomUUID(),
        action,
        actor: { type: "human", subjectId: target.subjectId },
      }),
  );
}

/** Pause has parked the quiesced turn exactly as the workflow does: idle
 * projection, same `recovering` logical turn and active-turn pointer. */
async function parkedUnderPause() {
  const parked = await strandedRecovery({
    closedSecondsAgo: 300,
    wakeDeliveredSecondsAgo: 1_200,
    quiesce: true,
  });
  await sessionControl(parked, "pause");
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set status = 'idle' where id = ${parked.sessionId}`;
  });
  await ageDeliveredWake(parked.sessionId);
  return parked;
}

async function statusOf(sessionId: string) {
  const [row] = await shared.admin<{ session_status: string; turn_status: string }[]>`
    select session.status as session_status, turn.status as turn_status
    from sessions session
    join session_turns turn on turn.id = session.active_turn_id
    where session.id = ${sessionId}
  `;
  return row;
}

describe("missing quiescence-receipt wake repair", () => {
  test("a stranded interrupted attempt gets one wake, then is paced", async () => {
    const stranded = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 1_200,
    });
    expect((await wakeOf(stranded.sessionId)).pending).toBe(false);

    await repairAll();
    expect(await wakeOf(stranded.sessionId)).toEqual({
      pending: true,
      reason: "attempt_quiescence_repair",
    });

    // Delivered just now: the next lap does not wake it again.
    await shared.admin`
      update session_workflow_wake_outbox
      set delivered_revision = wake_revision, updated_at = now()
      where session_id = ${stranded.sessionId}
    `;
    await repairAll();
    expect((await wakeOf(stranded.sessionId)).pending).toBe(false);

    // Still stranded ten minutes later: wake again.
    await shared.admin`
      update session_workflow_wake_outbox
      set updated_at = now() - interval '11 minutes'
      where session_id = ${stranded.sessionId}
    `;
    await repairAll();
    expect((await wakeOf(stranded.sessionId)).pending).toBe(true);
  });

  test("the closing activity's own receipt window is not preempted", async () => {
    const fresh = await strandedRecovery({ closedSecondsAgo: 0, wakeDeliveredSecondsAgo: 1_200 });
    await repairAll();
    expect((await wakeOf(fresh.sessionId)).pending).toBe(false);
  });

  test("a quiesced active recovery is rediscovered, but a recent wake is paced", async () => {
    const quiesced = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 1_200,
      quiesce: true,
    });
    const recentlyWoken = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 60,
    });
    // Historical projection drift must not hide the logical turn from the
    // bounded inventory; actual admission still owns whether it can execute.
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update sessions set status = 'idle' where id = ${quiesced.sessionId}`;
    });
    await repairAll();
    expect(await wakeOf(quiesced.sessionId)).toEqual({
      pending: true,
      reason: "turn_recovery_repair",
    });
    expect((await wakeOf(recentlyWoken.sessionId)).pending).toBe(false);
  });

  test("a paused stale recovering projection is parked once, then left for Resume", async () => {
    const paused = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 1_200,
      quiesce: true,
    });
    await sessionControl(paused, "pause");
    await ageDeliveredWake(paused.sessionId);
    expect(await statusOf(paused.sessionId)).toEqual({
      session_status: "recovering",
      turn_status: "recovering",
    });
    // The receipt is durable but the projection still says `recovering`: the
    // wake routes the turn through DB-only projection settlement, not admission.
    expect(await discovered(paused.sessionId)).toBe(true);
    await repairAll();
    expect(await wakeOf(paused.sessionId)).toEqual({
      pending: true,
      reason: "turn_recovery_repair",
    });
    const peek = await peekSessionWork(client.db, paused.workspaceId, paused.sessionId);
    expect(peek).toEqual({ kind: "cancellation-wait", attemptId: paused.attemptId });
    const workflowId = `session-${paused.sessionId}`;
    const ref = await getSessionAttemptActivityRef(client.db, {
      accountId: paused.accountId,
      workspaceId: paused.workspaceId,
      sessionId: paused.sessionId,
      attemptId: paused.attemptId,
      temporalWorkflowId: workflowId,
    });
    expect(ref?.quiesced).toBe(true);
    const parked = await reconcileSessionAttemptQuiescence(client.db, {
      accountId: paused.accountId,
      workspaceId: paused.workspaceId,
      sessionId: paused.sessionId,
      attemptId: paused.attemptId,
      temporalWorkflowId: workflowId,
      temporalWorkflowRunId: ref!.workflowRunId,
      temporalActivityId: ref!.activityId,
      activitySettled: true,
    });
    expect(parked.action).toBe("quiesced");
    // Pause preserves the logical turn; only the projection parked.
    expect(await statusOf(paused.sessionId)).toEqual({
      session_status: "idle",
      turn_status: "recovering",
    });
    await ageDeliveredWake(paused.sessionId);
    expect(await discovered(paused.sessionId)).toBe(false);
    await repairAll();
    expect((await wakeOf(paused.sessionId)).pending).toBe(false);
  });

  test("Pause-parked turns leave discovery and return after Resume", async () => {
    const parked = await parkedUnderPause();
    expect(await discovered(parked.sessionId)).toBe(false);
    await repairAll();
    expect((await wakeOf(parked.sessionId)).pending).toBe(false);
    expect(await statusOf(parked.sessionId)).toEqual({
      session_status: "idle",
      turn_status: "recovering",
    });

    // Resume commits its own wake for the preserved turn.
    await sessionControl(parked, "resume");
    expect((await wakeOf(parked.sessionId)).pending).toBe(true);
    expect((await peekSessionWork(client.db, parked.workspaceId, parked.sessionId)).kind).toBe(
      "runnable",
    );
    // If that wake is delivered but lost, ordinary rediscovery repairs it.
    await ageDeliveredWake(parked.sessionId);
    expect(await discovered(parked.sessionId)).toBe(true);
    await repairAll();
    expect(await wakeOf(parked.sessionId)).toEqual({
      pending: true,
      reason: "turn_recovery_repair",
    });
  });

  test("ancestor and workspace Pause park descendants with the override algebra", async () => {
    const child = await parkedUnderPause();
    // Selected Resume on the child advances its subtree override.
    await sessionControl(child, "resume");
    await ageDeliveredWake(child.sessionId);
    const parent = await createSession(client.db, {
      accountId: child.accountId,
      workspaceId: child.workspaceId,
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
      initialMessage: "parent",
    });
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update sessions set parent_session_id = ${parent.id}, root_session_id = ${parent.id}
        where id = ${child.sessionId}`;
    });
    expect(await discovered(child.sessionId)).toBe(true);
    // A newer ancestor Pause is not defeated by the child's older override.
    await sessionControl({ ...child, sessionId: parent.id }, "pause");
    await ageDeliveredWake(child.sessionId);
    expect(await discovered(child.sessionId)).toBe(false);
    await sessionControl({ ...child, sessionId: parent.id }, "resume");
    await ageDeliveredWake(child.sessionId);
    expect(await discovered(child.sessionId)).toBe(true);

    await withWorkspaceRls(client.db, child.workspaceId, (db) =>
      db.transaction((tx) =>
        mutateWorkspaceControlInTransaction(tx as unknown as typeof db, {
          accountId: child.accountId,
          workspaceId: child.workspaceId,
          actor: { type: "human", subjectId: child.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );
    await ageDeliveredWake(child.sessionId);
    expect(await discovered(child.sessionId)).toBe(false);
  });

  test("admission blocks and sandbox setup markers are durable waits, not lost wakes", async () => {
    const blocked = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 1_200,
      quiesce: true,
    });
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update sessions set status = 'requires_action', admission_block = ${tx.json({
        reason: "database_claim_rejected",
        sqlState: null,
        retryPolicy: "explicit_recheck",
        blockedAt: new Date().toISOString(),
        attemptId: crypto.randomUUID(),
        fence: { lastSequence: 1, controlVersion: 1 },
        previousStatus: "recovering",
      })} where id = ${blocked.sessionId}`;
    });
    expect(await discovered(blocked.sessionId)).toBe(false);

    const markers = {
      sandboxSetupOutcomeUnknown: (turnId: string, attemptId: string) => ({
        version: 1,
        turnId,
        attemptId,
        reason: "sandbox_command_start_outcome_unknown",
      }),
      sandboxSetupRecoveryExhausted: (turnId: string, attemptId: string) => ({
        version: 1,
        turnId,
        attemptId,
        reason: "sandbox_command_start_recovery_exhausted",
        setupOutcome: "not_started",
        providerRecoveryCount: 5,
      }),
    };
    for (const [key, marker] of Object.entries(markers)) {
      const waiting = await strandedRecovery({
        closedSecondsAgo: 300,
        wakeDeliveredSecondsAgo: 1_200,
        quiesce: true,
      });
      const [turn] = await shared.admin<{ id: string }[]>`
        select active_turn_id::text as id from sessions where id = ${waiting.sessionId}`;
      await shared.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update session_turns
          set metadata = coalesce(metadata, '{}'::jsonb) || ${tx.json({
            [key]: marker(turn!.id, waiting.attemptId),
          })}
          where id = ${turn!.id}`;
      });
      expect((await peekSessionWork(client.db, waiting.workspaceId, waiting.sessionId)).kind).toBe(
        "admission-blocked",
      );
      expect(await discovered(waiting.sessionId)).toBe(false);
      // A malformed marker does not block admission, so it stays discoverable.
      await shared.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update session_turns set metadata = jsonb_set(metadata, ${[key, "attemptId"]}::text[], '""')
          where id = ${turn!.id}`;
      });
      expect((await peekSessionWork(client.db, waiting.workspaceId, waiting.sessionId)).kind).toBe(
        "runnable",
      );
      expect(await discovered(waiting.sessionId)).toBe(true);
    }
  });

  test("the inventory is the dispatcher's private capability", async () => {
    const [posture] = await shared.admin<
      { same_owner: boolean; definer: boolean; public_execute: boolean }[]
    >`
      select repair.proowner = dispatcher.proowner as same_owner,
        repair.prosecdef as definer,
        has_function_privilege('public', repair.oid, 'EXECUTE') as public_execute
      from pg_proc repair, pg_proc dispatcher
      where repair.oid = 'opengeni_private.list_quiescence_receipt_wake_repairs_v1(integer,uuid,uuid)'::regprocedure
        and dispatcher.oid = 'opengeni_private.claim_session_workflow_wakes(integer)'::regprocedure
    `;
    expect(posture).toEqual({ same_owner: true, definer: true, public_execute: false });
  });

  test("latest-attempt inventory uses the existing exact ownership key", async () => {
    const waiting = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 1_200,
      quiesce: true,
    });
    const [definition] = await shared.admin<{ body: string; owner: string }[]>`
      select p.prosrc as body, r.rolname as owner
      from pg_proc p join pg_roles r on r.oid=p.proowner
      where p.oid='opengeni_private.list_quiescence_receipt_wake_repairs_v1(integer,uuid,uuid)'::regprocedure`;
    const match = definition!.body.match(/RETURN QUERY\s+([\s\S]*);\s*END\s*$/);
    if (!match) throw new Error("Unexpected inventory definition");
    const candidate = match[1]!
      .replace(/\bp_limit\b/g, "$1")
      .replace(/\bp_after_workspace_id\b/g, "$2")
      .replace(/\bp_after_session_id\b/g, "$3");
    const predicate = "latest.account_id = session.account_id AND ";
    expect(candidate.split(predicate)).toHaveLength(2);
    const baseline = candidate.replace(predicate, "");

    // Valid historical identities, inserted administratively to keep fixture
    // setup bounded rather than executing thousands of unrelated agent turns.
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role=replica`;
      await tx`
        with historical_turns as (
          insert into session_turns
          select (jsonb_populate_record(null::session_turns, to_jsonb(seed_turn) ||
            jsonb_build_object('id',gen_random_uuid(),'position',n,
              'status','completed','active_attempt_id',null,'finished_at',now()))).*
          from session_turns seed_turn cross join generate_series(1,1000) n
          where seed_turn.id=(select active_turn_id from sessions where id=${waiting.sessionId})
          returning id
        )
        insert into session_turn_attempts
        select (jsonb_populate_record(null::session_turn_attempts, to_jsonb(seed_attempt) ||
          jsonb_build_object('id',gen_random_uuid(),'turn_id',historical_turns.id,
            'execution_generation',generation,'temporal_workflow_run_id',gen_random_uuid()::text,
            'temporal_activity_id',gen_random_uuid()::text))).*
        from session_turn_attempts seed_attempt cross join historical_turns cross join generate_series(1,10) generation
        where seed_attempt.id=${waiting.attemptId}`;
    });
    await shared.admin`analyze session_turn_attempts`;
    await shared.admin`analyze session_turns`;
    await shared.admin`analyze sessions`;

    const measurements: unknown[] = [];
    await shared.admin.begin(async (tx) => {
      await tx.unsafe(`set local role "${definition!.owner.replaceAll('"', '""')}"`);
      await tx.unsafe(`prepare repair_old(integer,uuid,uuid) as ${baseline}`);
      await tx.unsafe(`prepare repair_new(integer,uuid,uuid) as ${candidate}`);
      for (const mode of ["force_custom_plan", "force_generic_plan"]) {
        await tx.unsafe(`set local plan_cache_mode=${mode}`);
        const before = await tx.unsafe("execute repair_old(100,null,null)");
        const after = await tx.unsafe("execute repair_new(100,null,null)");
        expect(Array.from(after)).toEqual(Array.from(before));
        expect(after.some((row) => row.candidate_session_id === waiting.sessionId)).toBe(true);
        const plans = [];
        for (const side of ["old", "new"]) {
          const [row] = await tx.unsafe(
            `explain (analyze,buffers,format json) execute repair_${side}(100,null,null)`,
          );
          plans.push(row!["QUERY PLAN"][0]);
        }
        type PlanNode = {
          Plans?: PlanNode[];
          "Relation Name"?: string;
          "Index Name"?: string;
          "Index Cond"?: string;
          "Shared Hit Blocks": number;
          "Shared Read Blocks": number;
        };
        const nodes = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
        const oldScan = nodes(plans[0].Plan).find(
          (node) => node["Relation Name"] === "session_turn_attempts",
        )!;
        const newScan = nodes(plans[1].Plan).find(
          (node) => node["Relation Name"] === "session_turn_attempts",
        )!;
        expect(newScan["Index Name"]).toBe("session_turn_attempts_human_input_owner_uq");
        expect(newScan["Index Cond"]).toContain("account_id = session.account_id");
        expect(newScan["Index Cond"]).toContain("turn_id = turn.id");
        expect(newScan["Shared Hit Blocks"] + newScan["Shared Read Blocks"]).toBeLessThan(
          (oldScan["Shared Hit Blocks"] + oldScan["Shared Read Blocks"]) / 2,
        );
        measurements.push({
          mode,
          oldScan,
          newScan,
          oldMs: plans[0]["Execution Time"],
          newMs: plans[1]["Execution Time"],
        });
      }
      await tx.unsafe("deallocate repair_old");
      await tx.unsafe("deallocate repair_new");
    });
    if (process.env.OPENGENI_BENCH_RECOVERY_PLAN === "1") console.log(JSON.stringify(measurements));
  }, 60_000);

  test("owner-key migration changes only the redundant predicate and preserves routine authority on replay", async () => {
    const baseline = await readFile(
      new URL("../drizzle/0977_baseline_01.sql", import.meta.url),
      "utf8",
    );
    const original = baseline.match(
      /CREATE FUNCTION opengeni_private\.list_quiescence_receipt_wake_repairs_v1\([\s\S]*?\$\$;/,
    )?.[0];
    if (!original) throw new Error("Missing original inventory routine");
    const migration = await readFile(
      new URL("../drizzle/1014_quiescence_repair_attempt_owner_key.sql", import.meta.url),
      "utf8",
    );
    await shared.admin.begin(async (tx) => {
      const [scope] = await tx<{ schema: string }[]>`select current_schema() as schema`;
      const schema = `"${scope!.schema.replaceAll('"', '""')}"`;
      const readPosture = () => tx`
        select proowner, proacl::text, prosecdef, provolatile, proconfig,
          proargtypes::text, proallargtypes::text, proargmodes, proargnames, prorettype
        from pg_proc where oid='opengeni_private.list_quiescence_receipt_wake_repairs_v1(integer,uuid,uuid)'::regprocedure`;
      const initialPosture = await readPosture();
      const installed = await tx<{ body: string }[]>`
        select prosrc as body from pg_proc
        where oid='opengeni_private.list_quiescence_receipt_wake_repairs_v1(integer,uuid,uuid)'::regprocedure`;
      const originalSql = original
        .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
        .replaceAll('"{{schema}}"', schema)
        .replaceAll("{{schema}}", scope!.schema);
      await tx.unsafe(originalSql);
      const [old] = await tx<{ body: string }[]>`
        select prosrc as body from pg_proc
        where oid='opengeni_private.list_quiescence_receipt_wake_repairs_v1(integer,uuid,uuid)'::regprocedure`;
      expect(
        installed[0]!.body.replace("latest.account_id = session.account_id AND ", "").trim(),
      ).toBe(old!.body.trim());
      expect(await readPosture()).toEqual(initialPosture);
      const oldRows =
        await tx`select * from opengeni_private.list_quiescence_receipt_wake_repairs_v1(100,null,null)`;
      await tx.unsafe(migration);
      expect(await readPosture()).toEqual(initialPosture);
      expect(
        await tx`select * from opengeni_private.list_quiescence_receipt_wake_repairs_v1(100,null,null)`,
      ).toEqual(oldRows);
      await tx.unsafe(migration);
      expect(await readPosture()).toEqual(initialPosture);
      expect(
        await tx`select * from opengeni_private.list_quiescence_receipt_wake_repairs_v1(100,null,null)`,
      ).toEqual(oldRows);
      const constraints = await tx`
        select conname, convalidated, condeferrable, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid in ('sessions'::regclass, 'session_turn_attempts'::regclass)
          and conname in ('sessions_workspace_account_fk', 'session_turn_attempts_workspace_account_fk')
        order by conname`;
      expect(constraints).toHaveLength(2);
      for (const constraint of constraints) {
        expect(constraint.convalidated).toBe(true);
        expect(constraint.condeferrable).toBe(false);
        expect(constraint.definition).toContain("FOREIGN KEY (workspace_id, account_id)");
        expect(constraint.definition).toContain("REFERENCES workspaces(id, account_id)");
      }
    });
  });
});
