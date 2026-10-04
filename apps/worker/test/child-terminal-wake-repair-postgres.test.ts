import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
  WORKSPACE_CLAUDE_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
} from "@opengeni/contracts";
import {
  addSessionSystemUpdateWithSourceMutation,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getOrCreateSessionSystemUpdateOutbox,
  initializeSessionStartAtomically,
  listSessionSystemUpdatesForTurn,
  markSessionSystemUpdateOutboxDeliveredInTransaction,
  markSessionWorkflowWakeDelivered,
  mutateSessionControlInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  reconcilePendingSessionWorkflowWakes,
  type NotifyServices,
} from "../src/activities/parent-wake";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("child-terminal-wake-repair");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "child-terminal-wake-repair",
    accountExternalId: suffix,
    accountName: "Child result repair",
    workspaceExternalSource: "child-terminal-wake-repair",
    workspaceExternalId: suffix,
    workspaceName: "Child result repair",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const input = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "delegate a task",
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject" as const, subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  };
  const parent = await createSession(client.db, input);
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: parent.id,
    clientEventId: `initial:${parent.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: parent.id,
    workflowId: `session-${parent.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("parent not claimed");
  const child = await createSession(client.db, {
    ...input,
    initialMessage: "child task",
    parentSessionId: parent.id,
    createdByActor: {
      type: "agent_attempt",
      sessionId: parent.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    },
  });
  expect(
    await applySessionTurnSettlement(client.db, grant.workspaceId!, {
      sessionId: parent.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "test" } }],
    }),
  ).toMatchObject({ action: "settled" });
  await shared.admin`update session_workflow_wake_outbox
    set delivered_revision = wake_revision where session_id = ${parent.id}`;
  return { grant, parent, child };
}

async function pendingResult(ctx: Awaited<ReturnType<typeof fixture>>, suffix = "terminal") {
  const input = {
    accountId: ctx.grant.accountId,
    workspaceId: ctx.grant.workspaceId!,
    sourceSessionId: ctx.child.id,
    targetSessionId: ctx.parent.id,
    kind: "child_terminal_result" as const,
    classification: "success" as const,
    sourceId: ctx.child.id,
    dedupeKey: `child-completion:${ctx.child.id}:${suffix}`,
    summary: "Child finished",
    payload: {
      type: "child_terminal_result" as const,
      childSessionId: ctx.child.id,
      status: "idle" as const,
    },
    lineage: { parentSessionId: ctx.parent.id, childSessionId: ctx.child.id },
    personalConnectionDelegations: [],
    mcpAccountBindings: null,
    xaiProviderAccountAuthoritySnapshot: WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
    claudeProviderAccountAuthoritySnapshot: WORKSPACE_CLAUDE_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
  };
  const outbox = await getOrCreateSessionSystemUpdateOutbox(client.db, input);
  const result = await addSessionSystemUpdateWithSourceMutation(
    client.db,
    { ...input, sessionId: ctx.parent.id },
    (tx) => markSessionSystemUpdateOutboxDeliveredInTransaction(tx, outbox),
  );
  if (result.reason !== "added") throw new Error("result not added");
  // Historical shape: the accepted result is pending, but the old wake ledger
  // is fully acknowledged and no goal or input hold remains. This setup also
  // remains valid when the coordinator's new producer is composed with repair.
  await shared.admin`update session_workflow_wake_outbox
    set delivered_revision = wake_revision where session_id = ${ctx.parent.id}`;
  await shared.admin`update sessions set status = 'idle' where id = ${ctx.parent.id}`;
  return result.update.id;
}

function services(signals: Array<{ sessionId: string; wakeRevision: number }>): NotifyServices {
  return {
    db: client.db,
    bus: { publish: async () => undefined } as unknown as EventBus,
    settings: {} as Settings,
    observability: {
      info: () => undefined,
      error: () => undefined,
    } as unknown as NotifyServices["observability"],
    wakeSessionWorkflow: async (wake) => {
      signals.push(wake);
      return markSessionWorkflowWakeDelivered(client.db, {
        ...wake,
        temporalWorkflowId: wake.workflowId,
      });
    },
  };
}

async function wakeRow(sessionId: string) {
  const [row] = await shared.admin<Array<{ wake_revision: number; delivered_revision: number }>>`
    select wake_revision::int, delivered_revision::int
    from session_workflow_wake_outbox where session_id = ${sessionId}`;
  return row!;
}

