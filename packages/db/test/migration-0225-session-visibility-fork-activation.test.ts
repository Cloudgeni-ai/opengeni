import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ResourceRef } from "@opengeni/contracts";
import {
  personalGitHubRepositoryResources,
  validateGitHubRepositorySelection,
} from "@opengeni/core";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  forkSessionContent,
  getSession,
  getSessionForSubject,
  getSessionGoal,
  getSessionHistoryItems,
  listSessionGoalRevisions,
  listSessionEvents,
  listSessionTurns,
  nestedPostgresSqlState,
  SessionTenancyAccessError,
  SessionTenancyConflictError,
  SessionTenancyInvalidRequestError,
  SessionTenancyNotActivatedError,
  transitionSessionVisibility,
  withSessionRlsActorContext,
  withWorkspaceRls,
  type DbClient,
} from "../src";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0303_session_tenancy_product_activation.sql",
);
const atomicForkMigrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0334_atomic_session_fork_visibility.sql",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const externalAdminUrl = process.env.OPENGENI_SESSION_VISIBILITY_POSTGRES_ADMIN_URL;
const externalAppUrl = process.env.OPENGENI_SESSION_VISIBILITY_POSTGRES_APP_URL;

beforeAll(async () => {
  if ((externalAdminUrl === undefined) !== (externalAppUrl === undefined)) {
    throw new Error(
      "set both OPENGENI_SESSION_VISIBILITY_POSTGRES_ADMIN_URL and OPENGENI_SESSION_VISIBILITY_POSTGRES_APP_URL",
    );
  }
  if (externalAdminUrl && externalAppUrl) {
    const admin = postgres(externalAdminUrl, { max: 8 });
    shared = {
      admin,
      adminUrl: externalAdminUrl,
      appUrl: externalAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    shared = await acquireSharedTestDatabase("migration-0225-session-visibility-fork-activation");
  }
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0225-session-visibility-fork-activation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

async function sessionVisibilityFixture() {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const ownerUserId = `session-owner-${suffix}`;
  const ownerSubjectId = `user:${ownerUserId}`;
  const ownerAccess = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Session owner",
  });
  const ownerGrant = ownerAccess.workspaceGrants[0]!;
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${ownerGrant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;
  // Migration 0323 leaves an organization activated after it with NO settings
  // row, i.e. private sessions disabled until an owner/admin enables them. This
  // fixture represents an organization that HAS enabled them, so the tests
  // below exercise fork visibility rather than the product gate. The gate
  // itself is proven by its own test.
  await shared.admin`
    insert into organization_private_session_settings (
      account_id, enabled, version, updated_by_membership_id, updated_at
    ) values (${ownerGrant.accountId}, true, 1, null, now())
    on conflict (account_id) do update set enabled = true`;
  const [ownerMembership] = await shared.admin<{ id: string }[]>`
    select id from organization_memberships
    where account_id = ${ownerGrant.accountId}
      and subject_id = ${ownerSubjectId}
      and status = 'active'
  `;
  const otherSubjectId = `user:session-other-${suffix}`;
  // The second member's personal workspace keeps the SHAPE real provisioning
  // produces: an organization_memberships pointer and NO workspace_memberships
  // row at all (0219 raises 42501 on one). An earlier revision of this fixture
  // hand-inserted a membership row here and used the result as the fork
  // destination, which is why the personal-workspace ownership defect repaired
  // by migration 0302 was invisible to this suite.
  const otherPersonalWorkspaceId = crypto.randomUUID();
  await shared.admin`
    insert into workspaces (id, account_id, name, external_source, external_id)
    values (
      ${otherPersonalWorkspaceId}, ${ownerGrant.accountId}, 'Other personal workspace',
      'session-visibility-test', ${`other-personal-${suffix}`}
    )
  `;
  const [otherMembership] = await shared.admin<{ id: string }[]>`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id
    ) values (
      ${ownerGrant.accountId}, ${otherSubjectId}, 'active', ${otherPersonalWorkspaceId}
    ) returning id
  `;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${otherPersonalWorkspaceId}, ${ownerGrant.accountId})
  `;
  await shared.admin`
    insert into workspace_memberships (
      account_id, workspace_id, subject_id, role, permissions
    ) values (
      ${ownerGrant.accountId}, ${ownerGrant.workspaceId}, ${otherSubjectId},
      'member', '["sessions:read","sessions:control"]'::jsonb
    )
  `;
  const session = await createSession(client.db, {
    accountId: ownerGrant.accountId,
    workspaceId: ownerGrant.workspaceId,
    initialMessage: "private session initial message",
    resources: [
      {
        kind: "repository",
        uri: "https://example.test/durable-resource.git",
        ref: "main",
        credentialBindingId: crypto.randomUUID(),
        connectionId: crypto.randomUUID(),
        installationId: crypto.randomUUID(),
      },
      {
        kind: "repository",
        uri: "https://github.com/example/private-personal-resource.git",
        ref: "main",
        provider: "github",
        connectionType: "github_personal",
        credentialBindingId: crypto.randomUUID(),
        access: "read",
        repositoryId: "424242",
      },
    ],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "modal",
    createdBy: { kind: "subject", subjectId: ownerSubjectId },
    createdByContext: {},
  });
  const eventId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  await shared.admin.begin(async (sql) => {
    await sql`
      insert into session_events (
        id, account_id, workspace_id, session_id, sequence, type, payload
      ) values (
        ${eventId}, ${ownerGrant.accountId}, ${ownerGrant.workspaceId}, ${session.id},
        0, 'user.message', '{"text":"private event"}'::jsonb
      )
    `;
    await sql`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, source, position, prompt,
        resources, tools, model, reasoning_effort, sandbox_backend,
        sandbox_os, metadata, initiator_kind, initiator_subject_id,
        initiator_context, initiating_human_subject_id
      ) values (
        ${turnId}, ${ownerGrant.accountId}, ${ownerGrant.workspaceId}, ${session.id},
        ${eventId}, ${`session-visibility-${suffix}`}, 'completed', 'user', 1,
        'private turn', '[]'::jsonb, '[]'::jsonb, 'test-model', 'medium',
        'modal', 'linux', '{}'::jsonb, 'subject', ${ownerSubjectId},
        '{}'::jsonb, ${ownerSubjectId}
      )
    `;
    await sql`
      insert into session_history_items (
        account_id, workspace_id, session_id, turn_id, position, item
      ) values (
        ${ownerGrant.accountId}, ${ownerGrant.workspaceId}, ${session.id}, ${turnId},
        1, '{"type":"message","role":"user","content":"private history"}'::jsonb
      )
    `;
    await sql`
      insert into session_goals (account_id, workspace_id, session_id, status, text)
      values (
        ${ownerGrant.accountId}, ${ownerGrant.workspaceId}, ${session.id}, 'completed', 'private goal'
      )
    `;
    await sql`
      insert into session_mcp_servers (
        account_id, workspace_id, session_id, server_id, url
      ) values (
        ${ownerGrant.accountId}, ${ownerGrant.workspaceId}, ${session.id},
        'private-server', 'https://private.example.test/mcp'
      )
    `;
    await sql`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id
      ) values (
        ${authorityId}, ${ownerGrant.accountId}, ${ownerMembership!.id},
        'variable_set', ${crypto.randomUUID()}, ${ownerGrant.workspaceId}
      )`;
    await sql`
      insert into organization_user_resource_grants (
        id, account_id, authority_id, owner_organization_membership_id,
        workspace_id, session_id, action, mode, context, authority_epoch
      ) values (
        ${grantId}, ${ownerGrant.accountId}, ${authorityId}, ${ownerMembership!.id},
        ${ownerGrant.workspaceId}, ${session.id}, 'use', 'session',
        'workspace_shared', 1
      )`;
  });
  return {
    ownerGrant,
    ownerMembershipId: ownerMembership!.id,
    ownerSubjectId,
    otherSubjectId,
    otherPersonalWorkspaceId,
    otherMembershipId: otherMembership!.id,
    session,
    grantId,
  };
}

describe("migration 0303 session tenancy product activation", () => {
  test("installs one bounded server-authoritative transition capability", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const transition = migration.slice(
      migration.indexOf("CREATE FUNCTION transition_session_visibility"),
      migration.indexOf("CREATE FUNCTION fork_session_content"),
    );
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain("CREATE TABLE session_tenancy_activations");
    expect(migration).toContain("CREATE FUNCTION transition_session_visibility");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("opengeni_private.current_account_id()");
    expect(migration).toContain("opengeni_private.current_workspace_id()");
    expect(migration).toContain("opengeni_private.current_subject_id()");
    expect(migration).toContain("membership.status = 'active'");
    expect(migration).toContain(
      "session_row.owner_organization_membership_id IS DISTINCT FROM actor_membership.id",
    );
    expect(migration).toContain("session_row.authority_epoch <> p_expected_authority_epoch");
    expect(migration).toContain("authority_epoch = new_epoch");
    expect(migration).not.toContain("cancel_reason = 'authority_changed'");
    expect(migration).toContain("assert_session_tenancy_quiescent");
    expect(migration).toContain("UPDATE organization_user_resource_grants");
    expect(migration).toContain("'session.visibility.changed'");
    expect(migration).toContain("receipt_row.result ->> 'status' = 'applied'");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(transition).not.toContain("created_by_subject_id");
    expect(transition).not.toContain("initial_message");
    expect(transition).not.toContain("'ownerOrganizationMembershipId', new_owner_id");
  });

  test("keeps lock and receipt order deterministic", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const transition = migration.slice(
      migration.indexOf("CREATE FUNCTION transition_session_visibility"),
      migration.indexOf("CREATE FUNCTION fork_session_content"),
    );
    const workspaceLock = transition.indexOf("FROM workspaces workspace_row");
    const membershipLock = transition.indexOf("FROM organization_memberships membership");
    const sessionLock = transition.indexOf("FROM sessions session");
    const receipt = transition.indexOf("INSERT INTO session_command_receipts");
    const mutation = transition.indexOf("UPDATE sessions transition_target");
    expect(workspaceLock).toBeGreaterThan(0);
    expect(membershipLock).toBeGreaterThan(workspaceLock);
    expect(sessionLock).toBeGreaterThan(membershipLock);
    expect(receipt).toBeGreaterThan(sessionLock);
    expect(mutation).toBeGreaterThan(receipt);
  });

  test("forks only an explicit durable-content allowlist with fresh authority", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const fork = migration.slice(migration.indexOf("CREATE FUNCTION fork_session_content"));
    expect(migration).toContain("CREATE FUNCTION fork_session_content");
    expect(migration).toContain(
      "p_destination_workspace_id IS DISTINCT FROM p_source_workspace_id",
    );
    expect(migration).toContain("p_destination_visibility <> 'user_private'");
    expect(migration).toContain("source_session.initial_message");
    expect(migration).toContain("source_session.title");
    expect(migration).toContain("source_session.instructions");
    expect(migration).toContain("jsonb_array_elements(source_session.resources)");
    expect(migration).toContain("- 'credentialBindingId'");
    expect(migration).toContain("- 'connectionId'");
    expect(migration).toContain("destination_resources, '[]'::jsonb, '[]'::jsonb");
    expect(migration).toContain("'subject', p_actor_subject_id");
    expect(migration).toContain("CREATE TEMP TABLE opengeni_session_fork_history_spool");
    expect(migration).toContain("FROM session_history_items source_item");
    expect(migration).toContain("FROM opengeni_session_fork_history_spool source_item");
    expect(migration).toContain("SELECT source_item.position, source_item.item,");
    expect(migration).not.toContain("source_item.item - 'providerData'");
    expect(migration).toContain("destination_session_id, 0, NULL, destination_depth");
    expect(migration).toContain("NULL, '[]'::jsonb, '[]'::jsonb");
    expect(migration).toContain("NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL");
    expect(migration).not.toContain("source_session.variable_set_id");
    expect(migration).not.toContain("source_session.rig_id");
    expect(migration).not.toContain("source_session.active_sandbox_id");
    expect(migration).not.toContain("source_session.codex_pinned_credential_id");
    expect(migration).not.toContain("INSERT INTO session_turns");
    expect(migration).not.toContain("INSERT INTO session_goals");
    expect(migration).not.toContain("INSERT INTO organization_user_resource_grants");
    expect(migration).not.toContain("INSERT INTO session_pins");
    expect(fork.indexOf("INSERT INTO session_command_receipts")).toBeGreaterThan(
      fork.indexOf("INTO source_session FROM sessions session"),
    );
    expect(fork.indexOf("PERFORM assert_session_tenancy_quiescent")).toBeGreaterThan(
      fork.indexOf("INSERT INTO session_command_receipts"),
    );
  });

  test("expands forks atomically without reintroducing a private-then-transition path", async () => {
    const migration = await readFile(atomicForkMigrationPath, "utf8");
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain("p_workspace_shared_acknowledged boolean");
    expect(migration).toContain("CREATE FUNCTION replay_applied_session_fork(");
    expect(migration).toContain(
      "p_destination_visibility NOT IN ('user_private', 'workspace_shared')",
    );
    expect(migration).toContain("source_session.visibility = 'user_private'");
    expect(migration).toContain("p_destination_visibility, 1");
    expect(migration).toContain("'workspaceSharedAcknowledged'");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION fork_session_content(");
    expect(migration).toContain("p_destination_visibility,\n    false,");
    expect(migration.match(/SET search_path = pg_catalog, %I, pg_temp/gu)).toHaveLength(4);
    expect(migration).toContain("provider_artifact_invalidated_at timestamptz");
    expect(migration).toContain("source_item.provider_artifact_invalidated_at");
    expect(migration).toContain("source_item.provider_artifact_invalidation_reason");
    expect(migration).toContain("source_item.provider_artifact_invalidated_by_attempt_id");
    expect(migration).toContain(
      "- 'provider' - 'connectionType' - 'credentialBindingId' - 'access'",
    );
    expect(migration).toContain("- 'githubInstallationId' - 'githubRepositoryId'");
    const appliedReceipt = migration.indexOf(
      "SELECT receipt.* INTO receipt_row FROM session_command_receipts receipt",
    );
    const sourceLock = migration.indexOf(
      "SELECT session.* INTO source_session FROM sessions session",
    );
    const newReceipt = migration.indexOf("INSERT INTO session_command_receipts");
    expect(appliedReceipt).toBeGreaterThan(0);
    expect(appliedReceipt).toBeLessThan(sourceLock);
    expect(newReceipt).toBeGreaterThan(sourceLock);
    expect(migration).not.toContain("transition_session_visibility(");
    expect(migration).not.toContain("source_session.variable_set_id");
    expect(migration).not.toContain("source_session.rig_id");
    expect(migration).not.toContain("source_session.active_sandbox_id");
    expect(migration).not.toContain("source_session.codex_pinned_credential_id");
    expect(migration).not.toContain("INSERT INTO session_turns");
    expect(migration).not.toContain("INSERT INTO session_goals");
    expect(migration).not.toContain("INSERT INTO organization_user_resource_grants");
    expect(migration).not.toContain("INSERT INTO session_pins");
  });

  test("installs both lifecycle capabilities and authority-change constraint", async () => {
    if (!shared) return;
    const functions = await shared.admin<Array<{ name: string; securityDefiner: boolean }>>`
      select routine_name as name, security_type = 'DEFINER' as "securityDefiner"
      from information_schema.routines
      where routine_schema = current_schema()
        and routine_name in ('transition_session_visibility', 'fork_session_content')
      order by routine_name
    `;
    expect(Array.from(functions)).toEqual([
      { name: "fork_session_content", securityDefiner: true },
      { name: "fork_session_content", securityDefiner: true },
      { name: "transition_session_visibility", securityDefiner: true },
    ]);
    const [constraint] = await shared.admin<Array<{ definition: string }>>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'session_attempt_interruptions'::regclass
        and conname = 'session_attempt_interruptions_kind_check'
    `;
    expect(constraint?.definition).toContain("authority_change");
  });

  test("keeps the unscoped quiescence helper private from the application role", async () => {
    if (!shared || !client) return;
    const value = await sessionVisibilityFixture();
    await shared.admin`
      update session_goals set status = 'active' where session_id = ${value.session.id}`;
    const app = postgres(shared.appUrl, { max: 1 });
    try {
      const [acl] = await app<{ executable: boolean }[]>`
        select has_function_privilege(
          current_user,
          'assert_session_tenancy_quiescent(uuid,uuid,uuid,boolean)',
          'EXECUTE'
        ) as executable`;
      expect(acl?.executable).toBe(false);
      let failure: unknown;
      try {
        await app`
          select assert_session_tenancy_quiescent(
            ${value.ownerGrant.accountId}::uuid,
            ${value.ownerGrant.workspaceId}::uuid,
            ${value.session.id}::uuid,
            true
          )`;
      } catch (error) {
        failure = error;
      }
      expect(nestedPostgresSqlState(failure)).toBe("42501");
      expect((failure as { detail?: string } | undefined)?.detail).not.toBe("active_goal");
    } finally {
      await app.end();
    }
  });

  test("adds restrictive visibility policies to every direct session reference", async () => {
    if (!shared) return;
    const missing = await shared.admin<Array<{ tableName: string }>>`
      select distinct relation.relname as "tableName"
      from pg_constraint constraint_row
      join pg_class relation on relation.oid = constraint_row.conrelid
      join pg_namespace relation_namespace on relation_namespace.oid = relation.relnamespace
      join pg_class referenced_relation on referenced_relation.oid = constraint_row.confrelid
      join lateral unnest(constraint_row.confkey) referenced_key(attnum) on true
      join pg_attribute referenced_attribute
        on referenced_attribute.attrelid = referenced_relation.oid
       and referenced_attribute.attnum = referenced_key.attnum
      where constraint_row.contype = 'f'
        and relation_namespace.nspname = current_schema()
        and referenced_relation.relname = 'sessions'
        and referenced_attribute.attname = 'id'
        and relation.relname <> 'sessions'
        and relation.relrowsecurity
        and not exists (
          select 1
          from pg_policy policy
          where policy.polrelid = relation.oid
            and policy.polname = 'session_visibility_isolation'
            and policy.polpermissive = false
        )
      order by relation.relname
    `;
    expect(Array.from(missing)).toEqual([]);
    const manualTables = [
      "connector_action_requests",
      "memory_slack_publications",
      "model_call_facts",
      "session_attempt_codemode_calls",
      "session_attempt_tool_catalogs",
      "session_human_input_requests",
      "usage_events",
    ];
    const manualPolicies = await shared.admin<Array<{ tableName: string }>>`
      select relation.relname as "tableName"
      from pg_policy policy
      join pg_class relation on relation.oid = policy.polrelid
      where policy.polname = 'session_visibility_isolation'
        and policy.polpermissive = false
        and relation.relname = any(${shared.admin.array(manualTables)})
      order by relation.relname
    `;
    expect(manualPolicies.map((row) => row.tableName)).toEqual([...manualTables].sort());
  });

  test("replays a same-workspace private fork before mutable source quiescence", async () => {
    if (!shared || !client) return;
    const value = await sessionVisibilityFixture();
    const operationKey = `fork:${crypto.randomUUID()}`;
    const forked = await forkSessionContent(client.db, {
      sourceWorkspaceId: value.ownerGrant.workspaceId,
      sourceSessionId: value.session.id,
      actorSubjectId: value.ownerSubjectId,
      destinationWorkspaceId: value.ownerGrant.workspaceId,
      destinationVisibility: "user_private",
      workspaceSharedAcknowledged: false,
      operationKey,
    });
    expect(forked).toMatchObject({
      workspaceId: value.ownerGrant.workspaceId,
      visibility: "user_private",
      authorityEpoch: 1,
      copiedHistoryItemCount: 1,
      replay: false,
    });

    const [destination] = await shared.admin<
      Array<{
        id: string;
        ownerId: string | null;
        ownerSubjectId: string | null;
        forkedFromSessionId: string | null;
        forkedFromAuthorityEpoch: number | null;
        forkedFromVisibility: string | null;
        historyCount: number;
        turnCount: number;
        goalCount: number;
        mcpServerCount: number;
        reasoningEffort: string;
        latencyMode: string;
      }>
    >`
      select
        destination.id,
        destination.owner_organization_membership_id as "ownerId",
        destination.owner_subject_id as "ownerSubjectId",
        destination.forked_from_session_id as "forkedFromSessionId",
        destination.forked_from_authority_epoch as "forkedFromAuthorityEpoch",
        destination.forked_from_visibility as "forkedFromVisibility",
        (select count(*)::int from session_history_items history
          where history.session_id = destination.id) as "historyCount",
        (select count(*)::int from session_turns turn_row
          where turn_row.session_id = destination.id) as "turnCount",
        (select count(*)::int from session_goals goal
          where goal.session_id = destination.id) as "goalCount",
        (select count(*)::int from session_mcp_servers server
          where server.session_id = destination.id) as "mcpServerCount",
        destination.reasoning_effort as "reasoningEffort",
        destination.latency_mode as "latencyMode"
      from sessions destination
      where destination.id = ${forked.sessionId}
    `;
    expect(destination).toEqual({
      id: forked.sessionId,
      ownerId: value.ownerMembershipId,
      ownerSubjectId: value.ownerSubjectId,
      forkedFromSessionId: value.session.id,
      forkedFromAuthorityEpoch: 1,
      forkedFromVisibility: "workspace_shared",
      historyCount: 1,
      turnCount: 0,
      goalCount: 0,
      mcpServerCount: 0,
      reasoningEffort: "medium",
      latencyMode: "standard",
    });

    // New work may legitimately begin after the committed fork. The exact
    // operation retry must still return its durable result rather than inspect
    // the source again.
    await shared.admin`
      update session_goals set status = 'active' where session_id = ${value.session.id}`;

    const replay = await forkSessionContent(client.db, {
      sourceWorkspaceId: value.ownerGrant.workspaceId,
      sourceSessionId: value.session.id,
      actorSubjectId: value.ownerSubjectId,
      destinationWorkspaceId: value.ownerGrant.workspaceId,
      destinationVisibility: "user_private",
      workspaceSharedAcknowledged: false,
      operationKey,
    });
    expect(replay).toEqual({ ...forked, replay: true });

    // Reusing the same key with a different canonical request remains a typed
    // database conflict even while the source is no longer quiescent.
    const app = postgres(shared.appUrl, { max: 1 });
    try {
      await expectSqlState(
        () =>
          app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${value.ownerGrant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${value.ownerGrant.workspaceId}, true)`;
            await sql`select set_config('opengeni.subject_id', ${value.ownerSubjectId}, true)`;
            await sql`
              select * from fork_session_content(
                ${value.ownerGrant.accountId}::uuid,
                ${value.ownerGrant.workspaceId}::uuid,
                ${value.session.id}::uuid,
                ${value.ownerSubjectId},
                ${value.ownerGrant.workspaceId}::uuid,
                'user_private',
                ${operationKey},
                ${"f".repeat(64)},
                1
              )`;
          }),
        "23505",
      );
    } finally {
      await app.end();
    }
  });

  test("atomically forks shared destinations with acknowledgement, fresh authority, and no live state", async () => {
    if (!shared || !client) return;

    const sharedSource = await sessionVisibilityFixture();
    const invalidatedAt = new Date("2026-08-24T00:00:00.000Z");
    const invalidatedByAttemptId = crypto.randomUUID();
    await shared.admin`
      insert into session_history_items (
        account_id, workspace_id, session_id, position, item,
        provider_artifact_invalidated_at, provider_artifact_invalidation_reason,
        provider_artifact_invalidated_by_attempt_id
      ) values
        (
          ${sharedSource.ownerGrant.accountId}, ${sharedSource.ownerGrant.workspaceId},
          ${sharedSource.session.id}, 2,
          ${shared.admin.json({
            type: "reasoning",
            encrypted_content: "rejected-reasoning-ciphertext",
          })},
          ${invalidatedAt}, 'encrypted_content_rejected', ${invalidatedByAttemptId}
        ),
        (
          ${sharedSource.ownerGrant.accountId}, ${sharedSource.ownerGrant.workspaceId},
          ${sharedSource.session.id}, 3,
          ${shared.admin.json({
            type: "compaction",
            encrypted_content: "rejected-compaction-ciphertext",
          })},
          ${invalidatedAt}, 'encrypted_content_rejected', ${invalidatedByAttemptId}
        )`;
    await shared.admin`
      insert into session_pins (account_id, workspace_id, subject_id, session_id)
      values (
        ${sharedSource.ownerGrant.accountId}, ${sharedSource.ownerGrant.workspaceId},
        ${sharedSource.ownerSubjectId}, ${sharedSource.session.id}
      )`;

    const sharedFork = await forkSessionContent(client.db, {
      sourceWorkspaceId: sharedSource.ownerGrant.workspaceId,
      sourceSessionId: sharedSource.session.id,
      actorSubjectId: sharedSource.ownerSubjectId,
      destinationWorkspaceId: sharedSource.ownerGrant.workspaceId,
      destinationVisibility: "workspace_shared",
      workspaceSharedAcknowledged: false,
      operationKey: `shared-fork:${crypto.randomUUID()}`,
    });
    expect(sharedFork).toMatchObject({
      visibility: "workspace_shared",
      authorityEpoch: 1,
      copiedHistoryItemCount: 3,
      replay: false,
    });

    const copiedInvalidations = await shared.admin<
      Array<{
        position: number;
        type: string;
        encryptedContent: string;
        invalidatedAt: Date;
        invalidationReason: string;
        invalidatedByAttemptId: string;
      }>
    >`
      select position::float8 as position,
        item ->> 'type' as type,
        item ->> 'encrypted_content' as "encryptedContent",
        provider_artifact_invalidated_at as "invalidatedAt",
        provider_artifact_invalidation_reason as "invalidationReason",
        provider_artifact_invalidated_by_attempt_id as "invalidatedByAttemptId"
      from session_history_items
      where session_id = ${sharedFork.sessionId}
        and provider_artifact_invalidated_at is not null
      order by position`;
    expect(Array.from(copiedInvalidations)).toEqual([
      {
        position: 2,
        type: "reasoning",
        encryptedContent: "rejected-reasoning-ciphertext",
        invalidatedAt,
        invalidationReason: "encrypted_content_rejected",
        invalidatedByAttemptId,
      },
      {
        position: 3,
        type: "compaction",
        encryptedContent: "rejected-compaction-ciphertext",
        invalidatedAt,
        invalidationReason: "encrypted_content_rejected",
        invalidatedByAttemptId,
      },
    ]);

    const [sharedDestination] = await shared.admin<
      Array<{
        rootSessionId: string;
        sandboxGroupId: string;
        ownerId: string;
        ownerSubjectId: string;
        authorityEpoch: number;
        resources: Array<Record<string, unknown>>;
        liveStateCount: number;
        variableSetId: string | null;
        rigId: string | null;
        rigVersionId: string | null;
        codexPinnedCredentialId: string | null;
        firstPartyMcpPermissions: unknown;
        initialPersonalConnectionDelegations: unknown[];
      }>
    >`
      select destination.root_session_id as "rootSessionId",
        destination.sandbox_group_id as "sandboxGroupId",
        destination.owner_organization_membership_id as "ownerId",
        destination.owner_subject_id as "ownerSubjectId",
        destination.authority_epoch as "authorityEpoch",
        destination.resources,
        destination.variable_set_id as "variableSetId",
        destination.rig_id as "rigId",
        destination.rig_version_id as "rigVersionId",
        destination.codex_pinned_credential_id as "codexPinnedCredentialId",
        destination.first_party_mcp_permissions as "firstPartyMcpPermissions",
        destination.initial_personal_connection_delegations as "initialPersonalConnectionDelegations",
        (
          (select count(*) from session_turns row where row.session_id = destination.id) +
          (select count(*) from session_goals row where row.session_id = destination.id) +
          (select count(*) from session_mcp_servers row where row.session_id = destination.id) +
          (select count(*) from organization_user_resource_grants row
            where row.session_id = destination.id) +
          (select count(*) from session_pins row where row.session_id = destination.id) +
          (select count(*) from sandbox_retained_processes row
            where row.session_id = destination.id)
        )::int as "liveStateCount"
      from sessions destination where destination.id = ${sharedFork.sessionId}
    `;
    expect(sharedDestination).toMatchObject({
      rootSessionId: sharedFork.sessionId,
      sandboxGroupId: sharedFork.sessionId,
      ownerId: sharedSource.ownerMembershipId,
      ownerSubjectId: sharedSource.ownerSubjectId,
      authorityEpoch: 1,
      liveStateCount: 0,
      variableSetId: null,
      rigId: null,
      rigVersionId: null,
      codexPinnedCredentialId: null,
      firstPartyMcpPermissions: null,
      initialPersonalConnectionDelegations: [],
    });
    expect(sharedDestination?.resources).toEqual([
      {
        kind: "repository",
        uri: "https://example.test/durable-resource.git",
        ref: "main",
      },
      {
        kind: "repository",
        uri: "https://github.com/example/private-personal-resource.git",
        ref: "main",
      },
    ]);
    const forkedResources = sharedDestination!.resources as ResourceRef[];
    expect(personalGitHubRepositoryResources(forkedResources)).toEqual([]);
    await expect(
      validateGitHubRepositorySelection(
        client.db,
        sharedSource.ownerGrant.workspaceId,
        forkedResources,
      ),
    ).resolves.toBeUndefined();

    const privateSource = await sessionVisibilityFixture();
    await transitionSessionVisibility(client.db, {
      workspaceId: privateSource.ownerGrant.workspaceId,
      sessionId: privateSource.session.id,
      actorSubjectId: privateSource.ownerSubjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `make-private:${crypto.randomUUID()}`,
    });
    const privateToSharedKey = `private-to-shared:${crypto.randomUUID()}`;
    await expect(
      forkSessionContent(client.db, {
        sourceWorkspaceId: privateSource.ownerGrant.workspaceId,
        sourceSessionId: privateSource.session.id,
        actorSubjectId: privateSource.ownerSubjectId,
        destinationWorkspaceId: privateSource.ownerGrant.workspaceId,
        destinationVisibility: "workspace_shared",
        workspaceSharedAcknowledged: false,
        operationKey: privateToSharedKey,
      }),
    ).rejects.toBeInstanceOf(SessionTenancyInvalidRequestError);

    const privateToShared = await forkSessionContent(client.db, {
      sourceWorkspaceId: privateSource.ownerGrant.workspaceId,
      sourceSessionId: privateSource.session.id,
      actorSubjectId: privateSource.ownerSubjectId,
      destinationWorkspaceId: privateSource.ownerGrant.workspaceId,
      destinationVisibility: "workspace_shared",
      workspaceSharedAcknowledged: true,
      operationKey: privateToSharedKey,
    });
    expect(privateToShared).toMatchObject({ visibility: "workspace_shared", replay: false });
    await expect(
      forkSessionContent(client.db, {
        sourceWorkspaceId: privateSource.ownerGrant.workspaceId,
        sourceSessionId: privateSource.session.id,
        actorSubjectId: privateSource.ownerSubjectId,
        destinationWorkspaceId: privateSource.ownerGrant.workspaceId,
        destinationVisibility: "workspace_shared",
        workspaceSharedAcknowledged: false,
        operationKey: privateToSharedKey,
      }),
    ).rejects.toBeInstanceOf(SessionTenancyConflictError);
    expect(
      await forkSessionContent(client.db, {
        sourceWorkspaceId: privateSource.ownerGrant.workspaceId,
        sourceSessionId: privateSource.session.id,
        actorSubjectId: privateSource.ownerSubjectId,
        destinationWorkspaceId: privateSource.ownerGrant.workspaceId,
        destinationVisibility: "workspace_shared",
        workspaceSharedAcknowledged: true,
        operationKey: privateToSharedKey,
      }),
    ).toEqual({ ...privateToShared, replay: true });
  }, 180_000);

  test("lets a workspace member fork a shared source into fresh private authority", async () => {
    if (!shared || !client) return;
    const value = await sessionVisibilityFixture();
    const memberForkOperationKey = `member-private-fork:${crypto.randomUUID()}`;

    const memberFork = await forkSessionContent(client.db, {
      sourceWorkspaceId: value.ownerGrant.workspaceId,
      sourceSessionId: value.session.id,
      actorSubjectId: value.otherSubjectId,
      destinationWorkspaceId: value.ownerGrant.workspaceId,
      destinationVisibility: "user_private",
      workspaceSharedAcknowledged: false,
      operationKey: memberForkOperationKey,
    });
    expect(memberFork).toMatchObject({
      visibility: "user_private",
      authorityEpoch: 1,
      copiedHistoryItemCount: 1,
      replay: false,
    });

    const [destination] = await shared.admin<
      Array<{ ownerId: string; ownerSubjectId: string; sourceSessionId: string }>
    >`
      select owner_organization_membership_id as "ownerId",
        owner_subject_id as "ownerSubjectId",
        forked_from_session_id as "sourceSessionId"
      from sessions where id = ${memberFork.sessionId}`;
    expect(destination).toEqual({
      ownerId: value.otherMembershipId,
      ownerSubjectId: value.otherSubjectId,
      sourceSessionId: value.session.id,
    });

    // The source owner can later make the shared source private. The member
    // then loses the source but keeps the independent private destination they
    // own, proving that source authority was not retained by the fork.
    await transitionSessionVisibility(client.db, {
      workspaceId: value.ownerGrant.workspaceId,
      sessionId: value.session.id,
      actorSubjectId: value.ownerSubjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `source-private-after-member-fork:${crypto.randomUUID()}`,
    });
    expect(
      await getSessionForSubject(
        client.db,
        value.ownerGrant.workspaceId,
        value.session.id,
        value.otherSubjectId,
      ),
    ).toBeNull();
    expect(
      await getSessionForSubject(
        client.db,
        value.ownerGrant.workspaceId,
        memberFork.sessionId,
        value.otherSubjectId,
      ),
    ).toMatchObject({
      id: memberFork.sessionId,
      tenancy: { visibility: "private", ownedByCurrentUser: true },
    });

    expect(
      await forkSessionContent(client.db, {
        sourceWorkspaceId: value.ownerGrant.workspaceId,
        sourceSessionId: value.session.id,
        actorSubjectId: value.otherSubjectId,
        destinationWorkspaceId: value.ownerGrant.workspaceId,
        destinationVisibility: "user_private",
        workspaceSharedAcknowledged: false,
        operationKey: memberForkOperationKey,
      }),
    ).toEqual({ ...memberFork, replay: true });

    await expect(
      forkSessionContent(client.db, {
        sourceWorkspaceId: value.ownerGrant.workspaceId,
        sourceSessionId: value.session.id,
        actorSubjectId: value.otherSubjectId,
        destinationWorkspaceId: value.ownerGrant.workspaceId,
        destinationVisibility: "workspace_shared",
        workspaceSharedAcknowledged: true,
        operationKey: memberForkOperationKey,
      }),
    ).rejects.toBeInstanceOf(SessionTenancyConflictError);

    await expect(
      forkSessionContent(client.db, {
        sourceWorkspaceId: value.ownerGrant.workspaceId,
        sourceSessionId: value.session.id,
        actorSubjectId: value.otherSubjectId,
        destinationWorkspaceId: value.ownerGrant.workspaceId,
        destinationVisibility: "user_private",
        workspaceSharedAcknowledged: false,
        operationKey: `member-cannot-fork-private-source:${crypto.randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(SessionTenancyAccessError);
  }, 180_000);

  test("refuses a private fork destination when the organization has not enabled private sessions", async () => {
    if (!shared || !client) return;
    const value = await sessionVisibilityFixture();

    // Migration 0323 makes private sessions in a SHARED workspace an explicit
    // owner/admin product decision. A fork lands in the source workspace, so it
    // is the same decision, and it must fail closed exactly as a private create
    // does rather than becoming a way around the setting.
    await shared.admin`
      update organization_private_session_settings
      set enabled = false, version = version + 1, updated_at = now()
      where account_id = ${value.ownerGrant.accountId}`;

    await expect(
      forkSessionContent(client.db, {
        sourceWorkspaceId: value.ownerGrant.workspaceId,
        sourceSessionId: value.session.id,
        actorSubjectId: value.otherSubjectId,
        destinationWorkspaceId: value.ownerGrant.workspaceId,
        destinationVisibility: "user_private",
        workspaceSharedAcknowledged: false,
        operationKey: `disabled-private-fork:${crypto.randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(SessionTenancyNotActivatedError);

    // The decision is about the private destination only: a shared fork of the
    // same source still succeeds.
    const sharedFork = await forkSessionContent(client.db, {
      sourceWorkspaceId: value.ownerGrant.workspaceId,
      sourceSessionId: value.session.id,
      actorSubjectId: value.otherSubjectId,
      destinationWorkspaceId: value.ownerGrant.workspaceId,
      destinationVisibility: "workspace_shared",
      workspaceSharedAcknowledged: false,
      operationKey: `disabled-shared-fork:${crypto.randomUUID()}`,
    });
    expect(sharedFork).toMatchObject({ visibility: "workspace_shared", replay: false });

    // A fork that already committed while the setting was on still replays
    // byte-identically after it is turned off. The gate sits after keyed replay
    // resolution precisely so a lost response stays recoverable.
    await shared.admin`
      update organization_private_session_settings
      set enabled = true, version = version + 1, updated_at = now()
      where account_id = ${value.ownerGrant.accountId}`;
    const committedKey = `enabled-then-disabled-private-fork:${crypto.randomUUID()}`;
    const committed = await forkSessionContent(client.db, {
      sourceWorkspaceId: value.ownerGrant.workspaceId,
      sourceSessionId: value.session.id,
      actorSubjectId: value.otherSubjectId,
      destinationWorkspaceId: value.ownerGrant.workspaceId,
      destinationVisibility: "user_private",
      workspaceSharedAcknowledged: false,
      operationKey: committedKey,
    });
    expect(committed).toMatchObject({ visibility: "user_private", replay: false });
    await shared.admin`
      update organization_private_session_settings
      set enabled = false, version = version + 1, updated_at = now()
      where account_id = ${value.ownerGrant.accountId}`;
    expect(
      await forkSessionContent(client.db, {
        sourceWorkspaceId: value.ownerGrant.workspaceId,
        sourceSessionId: value.session.id,
        actorSubjectId: value.otherSubjectId,
        destinationWorkspaceId: value.ownerGrant.workspaceId,
        destinationVisibility: "user_private",
        workspaceSharedAcknowledged: false,
        operationKey: committedKey,
      }),
    ).toEqual({ ...committed, replay: true });
  }, 180_000);

  test("blocks transition to private while an interaction holder retains sandbox access", async () => {
    if (!shared || !client) return;
    const value = await sessionVisibilityFixture();
    const [sessionRow] = await shared.admin<{ sandboxGroupId: string }[]>`
      select sandbox_group_id as "sandboxGroupId" from sessions where id = ${value.session.id}`;
    const [lease] = await shared.admin<{ id: string }[]>`
      insert into sandbox_leases (
        account_id, workspace_id, sandbox_group_id, liveness, refcount,
        viewer_holders, backend, expires_at
      ) values (
        ${value.ownerGrant.accountId}, ${value.ownerGrant.workspaceId},
        ${sessionRow!.sandboxGroupId}, 'warm', 1, 1, 'modal', now() + interval '10 minutes'
      ) returning id`;
    const holderId = `browser-session:${crypto.randomUUID()}`;
    await shared.admin`
      insert into sandbox_lease_holders (
        account_id, workspace_id, lease_id, kind, holder_id, subject_id
      ) values (
        ${value.ownerGrant.accountId}, ${value.ownerGrant.workspaceId}, ${lease!.id},
        'interaction', ${holderId}, ${value.session.id}
      )`;

    await expect(
      transitionSessionVisibility(client.db, {
        workspaceId: value.ownerGrant.workspaceId,
        sessionId: value.session.id,
        actorSubjectId: value.ownerSubjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `interaction-blocked:${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      name: "SessionTenancyConflictError",
      reason: "not_quiescent",
      blocker: "active_sandbox_access",
    });
    const [unchanged] = await shared.admin<{ visibility: string; epoch: number }[]>`
      select visibility, authority_epoch as epoch from sessions where id = ${value.session.id}`;
    expect(unchanged).toEqual({ visibility: "workspace_shared", epoch: 1 });

    await shared.admin`delete from sandbox_lease_holders where lease_id = ${lease!.id}`;
    await expect(
      transitionSessionVisibility(client.db, {
        workspaceId: value.ownerGrant.workspaceId,
        sessionId: value.session.id,
        actorSubjectId: value.ownerSubjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `interaction-released:${crypto.randomUUID()}`,
      }),
    ).resolves.toMatchObject({ visibility: "user_private", authorityEpoch: 2 });
  });

  test("denies a same-workspace non-owner across session content and resource tables", async () => {
    if (!shared || !client) return;
    const value = await sessionVisibilityFixture();
    const transition = await transitionSessionVisibility(client.db, {
      workspaceId: value.ownerGrant.workspaceId,
      sessionId: value.session.id,
      actorSubjectId: value.ownerSubjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `private:${crypto.randomUUID()}`,
    });
    expect(transition).toMatchObject({
      visibility: "user_private",
      authorityEpoch: 2,
      changed: true,
      replay: false,
      revokedGrantCount: 1,
    });
    const [revokedGrant] = await shared.admin<Array<{ status: string; generation: number }>>`
      select status, generation::int as generation
      from organization_user_resource_grants where id = ${value.grantId}`;
    expect(revokedGrant).toEqual({ status: "revoked", generation: 2 });

    const ownerProjection = await withSessionRlsActorContext(
      { subjectId: value.ownerSubjectId },
      async () => ({
        session: await getSession(client!.db, value.ownerGrant.workspaceId, value.session.id),
        events: await listSessionEvents(client!.db, value.ownerGrant.workspaceId, value.session.id),
        history: await getSessionHistoryItems(
          client!.db,
          value.ownerGrant.workspaceId,
          value.session.id,
        ),
        turns: await listSessionTurns(client!.db, value.ownerGrant.workspaceId, value.session.id),
        goal: await getSessionGoal(client!.db, value.ownerGrant.workspaceId, value.session.id),
      }),
    );
    expect(ownerProjection.session?.id).toBe(value.session.id);
    expect(
      ownerProjection.events.some((event) => event.type === "session.visibility.changed"),
    ).toBe(true);
    expect(ownerProjection.history).toHaveLength(1);
    expect(ownerProjection.turns).toHaveLength(1);
    expect(ownerProjection.goal?.text).toBe("private goal");
    const ownerGoalRevisions = await withSessionRlsActorContext(
      { subjectId: value.ownerSubjectId },
      () => listSessionGoalRevisions(client!.db, value.ownerGrant.workspaceId, value.session.id),
    );
    expect(ownerGoalRevisions).toHaveLength(1);
    expect(ownerGoalRevisions[0]).toMatchObject({
      sessionId: value.session.id,
      disposition: "applied",
      text: "private goal",
    });

    const nonOwnerProjection = await withSessionRlsActorContext(
      { subjectId: value.otherSubjectId },
      async () => ({
        session: await getSession(client!.db, value.ownerGrant.workspaceId, value.session.id),
        events: await listSessionEvents(client!.db, value.ownerGrant.workspaceId, value.session.id),
        history: await getSessionHistoryItems(
          client!.db,
          value.ownerGrant.workspaceId,
          value.session.id,
        ),
        turns: await listSessionTurns(client!.db, value.ownerGrant.workspaceId, value.session.id),
        goal: await getSessionGoal(client!.db, value.ownerGrant.workspaceId, value.session.id),
      }),
    );
    expect(nonOwnerProjection).toEqual({
      session: null,
      events: [],
      history: [],
      turns: [],
      goal: null,
    });

    const app = postgres(shared.appUrl, { max: 2 });
    try {
      const [counts] = await app.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${value.ownerGrant.accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${value.ownerGrant.workspaceId}, true)`;
        await sql`select set_config('opengeni.subject_id', ${value.otherSubjectId}, true)`;
        return await sql<
          {
            sessions: number;
            events: number;
            history: number;
            turns: number;
            goals: number;
            goalRevisions: number;
            mcpServers: number;
          }[]
        >`
          select
            (select count(*)::int from sessions where id = ${value.session.id}) as sessions,
            (select count(*)::int from session_events where session_id = ${value.session.id}) as events,
            (select count(*)::int from session_history_items where session_id = ${value.session.id}) as history,
            (select count(*)::int from session_turns where session_id = ${value.session.id}) as turns,
            (select count(*)::int from session_goals where session_id = ${value.session.id}) as goals,
            (select count(*)::int from session_goal_revisions where session_id = ${value.session.id}) as "goalRevisions",
            (select count(*)::int from session_mcp_servers where session_id = ${value.session.id}) as "mcpServers"
        `;
      });
      expect(counts).toEqual({
        sessions: 0,
        events: 0,
        history: 0,
        turns: 0,
        goals: 0,
        goalRevisions: 0,
        mcpServers: 0,
      });
    } finally {
      await app.end();
    }

    await transitionSessionVisibility(client.db, {
      workspaceId: value.ownerGrant.workspaceId,
      sessionId: value.session.id,
      actorSubjectId: value.ownerSubjectId,
      targetVisibility: "workspace_shared",
      expectedAuthorityEpoch: 2,
      operationKey: `reshare:${crypto.randomUUID()}`,
    });
    const sharedGoalRevisions = await withSessionRlsActorContext(
      { subjectId: value.otherSubjectId },
      () => listSessionGoalRevisions(client!.db, value.ownerGrant.workspaceId, value.session.id),
    );
    expect(sharedGoalRevisions).toHaveLength(1);
    expect(sharedGoalRevisions[0]?.sessionId).toBe(value.session.id);
  });

  test("returns a typed conflict instead of cancelling a nonquiescent source", async () => {
    if (!shared || !client) return;
    const value = await sessionVisibilityFixture();
    await shared.admin`
      update session_goals set status = 'active' where session_id = ${value.session.id}`;
    const operationKey = `blocked:${crypto.randomUUID()}`;
    await expect(
      transitionSessionVisibility(client.db, {
        workspaceId: value.ownerGrant.workspaceId,
        sessionId: value.session.id,
        actorSubjectId: value.ownerSubjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey,
      }),
    ).rejects.toMatchObject({
      name: "SessionTenancyConflictError",
      reason: "not_quiescent",
      blocker: "active_goal",
    });
    const [unchanged] = await shared.admin<
      Array<{ visibility: string; epoch: number; goalStatus: string }>
    >`
      select session_row.visibility, session_row.authority_epoch as epoch,
        goal.status as "goalStatus"
      from sessions session_row
      join session_goals goal on goal.session_id = session_row.id
      where session_row.id = ${value.session.id}`;
    expect(unchanged).toEqual({
      visibility: "workspace_shared",
      epoch: 1,
      goalStatus: "active",
    });
    await shared.admin`
      update session_goals set status = 'completed' where session_id = ${value.session.id}`;
    expect(
      await transitionSessionVisibility(client.db, {
        workspaceId: value.ownerGrant.workspaceId,
        sessionId: value.session.id,
        actorSubjectId: value.ownerSubjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey,
      }),
    ).toMatchObject({ changed: true, authorityEpoch: 2 });
  });

  test("denies a suspended owner and rejects direct authority writes", async () => {
    if (!shared || !client) return;
    const value = await sessionVisibilityFixture();
    await transitionSessionVisibility(client.db, {
      workspaceId: value.ownerGrant.workspaceId,
      sessionId: value.session.id,
      actorSubjectId: value.ownerSubjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `suspend:${crypto.randomUUID()}`,
    });
    await expectSqlState(
      () =>
        withSessionRlsActorContext({ subjectId: value.ownerSubjectId }, () =>
          withWorkspaceRls(client!.db, value.ownerGrant.workspaceId, async (db) => {
            await db.execute(
              drizzleSql`update sessions set visibility = 'workspace_shared' where id = ${value.session.id}`,
            );
          }),
        ),
      "42501",
    );
    await expectSqlState(
      () =>
        withSessionRlsActorContext({ subjectId: value.otherSubjectId }, () =>
          withWorkspaceRls(client!.db, value.ownerGrant.workspaceId, async (db) => {
            await db.execute(drizzleSql`
              insert into sessions (
                id, account_id, workspace_id, status, owner_organization_membership_id,
                owner_subject_id, created_by_kind, created_by_subject_id,
                resources, tools, metadata
              ) values (
                ${crypto.randomUUID()}, ${value.ownerGrant.accountId},
                ${value.ownerGrant.workspaceId}, 'pending', ${value.otherMembershipId},
                ${value.otherSubjectId}, 'service', 'service:forged-owner',
                '[]'::jsonb, '[]'::jsonb, '{}'::jsonb
              )
            `);
          }),
        ),
      "42501",
    );
    await shared.admin`
      update organization_memberships
      set status = 'suspended', revoked_at = null
      where account_id = ${value.ownerGrant.accountId}
        and subject_id = ${value.ownerSubjectId}
    `;
    const suspended = await withSessionRlsActorContext({ subjectId: value.ownerSubjectId }, () =>
      getSession(client!.db, value.ownerGrant.workspaceId, value.session.id),
    );
    expect(suspended).toBeNull();
  });

  test("prevents null-owner appropriation and serializes two-member transition races", async () => {
    if (!shared || !client) return;
    const value = await sessionVisibilityFixture();
    const legacy = await createSession(client.db, {
      accountId: value.ownerGrant.accountId,
      workspaceId: value.ownerGrant.workspaceId,
      initialMessage: "legacy shared session",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "modal",
      createdBy: { kind: "service", subjectId: "service:legacy" },
      createdByContext: {},
    });
    const legacyResults = await Promise.allSettled([
      transitionSessionVisibility(client.db, {
        workspaceId: value.ownerGrant.workspaceId,
        sessionId: legacy.id,
        actorSubjectId: value.ownerSubjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `legacy-owner:${crypto.randomUUID()}`,
      }),
      transitionSessionVisibility(client.db, {
        workspaceId: value.ownerGrant.workspaceId,
        sessionId: legacy.id,
        actorSubjectId: value.otherSubjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `legacy-other:${crypto.randomUUID()}`,
      }),
    ]);
    expect(legacyResults.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of legacyResults) {
      if (result.status === "rejected") expect(nestedPostgresSqlState(result.reason)).toBe("42501");
    }
    const [legacyRow] = await shared.admin<
      Array<{ visibility: string; ownerId: string | null; epoch: number }>
    >`
      select visibility, owner_organization_membership_id as "ownerId", authority_epoch as epoch
      from sessions where id = ${legacy.id}
    `;
    expect(legacyRow).toEqual({
      visibility: "workspace_shared",
      ownerId: null,
      epoch: 1,
    });

    const ownedRace = await Promise.allSettled([
      transitionSessionVisibility(client.db, {
        workspaceId: value.ownerGrant.workspaceId,
        sessionId: value.session.id,
        actorSubjectId: value.ownerSubjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `race-owner:${crypto.randomUUID()}`,
      }),
      transitionSessionVisibility(client.db, {
        workspaceId: value.ownerGrant.workspaceId,
        sessionId: value.session.id,
        actorSubjectId: value.otherSubjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `race-other:${crypto.randomUUID()}`,
      }),
    ]);
    expect(ownedRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(ownedRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = ownedRace.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") {
      expect(nestedPostgresSqlState(rejected.reason)).toBe("42501");
    }
  });
});
