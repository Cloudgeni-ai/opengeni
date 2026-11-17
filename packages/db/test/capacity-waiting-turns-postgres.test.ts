// The turn hold summary's parked capacity waits under the production database
// setup: a non-superuser owner, FORCE ROW LEVEL SECURITY and the runtime role
// with only the grants migrations give it. Sessions, turns, attempts and
// waiters are row-secured even for their owner, so the owner-run summary sees
// them only through the session inventory window; a superuser-owned test
// schema cannot show that. A wait counts exactly when the capacity reconcile
// would resume it once capacity returns, so the real Pause and Resume commands
// decide here, cross-checked against evaluateSessionControl.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  evaluateSessionControl,
  initializeSessionStartAtomically,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  summarizeTurnHolds,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";

let fixture: RestrictedRuntimeTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("capacity-waiting-turns");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  fixture = acquired;
  client = createDb(fixture.appUrl, { searchPath: fixture.schema });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 60_000);

type Organization = { accountId: string; workspaceId: string; subjectId: string };
type Chat = Organization & { sessionId: string; turnId: string };

async function organization(): Promise<Organization> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Capacity",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Capacity",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

/** A started chat whose first turn is queued. */
async function chat(org: Organization, parentSessionId: string | null = null): Promise<Chat> {
  const session = await createSession(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    initialMessage: "hello",
    parentSessionId,
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const [turn] = await fixture.admin<{ id: string }[]>`
    select id from session_turns where session_id = ${session.id}::uuid`;
  return { ...org, sessionId: session.id, turnId: turn!.id };
}

/**
 * The state armSubscriptionCoreCapacityWait leaves a parked turn in: the
 * active turn and its session wait, the attempt closed `waiting_capacity`
 * `parkedSecondsAgo`, and the session's waiter names the turn at its
 * generation. Foreign keys and triggers are not what this test is about, so
 * the superuser skips them for these writes only.
 */
async function park(
  parked: Chat,
  provider: "codex" | "claude" | "xai",
  parkedSecondsAgo: number,
  waiter: { goalId?: string; generationOffset?: number } = {},
) {
  await fixture.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update session_turns set status = 'waiting_capacity', active_attempt_id = null
      where id = ${parked.turnId}::uuid`;
    await tx`update sessions set status = 'waiting_capacity', active_turn_id = ${parked.turnId}::uuid
      where id = ${parked.sessionId}::uuid`;
    await tx`insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies, authority_epoch,
        authority_visibility, state, outcome, closed_at)
      values (gen_random_uuid(), ${parked.accountId}::uuid, ${parked.workspaceId}::uuid,
        ${parked.sessionId}::uuid, ${parked.turnId}::uuid, 1, 'workflow', gen_random_uuid()::text, 'activity',
        1, '{}'::jsonb, 1, 'workspace_shared', 'closed', 'waiting_capacity',
        now() - make_interval(secs => ${parkedSecondsAgo}))`;
    // The waiter was last touched just now (a recheck), so an age can only
    // come from the attempt.
    await tx`insert into subscription_capacity_waiters (
        account_id, workspace_id, session_id, turn_id, provider, wait_reason,
        blocked_turn_generation, goal_id, goal_version, updated_at)
      select ${parked.accountId}::uuid, ${parked.workspaceId}::uuid, ${parked.sessionId}::uuid,
        turn.id, ${provider}, 'no_eligible_capacity',
        turn.execution_generation + ${waiter.generationOffset ?? 0},
        ${waiter.goalId ?? null}::uuid, ${waiter.goalId ? 1 : null}, now()
      from session_turns turn where turn.id = ${parked.turnId}::uuid`;
  });
}

async function control(target: Chat, action: "pause" | "resume") {
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    target.workspaceId,
    target.subjectId,
    (db) =>
      mutateSessionControlInTransaction(db, {
        accountId: target.accountId,
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        actor: { type: "human", subjectId: target.subjectId },
        action,
        operationKey: crypto.randomUUID(),
      }),
  );
}

async function controlState(target: Chat) {
  return (
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      target.workspaceId,
      target.subjectId,
      (db) => evaluateSessionControl(db, target.workspaceId, target.sessionId),
    )
  ).state;
}

async function statuses(target: Chat) {
  const [row] = await fixture.admin<{ session_status: string; turn_status: string }[]>`
    select session.status as session_status, turn.status as turn_status
    from sessions session join session_turns turn on turn.id = session.active_turn_id
    where session.id = ${target.sessionId}::uuid`;
  return row;
}

test("parked turns count by provider only while they would resume on capacity, through the runtime's own grant", async () => {
  const org = await organization();
  // Counted: live waits on two providers, the oldest codex one two hours old.
  const codexOld = await chat(org);
  await park(codexOld, "codex", 7_200);
  const claude = await chat(org);
  await park(claude, "claude", 600);

  // Stopped (paused) by the person while it waits: Pause releases the wait
  // (capacity-wait-release), so the turn is no longer parked at all.
  const stoppedNow = await chat(org);
  await park(stoppedNow, "codex", 3_600 * 5);
  await control(stoppedNow, "pause");
  expect(await statuses(stoppedNow)).toEqual({ session_status: "idle", turn_status: "recovering" });

  // Leftovers in a paused chat still reading `waiting_capacity`, as a wait
  // paused before Pause released waits stays (production evidence): its own
  // pause, a paused parent's, and a whole paused workspace's. The reconcile
  // leaves such a wait untouched until Resume, so none counts. A sibling
  // resumed on its own after its parent's pause (a newer subtree override)
  // is live again and counts.
  const leftover = await chat(org);
  await control(leftover, "pause");
  await park(leftover, "codex", 3_600 * 5);
  const parent = await chat(org);
  const inherited = await chat(org, parent.sessionId);
  const resumedChild = await chat(org, parent.sessionId);
  await control(parent, "pause");
  await control(resumedChild, "resume");
  await park(inherited, "codex", 3_600 * 5);
  await park(resumedChild, "codex", 60);
  const pausedOrg = await organization();
  const inPausedWorkspace = await chat(pausedOrg);
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    pausedOrg.workspaceId,
    pausedOrg.subjectId,
    (db) =>
      mutateWorkspaceControlInTransaction(db, {
        accountId: pausedOrg.accountId,
        workspaceId: pausedOrg.workspaceId,
        actor: { type: "human", subjectId: pausedOrg.subjectId },
        action: "pause",
        operationKey: crypto.randomUUID(),
      }),
  );
  await park(inPausedWorkspace, "xai", 3_600 * 5);

  // Leftovers the reconcile would supersede, not resume: a goal that no longer
  // exists, and a waiter for an older execution of the turn.
  await park(await chat(org), "codex", 3_600 * 5, { goalId: crypto.randomUUID() });
  await park(await chat(org), "codex", 3_600 * 5, { generationOffset: -1 });

  // One queued, never-parked turn elsewhere.
  await chat(await organization());

  expect(await statuses(leftover)).toEqual({
    session_status: "waiting_capacity",
    turn_status: "waiting_capacity",
  });
  // The control authority agrees with what the summary counts.
  for (const counted of [codexOld, claude, resumedChild]) {
    expect(await controlState(counted)).toBe("active");
  }
  for (const paused of [leftover, inherited, inPausedWorkspace]) {
    expect(await controlState(paused)).toBe("paused");
  }

  // The runtime role calls it with the grant it already has (1274): no
  // further migration is needed for a deploy to publish these.
  const { queued, capacityWaiting } = await summarizeTurnHolds(client.db);
  expect(capacityWaiting.codex.count).toBe(2);
  expect(capacityWaiting.codex.oldestAgeSeconds).toBeGreaterThanOrEqual(7_200);
  expect(capacityWaiting.codex.oldestAgeSeconds).toBeLessThan(7_200 + 600);
  expect(capacityWaiting.claude.count).toBe(1);
  expect(capacityWaiting.claude.oldestAgeSeconds).toBeGreaterThanOrEqual(600);
  expect(capacityWaiting.claude.oldestAgeSeconds).toBeLessThan(7_200);
  expect(capacityWaiting.xai).toEqual({ count: 0, oldestAgeSeconds: 0 });

  // Parked turns are never queued prompts; the one queued turn (in a chat
  // that never parked) is visible to the queued split under this owner too.
  expect(queued.waiting_capacity.count).toBe(0);
  expect(queued.ready.count + queued.behind_active_turn.count).toBe(1);

  // Resuming the leftover's chat makes its wait live again.
  await control(leftover, "resume");
  expect(await statuses(leftover)).toEqual({
    session_status: "waiting_capacity",
    turn_status: "waiting_capacity",
  });
  const resumed = await summarizeTurnHolds(client.db);
  expect(resumed.capacityWaiting.codex.count).toBe(3);
  expect(resumed.capacityWaiting.codex.oldestAgeSeconds).toBeGreaterThanOrEqual(3_600 * 5);

  // The owner-only read policy and the closed window leave the runtime reading
  // no waiter row outside a tenant.
  const visible = await client.db.execute<{ count: number }>(
    sql`select count(*)::int as count from subscription_capacity_waiters`,
  );
  expect([...visible][0]!.count).toBe(0);
});
