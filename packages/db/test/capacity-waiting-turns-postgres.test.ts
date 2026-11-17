// The capacity-waiting summary under the production database setup: a
// non-superuser owner, FORCE ROW LEVEL SECURITY and the runtime role. Sessions,
// turns, attempts and waiters are row-secured even for their owner, so the
// owner-run summary only sees them through the session inventory window. A
// superuser-owned test schema cannot show that.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  capacityWaitingTurnsSummaryAvailable,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  summarizeCapacityWaitingTurns,
  type DbClient,
} from "@opengeni/db";
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

async function startedSession(provider: "codex" | "claude" | "xai") {
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
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    initialMessage: "hello",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const [turn] = await fixture.admin<{ id: string }[]>`
    select id from session_turns where session_id = ${session.id}::uuid`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    turnId: turn!.id,
    provider,
  };
}

type Started = Awaited<ReturnType<typeof startedSession>>;

// The state a parked turn is in (armSubscriptionCoreCapacityWait): the active
// turn and its session wait, its attempt closed `waiting_capacity` at
// `parkedSecondsAgo`, and the session's waiter row names the turn. Foreign
// keys and triggers are not what this test is about, so the superuser skips
// them for these writes only.
async function park(chat: Started, parkedSecondsAgo: number) {
  await fixture.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update session_turns set status = 'waiting_capacity'
      where id = ${chat.turnId}::uuid`;
    await tx`update sessions set status = 'waiting_capacity', active_turn_id = ${chat.turnId}::uuid
      where id = ${chat.sessionId}::uuid`;
    await tx`insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies, authority_epoch,
        authority_visibility, state, outcome, closed_at)
      values (gen_random_uuid(), ${chat.accountId}::uuid, ${chat.workspaceId}::uuid,
        ${chat.sessionId}::uuid, ${chat.turnId}::uuid, 1, 'workflow', 'run', 'activity',
        1, '{}'::jsonb, 1, 'workspace_shared', 'closed', 'waiting_capacity',
        now() - make_interval(secs => ${parkedSecondsAgo}))`;
    // The waiter row was last touched just now (a recheck), so the age can
    // only come from the attempt.
    await tx`insert into subscription_capacity_waiters (
        account_id, workspace_id, session_id, turn_id, provider, wait_reason, updated_at)
      values (${chat.accountId}::uuid, ${chat.workspaceId}::uuid, ${chat.sessionId}::uuid,
        ${chat.turnId}::uuid, ${chat.provider}, 'no_eligible_capacity', now())`;
  });
}

test("parked turns in different workspaces count by provider, with the oldest wait's age, once granted", async () => {
  const codexOld = await startedSession("codex");
  const codexNew = await startedSession("codex");
  const claude = await startedSession("claude");
  await park(codexOld, 7_200);
  await park(codexNew, 60);
  await park(claude, 600);
  // A turn that is queued but not parked is not a capacity wait.
  await startedSession("xai");

  // Withheld by 1485: the control worker does not publish the gauge.
  expect(await capacityWaitingTurnsSummaryAvailable(client.db)).toBe(false);
  await fixture.admin.unsafe(
    "GRANT EXECUTE ON FUNCTION opengeni_private.summarize_capacity_waiting_turns_v1() TO opengeni_app",
  );
  expect(await capacityWaitingTurnsSummaryAvailable(client.db)).toBe(true);

  const summary = await summarizeCapacityWaitingTurns(client.db);
  expect(summary.codex.count).toBe(2);
  expect(summary.claude.count).toBe(1);
  expect(summary.xai).toEqual({ count: 0, oldestAgeSeconds: 0 });
  expect(summary.codex.oldestAgeSeconds).toBeGreaterThanOrEqual(7_200);
  expect(summary.codex.oldestAgeSeconds).toBeLessThan(7_200 + 600);
  expect(summary.claude.oldestAgeSeconds).toBeGreaterThanOrEqual(600);
  expect(summary.claude.oldestAgeSeconds).toBeLessThan(7_200);

  // The new owner-only read policy and the closed window leave the runtime
  // reading no waiter row outside a tenant.
  const visible = await client.db.execute<{ count: number }>(
    sql`select count(*)::int as count from subscription_capacity_waiters`,
  );
  expect([...visible][0]!.count).toBe(0);
});
