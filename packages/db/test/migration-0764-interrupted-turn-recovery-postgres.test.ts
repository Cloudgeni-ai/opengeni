import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdate,
  addSessionSystemUpdateWithSourceMutation,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  childProgressDedupeKey,
  configureChildLifecycleNotices,
  createDb,
  createSession,
  getSessionHistoryItems,
  getSessionSystemUpdateOutboxByDedupeKey,
  initializeSessionStartAtomically,
  markSessionAttemptQuiesced,
  markSessionSystemUpdateOutboxDeliveredInTransaction,
  markSessionWorkflowWakeDelivered,
  mutateSessionControlInTransaction,
  requestSessionTurnRecovery,
  recordSessionGoalProgressWithEvent,
  repairPendingChildTerminalResultWakes,
  peekSessionWork,
  sessionSystemUpdateOutboxKindPayload,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
import { executeMigrationFile, migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { withRestoredSessionActivityRlsContext } from "../src/database";
import {
  INTERRUPTED_TURN_RETIREMENT_MIGRATION as MIGRATION,
  parseInterruptedTurnRetirementManifest,
  type InterruptedTurnRetirementManifest,
} from "../src/interrupted-turn-retirement-migration";
import { stageSiteSessionAudienceColumns } from "./vault-policy-column-fixture";

let shared: NonNullable<Awaited<ReturnType<typeof acquireOwnerMigratedTestDatabase>>>;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("interrupted-turn-retirement");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  const owner = postgres(shared.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of await readdir(join(import.meta.dir, "../drizzle"))) {
      if (name.endsWith(".sql") && name >= MIGRATION)
        await owner`insert into schema_migrations(name) values (${name})`;
    }
    await migrate(shared.ownerUrl);
    // The schema stops before 0764 for good (0793 stays marked applied), but
    // the current session adapter names the 0793 Site audience columns.
    await stageSiteSessionAudienceColumns(shared.ownerUrl);
    await provisionRoles(shared.adminUrl, { appPassword: shared.appPassword });
  } finally {
    await owner.end();
  }
  const url = new URL(shared.ownerUrl);
  url.username = "opengeni_app";
  url.password = shared.appPassword;
  client = createDb(url.toString());
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Retirement fixture",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Retirement fixture",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}
type Scope = Awaited<ReturnType<typeof fixture>>;
async function start(
  scope: Scope,
  parent?: {
    session: { id: string };
    turn: { id: string; executionGeneration: number };
    attemptId: string;
  },
  options: { goal?: boolean; requestedSessionId?: string } = {},
) {
  const session = await createSession(client.db, {
    ...scope,
    ...(options.requestedSessionId ? { requestedSessionId: options.requestedSessionId } : {}),
    initialMessage: "Accepted work",
    resources: [],
    metadata: {},
    sandboxBackend: "none",
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    createdBy: { kind: "subject", subjectId: scope.subjectId },
    ...(parent
      ? {
          parentSessionId: parent.session.id,
          createdByActor: {
            type: "agent_attempt" as const,
            sessionId: parent.session.id,
            turnId: parent.turn.id,
            attemptId: parent.attemptId,
            executionGeneration: parent.turn.executionGeneration,
          },
        }
      : {}),
  });
  await initializeSessionStartAtomically(client.db, {
    ...scope,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
    ...(options.goal === false ? {} : { goal: { text: "Complete accepted work" } }),
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Fixture claim failed");
  return { session, turn: claim.turn, attemptId };
}
async function interrupt(scope: Scope, started: Awaited<ReturnType<typeof start>>) {
  expect(
    (
      await requestSessionTurnRecovery(client.db, scope.workspaceId, {
        sessionId: started.session.id,
        turnId: started.turn.id,
        triggerEventId: started.turn.triggerEventId,
        attemptId: started.attemptId,
        reason: "worker_shutdown",
      })
    ).action,
  ).toBe("recovering");
  await markSessionAttemptQuiesced(client.db, {
    ...scope,
    sessionId: started.session.id,
    attemptId: started.attemptId,
    temporalWorkflowId: `session-${started.session.id}`,
  });
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    scope.workspaceId,
    scope.subjectId,
    (db) =>
      mutateSessionControlInTransaction(db, {
        ...scope,
        sessionId: started.session.id,
        actor: { type: "human", subjectId: scope.subjectId },
        action: "pause",
        operationKey: crypto.randomUUID(),
      }),
  );
  await markSessionAttemptQuiesced(client.db, {
    ...scope,
    sessionId: started.session.id,
    attemptId: started.attemptId,
    temporalWorkflowId: `session-${started.session.id}`,
  });
}
async function target(scope: Scope, started: Awaited<ReturnType<typeof start>>) {
  const [row] = await shared.admin`select t.version, s.last_sequence from session_turns t
    join sessions s on s.id = t.session_id where t.id = ${started.turn.id}`;
  return {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: started.session.id,
    turnId: started.turn.id,
    workflowId: `session-${started.session.id}`,
    expectedVersion: Number(row!.version),
    expectedLastSequence: Number(row!.last_sequence),
  };
}
async function repair(manifest?: InterruptedTurnRetirementManifest) {
  const owner = postgres(shared.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await executeMigrationFile(
      owner,
      MIGRATION,
      await readFile(join(import.meta.dir, "../drizzle", MIGRATION), "utf8"),
      manifest ? { interruptedTurnRetirement: manifest } : {},
    );
  } finally {
    await owner.end();
  }
}

test("retirement leaves an idle parent non-runnable with no inbox, wake or new turn", async () => {
  const scope = await fixture();
  const parent = await start(scope, undefined, { goal: false });
  const child = await start(scope, parent);
  await interrupt(scope, child);
  expect(
    await applySessionTurnSettlement(client.db, scope.workspaceId, {
      sessionId: parent.session.id,
      turnId: parent.turn.id,
      triggerEventId: parent.turn.triggerEventId,
      attemptId: parent.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "fixture" } }],
    }),
  ).toMatchObject({ action: "settled" });
  const [wakeBefore] = await shared.admin`select * from session_workflow_wake_outbox
    where session_id = ${parent.session.id}`;
  expect(
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: parent.session.id,
      temporalWorkflowId: `session-${parent.session.id}`,
      wakeRevision: Number(wakeBefore!.wake_revision),
    }),
  ).toMatchObject({ action: "acknowledged" });
  const [baselineWake] = await shared.admin`select * from session_workflow_wake_outbox
    where session_id = ${parent.session.id}`;
  const baselineHistory = await getSessionHistoryItems(
    client.db,
    scope.workspaceId,
    parent.session.id,
  );
  const baselineTurns = [
    ...(await shared.admin`select * from session_turns where session_id = ${parent.session.id}`),
  ];
  const baselineAttempts = [
    ...(await shared.admin`select * from session_turn_attempts where session_id = ${parent.session.id}`),
  ];
  const manifest = { operationId: crypto.randomUUID(), targets: [await target(scope, child)] };
  await repair(manifest);

  // Run the real outbox delivery boundary, not a mocked wake decision. The
  // previous implementation emits an actionable result here and queues this
  // otherwise idle parent. Notification-only retirement emits no such row.
  const outbox = await getSessionSystemUpdateOutboxByDedupeKey(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    dedupeKey: `child-completion:${child.session.id}:turn:${child.turn.id}`,
  });
  let shouldWake = false;
  if (outbox && outbox.status === "pending") {
    const result = await addSessionSystemUpdateWithSourceMutation(
      client.db,
      {
        accountId: outbox.accountId,
        workspaceId: outbox.workspaceId,
        sessionId: outbox.targetSessionId,
        ...sessionSystemUpdateOutboxKindPayload(outbox),
        classification: outbox.classification,
        sourceId: outbox.sourceId,
        dedupeKey: outbox.dedupeKey,
        summary: outbox.summary,
        lineage: outbox.lineage,
        personalConnectionDelegations: outbox.personalConnectionDelegations,
        mcpAccountBindings: outbox.mcpAccountBindings,
        xaiProviderAccountAuthoritySnapshot: outbox.xaiProviderAccountAuthoritySnapshot,
        claudeProviderAccountAuthoritySnapshot: outbox.claudeProviderAccountAuthoritySnapshot,
        subscriptionAuthority: outbox.subscriptionAuthority,
      },
      async (tx) => await markSessionSystemUpdateOutboxDeliveredInTransaction(tx, outbox),
    );
    shouldWake = "shouldWake" in result && result.shouldWake;
  }
  expect(shouldWake).toBe(false);
  expect((await peekSessionWork(client.db, scope.workspaceId, parent.session.id)).kind).toBe(
    "idle",
  );
  const sweep = await repairPendingChildTerminalResultWakes(client.db);
  expect(sweep.registered).toBe(0);
  expect(sweep.failed).toBe(0);
  expect(
    await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: parent.session.id,
      workflowId: `session-${parent.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    }),
  ).toEqual({ action: "unclaimed", reason: "no-work" });
  const [after] =
    await shared.admin`select status,active_turn_id from sessions where id = ${parent.session.id}`;
  expect(after).toMatchObject({ status: "idle", active_turn_id: null });
  const [pending] = await shared.admin`select count(*)::int as count from session_system_updates
    where session_id = ${parent.session.id} and state = 'pending'`;
  expect(pending!.count).toBe(0);
  const [wakeAfter] = await shared.admin`select * from session_workflow_wake_outbox
    where session_id = ${parent.session.id}`;
  expect(wakeAfter).toEqual(baselineWake);
  expect([
    ...(await shared.admin`select * from session_turns where session_id = ${parent.session.id}`),
  ]).toEqual(baselineTurns);
  expect([
    ...(await shared.admin`select * from session_turn_attempts where session_id = ${parent.session.id}`),
  ]).toEqual(baselineAttempts);
  expect(await getSessionHistoryItems(client.db, scope.workspaceId, parent.session.id)).toEqual(
    baselineHistory,
  );
  // Tenancy cutover is an owner-only maintenance capability, not an app grant.
  const owner = createDb(shared.ownerUrl);
  try {
    await owner.db.transaction(async (tx) => {
      await withRestoredSessionActivityRlsContext(tx, scope, async (scoped) => {
        await scoped.execute(sql`select assert_session_tenancy_quiescent(${scope.accountId}::uuid,
          ${scope.workspaceId}::uuid, ${parent.session.id}::uuid, false)`);
      });
    });
  } finally {
    await owner.close();
  }
  const [receipts] = await shared.admin`select count(*)::int as count from session_events
    where session_id = ${parent.session.id} and type = 'system.update.settled'
      and payload->>'retirementOperationId' = ${manifest.operationId}
      and payload->>'notificationOnly' = 'true'`;
  expect(receipts!.count).toBe(1);
  // Exercise the exact operator verification SELECT, including pre-existing
  // queued-turn starts rather than relying only on new turn row timestamps.
  const runbook = await readFile(join(import.meta.dir, "../../../docs/run-lifecycle.md"), "utf8");
  const verification = [...runbook.matchAll(/```sql\n([\s\S]*?)\n```/g)]
    .map((match) => match[1]!)
    .find((query) => query.includes("AS parent_receipts"));
  if (!verification) throw new Error("Missing parent retirement verification SELECT");
  const [counts] = await shared.admin.unsafe(
    verification
      .replaceAll(":'workspace_id'", "$1")
      .replaceAll(":'operation_id'", "$2")
      .replaceAll(":'verify_before'", "$3"),
    [scope.workspaceId, manifest.operationId, new Date().toISOString()],
  );
  expect(counts).toMatchObject({
    parent_receipts: "1",
    pending_retired_child_inputs: "0",
    pending_retired_child_outboxes: "0",
    parent_turns_started: "0",
    parent_turns_created: "0",
    parent_attempts_created: "0",
  });
}, 60_000);

test("a selected child's receipt cannot invalidate a selected parent's manifest cursor", async () => {
  const scope = await fixture();
  const parent = await start(scope, undefined, {
    goal: false,
    requestedSessionId: crypto.randomUUID().replace(/^./, "f"),
  });
  const child = await start(scope, parent, {
    requestedSessionId: crypto.randomUUID().replace(/^./, "0"),
  });
  await interrupt(scope, child);
  await interrupt(scope, parent);
  const manifest = {
    operationId: crypto.randomUUID(),
    targets: [await target(scope, parent), await target(scope, child)],
  };
  expect(child.session.id < parent.session.id).toBe(true);
  await repair(manifest);
  const rows = [
    ...(await shared.admin`select status from session_turns where id in (${parent.turn.id},${child.turn.id})`),
  ];
  expect(rows.map((row) => row.status)).toEqual(["failed", "failed"]);
  await repair(manifest);
  const receipts = [
    ...(await shared.admin`select id from session_events where session_id = ${parent.session.id}
    and type = 'system.update.settled' and payload->>'retirementOperationId' = ${manifest.operationId}`),
  ];
  expect(receipts).toHaveLength(1);
}, 60_000);

test("retirement supersedes obsolete notices and rejects captured delivery without losing other results", async () => {
  configureChildLifecycleNotices({ enabled: true });
  try {
    const scope = await fixture();
    const parent = await start(scope, undefined, { goal: false });
    const child = await start(scope, parent);
    const progress = await recordSessionGoalProgressWithEvent(
      client.db,
      scope.workspaceId,
      child.session.id,
      {
        progressNote: "Still working",
        command: {
          accountId: scope.accountId,
          actor: {
            type: "agent_attempt",
            sessionId: child.session.id,
            turnId: child.turn.id,
            attemptId: child.attemptId,
            executionGeneration: child.turn.executionGeneration,
          },
          operationKey: crypto.randomUUID(),
        },
      },
    );
    const progressRow = await getSessionSystemUpdateOutboxByDedupeKey(client.db, {
      ...scope,
      dedupeKey: childProgressDedupeKey({
        childSessionId: child.session.id,
        receiptId: progress.operationId,
      }),
    });
    if (!progressRow) throw new Error("Missing progress producer");
    const deliver = (row: typeof progressRow) =>
      addSessionSystemUpdateWithSourceMutation(
        client.db,
        {
          accountId: row.accountId,
          workspaceId: row.workspaceId,
          sessionId: row.targetSessionId,
          ...sessionSystemUpdateOutboxKindPayload(row),
          classification: row.classification,
          sourceId: row.sourceId,
          dedupeKey: row.dedupeKey,
          summary: row.summary,
          lineage: row.lineage,
          personalConnectionDelegations: row.personalConnectionDelegations,
          mcpAccountBindings: row.mcpAccountBindings,
          xaiProviderAccountAuthoritySnapshot: row.xaiProviderAccountAuthoritySnapshot,
          claudeProviderAccountAuthoritySnapshot: row.claudeProviderAccountAuthoritySnapshot,
          subscriptionAuthority: row.subscriptionAuthority,
        },
        async (tx) => await markSessionSystemUpdateOutboxDeliveredInTransaction(tx, row),
      );
    await deliver(progressRow);
    await interrupt(scope, child);
    const [paused] = await shared.admin`select dedupe_key from session_system_update_outbox
      where source_session_id = ${child.session.id} and kind = 'child_paused' and status = 'pending'`;
    if (!paused) throw new Error("Missing captured pause producer");
    const captured = await getSessionSystemUpdateOutboxByDedupeKey(client.db, {
      ...scope,
      dedupeKey: String(paused.dedupe_key),
    });
    if (!captured) throw new Error("Missing captured producer");
    const requestId = crypto.randomUUID();
    // Synthetic historical interaction left behind by the interrupted attempt.
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into session_human_input_requests
        (id,account_id,workspace_id,session_id,turn_id,turn_generation,creation_attempt_id,tool_call_id,questions)
        values (${requestId},${scope.accountId},${scope.workspaceId},${child.session.id},
          ${child.turn.id},${child.turn.executionGeneration},${child.attemptId},'fixture-question',
          '[{"id":"choice","kind":"text","prompt":"Which option?","options":[],"required":true,"allowOther":false}]'::jsonb)`;
    });
    const priorResultKey = crypto.randomUUID();
    const otherSenderKey = crypto.randomUUID();
    await addSessionSystemUpdate(client.db, {
      ...scope,
      sessionId: parent.session.id,
      kind: "child_terminal_result",
      classification: "info",
      sourceId: child.session.id,
      dedupeKey: priorResultKey,
      summary: "Earlier terminal answer",
      payload: {
        type: "child_terminal_result",
        childSessionId: child.session.id,
        status: "idle",
        turnId: crypto.randomUUID(),
      },
    });
    await addSessionSystemUpdate(client.db, {
      ...scope,
      sessionId: parent.session.id,
      kind: "child_terminal_result",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: otherSenderKey,
      summary: "Unrelated terminal answer",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
      },
    });
    const manifest = { operationId: crypto.randomUUID(), targets: [await target(scope, child)] };
    await repair(manifest);
    const inputs = await shared.admin`select dedupe_key,state from session_system_updates
      where session_id = ${parent.session.id}`;
    expect(inputs.find((row) => row.dedupe_key === progressRow.dedupeKey)?.state).toBe(
      "superseded",
    );
    expect(inputs.find((row) => row.dedupe_key === priorResultKey)?.state).toBe("pending");
    expect(inputs.find((row) => row.dedupe_key === otherSenderKey)?.state).toBe("pending");
    const [source] =
      await shared.admin`select status from session_system_update_outbox where id = ${captured.id}`;
    expect(source!.status).toBe("failed");
    const [question] =
      await shared.admin`select status from session_human_input_requests where id = ${requestId}`;
    expect(question!.status).toBe("cancelled");
    const [resolution] =
      await shared.admin`select count(*)::int as count from session_system_update_outbox
      where source_session_id = ${child.session.id} and kind = 'child_requires_action_resolved'`;
    expect(resolution!.count).toBe(0);
    const beforeInputs = [...inputs];
    const beforeWake = [
      ...(await shared.admin`select * from session_workflow_wake_outbox where session_id = ${parent.session.id}`),
    ];
    await expect(deliver(captured)).rejects.toThrow("System-update outbox row not pending");
    expect([
      ...(await shared.admin`select dedupe_key,state from session_system_updates where session_id = ${parent.session.id}`),
    ]).toEqual(beforeInputs);
    expect([
      ...(await shared.admin`select * from session_workflow_wake_outbox where session_id = ${parent.session.id}`),
    ]).toEqual(beforeWake);
    await repair(manifest);
    const [receipts] = await shared.admin`select count(*)::int as count from session_events
      where session_id = ${parent.session.id} and type = 'system.update.settled'
      and payload->>'retirementOperationId' = ${manifest.operationId}`;
    expect(receipts!.count).toBe(1);
  } finally {
    configureChildLifecycleNotices({ enabled: false });
  }
}, 60_000);

