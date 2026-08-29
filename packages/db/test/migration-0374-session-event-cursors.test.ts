import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { bootstrapWorkspace, createDb, createSession } from "../src";
import { migrate } from "../src/migrate";

const migrationName = "0374_session_event_cursors.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0374 session event cursors", () => {
  test("refuses a legacy event history with a missing sequence", async () => {
    const blank = await acquireBlankTestDatabase("migration-0374-gapped-history");
    if (!blank) {
      if (requireRealDatabase) throw new Error("real blank database unavailable");
      return;
    }

    const sql = postgres(blank.databaseUrl, { max: 1, prepare: false });
    const client = createDb(blank.databaseUrl, { max: 1 });
    try {
      await sql.unsafe(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await sql`insert into schema_migrations (name) values (${migrationName})`;
      await migrate(blank.databaseUrl);

      const suffix = crypto.randomUUID();
      const access = await bootstrapWorkspace(client.db, {
        accountExternalSource: "test",
        accountExternalId: `cursor-gap-account-${suffix}`,
        accountName: "Cursor gap account",
        workspaceExternalSource: "test",
        workspaceExternalId: `cursor-gap-workspace-${suffix}`,
        workspaceName: "Cursor gap workspace",
        subjectId: `cursor-gap-subject-${suffix}`,
      });
      const grant = access.workspaceGrants[0]!;
      const session = await createSession(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        initialMessage: "legacy gapped event history",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });

      await sql`
        insert into session_events (
          account_id, workspace_id, session_id, sequence, type, payload
        ) values
          (${grant.accountId}, ${grant.workspaceId!}, ${session.id}, 1, 'legacy.one', '{}'::jsonb),
          (${grant.accountId}, ${grant.workspaceId!}, ${session.id}, 3, 'legacy.three', '{}'::jsonb)
      `;
      await sql`
        update sessions
        set last_sequence = 3
        where workspace_id = ${grant.workspaceId!}
          and id = ${session.id}
      `;
      await sql`delete from schema_migrations where name = ${migrationName}`;

      await expect(migrate(blank.databaseUrl)).rejects.toThrow(
        "session event cursor backfill refused because sessions.last_sequence diverges from durable event history",
      );
      expect(
        Array.from(
          await sql<Array<{ cursorTable: string | null }>>`
            select to_regclass('session_event_cursors')::text as "cursorTable"
          `,
        ),
      ).toEqual([{ cursorTable: null }]);
    } finally {
      await client.close().catch(() => undefined);
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);
});
