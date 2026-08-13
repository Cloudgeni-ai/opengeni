import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
} from "../src";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0229_realtime_turn_instructions.sql", import.meta.url);

describe("migration 0229 realtime turn instructions", () => {
  test("adds bounded private guidance only to turn-bearing provider entries", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('ADD COLUMN "turn_instructions" text');
    expect(source).toContain("\"direction\" = 'provider_in'");
    expect(source).toContain("'delegation_call', 'user_transcript', 'assistant_transcript'");
    expect(source).toContain('char_length("turn_instructions") BETWEEN 1 AND 32768');
    expect(source).toContain("NOT VALID");
    expect(source).toContain(
      'VALIDATE CONSTRAINT "session_realtime_entries_turn_instructions_check"',
    );
    expect(source).toContain("opengeni.turn_instructions_protocol_v1");
    expect(source).toContain("sessions_turn_instructions_protocol_v1_guard");
    expect(source).toContain("session_turns_turn_instructions_protocol_v1_guard");
    expect(source).toContain("session_realtime_entries_turn_instructions_protocol_v1_guard");

    const blank = await acquireBlankTestDatabase("migration-0229-realtime-turn-instructions");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const [column] = await sql<Array<{ dataType: string; nullable: string }>>`
        select data_type as "dataType", is_nullable as nullable
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'session_realtime_entries'
          and column_name = 'turn_instructions'`;
      expect(column).toEqual({ dataType: "text", nullable: "YES" });

      const [constraint] = await sql<Array<{ definition: string; validated: boolean }>>`
        select pg_get_constraintdef(oid) as definition, convalidated as validated
        from pg_constraint
        where connamespace = current_schema()::regnamespace
          and conname = 'session_realtime_entries_turn_instructions_check'`;
      expect(constraint?.validated).toBe(true);
      expect(constraint?.definition).toContain("provider_in");
      expect(constraint?.definition).toContain("delegation_call");
      expect(constraint?.definition).toContain("user_transcript");
      expect(constraint?.definition).toContain("assistant_transcript");
      expect(constraint?.definition).toContain("32768");

      const triggers = await sql<Array<{ name: string }>>`
        select tgname as name
        from pg_trigger
        where tgrelid in (
          'sessions'::regclass,
          'session_turns'::regclass,
          'session_realtime_entries'::regclass
        )
          and tgname like '%turn_instructions_protocol_v1_guard'
          and not tgisinternal
        order by tgname`;
      expect(triggers.map((trigger) => trigger.name)).toEqual([
        "session_realtime_entries_turn_instructions_protocol_v1_guard",
        "session_turns_turn_instructions_protocol_v1_guard",
        "sessions_turn_instructions_protocol_v1_guard",
      ]);

      const client = createDb(blank.databaseUrl, { max: 2 });
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = "apppw";
      const legacyApp = postgres(appUrl.toString(), { max: 1, onnotice: () => undefined });
      try {
        const suffix = crypto.randomUUID();
        const access = await bootstrapWorkspace(client.db, {
          accountExternalSource: "migration-0229",
          accountExternalId: `account-${suffix}`,
          accountName: "Migration 0229",
          workspaceExternalSource: "migration-0229",
          workspaceExternalId: `workspace-${suffix}`,
          workspaceName: "Migration 0229",
          subjectId: `user:${suffix}`,
        });
        const grant = access.workspaceGrants[0]!;
        const session = await createSession(client.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          initialMessage: "authorized hidden context",
          initialTurnInstructions: "trusted initial context",
          resources: [],
          metadata: {},
          model: "migration-test",
          sandboxBackend: "none",
        });
        const started = await initializeSessionStartAtomically(client.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          reasoningEffortFallback: "low",
          createdEventPayload: {},
        });
        if (!started.turn) throw new Error("Migration 0229 fixture did not create an initial turn");

        let legacyError: unknown;
        try {
          await legacyApp.begin(async (tx) => {
            await tx`select set_config('opengeni.account_id', ${grant.accountId}, true)`;
            await tx`select set_config('opengeni.workspace_id', ${grant.workspaceId!}, true)`;
            await tx`update session_turns
              set turn_instructions = 'legacy replacement'
              where id = ${started.turn!.id}`;
          });
        } catch (error) {
          legacyError = error;
        }
        expect((legacyError as { code?: string } | undefined)?.code).toBe("55000");
        expect(String(legacyError)).toContain("turn-instructions protocol v1 marker is required");

        let legacyClearError: unknown;
        try {
          await legacyApp.begin(async (tx) => {
            await tx`select set_config('opengeni.account_id', ${grant.accountId}, true)`;
            await tx`select set_config('opengeni.workspace_id', ${grant.workspaceId!}, true)`;
            await tx`update session_turns
              set turn_instructions = null
              where id = ${started.turn!.id}`;
          });
        } catch (error) {
          legacyClearError = error;
        }
        expect((legacyClearError as { code?: string } | undefined)?.code).toBe("55000");

        await sql.begin(async (tx) => {
          await tx`select set_config('opengeni.turn_instructions_protocol_v1', '1', true)`;
          await tx`update session_turns
            set turn_instructions = 'authorized replacement'
            where id = ${started.turn!.id}`;
        });
        const [updated] = await sql<Array<{ turnInstructions: string | null }>>`
          select turn_instructions as "turnInstructions"
          from session_turns where id = ${started.turn.id}`;
        expect(updated?.turnInstructions).toBe("authorized replacement");
      } finally {
        await legacyApp.end();
        await client.close();
      }
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
