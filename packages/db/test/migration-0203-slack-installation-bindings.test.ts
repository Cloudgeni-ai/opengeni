import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  FORCE_RLS_TABLES,
  RUNTIME_FULL_DML_TABLES,
  RUNTIME_READ_ONLY_TABLES,
} from "../src/runtime-posture";

const migrationUrl = new URL("../drizzle/0203_slack_installation_bindings.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0203-slack-bindings");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0203-slack-bindings] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 180_000);

describe("migration 0203 Slack installation bindings", () => {
  test("declares a rolling FORCE-RLS authority with least-privilege runtime ACL", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('CREATE TABLE "slack_installation_bindings"');
    expect(source).toContain('ALTER TABLE "slack_installation_bindings" FORCE ROW LEVEL SECURITY');
    expect(source).toContain("slack_installation_bindings_active_team_uq");
    expect(source).toContain("inspect_slack_installation_binding");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("legacy_conflicting_installations");
    expect(source).toContain("OPENGENI_SLACK_BINDING_CONFLICT");
    expect(source).toContain("REVOKE ALL ON FUNCTION");
    expect(source).not.toMatch(/credential_encrypted\s*=|access_token|authorization header/iu);
    expect(FORCE_RLS_TABLES).toContain("slack_installation_bindings");
    expect(RUNTIME_FULL_DML_TABLES).not.toContain("slack_installation_bindings");
    expect(RUNTIME_READ_ONLY_TABLES).toContain("slack_installation_bindings");
  });

  test("backfills one canonical principal, quarantines conflicts, and preserves credentials", async () => {
    const blank = await acquireBlankTestDatabase("migration-0203-backfill");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    const source = await readFile(migrationUrl, "utf8");
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`
          create extension if not exists pgcrypto;
          create schema opengeni_private;
          create function opengeni_private.workspace_rls_visible(uuid, uuid)
          returns boolean language sql stable as $$ select true $$;
          create table managed_accounts (id uuid primary key, name text not null);
          create table workspaces (
            id uuid primary key,
            account_id uuid not null references managed_accounts(id) on delete cascade,
            name text not null,
            unique (id, account_id)
          );
          create table connections (
            id uuid primary key,
            account_id uuid not null references managed_accounts(id) on delete cascade,
            workspace_id uuid not null references workspaces(id) on delete cascade,
            subject_id text,
            provider_domain text not null,
            kind text not null,
            status text not null,
            credential_encrypted text not null,
            granted_scopes jsonb not null,
            version integer not null,
            verified_install_at timestamptz,
            verified_install_version integer,
            metadata jsonb not null,
            created_by_subject_id text,
            updated_by_subject_id text,
            created_at timestamptz not null,
            updated_at timestamptz not null
          );
        `);
        const accountA = crypto.randomUUID();
        const workspaceA = crypto.randomUUID();
        const accountB = crypto.randomUUID();
        const workspaceB = crypto.randomUUID();
        await tx`
          insert into managed_accounts (id, name)
          values (${accountA}, 'Account A'), (${accountB}, 'Account B')`;
        await tx`
          insert into workspaces (id, account_id, name)
          values (${workspaceA}, ${accountA}, 'Workspace A'), (${workspaceB}, ${accountB}, 'Workspace B')`;
        const insertConnection = async (input: {
          id: string;
          accountId: string;
          workspaceId: string;
          teamId: string;
          botId: string;
          botUserId: string;
          createdAt: string;
          credential: string;
        }) =>
          await tx`
            insert into connections (
              id, account_id, workspace_id, subject_id, provider_domain, kind, status,
              credential_encrypted, granted_scopes, version, verified_install_at,
              verified_install_version, metadata, created_at, updated_at
            ) values (
              ${input.id}, ${input.accountId}, ${input.workspaceId}, null, 'slack.com',
              'app_install', 'active', ${input.credential}, '[]'::jsonb, 1, now(), 1,
              ${tx.json({
                credentialRole: "opengeni_slack_bot",
                slackTeamId: input.teamId,
                slackTeamName: input.teamId,
                botId: input.botId,
                botUserId: input.botUserId,
                botDisplayName: "OpenGeni",
              })},
              ${input.createdAt}, ${input.createdAt}
            )`;

        const oldDuplicate = crypto.randomUUID();
        const canonical = crypto.randomUUID();
        await insertConnection({
          id: oldDuplicate,
          accountId: accountA,
          workspaceId: workspaceA,
          teamId: "T_UNAMBIGUOUS",
          botId: "B_ONE",
          botUserId: "U_ONE",
          createdAt: "2026-01-01T00:00:00Z",
          credential: "cipher-old",
        });
        await insertConnection({
          id: canonical,
          accountId: accountA,
          workspaceId: workspaceA,
          teamId: "T_UNAMBIGUOUS",
          botId: "B_ONE",
          botUserId: "U_ONE",
          createdAt: "2026-01-02T00:00:00Z",
          credential: "cipher-current",
        });
        await insertConnection({
          id: crypto.randomUUID(),
          accountId: accountA,
          workspaceId: workspaceA,
          teamId: "T_CONFLICT",
          botId: "B_A",
          botUserId: "U_A",
          createdAt: "2026-01-03T00:00:00Z",
          credential: "cipher-a",
        });
        await insertConnection({
          id: crypto.randomUUID(),
          accountId: accountB,
          workspaceId: workspaceB,
          teamId: "T_CONFLICT",
          botId: "B_B",
          botUserId: "U_B",
          createdAt: "2026-01-04T00:00:00Z",
          credential: "cipher-b",
        });

        await tx.unsafe(source);

        const bindings = await tx<
          Array<{ teamId: string; connectionId: string; state: string; reason: string | null }>
        >`
          select slack_team_id as "teamId", connection_id as "connectionId",
                 state, quarantine_reason as reason
          from slack_installation_bindings
          order by slack_team_id, connection_id`;
        expect(bindings.filter((binding) => binding.teamId === "T_UNAMBIGUOUS")).toEqual([
          {
            teamId: "T_UNAMBIGUOUS",
            connectionId: canonical,
            state: "active",
            reason: null,
          },
        ]);
        expect(bindings.filter((binding) => binding.teamId === "T_CONFLICT")).toEqual([
          expect.objectContaining({
            state: "quarantined",
            reason: "legacy_conflicting_installations",
          }),
          expect.objectContaining({
            state: "quarantined",
            reason: "legacy_conflicting_installations",
          }),
        ]);
        expect(
          await tx`select credential_encrypted from connections order by credential_encrypted`,
        ).toHaveLength(4);

        await tx`
          update connections
          set status = 'revoked',
              version = 2,
              verified_install_at = null,
              verified_install_version = null,
              metadata = jsonb_set(metadata, '{botDisplayName}', '"Legacy writer"'::jsonb),
              updated_at = now()
          where id = ${canonical}`;
        const [preservedBinding] = await tx<
          Array<{ displayName: string; state: string; version: number }>
        >`
          select bot_display_name as "displayName", state, version
          from slack_installation_bindings
          where connection_id = ${canonical}`;
        expect(preservedBinding).toEqual({
          displayName: "OpenGeni",
          state: "active",
          version: 1,
        });
      });
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);

  test("enforces FORCE RLS and exposes only SELECT to the runtime role", async () => {
    if (!shared) return;
    const [posture] = await shared.admin<
      Array<{
        rls: boolean;
        forced: boolean;
        selectPrivilege: boolean;
        insertPrivilege: boolean;
        updatePrivilege: boolean;
        deletePrivilege: boolean;
        publicInspect: boolean;
      }>
    >`
      select
        C.relrowsecurity as rls,
        C.relforcerowsecurity as forced,
        has_table_privilege('opengeni_app', C.oid, 'select') as "selectPrivilege",
        has_table_privilege('opengeni_app', C.oid, 'insert') as "insertPrivilege",
        has_table_privilege('opengeni_app', C.oid, 'update') as "updatePrivilege",
        has_table_privilege('opengeni_app', C.oid, 'delete') as "deletePrivilege",
        has_function_privilege('public',
          'opengeni_private.inspect_slack_installation_binding(text,text,text)', 'execute')
          as "publicInspect"
      from pg_class C
      where C.oid = 'slack_installation_bindings'::regclass`;
    expect(posture).toEqual({
      rls: true,
      forced: true,
      selectPrivilege: true,
      insertPrivilege: false,
      updatePrivilege: false,
      deletePrivilege: false,
      publicInspect: false,
    });
  });
});
