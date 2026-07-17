import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { drainLegacyRunningTurns } from "./release-database-maintenance";

const migrationsDirectory = join(import.meta.dir, "../packages/db/drizzle");
const sourceRevision = "1234567890abcdef1234567890abcdef12345678";

describe("release database maintenance", () => {
  test("durably recovers legacy running turns and unresolved tool calls before cutover", async () => {
    const database = await acquireBlankTestDatabase("release-database-maintenance-recovery");
    if (!database) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error("real PostgreSQL is required for release database maintenance proof");
      }
      return;
    }
    const sql = postgres(database.databaseUrl, { max: 1 });
    try {
      await applyLegacyMigrations(sql);
      const fixture = await seedRunningTurn(sql, true);
      const receipt = await drainLegacyRunningTurns(sql, "test-cutover", sourceRevision);
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        command: "drain-running-turns",
        runId: "test-cutover",
        sourceRevision,
        recoveredTurnCount: 1,
        closedToolCallCount: 1,
        remainingRunningTurnCount: 0,
      });
      expect(receipt.recoveredTurnIdentitySha256).toMatch(/^[0-9a-f]{64}$/u);

      const [turn] = await sql<
        Array<{ status: string; activeAttemptId: string | null; metadata: Record<string, unknown> }>
      >`
        select status, active_attempt_id::text as "activeAttemptId", metadata
        from session_turns where id = ${fixture.turnId}
      `;
      expect(turn).toMatchObject({
        status: "recovering",
        activeAttemptId: null,
        metadata: { dispatchGeneration: 1, retained: true },
      });
      expect(turn?.metadata).not.toHaveProperty("dispatchAttempt");
      const [session] = await sql<
        Array<{ status: string; activeTurnId: string; lastSequence: number }>
      >`
        select status, active_turn_id::text as "activeTurnId", last_sequence as "lastSequence"
        from sessions where id = ${fixture.sessionId}
      `;
      expect(session).toMatchObject({
        status: "recovering",
        activeTurnId: fixture.turnId,
        lastSequence: 4,
      });
      const events = await sql<Array<{ type: string; payload: Record<string, unknown> }>>`
        select type, payload from session_events
        where session_id = ${fixture.sessionId} order by sequence
      `;
      expect(events.map((event) => event.type)).toEqual([
        "user.message",
        "agent.toolCall.output",
        "turn.recovery.requested",
        "session.status.changed",
      ]);
      expect(events[1]?.payload).toMatchObject({
        recovery: { interrupted: true, outcome: "unknown", reason: "production maintenance" },
      });
      const history = await sql<Array<{ item: Record<string, unknown> }>>`
        select item from session_history_items
        where session_id = ${fixture.sessionId} order by position
      `;
      expect(history.map(({ item }) => item.type)).toEqual(["shell_call", "shell_call_output"]);
      expect(
        (history[1]?.item.output as Array<{ stderr?: string }> | undefined)?.[0]?.stderr,
      ).toContain("side-effect outcome is unknown");
      const [{ count: pendingCalls } = { count: -1 }] = await sql<Array<{ count: number }>>`
        select count(*)::integer as count from session_pending_tool_calls
        where turn_id = ${fixture.turnId}
      `;
      expect(pendingCalls).toBe(0);
      const [audit] = await sql<Array<{ subjectId: string; metadata: Record<string, unknown> }>>`
        select subject_id as "subjectId", metadata from audit_events
        where action = 'session.release.running_turn_recovered'
      `;
      expect(audit).toMatchObject({
        subjectId: "maintenance:test-cutover",
        metadata: {
          turnId: fixture.turnId,
          attemptId: fixture.attemptId,
          sourceRevision,
        },
      });

      await sql.unsafe(
        await readFile(
          join(migrationsDirectory, "0063_session_control_mega_foundation.sql"),
          "utf8",
        ),
      );
      const [attempt] = await sql<Array<{ state: string; outcome: string }>>`
        select state, outcome from session_turn_attempts where id = ${fixture.attemptId}
      `;
      expect(attempt).toEqual({ state: "closed", outcome: "pre_cutover_closed" });
      const [wake] = await sql<Array<{ reason: string }>>`
        select reason from session_workflow_wake_outbox where session_id = ${fixture.sessionId}
      `;
      expect(wake?.reason).toBe("control_mega_cutover:recovering_turn");
    } finally {
      await sql.end().catch(() => undefined);
      await database.release();
    }
  }, 180_000);

  test("fails atomically when a running turn lacks exact ownership", async () => {
    const database = await acquireBlankTestDatabase("release-database-maintenance-invalid");
    if (!database) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error("real PostgreSQL is required for release database maintenance proof");
      }
      return;
    }
    const sql = postgres(database.databaseUrl, { max: 1 });
    try {
      await applyLegacyMigrations(sql);
      const fixture = await seedRunningTurn(sql, false);
      await expect(drainLegacyRunningTurns(sql, "test-invalid", sourceRevision)).rejects.toThrow(
        "1 running turns have invalid exact ownership",
      );
      const [turn] = await sql<Array<{ status: string }>>`
        select status from session_turns where id = ${fixture.turnId}
      `;
      expect(turn?.status).toBe("running");
      const [{ count: recoveryEvents } = { count: -1 }] = await sql<Array<{ count: number }>>`
        select count(*)::integer as count from session_events
        where session_id = ${fixture.sessionId} and type = 'turn.recovery.requested'
      `;
      expect(recoveryEvents).toBe(0);
    } finally {
      await sql.end().catch(() => undefined);
      await database.release();
    }
  }, 180_000);
});

