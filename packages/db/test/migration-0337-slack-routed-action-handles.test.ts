// Migration 0337 makes two things possible that routing needs once the routed
// workspace and the installation's workspace can actually differ: resolving an
// action handle's tenancy from its id, and freezing a home-tenancy Slack task
// policy on a routed-tenancy shared-task origin.
//
// The handle probe is proven through `acquireOwnerMigratedTestDatabase`, because
// the shared harness hands out the container superuser, for whom FORCE ROW LEVEL
// SECURITY never engages and a definer probe therefore looks correct while
// returning zero rows in production.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0337_slack_routed_action_handles.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const ACCOUNT = "aaaaaaaa-0337-4336-8336-aaaaaaaaaaaa";
const HOME_WORKSPACE = "11111111-0337-4336-8336-111111111111";
const TARGET_WORKSPACE = "22222222-0337-4336-8336-222222222222";
const CONNECTION = "33333333-0337-4336-8336-333333333333";
const INTERACTION = "44444444-0337-4336-8336-444444444444";
const SESSION = "55555555-0337-4336-8336-555555555555";
const HANDLE = "66666666-0337-4336-8336-666666666666";
const PROBE_PASSWORD = "handle_probe_password";

let owned: OwnerMigratedTestDatabase | null = null;
let probeUrl: string | null = null;
let probeRole: string | null = null;

/**
 * A session is not an ordinary insert: the depth-policy and activity-gate
 * SECURITY DEFINER triggers are owned by the same NOSUPERUSER role, so they need
 * the tenant context and the gate state a real writer establishes, and 0214's
 * commit guard rejects a transaction that reaches COMMIT unfinalized.
 */
async function insertTargetSession(database: OwnerMigratedTestDatabase): Promise<void> {
  await database.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.account_id', ${ACCOUNT}, true)`;
    await sql`select set_config('opengeni.workspace_id', ${TARGET_WORKSPACE}, true)`;
    await sql`select set_config('opengeni.subject_id', 'user:probe', true)`;
    await sql`select set_config('opengeni.session_activity_gate_state', 'open', true)`;
    await sql`
      select set_config('opengeni.session_activity_gate_workspace_id', ${TARGET_WORKSPACE}, true)
    `;
    await sql`
      insert into sessions (
        id, account_id, workspace_id, sandbox_group_id, status,
        created_by_kind, created_by_subject_id, initial_message, model,
        sandbox_backend, resources, tools, metadata, tool_policy,
        reasoning_effort, latency_mode
      ) values (
        ${SESSION}, ${ACCOUNT}, ${TARGET_WORKSPACE}, ${SESSION}, 'queued',
        'subject', 'user:probe', 'routed slack session', 'test-model', 'modal',
        '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        '{"mode":"workspace_default","inheritedFromSessionId":null}'::jsonb,
        'medium', 'standard'
      )
    `;
    await sql`select set_config('opengeni.session_activity_gate_state', 'preparing', true)`;
    await sql`set constraints all immediate`;
    await sql`
      set constraints sessions_activity_insert_commit_guard,
        sessions_activity_update_commit_guard deferred
    `;
    await sql`select set_config('opengeni.session_activity_gate_state', 'finalizing', true)`;
    await sql`
      with advanced as (
        update workspace_session_activity_revisions as counter
        set revision = counter.revision + 1
        where counter.workspace_id = ${TARGET_WORKSPACE}
        returning counter.revision
      )
      update sessions as session
      set activity_revision = advanced.revision,
          activity_revision_pending_xid = null
      from advanced
      where session.workspace_id = ${TARGET_WORKSPACE}
        and session.activity_revision_pending_xid = pg_current_xact_id()::text::bigint
    `;
    await sql`select set_config('opengeni.session_activity_gate_state', 'finalized', true)`;
  });
}

