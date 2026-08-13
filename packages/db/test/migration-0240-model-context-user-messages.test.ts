import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createConnection,
  createDb,
  createSession,
  getOrCreateSlackInteraction,
  initializeSessionStartAtomically,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";

const migrationName = "0240_model_context_user_messages.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const slackSessionInstructions = [
  "This session is an OpenGeni Slack task surface. Treat Slack message and thread context as task-local unless a separate explicit authorized user action says otherwise.",
  "Execute direct, safe, sufficiently specified requests immediately.",
  "Ask one concise clarifying question only when materially required information is missing or the requested action is risky, irreversible, or authorization-sensitive.",
  "Do not write Slack context to Documents, Knowledge, Memory, preferences, Workspace Charter, instructions, or policy unless a separate explicit authorized user action requests it.",
  "Never expose private reasoning, credentials, secrets, raw logs, or unbounded output.",
  "Keep user-visible output concise, bounded, and safe to send back to Slack.",
].join(" ");

type FixtureSession = {
  id: string;
  turnId: string;
  context: string;
};

function appDatabaseUrl(blank: BlankTestDatabase): string {
  const url = new URL(blank.databaseUrl);
  url.username = "opengeni_app";
  url.password = "apppw";
  return url.toString();
}

async function createInitializedSession(
  client: DbClient,
  input: {
    accountId: string;
    workspaceId: string;
    message: string;
    context: string;
    requestedSessionId?: string;
    instructions?: string;
  },
): Promise<FixtureSession> {
  const session = await createSession(client.db, {
    ...(input.requestedSessionId ? { requestedSessionId: input.requestedSessionId } : {}),
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: input.message,
    initialModelContext: input.context,
    ...(input.instructions ? { instructions: input.instructions } : {}),
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const initialized = await initializeSessionStartAtomically(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!initialized.turn) throw new Error("Expected the migration fixture to create a turn");
  return { id: session.id, turnId: initialized.turn.id, context: input.context };
}

async function expectPreCutoverColumns(sql: postgres.Sql): Promise<void> {
  const columns = await sql<Array<{ tableName: string; columnName: string }>>`
    select table_name as "tableName", column_name as "columnName"
    from information_schema.columns
    where table_schema = current_schema()
      and (
        (table_name = 'sessions' and column_name in ('initial_model_context', 'initial_turn_instructions'))
        or (table_name = 'session_turns' and column_name in ('model_context', 'turn_instructions'))
        or (table_name = 'session_realtime_entries' and column_name = 'model_context')
      )
    order by table_name, column_name`;
  expect([...columns]).toEqual([
    { tableName: "session_turns", columnName: "turn_instructions" },
    { tableName: "sessions", columnName: "initial_turn_instructions" },
  ]);
}

describe("migration 0240 model context user messages", () => {
  test("drains writers, rolls back live turns, preserves populated rows, and backfills Slack authority", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain("all opengeni_app sessions to be stopped");
    expect(source).toContain("legacy context-bearing live turns to settle or be superseded");
    expect(source).toContain('LOCK TABLE "slack_interactions" IN ACCESS EXCLUSIVE MODE');
    expect(source).toContain(slackSessionInstructions);
    expect(source).toContain(
      'RENAME COLUMN "initial_turn_instructions" TO "initial_model_context"',
    );
    expect(source).toContain('RENAME COLUMN "turn_instructions" TO "model_context"');
    expect(source).toContain('ADD COLUMN "model_context" text');
    expect(source).toContain("Completed historical turns retain their original conversation truth");
    expect(source).not.toContain('UPDATE "session_history_items"');
    expect(source).toContain(
      "\"kind\" IN ('delegation_call', 'user_transcript', 'assistant_transcript')",
    );
    expect(source).not.toContain("sessions:turn_instructions");

    const blank = await acquireBlankTestDatabase("migration-0240");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0240-model-context] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    let client: DbClient | null = null;
    try {
      await migrate(blank.databaseUrl);
      client = createDb(appDatabaseUrl(blank));
      const access = await bootstrapWorkspace(client.db, {
        accountExternalSource: "migration-0240-test",
        accountExternalId: crypto.randomUUID(),
        accountName: "Migration 0240 account",
        workspaceExternalSource: "migration-0240-test",
        workspaceExternalId: crypto.randomUUID(),
        workspaceName: "Migration 0240 workspace",
        subjectId: `user:migration-0240-${crypto.randomUUID()}`,
      });
      const grant = access.workspaceGrants[0]!;
      const queued = await createInitializedSession(client, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        message: "queued message",
        context: "queued application context",
      });
      const completed = await createInitializedSession(client, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        message: "completed message",
        context: "completed legacy context",
      });
      const live = await createInitializedSession(client, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        message: "live message",
        context: "live legacy context",
      });
      await sql`update session_turns set status = 'completed' where id = ${completed.turnId}`;
      const liveClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
        sessionId: live.id,
        workflowId: `session-${live.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (liveClaim.action !== "claimed") {
        throw new Error(`Expected the live migration fixture to be claimed: ${liveClaim.reason}`);
      }
      const completedHistory = {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "completed canonical history" }],
      };
      await sql`
        insert into session_history_items (
          account_id, workspace_id, session_id, turn_id, position, item
        ) values (
          ${grant.accountId}, ${grant.workspaceId}, ${completed.id}, ${completed.turnId},
          0, ${sql.json(completedHistory)}
        )`;

      const connection = await createConnection(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: null,
        providerDomain: "slack.com",
        kind: "app_install",
        credentialEncrypted: "migration-0240-fixture",
        metadata: {},
      });
      const { interaction } = await getOrCreateSlackInteraction(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        connectionId: connection.id,
        slackTeamId: "T_MIGRATION_0240",
        slackChannelId: "C_MIGRATION_0240",
        slackThreadTs: "1700000000.000001",
        routeKey: "C_MIGRATION_0240:1700000000.000001",
        triggeringProviderEventId: "E_MIGRATION_0240",
        owningSubjectId: grant.subjectId,
        visibility: "workspace",
      });
      const slack = await createInitializedSession(client, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        requestedSessionId: interaction.sessionReservationId,
        message: "Slack migration message",
        context: "legacy Slack turn instructions",
        instructions: "Existing Slack persona.",
      });

      await client.close();
      client = null;
      await sql.unsafe(`
        ALTER TABLE "session_realtime_entries"
          DROP CONSTRAINT "session_realtime_entries_model_context_check";
        ALTER TABLE "session_realtime_entries" DROP COLUMN "model_context";
        ALTER TABLE "session_turns" RENAME COLUMN "model_context" TO "turn_instructions";
        ALTER TABLE "sessions" RENAME COLUMN "initial_model_context" TO "initial_turn_instructions";
        DELETE FROM "schema_migrations" WHERE "name" = '${migrationName}';
      `);
      await expectPreCutoverColumns(sql);

      const liveApp = postgres(appDatabaseUrl(blank), { max: 1 });
      let writerError: unknown;
      try {
        await liveApp`select 1`;
        await migrate(blank.databaseUrl);
      } catch (error) {
        writerError = error;
      } finally {
        await liveApp.end();
      }
      expect((writerError as { code?: string } | undefined)?.code).toBe("55000");
      expect(String(writerError)).toContain("all opengeni_app sessions to be stopped");
      await expectPreCutoverColumns(sql);

      let liveTurnError: unknown;
      try {
        await migrate(blank.databaseUrl);
      } catch (error) {
        liveTurnError = error;
      }
      expect((liveTurnError as { code?: string } | undefined)?.code).toBe("55000");
      expect(String(liveTurnError)).toContain(
        "legacy context-bearing live turns to settle or be superseded",
      );
      await expectPreCutoverColumns(sql);
      const [notApplied] = await sql<Array<{ applied: boolean }>>`
        select exists(
          select 1 from schema_migrations where name = ${migrationName}
        ) as applied`;
      expect(notApplied).toEqual({ applied: false });

      await sql`update session_turns set status = 'completed' where id = ${live.turnId}`;
      await migrate(blank.databaseUrl);

      const columns = await sql<Array<{ tableName: string; columnName: string }>>`
        select table_name as "tableName", column_name as "columnName"
        from information_schema.columns
        where table_schema = current_schema()
          and (
            (table_name = 'sessions' and column_name in ('initial_model_context', 'initial_turn_instructions'))
            or (table_name = 'session_turns' and column_name in ('model_context', 'turn_instructions'))
            or (table_name = 'session_realtime_entries' and column_name = 'model_context')
          )
        order by table_name, column_name`;
      expect([...columns]).toEqual([
        { tableName: "session_realtime_entries", columnName: "model_context" },
        { tableName: "session_turns", columnName: "model_context" },
        { tableName: "sessions", columnName: "initial_model_context" },
      ]);
      const [preserved] = await sql<
        Array<{
          queuedInitial: string | null;
          queuedTurn: string | null;
          completedTurn: string | null;
          completedHistory: unknown;
          slackInstructions: string | null;
          slackInitial: string | null;
        }>
      >`
        select
          (select initial_model_context from sessions where id = ${queued.id}) as "queuedInitial",
          (select model_context from session_turns where id = ${queued.turnId}) as "queuedTurn",
          (select model_context from session_turns where id = ${completed.turnId}) as "completedTurn",
          (select item from session_history_items where session_id = ${completed.id} and position = 0)
            as "completedHistory",
          (select instructions from sessions where id = ${slack.id}) as "slackInstructions",
          (select initial_model_context from sessions where id = ${slack.id}) as "slackInitial"`;
      expect(preserved).toEqual({
        queuedInitial: queued.context,
        queuedTurn: queued.context,
        completedTurn: completed.context,
        completedHistory,
        slackInstructions: `Existing Slack persona.\n\n${slackSessionInstructions}`,
        slackInitial: slack.context,
      });
      const constraints = await sql<Array<{ name: string; validated: boolean }>>`
        select conname as name, convalidated as validated
        from pg_constraint
        where conname = 'session_realtime_entries_model_context_check'`;
      expect([...constraints]).toEqual([
        { name: "session_realtime_entries_model_context_check", validated: true },
      ]);
    } finally {
      await client?.close();
      await sql.end();
      await blank.release();
    }
  }, 300_000);
});
