import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0224_slack_post_outcome_reconciliation.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0224 Slack post outcome reconciliation", () => {
  test("is a rolling old-writer fence with validated states and claim modes", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain('ADD COLUMN IF NOT EXISTS "claim_mode" text');
    expect(source).toContain("'pending', 'provider_started', 'outcome_unknown', 'completed'");
    expect(source).toContain("Slack post outcome requires reconciliation");
    expect(source).toContain("BEFORE INSERT OR UPDATE");
    expect(source).toContain("\"claim_mode\" = 'reconcile'");
    expect(source).toContain('VALIDATE CONSTRAINT "slack_bot_post_operations_identity_check"');
    expect(source).not.toMatch(/ACCESS\s+EXCLUSIVE/iu);
  });

  test("backfills live claims, blocks old unknown reclaims, and preserves FORCE RLS", async () => {
    const blank = await acquireBlankTestDatabase("migration-0224-slack-post");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await sql.unsafe(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await sql`insert into schema_migrations (name) values (${migrationName})`;
      await migrate(blank.databaseUrl);

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0221-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0221-workspace') returning id`;
      const [otherAccount] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0221-other-account') returning id`;
      const [otherWorkspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${otherAccount!.id}, 'migration-0221-other-workspace') returning id`;
      const insertConnection = async (accountId: string, workspaceId: string) => {
        const [connection] = await sql<{ id: string }[]>`
          insert into connections (
            account_id, workspace_id, provider_domain, kind,
            credential_encrypted, metadata
          ) values (
            ${accountId}, ${workspaceId}, 'slack.com', 'app_install',
            'fixture-encrypted', '{}'::jsonb
          ) returning id`;
        return connection!.id;
      };
      const connectionId = await insertConnection(account!.id, workspace!.id);
      const otherConnectionId = await insertConnection(otherAccount!.id, otherWorkspace!.id);
      const activeOperationId = crypto.randomUUID();
      const releasedOperationId = crypto.randomUUID();
      const activeHolderId = crypto.randomUUID();
      const insertLegacyPost = async (input: {
        accountId: string;
        workspaceId: string;
        connectionId: string;
        operationId: string;
        claimHolderId: string | null;
      }) =>
        await sql`
          insert into slack_bot_post_operations (
            account_id, workspace_id, connection_id, operation_id, client_message_id,
            target_kind, target_id, request_digest, status, claim_holder_id,
            claim_expires_at, attempt_count
          ) values (
            ${input.accountId}, ${input.workspaceId}, ${input.connectionId},
            ${input.operationId}, ${input.operationId}, 'channel', 'C_MEMBER',
            ${"a".repeat(64)}, 'provider_started', ${input.claimHolderId},
            ${input.claimHolderId ? sql`now() + interval '1 minute'` : null}, 1
          )`;
      await insertLegacyPost({
        accountId: account!.id,
        workspaceId: workspace!.id,
        connectionId,
        operationId: activeOperationId,
        claimHolderId: activeHolderId,
      });
      await insertLegacyPost({
        accountId: account!.id,
        workspaceId: workspace!.id,
        connectionId,
        operationId: releasedOperationId,
        claimHolderId: null,
      });

      await sql`delete from schema_migrations where name = ${migrationName}`;
      await migrate(blank.databaseUrl);

      const upgraded = await sql<
        { operationId: string; claimMode: string | null; status: string }[]
      >`
        select operation_id as "operationId", claim_mode as "claimMode", status
        from slack_bot_post_operations
        where workspace_id = ${workspace!.id}
        order by operation_id`;
      expect([...upgraded]).toEqual(
        [
          {
            operationId: activeOperationId,
            claimMode: "send",
            status: "provider_started",
          },
          {
            operationId: releasedOperationId,
            claimMode: null,
            status: "provider_started",
          },
        ].sort((left, right) => left.operationId.localeCompare(right.operationId)),
      );

      let oldReclaimError: unknown;
      try {
        await sql`
          update slack_bot_post_operations
          set claim_holder_id = ${crypto.randomUUID()},
              claim_expires_at = now() + interval '1 minute',
              attempt_count = attempt_count + 1
          where workspace_id = ${workspace!.id}
            and operation_id = ${releasedOperationId}`;
      } catch (error) {
        oldReclaimError = error;
      }
      expect(oldReclaimError).toMatchObject({ code: "23514" });

      const reconcileHolderId = crypto.randomUUID();
      await sql`
        update slack_bot_post_operations
        set status = 'outcome_unknown',
            claim_holder_id = ${reconcileHolderId},
            claim_expires_at = now() + interval '1 minute',
            claim_mode = 'reconcile',
            attempt_count = attempt_count + 1
        where workspace_id = ${workspace!.id}
          and operation_id = ${releasedOperationId}`;
      const [reconcileClaim] = await sql<
        { status: string; claimMode: string; claimHolderId: string }[]
      >`
        select status, claim_mode as "claimMode", claim_holder_id as "claimHolderId"
        from slack_bot_post_operations
        where workspace_id = ${workspace!.id}
          and operation_id = ${releasedOperationId}`;
      expect(reconcileClaim).toEqual({
        status: "outcome_unknown",
        claimMode: "reconcile",
        claimHolderId: reconcileHolderId,
      });

      const pendingOperationId = crypto.randomUUID();
      await sql`
        insert into slack_bot_post_operations (
          account_id, workspace_id, connection_id, operation_id, client_message_id,
          target_kind, target_id, request_digest, status, attempt_count
        ) values (
          ${account!.id}, ${workspace!.id}, ${connectionId}, ${pendingOperationId},
          ${pendingOperationId}, 'channel', 'C_MEMBER', ${"b".repeat(64)}, 'pending', 1
        )`;
      const pendingHolderId = crypto.randomUUID();
      await sql`
        update slack_bot_post_operations
        set claim_holder_id = ${pendingHolderId},
            claim_expires_at = now() + interval '1 minute'
        where workspace_id = ${workspace!.id}
          and operation_id = ${pendingOperationId}`;
      const [oldPendingClaim] = await sql<{ claimMode: string }[]>`
        select claim_mode as "claimMode"
        from slack_bot_post_operations
        where workspace_id = ${workspace!.id}
          and operation_id = ${pendingOperationId}`;
      expect(oldPendingClaim).toEqual({ claimMode: "send" });

      const otherOperationId = crypto.randomUUID();
      await sql`
        insert into slack_bot_post_operations (
          account_id, workspace_id, connection_id, operation_id, client_message_id,
          target_kind, target_id, request_digest, status, attempt_count
        ) values (
          ${otherAccount!.id}, ${otherWorkspace!.id}, ${otherConnectionId},
          ${otherOperationId}, ${otherOperationId}, 'channel', 'C_OTHER',
          ${"c".repeat(64)}, 'pending', 1
        )`;
      const [posture] = await sql<{ forced: boolean; policyCount: number; triggerCount: number }[]>`
        select
          relforcerowsecurity as forced,
          (select count(*)::int from pg_policy
           where polrelid = 'slack_bot_post_operations'::regclass) as "policyCount",
          (select count(*)::int from pg_trigger
           where tgrelid = 'slack_bot_post_operations'::regclass
             and tgname = 'slack_bot_post_operations_claim_mode_fence'
             and not tgisinternal) as "triggerCount"
        from pg_class where oid = 'slack_bot_post_operations'::regclass`;
      expect(posture).toEqual({
        forced: true,
        policyCount: 1,
        triggerCount: 1,
      });

      await sql.begin(async (tx) => {
        await tx.unsafe("set local role opengeni_app");
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
        const [visible] = await tx<{ count: number }[]>`
          select count(*)::int as count from slack_bot_post_operations`;
        expect(visible!.count).toBe(3);
      });
    } finally {
      await sql.end().catch(() => undefined);
      await blank.release();
    }
  }, 180_000);
});