test("the owner repair is opt-in, settles exact interrupted work and records one non-actionable parent receipt", async () => {
  const scope = await fixture();
  const parent = await start(scope);
  const child = await start(scope, parent);
  await interrupt(scope, child);
  const draftId = crypto.randomUUID();
  // Retained withdrawn drafts are not executable turn obligations, and must
  // survive the operator's terminal retirement of the current logical turn.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into session_turns
      select (jsonb_populate_record(null::session_turns, to_jsonb(original) ||
        jsonb_build_object('id', ${draftId}::text, 'status', 'withdrawn_for_edit',
          'active_attempt_id', null, 'started_at', null, 'finished_at', null,
          'execution_generation', 0))).*
      from session_turns original where original.id = ${child.turn.id}`;
  });
  const unrelatedScope = await fixture();
  const unrelated = await start(unrelatedScope);
  await interrupt(unrelatedScope, unrelated);
  const secondScope = await fixture();
  const second = await start(secondScope);
  await interrupt(secondScope, second);
  await addSessionSystemUpdate(client.db, {
    ...scope,
    sessionId: child.session.id,
    kind: "child_terminal_result",
    classification: "info",
    sourceId: "fixture",
    dedupeKey: crypto.randomUUID(),
    summary: "Accepted old input",
    payload: { type: "child_terminal_result", childSessionId: crypto.randomUUID(), status: "idle" },
  });
  const taskId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const successfulRunId = crypto.randomUUID();
  const realtimeId = crypto.randomUUID();
  // A legacy occurrence was dispatched into a paused inbox and never claimed.
  // Preserve its immutable source snapshot; retirement must use the actual
  // scheduled-run lifecycle capability, including dispatched -> failed.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into scheduled_tasks(id,account_id,workspace_id,name,schedule,temporal_schedule_id,agent_config,execution_digest)
      values (${taskId},${scope.accountId},${scope.workspaceId},'Fixture schedule',
        '{"type":"manual"}'::jsonb,${`schedule-${taskId}`},'{"prompt":"Accepted occurrence"}'::jsonb,repeat('0',64))`;
    await tx`insert into scheduled_task_runs(id,account_id,workspace_id,task_id,status,trigger_type,session_id,accepted_execution_snapshot,accepted_execution_digest)
      values (${runId},${scope.accountId},${scope.workspaceId},${taskId},'dispatched','scheduled',${child.session.id},
          '{}'::jsonb,encode(digest(convert_to('{}','UTF8'),'sha256'),'hex')),
        (${successfulRunId},${scope.accountId},${scope.workspaceId},${taskId},'succeeded','scheduled',${child.session.id},
          '{}'::jsonb,encode(digest(convert_to('{}','UTF8'),'sha256'),'hex'))`;
    await tx`insert into session_system_updates(account_id,workspace_id,session_id,kind,source_id,dedupe_key,summary,payload,scheduled_task_run_id)
      values (${scope.accountId},${scope.workspaceId},${child.session.id},'scheduled_occurrence',
        ${runId},${`scheduled-task-run:${runId}`},'Accepted occurrence',
        ${tx.json({ type: "scheduled_occurrence", text: "Accepted occurrence", scheduledTaskId: taskId, scheduledTaskRunId: runId })},${runId})`;
    await tx`insert into session_realtime_modes(id,account_id,workspace_id,session_id,operation_id,
      owner_subject_id,browser_instance_id,owner_key_hash,model,lease_expires_at,last_heartbeat_at)
      values (${realtimeId},${scope.accountId},${scope.workspaceId},${child.session.id},${crypto.randomUUID()},
        ${scope.subjectId},'fixture',repeat('0',64),'opengeni-azure/gpt-live-1',now()+interval '1 hour',now())`;
    await tx`insert into session_realtime_entries(account_id,workspace_id,session_id,realtime_id,operation_id,
      connection_epoch,sequence,direction,kind,text,payload)
      values (${scope.accountId},${scope.workspaceId},${child.session.id},${realtimeId},${crypto.randomUUID()},
        1,1,'provider_out','session_update','Existing realtime context','{}'::jsonb)`;
  });
  const [priorRealtime] = await shared.admin`select * from session_realtime_entries
    where realtime_id = ${realtimeId}`;
  const manifest = {
    operationId: crypto.randomUUID(),
    targets: [await target(scope, child), await target(secondScope, second)],
  };
  const history = await getSessionHistoryItems(client.db, scope.workspaceId, child.session.id);
  const attempts = [
    ...(await shared.admin`select * from session_turn_attempts where session_id = ${child.session.id}`),
  ];
  await repair();
  const [before] = await shared.admin`select status from session_turns where id = ${child.turn.id}`;
  expect(before!.status).toBe("recovering");
  await repair(manifest);
  const [settled] = await shared.admin`select s.status, s.active_turn_id, s.direct_control_state,
    t.status as turn_status, t.finished_at, g.continuation_suppressed_turn_id
    from sessions s join session_turns t on t.session_id = s.id join session_goals g on g.session_id = s.id
    where t.id = ${child.turn.id}`;
  expect(settled).toMatchObject({
    status: "failed",
    active_turn_id: null,
    direct_control_state: "paused",
    turn_status: "failed",
    continuation_suppressed_turn_id: child.turn.id,
  });
  expect(settled!.finished_at).not.toBeNull();
  expect([
    ...(await shared.admin`select * from session_turn_attempts where session_id = ${child.session.id}`),
  ]).toEqual(attempts);
  expect(await getSessionHistoryItems(client.db, scope.workspaceId, child.session.id)).toEqual(
    history,
  );
  const notices = [
    ...(await shared.admin`select payload from session_events
    where session_id = ${parent.session.id} and type = 'system.update.settled'
      and payload->>'retirementOperationId' = ${manifest.operationId}`),
  ];
  expect(notices).toHaveLength(1);
  expect(notices[0]!.payload).toMatchObject({
    notificationOnly: true,
    childTurnId: child.turn.id,
    members: [
      { kind: "child_terminal_result", classification: "failure", sourceId: child.session.id },
    ],
  });
  const [pending] = await shared.admin`select count(*)::int as count from session_system_updates
    where session_id = ${child.session.id} and state = 'pending'`;
  expect(pending!.count).toBe(0);
  const [run] =
    await shared.admin`select status,completed_at from scheduled_task_runs where id = ${runId}`;
  expect(run!.status).toBe("failed");
  expect(run!.completed_at).not.toBeNull();
  const realtime = [
    ...(await shared.admin`select * from session_realtime_entries
    where realtime_id = ${realtimeId} order by sequence`),
  ];
  expect(realtime).toHaveLength(2);
  expect(realtime[0]).toEqual(priorRealtime);
  expect(realtime[1]!.text).toBe("Delegated turn failed.");
  expect(realtime[1]!.payload).toMatchObject({
    code: "delegation_turn_failed",
    terminal: { status: "failed" },
  });
  expect(JSON.stringify(realtime[1]!.payload)).not.toContain(manifest.operationId);
  expect(JSON.stringify(realtime[1]!.payload)).not.toContain("interrupted_turn_retired");
  const [successfulRun] =
    await shared.admin`select status from scheduled_task_runs where id = ${successfulRunId}`;
  expect(successfulRun!.status).toBe("succeeded");
  const [other] =
    await shared.admin`select status from session_turns where id = ${unrelated.turn.id}`;
  expect(other!.status).toBe("recovering");
  const [secondResult] =
    await shared.admin`select status from session_turns where id = ${second.turn.id}`;
  expect(secondResult!.status).toBe("failed");
  const count = [
    ...(await shared.admin`select id from session_events where session_id = ${child.session.id}`),
  ].length;
  await migrate(shared.ownerUrl, undefined, { interruptedTurnRetirement: manifest });
  expect([
    ...(await shared.admin`select id from session_events where session_id = ${child.session.id}`),
  ]).toHaveLength(count);
  expect([
    ...(await shared.admin`select id from session_events where session_id = ${parent.session.id}
    and type = 'system.update.settled' and payload->>'retirementOperationId' = ${manifest.operationId}`),
  ]).toHaveLength(1);
  expect([
    ...(await shared.admin`select id from session_system_update_outbox where source_session_id = ${child.session.id}
    and status = 'pending'`),
  ]).toHaveLength(0);
  const [posture] =
    await shared.admin`select bool_and(relrowsecurity and relforcerowsecurity) as forced
    from pg_class where oid in ('sessions'::regclass, 'session_turns'::regclass, 'session_turn_attempts'::regclass)`;
  expect(posture!.forced).toBe(true);
  const [draft] = await shared.admin`select status from session_turns where id = ${draftId}`;
  expect(draft!.status).toBe("withdrawn_for_edit");
}, 60_000);

