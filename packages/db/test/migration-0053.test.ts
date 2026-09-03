import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { selectCodexCredentialLeaseForTurn } from "../../../apps/worker/src/activities/codex-rotation";
import { acquireCodexCredentialLease, createDb } from "../src/index";
import { migrate } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

let available = true;
let blank: BlankTestDatabase | null = null;
let databaseUrl = "";

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0053");
  if (!blank) {
    available = false;
    console.warn("[migration-0053] postgres unavailable, skipping");
    return;
  }
  databaseUrl = blank.databaseUrl;
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("migration 0053 (Codex credential leases)", () => {
  test("upgrades the additive lease foundation through the 0401 maintenance activation", async () => {
    if (!available) return;

    const admin = postgres(databaseUrl, { max: 1 });
    let client: ReturnType<typeof createDb> | null = null;
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      expect(files).toContain("0053_codex_credential_leases.sql");
      expect(files).toContain("0401_codex_unconditional_credential_leasing.sql");

      await admin`select pg_advisory_lock(727458)`;
      await admin.unsafe(
        `CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,
      );
      for (const migrationFile of files.filter((candidate) => candidate < "0053_")) {
        await applyFile(admin, migrationFile);
        await admin`insert into schema_migrations (name) values (${migrationFile}) on conflict do nothing`;
      }

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0053-account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'lease-foundation-workspace') returning id`;
      const credentialId = crypto.randomUUID();
      await admin`
        insert into codex_subscription_credentials (
          id, account_id, workspace_id, credential_encrypted,
          chatgpt_account_id, plan_type, status
        ) values (
          ${credentialId}, ${account!.id}, ${workspace!.id}, 'legacy-ciphertext',
          'legacy-provider-account', 'pro', 'active'
        )`;
      await admin`
        insert into codex_rotation_settings (
          account_id, workspace_id, active_credential_id,
          rotation_enabled, rotation_strategy
        ) values (
          ${account!.id}, ${workspace!.id}, ${credentialId}, false, 'most_remaining'
        )`;

      const sessionId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const triggerEventId = crypto.randomUUID();
      await admin`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id, status
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'legacy turn',
          'codex/gpt-5.6-sol', 'modal', ${sessionId}, 'running'
        )`;
      await admin`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model,
          reasoning_effort, sandbox_backend
        ) values (
          ${turnId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${triggerEventId},
          'lease-foundation-workflow', 'running', 1, 'legacy turn',
          'codex/gpt-5.6-sol', 'low', 'modal'
        )`;
      await admin`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`;

      const beforeColumns = await admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'codex_rotation_settings'
          and column_name = 'lease_rotation_enabled'`;
      expect(beforeColumns).toHaveLength(0);

      await applyFile(admin, "0053_codex_credential_leases.sql");
      await admin`
        insert into schema_migrations (name)
        values ('0053_codex_credential_leases.sql') on conflict do nothing`;
      await admin`select pg_advisory_unlock(727458)`;

      const [additive] = await admin<
        Array<{
          active_credential_id: string;
          rotation_enabled: boolean;
          lease_rotation_enabled: boolean;
          allocator_enabled: boolean;
        }>
      >`
        select r.active_credential_id, r.rotation_enabled,
               r.lease_rotation_enabled, c.allocator_enabled
        from codex_rotation_settings r
        join codex_subscription_credentials c on c.id = r.active_credential_id
        where r.workspace_id = ${workspace!.id}`;
      expect(additive).toEqual({
        active_credential_id: credentialId,
        rotation_enabled: false,
        lease_rotation_enabled: false,
        allocator_enabled: true,
      });

      await migrate(databaseUrl);

      const attemptId = crypto.randomUUID();
      const dispatchId = `migration-0053:${attemptId}`;
      const workflowRunId = `run:${attemptId}`;
      await admin.begin(async (transaction) => {
        await transaction`set constraints all deferred`;
        await transaction`
          update session_turns
          set status = 'running', execution_generation = 1,
              active_attempt_id = ${attemptId},
              metadata = jsonb_build_object(
                'dispatchGeneration', 1,
                'dispatchAttempt', jsonb_build_object(
                  'id', ${dispatchId}::text, 'generation', 1,
                  'triggerEventId', ${triggerEventId}::uuid
                )
              )
          where id = ${turnId}`;
        await transaction`
          insert into session_turn_attempts (
            id, account_id, workspace_id, session_id, turn_id, execution_generation,
            state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
            verified_control_revision, mcp_approval_policies
          ) values (
            ${attemptId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 1,
            'running', 'lease-foundation-workflow', ${workflowRunId}, ${dispatchId}, 0,
            '{}'::jsonb
          )`;
      });

      const retiredColumns = await admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = current_schema()
          and table_name in ('codex_rotation_settings', 'organization_codex_rotation_settings')
          and column_name = 'lease_rotation_enabled'`;
      expect(retiredColumns).toHaveLength(0);
      const [preserved] = await admin<
        Array<{ active_credential_id: string; rotation_enabled: boolean }>
      >`
        select active_credential_id, rotation_enabled
        from codex_rotation_settings where workspace_id = ${workspace!.id}`;
      expect(preserved).toEqual({
        active_credential_id: credentialId,
        rotation_enabled: false,
      });

      client = createDb(databaseUrl, { max: 2 });
      const leased = await acquireCodexCredentialLease(
        client.db,
        {
          accountId: account!.id,
          workspaceId: workspace!.id,
          sessionId,
          turnId,
          attemptId,
          executionGeneration: 1,
          workflowId: "lease-foundation-workflow",
          workflowRunId,
          dispatchId,
          expectedRedispatches: 0,
          holderId: "migration-0053-unconditional-lease",
          advanceActivePointer: true,
        },
        (context) =>
          selectCodexCredentialLeaseForTurn({
            context,
            sessionId,
            sessionPinSource: null,
            sessionPinnedCredentialId: null,
            sessionLastCredentialId: null,
            now: new Date("2026-09-03T00:00:00.000Z"),
          }),
      );
      expect(leased).toMatchObject({
        credentialId,
        holderId: "migration-0053-unconditional-lease",
        generation: 1,
        rotationEnabled: false,
      });
      const [leaseCount] = await admin<{ count: number }[]>`
        select count(*)::int as count from codex_credential_leases
        where workspace_id = ${workspace!.id} and turn_id = ${turnId}`;
      expect(leaseCount?.count).toBe(1);
    } finally {
      await client?.close().catch(() => undefined);
      await admin.end();
    }
  }, 900_000);
});
