import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getSession,
  getSessionGoal,
  getSessionHistoryItems,
  listSessionEvents,
  listSessionTurns,
  nestedPostgresSqlState,
  transitionSessionVisibility,
  withSessionRlsActorContext,
  withWorkspaceRls,
  type DbClient,
} from "../src";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0225_session_visibility_fork_activation.sql",
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
  const otherSubjectId = `user:session-other-${suffix}`;
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
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "modal",
    createdBy: { kind: "subject", subjectId: ownerSubjectId },
    createdByContext: {},
  });
  const eventId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
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
      insert into session_goals (account_id, workspace_id, session_id, text)
      values (
        ${ownerGrant.accountId}, ${ownerGrant.workspaceId}, ${session.id}, 'private goal'
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
  });
  return {
    ownerGrant,
    ownerSubjectId,
    otherSubjectId,
    otherMembershipId: otherMembership!.id,
    session,
  };
}

describe("migration 0225 session visibility and fork activation", () => {
  test("installs one bounded server-authoritative transition capability", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const transition = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION %1$I.transition_session_visibility"),
      migration.indexOf("DO $session_fork_activation$"),
    );
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION %1$I.transition_session_visibility");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("opengeni_private.current_account_id()");
    expect(migration).toContain("opengeni_private.current_workspace_id()");
    expect(migration).toContain("opengeni_private.current_subject_id()");
    expect(migration).toContain("membership.status = 'active'");
    expect(migration).toContain(
      "session_row.owner_organization_membership_id <> actor_membership.id",
    );
    expect(migration).toContain("session_row.authority_epoch <> p_expected_authority_epoch");
    expect(migration).toContain("authority_epoch = new_epoch");
    expect(migration).toContain("'authority_change'");
    expect(migration).toContain("cancel_reason = 'authority_changed'");
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
      migration.indexOf("CREATE OR REPLACE FUNCTION %1$I.transition_session_visibility"),
      migration.indexOf("DO $session_fork_activation$"),
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
    expect(migration).toContain("CREATE OR REPLACE FUNCTION %1$I.fork_session_content");
    expect(migration).toContain("session fork destination workspace access is unavailable");
    expect(migration).toContain("session fork source session is private");
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
    expect(migration).toContain("p_destination_visibility, 1");
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
    });

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
            mcpServers: number;
          }[]
        >`
          select
            (select count(*)::int from sessions where id = ${value.session.id}) as sessions,
            (select count(*)::int from session_events where session_id = ${value.session.id}) as events,
            (select count(*)::int from session_history_items where session_id = ${value.session.id}) as history,
            (select count(*)::int from session_turns where session_id = ${value.session.id}) as turns,
            (select count(*)::int from session_goals where session_id = ${value.session.id}) as goals,
            (select count(*)::int from session_mcp_servers where session_id = ${value.session.id}) as "mcpServers"
        `;
      });
      expect(counts).toEqual({
        sessions: 0,
        events: 0,
        history: 0,
        turns: 0,
        goals: 0,
        mcpServers: 0,
      });
    } finally {
      await app.end();
    }
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
    expect(legacyRow).toEqual({ visibility: "workspace_shared", ownerId: null, epoch: 1 });

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
