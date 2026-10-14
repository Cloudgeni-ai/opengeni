import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { acquireBlankTestDatabase } from "@opengeni/testing";

test("Slack branding preserves legacy installs and records the verified name for new bindings", async () => {
  const blank = await acquireBlankTestDatabase("migration-0647-slack-branding");
  if (!blank) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL is unavailable");
    return;
  }
  const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
  const migration = await readFile(
    new URL("../drizzle/0647_slack_bot_branding.sql", import.meta.url),
    "utf8",
  );
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`
        create schema opengeni_private;
        create table connections (
          id uuid primary key, account_id uuid not null, workspace_id uuid not null,
          subject_id text, provider_domain text not null, kind text not null,
          status text not null, version integer not null, verified_install_at timestamptz,
          verified_install_version integer, metadata jsonb not null,
          credential_encrypted text not null,
          created_by_subject_id text, updated_by_subject_id text
        );
        create table slack_installation_bindings (
          id uuid primary key default gen_random_uuid(), account_id uuid not null,
          workspace_id uuid not null, connection_id uuid not null unique,
          slack_team_id text not null unique, slack_team_name text not null,
          bot_id text not null, bot_user_id text not null, bot_display_name text not null,
          state text not null, version integer not null default 1,
          created_by_subject_id text, updated_by_subject_id text,
          updated_at timestamptz not null default now(),
          constraint slack_installation_bindings_identity_check check (
            bot_display_name in ('OpenGeni', 'OpenGeni Staging')
          )
        );
        create function opengeni_private.sync_slack_installation_binding()
        returns trigger language plpgsql security definer set search_path = pg_catalog
        as $$ begin return NEW; end $$;
        revoke all on function opengeni_private.sync_slack_installation_binding() from public;
        create trigger sync_slack_installation_binding after insert or update on connections
        for each row execute function opengeni_private.sync_slack_installation_binding();
      `);
      await tx.unsafe(migration);
      const account = crypto.randomUUID();
      const workspace = crypto.randomUUID();
      const insert = async (name: string | null, database = tx) => {
        const id = crypto.randomUUID();
        await database`insert into connections (
          id, account_id, workspace_id, subject_id, provider_domain, kind, status,
          version, verified_install_at, verified_install_version, metadata, credential_encrypted
        ) values (
          ${id}, ${account}, ${workspace}, null, 'slack.com', 'app_install', 'active',
          1, now(), 1, ${database.json({
            credentialRole: "opengeni_slack_bot",
            slackTeamId: `T_${id}`,
            slackTeamName: "Test workspace",
            botId: "B_TEST",
            botUserId: "U_TEST",
            botDisplayName: name,
          })}, 'unchanged-test-credential'
        )`;
        return id;
      };
      for (const name of ["Opengeni", "Opengeni Staging", "OpenGeni", "OpenGeni Staging"]) {
        const id = await insert(name);
        const [binding] =
          await tx`select bot_display_name from slack_installation_bindings where connection_id = ${id}`;
        expect(binding?.bot_display_name).toBe(name);
      }
      for (const name of ["Unexpected bot", null]) {
        await expect(tx.savepoint((savepoint) => insert(name, savepoint))).rejects.toThrow(
          "invalid verified Slack identity",
        );
      }
      const credentials = await tx`select credential_encrypted from connections`;
      expect(credentials).toHaveLength(4);
      expect(
        credentials.every((row) => row.credential_encrypted === "unchanged-test-credential"),
      ).toBe(true);
      const [posture] = await tx`select prosecdef, proconfig,
        has_function_privilege('public', oid, 'execute') as public_execute
        from pg_proc where oid = 'opengeni_private.sync_slack_installation_binding()'::regprocedure`;
      expect(posture).toMatchObject({
        prosecdef: true,
        proconfig: ["search_path=pg_catalog"],
        public_execute: false,
      });
    });
  } finally {
    await sql.end();
    await blank.release();
  }
}, 180_000);