async function pauseTarget(ctx: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    ctx.grant.workspaceId!,
    ctx.grant.subjectId,
    (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as unknown as typeof db, {
          workspaceId: ctx.grant.workspaceId!,
          sessionId,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
  );
  // The historical Pause transport is settled separately from repair debt.
  await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision
    where workspace_id = ${ctx.grant.workspaceId!}`;
}

test("reaper discovers an authentic no-goal child result behind a fully ACKed ended-wait wake", async () => {
  const ctx = await fixture();
  const updateId = await pendingResult(ctx);
  const before = await wakeRow(ctx.parent.id);
  const signals: Array<{ sessionId: string; wakeRevision: number }> = [];
  const svc = services(signals);
  await reconcilePendingSessionWorkflowWakes(svc, 1000);
  expect(signals.filter((wake) => wake.sessionId === ctx.parent.id)).toHaveLength(1);
  expect(await wakeRow(ctx.parent.id)).toEqual({
    wake_revision: before.wake_revision + 1,
    delivered_revision: before.delivered_revision,
  });
  const [parent] = await shared.admin`select status, active_turn_id, input_wait_turn_id
    from sessions where id = ${ctx.parent.id}`;
  expect(parent).toEqual({ status: "queued", active_turn_id: null, input_wait_turn_id: null });
  // Transport acceptance cannot retire this repaired revision before claim.
  expect(
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.parent.id,
      temporalWorkflowId: `session-${ctx.parent.id}`,
      wakeRevision: before.wake_revision + 1,
    }),
  ).toEqual({ action: "pending_admission", blocker: "pending_machine_input" });
  await reconcilePendingSessionWorkflowWakes(svc, 1000);
  expect((await wakeRow(ctx.parent.id)).wake_revision).toBe(before.wake_revision + 1);
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
    sessionId: ctx.parent.id,
    workflowId: `session-${ctx.parent.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("repaired input was not claimed");
  const batch = await listSessionSystemUpdatesForTurn(
    client.db,
    ctx.grant.workspaceId!,
    ctx.parent.id,
    claimed.turn.id,
  );
  expect(batch.map((update) => update.id)).toContain(updateId);
});

test("coalesces multiple already-pending child results into one repair revision", async () => {
  const ctx = await fixture();
  await pendingResult(ctx, "one");
  await pendingResult(ctx, "two");
  const before = await wakeRow(ctx.parent.id);
  const signals: Array<{ sessionId: string; wakeRevision: number }> = [];
  await reconcilePendingSessionWorkflowWakes(services(signals), 1000);
  expect(signals.filter((wake) => wake.sessionId === ctx.parent.id)).toHaveLength(1);
  expect((await wakeRow(ctx.parent.id)).wake_revision).toBe(before.wake_revision + 1);
});

for (const scenario of [
  "paused",
  "ancestor_paused",
  "failed",
  "cancelled",
  "superseded",
  "forged_link",
  "cross_tenant",
  "nonterminal",
  "unquiesced",
  "completed_goal",
  "paused_goal",
] as const) {
  test(`repair preserves ${scenario} exclusion`, async () => {
    const ctx = await fixture();
    const updateId = await pendingResult(ctx);
    if (scenario === "paused") {
      await pauseTarget(ctx, ctx.parent.id);
    } else if (scenario === "ancestor_paused") {
      // Test-only historical control fixture; scoped repair must still evaluate
      // the entire ancestry rather than just this parent's direct state.
      const ancestor = await createSession(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.grant.workspaceId!,
        initialMessage: "ancestor",
        resources: [],
        tools: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId: ctx.grant.subjectId },
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });
      await shared.admin`update sessions set parent_session_id = ${ancestor.id}
        where id = ${ctx.parent.id}`;
      await pauseTarget(ctx, ancestor.id);
    } else if (scenario === "failed" || scenario === "cancelled") {
      await shared.admin`update sessions set status = ${scenario} where id = ${ctx.parent.id}`;
    } else if (scenario === "superseded") {
      await shared.admin`update session_system_updates set state = 'superseded' where id = ${updateId}`;
    } else if (scenario === "forged_link") {
      await shared.admin`update sessions set parent_session_id = null where id = ${ctx.child.id}`;
    } else if (scenario === "cross_tenant") {
      const other = await fixture();
      await shared.admin`update session_system_updates set source_id = ${other.child.id},
        payload = jsonb_set(payload, '{childSessionId}', to_jsonb(${other.child.id}::text))
        where id = ${updateId}`;
    } else if (scenario === "nonterminal") {
      await shared.admin`update session_system_updates set kind = 'child_progress',
        payload = jsonb_set(payload, '{type}', '"child_progress"'::jsonb) where id = ${updateId}`;
    } else if (scenario === "unquiesced") {
      await shared.admin`update session_turn_attempts set quiesced_at = null, outcome = 'interrupted_recoverable'
        where session_id = ${ctx.parent.id}`;
    } else {
      await shared.admin`insert into session_goals (account_id, workspace_id, session_id, text, status)
        values (${ctx.grant.accountId}, ${ctx.grant.workspaceId!}, ${ctx.parent.id}, 'settled goal',
          ${scenario === "completed_goal" ? "completed" : "paused"})`;
    }
    const before = await wakeRow(ctx.parent.id);
    const signals: Array<{ sessionId: string; wakeRevision: number }> = [];
    await reconcilePendingSessionWorkflowWakes(services(signals), 1000);
    expect(signals.some((wake) => wake.sessionId === ctx.parent.id)).toBe(false);
    expect(await wakeRow(ctx.parent.id)).toEqual(before);
  });
}

test("content-free discovery inherits only the existing wake dispatcher owner and runtime ACL", async () => {
  const [posture] = await shared.admin`
    select repair.proowner = wake.proowner as same_owner, repair.prosecdef as definer,
      repair.proconfig = array['search_path=pg_catalog']::text[] as safe_path,
      has_function_privilege('opengeni_app', repair.oid, 'EXECUTE') as app_execute,
      exists (select 1 from aclexplode(coalesce(repair.proacl, acldefault('f', repair.proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute
    from pg_proc repair, pg_proc wake
    where repair.oid = 'opengeni_private.list_pending_child_terminal_wake_repairs_v1(integer,uuid,uuid)'::regprocedure
      and wake.oid = 'opengeni_private.claim_session_workflow_wakes(integer)'::regprocedure`;
  expect(posture).toEqual({
    same_owner: true,
    definer: true,
    safe_path: true,
    app_execute: true,
    public_execute: false,
  });
});
