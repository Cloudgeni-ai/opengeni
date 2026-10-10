import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { allowanceMigrationTail } from "./allowance-migration-tail";

const migration = "0478_sender_owned_connections.sql";
// 0494 patches the installed 0478 resolver, so it must wait until this fixture
// has actually applied the sender cutover rather than merely marked it applied.
const accountBindingsMigration = "0494_mcp_account_bindings.sql";
const sharingMigration = "0501_session_sharing_execution.sql";
// Replaces the owner trigger installed by this cutover.
const admissionDiagnosticsMigration = "0534_scheduled_admission_diagnostics.sql";
// Replaces 0534's scheduled-run triggers; withheld with it.
const admissionRefusalsMigration = "0539_scheduled_admission_refusals.sql";
// 0608 rewrites the MCP receipt fence installed by withheld 0494 and preserves
// its 0501 sharing behavior. Replay it only after both prerequisites exist.
const receiverExecutionContextMigration = "0608_receiver_execution_context.sql";
// 0661 compiles its inbox person resolver against scheduled_tasks.owner_subject_id
// from this cutover, and 0663-0666 replace 0661's inbox projection trigger and
// read the paused-goal setting 0663 adds. 0689 redefines 0661's resolver.
const inboxScheduleOwnerMigration = "0661_inbox_subagent_goals_and_schedules.sql";
const inboxPausedGoalSettingMigration = "0663_inbox_paused_goal_setting.sql";
const inboxTriggerTailMigrations = [
  "0664_inbox_rich_notifications.sql",
  "0665_inbox_replies.sql",
  "0666_inbox_reply_current_turn.sql",
  // Redefines 0661's person resolver, which reads scheduled_tasks.owner_subject_id.
  "0677_local_human_inbox_recipient.sql",
  // Compiles SQL bodies against 0661's session person resolver.
  "0678_inbox_mute_session_replies.sql",
];
const withheldMigrations = [
  migration,
  accountBindingsMigration,
  sharingMigration,
  admissionDiagnosticsMigration,
  admissionRefusalsMigration,
  receiverExecutionContextMigration,
  inboxScheduleOwnerMigration,
  inboxPausedGoalSettingMigration,
  ...inboxTriggerTailMigrations,
  // The Codex writers and the drained cutover read columns the withheld 0661
  // adds, so they run with the withheld tail, in ledger order.
  "0688_subscription_core_codex_writers.sql",
  "0689_subscription_core_codex_cutover.sql",
  // Disconnect patches the cutover routine; catalog observations and retry
  // admission extend its tables and guards. Replay after those prerequisites.
  "0691_subscription_core_codex_disconnect.sql",
  "0695_subscription_model_catalog_observations.sql",
  "0697_codex_retry_after_unknown_outcome.sql",
  // Patches ownerless access and lease guards created by withheld 0667 and 0671.
  "0698_codex_ownerless_person_turns.sql",
  // Patches the request guard after 0697.
  "0699_codex_recovery_after_interrupted_attempt.sql",
  "0700_codex_ownerless_person_refresh.sql",
  // Replaces the scope guard on the shared connection table from withheld 0642.
  "0702_subscription_codex_access_editor.sql",
  // Patches the capture function installed by withheld 0478 and patched by 0608.
  "0704_inactive_inherited_personal_connections.sql",
  // Adds provider-neutral routines over the shared core tables from withheld 0642.
  "0707_subscription_core_neutral_routines.sql",
  // Rewrites the inbox routines from the withheld inbox tail and reads its columns.
  "0708_inbox_member_notifications.sql",
  // Records receipts over withheld 0689 and patches the capture function from withheld 0478.
  "0711_subscription_core_generic_precursor.sql",
];
let database: OwnerMigratedTestDatabase | null = null;

