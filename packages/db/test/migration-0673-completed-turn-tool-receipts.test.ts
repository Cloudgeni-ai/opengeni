import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  appendSessionHistoryItems,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src/index";

// Completed turns consume their settled tool receipts, and migration 0673
// removes receipts that earlier releases stranded on completed turns.
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0673-completed-turn-receipts");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function runningTurn(db: DbClient["db"] = client.db) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "completed receipts",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "completed receipts",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await withWorkspaceSubjectSessionActivityRls(db, workspaceId, grant.subjectId, (scoped) =>
    submitHumanPromptInTransaction(scoped, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      actor: { type: "human", subjectId: grant.subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Run tools, then answer",
      resources: [],
      reasoningEffortFallback: "medium",
      source: "user",
    }),
  );
  const claimed = await claimSessionWorkForAttempt(db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("turn was not claimed");
  return {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turn: claimed.turn,
    attemptId: claimed.turn.activeAttemptId!,
  };
}

type Turn = Awaited<ReturnType<typeof runningTurn>>;

async function register(t: Turn, callId: string, db: DbClient["db"] = client.db) {
  await registerPendingSessionToolCall(db, {
    accountId: t.accountId,
    workspaceId: t.workspaceId,
    sessionId: t.sessionId,
    turnId: t.turn.id,
    executionGeneration: t.turn.executionGeneration,
    attemptId: t.attemptId,
    callId,
    callType: "function_call",
    callItem: { type: "function_call", callId, name: "exec_command", arguments: "{}" },
  });
}

async function completeWithDurablePair(t: Turn, callId: string) {
  const result = {
    type: "function_call_result",
    callId,
    name: "exec_command",
    output: { type: "text", text: "done" },
  };
  await recordPendingSessionToolCallResult(client.db, {
    accountId: t.accountId,
    workspaceId: t.workspaceId,
    sessionId: t.sessionId,
    turnId: t.turn.id,
    executionGeneration: t.turn.executionGeneration,
    attemptId: t.attemptId,
    callId,
    resultItem: result,
  });
  const [last] = await shared.admin<Array<{ position: number }>>`
    select coalesce(max(position), 0)::integer as position
    from session_history_items where session_id = ${t.sessionId}`;
  expect(
    await appendSessionHistoryItems(client.db, {
      accountId: t.accountId,
      workspaceId: t.workspaceId,
      sessionId: t.sessionId,
      turnId: t.turn.id,
      expectedExecutionGeneration: t.turn.executionGeneration,
      expectedAttemptId: t.attemptId,
      items: [
        {
          position: last!.position + 1,
          item: { type: "function_call", callId, name: "exec_command", arguments: "{}" },
        },
        { position: last!.position + 2, item: result },
      ],
    }),
  ).toBe(true);
}

async function settleCompleted(t: Turn, db: DbClient["db"] = client.db) {
  await applySessionTurnSettlement(db, t.workspaceId, {
    sessionId: t.sessionId,
    turnId: t.turn.id,
    triggerEventId: t.turn.triggerEventId,
    attemptId: t.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [
      { type: "turn.completed", payload: { output: "Answered" } },
      { type: "session.status.changed", payload: { status: "idle" } },
    ],
  });
}

async function receipts(t: Turn, admin: postgres.Sql = shared.admin): Promise<string[]> {
  const rows = await admin<Array<{ call_id: string }>>`
    select call_id from session_pending_tool_calls where session_id = ${t.sessionId}
    order by call_id`;
  return rows.map((row) => row.call_id);
}

describe("completed-turn tool receipts", () => {
  test("completion consumes every settled receipt of the turn, paired or not", async () => {
    const t = await runningTurn();
    await register(t, "a-paired");
    await completeWithDurablePair(t, "a-paired");
    await register(t, "b-unpaired");
    expect(await receipts(t)).toEqual(["a-paired", "b-unpaired"]);
    await settleCompleted(t);
    expect(await receipts(t)).toEqual([]);
    const history = await shared.admin`
      select id from session_history_items where session_id = ${t.sessionId}`;
    expect(history.length).toBeGreaterThanOrEqual(2);
  }, 180_000);

  test("migration 0673, run as the non-superuser owner, deletes only stranded receipts", async () => {
    const owned = await acquireOwnerMigratedTestDatabase("migration-0673-owner");
    if (!owned) throw new Error("PostgreSQL verification requires the test fixture");
    let app: DbClient | undefined;
    const owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      app = createDb(appUrl.toString(), { max: 4 });
      const strand = async (t: Turn, callId: string) => {
        // An earlier release left this receipt behind on the completed turn.
        await owned.admin`insert into session_pending_tool_calls (account_id, workspace_id,
            session_id, turn_id, execution_generation, attempt_id, call_id, call_type, call_item,
            call_item_codec_version)
          values (${t.accountId}, ${t.workspaceId}, ${t.sessionId}, ${t.turn.id},
            ${t.turn.executionGeneration}, ${t.attemptId}, ${callId}, 'function_call',
            ${owned.admin.json({ type: "function_call", callId, name: "x", arguments: "{}" })}, 1)`;
      };
      const stranded = await runningTurn(app.db);
      await settleCompleted(stranded, app.db);
      await strand(stranded, "stranded");

      // A settled interruption still owes its quiescence receipt: live, kept.
      const unquiesced = await runningTurn(app.db);
      await settleCompleted(unquiesced, app.db);
      await strand(unquiesced, "unquiesced");
      await owned.admin`update session_turn_attempts set quiesced_at = null
        where id = ${unquiesced.attemptId}`;
      const [operation] = await owned.admin<Array<{ id: string }>>`
        insert into session_command_receipts (account_id, workspace_id, actor_type,
          actor_subject_id, action, target_session_id, operation_key, canonical_request_hash)
        values (${unquiesced.accountId}, ${unquiesced.workspaceId}, 'human', 'subject-test',
          'session.steer', ${unquiesced.sessionId}, ${crypto.randomUUID()}, ${"0".repeat(64)})
        returning id`;
      await owned.admin`insert into session_attempt_interruptions (account_id, workspace_id,
          session_id, operation_id, attempt_id, kind, control_revision, state)
        values (${unquiesced.accountId}, ${unquiesced.workspaceId}, ${unquiesced.sessionId},
          ${operation!.id}, ${unquiesced.attemptId}, 'steer', 1, 'settled')`;

      const live = await runningTurn(app.db);
      await register(live, "live", app.db);

      const migration = await readFile(
        join(import.meta.dir, "../drizzle/0673_delete_stranded_completed_turn_tool_receipts.sql"),
        "utf8",
      );
      await owner.unsafe(migration);

      expect(await receipts(stranded, owned.admin)).toEqual([]);
      expect(await receipts(unquiesced, owned.admin)).toEqual(["unquiesced"]);
      expect(await receipts(live, owned.admin)).toEqual(["live"]);
      const [forced] = await owned.admin<Array<{ count: number }>>`
        select count(*)::int as count from pg_class
        where relname in ('session_pending_tool_calls', 'session_turns',
          'session_turn_attempts', 'session_attempt_interruptions') and relforcerowsecurity`;
      expect(forced!.count).toBe(4);
      const [fences] = await owner<Array<{ count: number }>>`
        select count(*)::int as count from pg_locks
        where locktype = 'advisory' and pid = pg_backend_pid()`;
      expect(fences!.count).toBe(0);
    } finally {
      await owner.end().catch(() => undefined);
      await app?.close().catch(() => undefined);
      await owned.release();
    }
  }, 600_000);
});