async function applyLegacyMigrations(sql: postgres.Sql): Promise<void> {
  const migrations = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql") && file < "0063_")
    .sort();
  for (const migration of migrations) {
    await sql.unsafe(await readFile(join(migrationsDirectory, migration), "utf8"));
  }
}

async function seedRunningTurn(sql: postgres.Sql, exactOwner: boolean) {
  const [{ id: accountId } = { id: "" }] = await sql<{ id: string }[]>`
    insert into managed_accounts (name) values ('release drain') returning id
  `;
  const [{ id: workspaceId } = { id: "" }] = await sql<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, 'release drain') returning id
  `;
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const triggerEventId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await sql`
    insert into sessions (
      id, account_id, workspace_id, status, initial_message, model,
      sandbox_backend, sandbox_group_id, temporal_workflow_id, last_sequence
    ) values (
      ${sessionId}, ${accountId}, ${workspaceId}, 'running', 'release drain',
      'codex/gpt-5.6-sol', 'none', ${sessionId}, ${`session-${sessionId}`}, 1
    )
  `;
  await sql`
    insert into session_events (
      id, account_id, workspace_id, session_id, sequence, type, payload
    ) values (
      ${triggerEventId}, ${accountId}, ${workspaceId}, ${sessionId}, 1,
      'user.message', ${sql.json({ text: "continue" })}
    )
  `;
  await sql`
    insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id,
      temporal_workflow_id, status, source, position, prompt, model,
      reasoning_effort, sandbox_backend, execution_generation, active_attempt_id,
      metadata, started_at
    ) values (
      ${turnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${triggerEventId},
      ${`session-${sessionId}`}, 'running', 'user', 1, 'continue',
      'codex/gpt-5.6-sol', 'high', 'none', 1,
      ${exactOwner ? attemptId : null},
      ${sql.json({
        retained: true,
        dispatchGeneration: 1,
        ...(exactOwner
          ? { dispatchAttempt: { id: attemptId, generation: 1, triggerEventId } }
          : {}),
      })},
      now()
    )
  `;
  await sql`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`;
  if (exactOwner) {
    const callId = "maintenance-shell-call";
    await sql`
      insert into session_pending_tool_calls (
        account_id, workspace_id, session_id, turn_id, execution_generation,
        attempt_id, call_id, call_type, call_item
      ) values (
        ${accountId}, ${workspaceId}, ${sessionId}, ${turnId}, 1,
        ${attemptId}, ${callId}, 'shell_call',
        ${sql.json({ type: "shell_call", callId, command: "do something" })}
      )
    `;
  }
  return { accountId, workspaceId, sessionId, turnId, triggerEventId, attemptId };
}
