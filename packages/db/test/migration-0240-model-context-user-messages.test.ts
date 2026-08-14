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
  return {
    id: session.id,
    turnId: initialized.turn.id,
    context: input.context,
  };
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
    expect(source).toContain('ADD CONSTRAINT "sessions_initial_model_context_check"');
    expect(source).toContain('ADD CONSTRAINT "session_turns_model_context_check"');
    expect(source).toContain("opengeni_private.model_context_value_valid");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.model_context_value_valid(text) FROM PUBLIC",
    );
    expect(source).toContain(
      "GRANT EXECUTE ON FUNCTION opengeni_private.model_context_value_valid(text)",
    );
    expect(source).toContain('VALIDATE CONSTRAINT "sessions_initial_model_context_check"');
    expect(source).toContain('VALIDATE CONSTRAINT "session_turns_model_context_check"');
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
    const sql = postgres(blank.databaseUrl, {
      max: 1,
      onnotice: () => undefined,
    });
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
        ALTER TABLE "session_turns" DROP CONSTRAINT "session_turns_model_context_check";
        ALTER TABLE "session_turns" RENAME COLUMN "model_context" TO "turn_instructions";
        ALTER TABLE "sessions" DROP CONSTRAINT "sessions_initial_model_context_check";
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

      await sql`update sessions set initial_turn_instructions = ${"\t"} where id = ${queued.id}`;
      let legacyWhitespaceError: unknown;
      try {
        await migrate(blank.databaseUrl);
      } catch (error) {
        legacyWhitespaceError = error;
      }
      expect((legacyWhitespaceError as { code?: string } | undefined)?.code).toBe("23514");
      await expectPreCutoverColumns(sql);
      await sql`update sessions set initial_turn_instructions = ${queued.context} where id = ${queued.id}`;

      const astralOverflow = "😀".repeat(16_385);
      await sql`update session_turns set turn_instructions = ${astralOverflow} where id = ${queued.turnId}`;
      let legacyUtf16Error: unknown;
      try {
        await migrate(blank.databaseUrl);
      } catch (error) {
        legacyUtf16Error = error;
      }
      expect((legacyUtf16Error as { code?: string } | undefined)?.code).toBe("23514");
      await expectPreCutoverColumns(sql);
      await sql`update session_turns set turn_instructions = ${queued.context} where id = ${queued.turnId}`;

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
      let invalidSessionContextError: unknown;
      try {
        await sql`update sessions set initial_model_context = ${"\tvalue\t"} where id = ${queued.id}`;
      } catch (error) {
        invalidSessionContextError = error;
      }
      expect((invalidSessionContextError as { code?: string } | undefined)?.code).toBe("23514");

      let invalidTurnContextError: unknown;
      try {
        await sql`update session_turns set model_context = ${astralOverflow} where id = ${queued.turnId}`;
      } catch (error) {
        invalidTurnContextError = error;
      }
      expect((invalidTurnContextError as { code?: string } | undefined)?.code).toBe("23514");
      const realtimeId = crypto.randomUUID();
      await sql`
        insert into session_realtime_modes (
          id, account_id, workspace_id, session_id, operation_id, owner_subject_id,
          browser_instance_id, owner_key_hash, model, version, connection_epoch,
          lease_expires_at, last_heartbeat_at
        ) values (
          ${realtimeId}, ${grant.accountId}, ${grant.workspaceId}, ${queued.id},
          ${crypto.randomUUID()}, ${grant.subjectId}, ${crypto.randomUUID()}, ${"a".repeat(64)},
          'gpt-live-1-boulder-alpha', 1, 1, now() + interval '30 seconds', now()
        )`;
      let invalidRealtimeContextError: unknown;
      try {
        await sql`
          insert into session_realtime_entries (
            account_id, workspace_id, session_id, realtime_id, operation_id,
            connection_epoch, sequence, direction, kind, role, text, text_codec_version,
            payload, payload_codec_version, model_context
          ) values (
            ${grant.accountId}, ${grant.workspaceId}, ${queued.id}, ${realtimeId},
            ${crypto.randomUUID()}, 1, 1, 'provider_in', 'user_transcript', 'user',
            'final transcript', 1, '{}'::jsonb, 1, ${astralOverflow}
          )`;
      } catch (error) {
        invalidRealtimeContextError = error;
      }
      expect((invalidRealtimeContextError as { code?: string } | undefined)?.code).toBe("23514");
      const [validator] = await sql<
        Array<{ valid: boolean; tabOnly: boolean; tabPadded: boolean; astralOverflow: boolean }>
      >`
        select
          opengeni_private.model_context_value_valid('valid context') as valid,
          opengeni_private.model_context_value_valid(${"\t"}) as "tabOnly",
          opengeni_private.model_context_value_valid(${"\tvalue\t"}) as "tabPadded",
          opengeni_private.model_context_value_valid(${astralOverflow}) as "astralOverflow"`;
      expect(validator).toEqual({
        valid: true,
        tabOnly: false,
        tabPadded: false,
        astralOverflow: false,
      });
      const [validatorAcl] = await sql<
        Array<{
          appExecute: boolean;
          publicExecute: boolean;
        }>
      >`
        select
          has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
          exists (
            select 1
            from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
            where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
          ) as "publicExecute"
        from pg_proc procedure
        where procedure.oid =
          'opengeni_private.model_context_value_valid(text)'::regprocedure`;
      expect(validatorAcl).toEqual({
        appExecute: true,
        publicExecute: false,
      });
      const constraints = await sql<Array<{ name: string; validated: boolean }>>`
        select conname as name, convalidated as validated
        from pg_constraint
        where conname in (
          'sessions_initial_model_context_check',
          'session_turns_model_context_check',
          'session_realtime_entries_model_context_check'
        )
        order by conname`;
      expect([...constraints]).toEqual([
        {
          name: "session_realtime_entries_model_context_check",
          validated: true,
        },
        { name: "session_turns_model_context_check", validated: true },
        { name: "sessions_initial_model_context_check", validated: true },
      ]);
    } finally {
      await client?.close();
      await sql.end();
      await blank.release();
    }
  }, 300_000);
});