beforeAll(async () => {
  database = await acquireOwnerMigratedTestDatabase("sender-cutover-upgrade");
  if (!database && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("PostgreSQL required");
}, 180_000);

afterAll(async () => {
  await database?.release();
}, 120_000);

test("maintenance cutover backfills proven owners under FORCE RLS without rewriting accepted bindings", async () => {
  const db = database;
  if (!db) return;
  const owner = postgres(db.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner.unsafe(
      `CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await owner`insert into schema_migrations (name) select unnest(${withheldMigrations}::text[])`;
    // The allowance guard patch must wait for the withheld refusal lifecycle.
    for (const name of allowanceMigrationTail)
      await owner`insert into schema_migrations(name) values(${name})`;
    await migrate(db.ownerUrl);
    const [historicalBindings] =
      await owner`select to_regprocedure('opengeni_private.fence_mcp_account_bindings()') as receipt_fence`;
    expect(historicalBindings!.receipt_fence).toBeNull();
    await owner`delete from schema_migrations where name = any(${withheldMigrations}::text[])`;
    for (const name of allowanceMigrationTail)
      await owner`delete from schema_migrations where name=${name}`;
    const [posture] =
      await owner`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(posture).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const [account] =
      await db.admin`insert into managed_accounts (name) values ('migration fixture') returning id`;
    const [workspace] =
      await db.admin`insert into workspaces (account_id, name) values (${account!.id}, 'migration fixture') returning id`;
    await db.admin`insert into capability_catalog_items (id, account_id, workspace_id, kind, source, name, endpoint_url, metadata)
      values ('mcp:fixture:gmail', ${account!.id}, ${workspace!.id}, 'mcp', 'manual', 'Mail',
      'https://gmailmcp.googleapis.com/mcp/v1', '{"connectionOwnership":"personal_only","oauthProfile":{"allowedOwnership":["personal"],"sendResourceParameter":false}}'::jsonb)`;
    const taskIds: string[] = [];
    for (const context of [{}, { backfill: true }, { backfill: true }, {}]) {
      const selections =
        taskIds.length === 2
          ? [
              {
                serverId: "fixture-mail",
                connectionId: crypto.randomUUID(),
                originWorkspaceId: workspace!.id,
                ownerSubjectId: "user:fixture",
                providerDomain: "mail.example.test",
                kind: "oauth2",
                connectionType: "connection",
              },
            ]
          : [];
      const task = await db.admin.begin(async (tx) => {
        await tx`select acquire_session_tenancy_fence(${workspace!.id})`;
        const [row] = await tx`
        insert into scheduled_tasks (account_id, workspace_id, name, schedule, temporal_schedule_id, agent_config,
          created_by_kind, created_by_subject_id, created_by_context, personal_connection_delegations)
        values (${account!.id}, ${workspace!.id}, 'migration fixture', '{"type":"manual"}', ${crypto.randomUUID()}, '{}',
          'subject', 'user:fixture', ${db.admin.json(context)}, ${db.admin.json(selections)}) returning id`;
        return row!;
      });
      taskIds.push(task.id as string);
    }
    const [membership] = await db.admin`insert into organization_memberships
      (account_id, subject_id, status, personal_workspace_id)
      values (${account!.id}, 'user:revision-owner', 'active', ${workspace!.id}) returning id`;
    await db.admin`insert into scheduled_task_revision_authorities
      (task_id, task_authority_revision, account_id, workspace_id, subject_id,
       organization_membership_id, membership_authorization_revision, execution_digest)
      select id, authority_revision, account_id, workspace_id, 'user:revision-owner',
        ${membership!.id}, 1, execution_digest from scheduled_tasks where id = ${taskIds[3]!}`;
    const before =
      await db.admin`select id, authority_revision, execution_digest from scheduled_tasks order by id`;
    const [rls] =
      await db.admin`select relforcerowsecurity from pg_class where oid = 'scheduled_tasks'::regclass`;
    expect(rls!.relforcerowsecurity).toBe(true);
    await migrate(db.ownerUrl);
    const [receiverContext] = await db.admin`
      select
        exists(select 1 from schema_migrations where name = ${receiverExecutionContextMigration}) as applied,
        to_regprocedure('opengeni_private.fence_mcp_account_bindings()') is not null as receipt_fence_present,
        exists(select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'session_turns'
            and column_name = 'execution_context_turn_id') as execution_context_present
    `;
    expect(receiverContext).toEqual({
      applied: true,
      receipt_fence_present: true,
      execution_context_present: true,
    });
    const [catalog] =
      await db.admin`select metadata from capability_catalog_items where id = 'mcp:fixture:gmail'`;
    expect(catalog!.metadata).toEqual({
      defaultConnectionOwnership: "personal",
      oauthProfile: { defaultOwnership: "personal", sendResourceParameter: false },
    });
    const after =
      await db.admin`select id, authority_revision, execution_digest from scheduled_tasks order by id`;
    expect(after).toEqual(before);
    const rows = await db.admin`select id, owner_subject_id, status from scheduled_tasks`;
    expect(rows.find((row) => row.id === taskIds[0])!.owner_subject_id).toBe("user:fixture");
    expect(rows.find((row) => row.id === taskIds[1])!.owner_subject_id).toBeNull();
    expect(rows.find((row) => row.id === taskIds[0])!.status).toBe("active");
    expect(rows.find((row) => row.id === taskIds[1])!.status).toBe("active");
    expect(rows.find((row) => row.id === taskIds[2])!).toMatchObject({
      owner_subject_id: null,
      status: "paused",
    });
    expect(rows.find((row) => row.id === taskIds[3])!).toMatchObject({
      owner_subject_id: "user:revision-owner",
      status: "active",
    });
    const [restored] =
      await db.admin`select relforcerowsecurity from pg_class where oid = 'scheduled_tasks'::regclass`;
    expect(restored!.relforcerowsecurity).toBe(true);
  } finally {
    await owner.end({ timeout: 5 });
  }
}, 180_000);