describe("migration 0337 routed Slack action handles", () => {
  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("slack-routed-handles");
    if (!owned) {
      if (requireRealDatabase) {
        throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no owner-migrated database was available");
      }
      return;
    }
    await migrate(owned.ownerUrl);
    probeRole = `${owned.ownerRole}_probe`.slice(0, 63);
    await owned.admin.unsafe(`
      CREATE ROLE "${probeRole}" WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE
        NOCREATEDB NOREPLICATION NOINHERIT PASSWORD '${PROBE_PASSWORD}';
      GRANT USAGE ON SCHEMA public TO "${probeRole}";
      GRANT USAGE ON SCHEMA opengeni_private TO "${probeRole}";
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${probeRole}";
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "${probeRole}";
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO "${probeRole}";
    `);
    await owned.admin.unsafe(`
      insert into managed_accounts (id, name) values ('${ACCOUNT}', 'handles');
      insert into workspaces (id, account_id, name) values
        ('${HOME_WORKSPACE}', '${ACCOUNT}', 'Home'),
        ('${TARGET_WORKSPACE}', '${ACCOUNT}', 'Target');
      insert into workspace_inference_controls (workspace_id, account_id) values
        ('${HOME_WORKSPACE}', '${ACCOUNT}'), ('${TARGET_WORKSPACE}', '${ACCOUNT}')
        on conflict do nothing;
      select set_config('opengeni.account_id', '${ACCOUNT}', false),
             set_config('opengeni.workspace_id', '${HOME_WORKSPACE}', false);
      insert into connections
        (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
        values ('${CONNECTION}', '${ACCOUNT}', '${HOME_WORKSPACE}', 'slack.com', 'app_install',
                'active', '\\x00'::bytea);
      insert into slack_interactions
        (id, account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
         slack_thread_ts, route_key, triggering_provider_event_id, owning_subject_id, visibility,
         session_reservation_id)
        values ('${INTERACTION}', '${ACCOUNT}', '${TARGET_WORKSPACE}', '${CONNECTION}', 'T0337',
                'C0337', '1.0', 'C0337:1.0', 'Ev0337', 'user:probe', 'workspace', '${SESSION}');
    `);
    await insertTargetSession(owned);
    await owned.admin.unsafe(`
      select set_config('opengeni.account_id', '${ACCOUNT}', false),
             set_config('opengeni.workspace_id', '${TARGET_WORKSPACE}', false);
      update slack_interactions set session_id = '${SESSION}' where id = '${INTERACTION}';
      insert into slack_interaction_action_handles
        (id, account_id, workspace_id, connection_id, interaction_id, session_id,
         session_event_sequence, action_kind, action_key, authorized_subject_id,
         authorized_slack_user_id, message_operation_id, expires_at)
        values ('${HANDLE}', '${ACCOUNT}', '${TARGET_WORKSPACE}', '${CONNECTION}',
                '${INTERACTION}', '${SESSION}', 1, 'session_status', 'status', 'user:probe',
                'U0337', gen_random_uuid(), now() + interval '1 hour');
    `);
    probeUrl = owned.adminUrl.replace(
      /postgres:\/\/[^@]+@/u,
      `postgres://${probeRole}:${PROBE_PASSWORD}@`,
    );
  }, 900_000);

  afterAll(async () => {
    if (owned && probeRole) {
      await owned.admin
        .unsafe(`DROP OWNED BY "${probeRole}"; DROP ROLE IF EXISTS "${probeRole}"`)
        .catch(() => undefined);
    }
    await owned?.release();
  });

  test("declares a rolling migration whose only backfill opens the owner posture window", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling")).toBe(true);
    // The one UPDATE in this file is over a FORCE-RLS table, so it must be
    // wrapped in the owner-only window or it matches zero rows and reports
    // success.
    const update = source.indexOf('UPDATE "slack_shared_task_origins"');
    expect(update).toBeGreaterThan(0);
    expect(source.lastIndexOf("NO FORCE ROW LEVEL SECURITY", update)).toBeGreaterThan(0);
    expect(source.indexOf("FORCE ROW LEVEL SECURITY;", update)).toBeGreaterThan(update);
    // The handle backfill reads a FORCE-RLS table and needs the same window.
    const backfill = source.indexOf(
      "INSERT INTO opengeni_private.slack_action_handle_tenancy (\n  handle_id",
    );
    expect(backfill).toBeGreaterThan(0);
    expect(source.lastIndexOf("NO FORCE ROW LEVEL SECURITY", backfill)).toBeGreaterThan(0);
    expect(source).toContain("REVOKE ALL ON FUNCTION");
    // Both owner-bound guards must be restored, or the table is left readable by
    // its owner and mutable through the immutability trigger.
    expect(source).toContain(
      'ALTER TABLE "slack_shared_task_origins" ENABLE TRIGGER "slack_shared_task_origins_immutable";',
    );
    expect(source).toContain(
      'ALTER TABLE "slack_interaction_action_handles" FORCE ROW LEVEL SECURITY;',
    );
    // The installation authority stays frozen.
    expect(source).not.toContain("resolve_slack_installation");
    expect(source).not.toContain("sync_slack_installation_binding");
  });

  test("resolves a target-workspace handle while the caller is scoped to home", async () => {
    if (!owned || !probeUrl) return;
    const app = postgres(probeUrl, { max: 1, onnotice: () => undefined });
    try {
      const observed = await app.begin(async (tx) => {
        await tx.unsafe(`select
          set_config('opengeni.account_id', '${ACCOUNT}', true),
          set_config('opengeni.workspace_id', '${HOME_WORKSPACE}', true)`);
        const direct = await tx.unsafe<Array<{ n: number }>>(
          `select count(*)::int as n from slack_interaction_action_handles where id = '${HANDLE}'`,
        );
        const probed = await tx.unsafe<Array<{ account_id: string; workspace_id: string }>>(
          `select account_id, workspace_id
             from opengeni_private.resolve_slack_action_handle_tenancy(
               '${CONNECTION}'::uuid, '${HANDLE}'::uuid)`,
        );
        const after = await tx.unsafe<Array<{ n: number }>>(
          `select count(*)::int as n from slack_interaction_action_handles where id = '${HANDLE}'`,
        );
        return { direct: direct[0]?.n, probed: [...probed], after: after[0]?.n };
      });
      expect(observed.direct).toBe(0);
      expect(observed.after).toBe(0);
      expect(observed.probed).toEqual([{ account_id: ACCOUNT, workspace_id: TARGET_WORKSPACE }]);
    } finally {
      await app.end({ timeout: 5 });
    }
  }, 120_000);

  test("refuses a handle that belongs to another connection", async () => {
    if (!owned || !probeUrl) return;
    const app = postgres(probeUrl, { max: 1, onnotice: () => undefined });
    try {
      const probed = await app.unsafe<Array<Record<string, unknown>>>(
        `select * from opengeni_private.resolve_slack_action_handle_tenancy(
           gen_random_uuid(), '${HANDLE}'::uuid)`,
      );
      expect([...probed]).toEqual([]);
    } finally {
      await app.end({ timeout: 5 });
    }
  }, 120_000);

  test("grants opengeni_app the probe but never the tenancy mapping", async () => {
    if (!owned) return;
    // The probe role above is granted by this test, so what it can do proves
    // nothing about the migration. Assert the shape the migration actually
    // produced for the real runtime role, through the catalog.
    const [privileges] = await owned.admin<
      Array<{ probe: boolean; select: boolean; insert: boolean }>
    >`
      select
        has_function_privilege(
          'opengeni_app',
          'opengeni_private.resolve_slack_action_handle_tenancy(uuid, uuid)',
          'EXECUTE') as probe,
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.slack_action_handle_tenancy',
          'SELECT') as select,
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.slack_action_handle_tenancy',
          'INSERT') as insert`;
    expect(privileges).toEqual({ probe: true, select: false, insert: false });
  }, 120_000);

  test("keeps the mapping in step when a handle is moved between workspaces", async () => {
    if (!owned) return;
    // The trigger watches the tenancy columns, so a corrected handle must not
    // leave the probe answering with the old workspace.
    await owned.admin.unsafe(`
      select set_config('opengeni.account_id', '${ACCOUNT}', false),
             set_config('opengeni.workspace_id', '${TARGET_WORKSPACE}', false);
      update slack_interaction_action_handles
        set workspace_id = '${TARGET_WORKSPACE}'
        where id = '${HANDLE}';
    `);
    const [row] = await owned.admin<Array<{ workspaceId: string }>>`
      select workspace_id as "workspaceId" from opengeni_private.slack_action_handle_tenancy
      where handle_id = ${HANDLE}::uuid`;
    expect(row?.workspaceId).toBe(TARGET_WORKSPACE);
  }, 120_000);

  test("denies the probe role every direct privilege on the tenancy mapping", async () => {
    if (!owned || !probeUrl) return;
    const app = postgres(probeUrl, { max: 1, onnotice: () => undefined });
    try {
      let code: string | null = null;
      try {
        await app.unsafe(`select * from opengeni_private.slack_action_handle_tenancy`);
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code).toBe("42501");
    } finally {
      await app.end({ timeout: 5 });
    }
  }, 120_000);

  test("forgets a handle when it is deleted", async () => {
    if (!owned) return;
    const doomed = crypto.randomUUID();
    await owned.admin.unsafe(`
      select set_config('opengeni.account_id', '${ACCOUNT}', false),
             set_config('opengeni.workspace_id', '${TARGET_WORKSPACE}', false);
      insert into slack_interaction_action_handles
        (id, account_id, workspace_id, connection_id, interaction_id, session_id,
         session_event_sequence, action_kind, action_key, authorized_subject_id,
         authorized_slack_user_id, message_operation_id, expires_at)
        values ('${doomed}', '${ACCOUNT}', '${TARGET_WORKSPACE}', '${CONNECTION}',
                '${INTERACTION}', '${SESSION}', 2, 'session_pause', 'pause', 'user:probe',
                'U0337', gen_random_uuid(), now() + interval '1 hour');
    `);
    const [present] = await owned.admin<Array<{ n: number }>>`
      select count(*)::int as n from opengeni_private.slack_action_handle_tenancy
      where handle_id = ${doomed}::uuid`;
    expect(present?.n).toBe(1);
    await owned.admin.unsafe(`delete from slack_interaction_action_handles where id = '${doomed}'`);
    const [gone] = await owned.admin<Array<{ n: number }>>`
      select count(*)::int as n from opengeni_private.slack_action_handle_tenancy
      where handle_id = ${doomed}::uuid`;
    expect(gone?.n).toBe(0);
  }, 120_000);

  test("lets a routed shared-task origin freeze a home-tenancy policy revision", async () => {
    if (!owned) return;
    const revision = crypto.randomUUID();
    await owned.admin.unsafe(`
      select set_config('opengeni.account_id', '${ACCOUNT}', false),
             set_config('opengeni.workspace_id', '${HOME_WORKSPACE}', false);
      insert into slack_task_policy_revisions
        (id, operation_id, request_fingerprint, account_id, workspace_id, policy,
         policy_hash, created_by_subject_id)
        select '${revision}', gen_random_uuid(), repeat('b', 64), '${ACCOUNT}',
               '${HOME_WORKSPACE}', policy.value, slack_task_policy_hash(policy.value),
               'user:admin'
        from (select jsonb_build_object(
                'allowedTeamIds', '[]'::jsonb,
                'allowedConversationIds', '[]'::jsonb,
                'allowGuestInitiators', false,
                'allowExternalInitiators', false,
                'allowMpim', false,
                'sharedConversationMode', 'private_handoff',
                'resultPublicationMode', 'approval_required') as value) policy;
      select set_config('opengeni.workspace_id', '${TARGET_WORKSPACE}', false);
    `);
    // The origin follows the routed task, while the policy it froze stays home.
    // Before 0337 no value of (account_id, workspace_id) could satisfy both
    // composite foreign keys at once.
    await owned.admin.unsafe(`
      insert into slack_shared_task_origins
        (interaction_id, account_id, workspace_id, connection_id, session_id, slack_team_id,
         source_channel_id, source_thread_ts, initiating_slack_user_id,
         policy_revision_id, policy_account_id, policy_workspace_id,
         policy_hash, policy_activation_version, publication_mode)
        values ('${INTERACTION}', '${ACCOUNT}', '${TARGET_WORKSPACE}', '${CONNECTION}',
                '${SESSION}', 'T0337', 'C0337', '1.0', 'U0337',
                '${revision}', '${ACCOUNT}', '${HOME_WORKSPACE}',
                (select policy_hash from slack_task_policy_revisions where id = '${revision}'),
                1, 'allow');
    `);
    const [row] = await owned.admin<Array<{ policyWorkspaceId: string; workspaceId: string }>>`
      select policy_workspace_id as "policyWorkspaceId", workspace_id as "workspaceId"
      from slack_shared_task_origins where interaction_id = ${INTERACTION}::uuid`;
    expect(row).toEqual({
      policyWorkspaceId: HOME_WORKSPACE,
      workspaceId: TARGET_WORKSPACE,
    });
  }, 120_000);
});