test("a stale manifest rolls back every target, and a live writer cannot be retired", async () => {
  const scope = await fixture();
  const first = await start(scope);
  const second = await start(scope);
  await interrupt(scope, first);
  await interrupt(scope, second);
  const [valid, stale] = [await target(scope, first), await target(scope, second)].sort((a, b) =>
    a.sessionId.localeCompare(b.sessionId),
  );
  await expect(
    repair({
      operationId: crypto.randomUUID(),
      targets: [valid!, { ...stale!, expectedVersion: stale!.expectedVersion + 1 }],
    }),
  ).rejects.toThrow("target changed or is unsafe");
  const rows = [
    ...(await shared.admin`select status from session_turns where id in (${first.turn.id}, ${second.turn.id})`),
  ];
  expect(rows.map((row) => row.status)).toEqual(["recovering", "recovering"]);
  const live = await start(scope);
  await expect(
    repair({ operationId: crypto.randomUUID(), targets: [await target(scope, live)] }),
  ).rejects.toThrow("target changed or is unsafe");
}, 60_000);

test("retirement manifests fail closed on unbounded or duplicate operator scope", () => {
  expect(() =>
    parseInterruptedTurnRetirementManifest({ operationId: crypto.randomUUID(), targets: [] }),
  ).toThrow("Invalid");
  expect(() =>
    parseInterruptedTurnRetirementManifest({
      operationId: crypto.randomUUID(),
      targets: [],
      unknown: true,
    }),
  ).toThrow("Invalid");
  const sample = {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    workflowId: "session-test",
    expectedVersion: 1,
    expectedLastSequence: 1,
  };
  expect(() =>
    parseInterruptedTurnRetirementManifest({
      operationId: crypto.randomUUID(),
      targets: [sample, sample],
    }),
  ).toThrow("unique sessions");
});
