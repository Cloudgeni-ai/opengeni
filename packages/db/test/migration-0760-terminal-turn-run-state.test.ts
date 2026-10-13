import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getLatestRunState,
  initializeSessionStartAtomically,
  saveRunState,
  withWorkspaceRls,
} from "../src/index";
import { migrate } from "../src/migrate";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("terminal-run-state");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(db = client.db) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Run state lifecycle",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Run state lifecycle",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Fixture claim failed");
  const state = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    turnId: claim.turn.id,
    expectedExecutionGeneration: claim.turn.executionGeneration,
    expectedAttemptId: attemptId,
    serializedRunState: "{}",
    pendingApprovals: [],
  };
  // Multiple snapshots must all be retired, not just the latest receipt.
  expect(await saveRunState(db, state)).toBe(true);
  expect(await saveRunState(db, state)).toBe(true);
  return { grant, session, turn: claim.turn, attemptId, state };
}

for (const status of ["completed", "failed"] as const) {
  test(`${status} settlement deletes snapshots and fences late saves`, async () => {
    const value = await fixture();
    const result = await applySessionTurnSettlement(client.db, value.grant.workspaceId!, {
      sessionId: value.session.id,
      turnId: value.turn.id,
      triggerEventId: value.turn.triggerEventId,
      attemptId: value.attemptId,
      turnStatus: status,
      sessionStatus: status === "completed" ? "idle" : "failed",
      activeTurnId: null,
      events: [{ type: status === "completed" ? "turn.completed" : "turn.failed", payload: {} }],
    });
    expect(result.action).toBe("settled");
    expect(
      await getLatestRunState(client.db, value.grant.workspaceId!, value.session.id),
    ).toBeNull();
    expect(await saveRunState(client.db, value.state)).toBe(false);
  });
}

test("all SQL terminal paths clean snapshots; resumable transitions retain them", async () => {
  for (const status of [
    "cancelled",
    "superseded",
    "withdrawn_for_edit",
    "recovering",
    "requires_action",
    "waiting_capacity",
  ]) {
    const value = await fixture();
    await withWorkspaceRls(client.db, value.grant.workspaceId!, async (db) => {
      await db.execute(
        sql`update session_turns set status = ${status} where id = ${value.turn.id}`,
      );
    });
    const state = await getLatestRunState(client.db, value.grant.workspaceId!, value.session.id);
    expect(state !== null).toBe(
      ["recovering", "requires_action", "waiting_capacity"].includes(status),
    );
  }
}, 30_000);

test("repair runs as a non-bypass owner and preserves nonterminal and unassociated state", async () => {
  const sharedOwner = await acquireOwnerMigratedTestDatabase("terminal-state-owner");
  if (!sharedOwner) throw new Error("Real non-bypass owner PostgreSQL is required");
  const owner = postgres(sharedOwner.ownerUrl, { max: 1 });
  const adminClient = createDb(sharedOwner.adminUrl);
  try {
    await migrate(sharedOwner.ownerUrl);
    await owner`drop trigger terminal_turn_run_state_cleanup on session_turns`;
    await owner`drop function retire_terminal_turn_run_state()`;
    const terminal = await fixture(adminClient.db);
    const recovering = await fixture(adminClient.db);
    await sharedOwner.admin.begin(async (tx) => {
      for (const value of [terminal, recovering]) {
        await tx`select pg_advisory_xact_lock_shared(hashtextextended('session-tenancy:' || ${value.grant.workspaceId!}, 0))`;
        await tx`update session_turns set status = ${value === terminal ? "superseded" : "recovering"} where id = ${value.turn.id}`;
      }
      await tx`insert into agent_run_states(account_id, workspace_id, session_id, state_version, serialized_run_state)
        values (${recovering.grant.accountId}, ${recovering.grant.workspaceId!}, ${recovering.session.id}, 3, '{}')`;
    });
    const migration = await readFile(
      new URL("../drizzle/0760_terminal_turn_run_state_cleanup.sql", import.meta.url),
      "utf8",
    );
    await owner.begin((tx) => tx.unsafe(migration));
    const rows = await sharedOwner.admin`select turn_id from agent_run_states`;
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.turn_id === recovering.turn.id)).toHaveLength(2);
    expect(rows.filter((row) => row.turn_id === null)).toHaveLength(1);
    const posture =
      await sharedOwner.admin`select relforcerowsecurity from pg_class where relname in ('agent_run_states', 'session_turns')`;
    expect(posture.every((row) => row.relforcerowsecurity)).toBe(true);
    expect(
      (
        await sharedOwner.admin`select tgenabled from pg_trigger where tgrelid='agent_run_states'::regclass and tgname='session_tenancy_workspace_fence'`
      )[0]?.tgenabled,
    ).toBe("O");
  } finally {
    await adminClient.close();
    await owner.end();
    await sharedOwner.release();
  }
}, 180_000);
