import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  acceptOrganizationInvitation,
  claimOrganizationRetentionDeletion,
  createConnection,
  createSession,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUser,
  ensureManagedAccessForUserWithOrganizationMemberships,
  failOrganizationRetentionDeletion,
  finalizeOrganizationRetentionDeletion,
  getSelfOrganizationInvitation,
  listOrganizationMembers,
  listOrganizationRetentionDeletionObjects,
  listOrganizationInvitations,
  listSelfOrganizationInvitations,
  listSelfOrganizationMemberships,
  nestedPostgresSqlState,
  provisionRoles,
  recordOrganizationRetentionObjectDeleted,
  revokeOrganizationInvitation,
  transitionSessionVisibility,
  updateOrganizationMember,
  updateOrganizationRetentionPolicy,
  runMigrations,
  type DbClient,
} from "../src";
import { rawRows, setSubjectRlsContext, withRlsContext } from "../src/database";

const migrationUrl = new URL(
  "../drizzle/0263_organization_membership_lifecycle.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0263-organization-membership-lifecycle");
  if (!shared && requireRealDatabase) {
    throw new Error("migration 0263 requires PostgreSQL");
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

async function provisionSelf(userId: string) {
  if (!client) throw new Error("test database unavailable");
  return await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: userId,
  });
}

describe("migration 0263 organization membership lifecycle", () => {
  test("declares a closed lifecycle capability and immutable FORCE-RLS evidence", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(6);
    expect(migration.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(6);
    expect(migration).toContain("organization_membership_command(p_command jsonb)");
    expect(migration).toContain("invitation.target_subject_id IS DISTINCT FROM actor_subject");
    expect(migration).toContain("organization operation id was reused with different input");
    expect(migration).toContain("cannot remove the last active organization owner");
    expect(migration).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(migration).toContain("organization_membership_operation_receipts_immutable");
    expect(migration).toContain("organization_membership_lifecycle_events_immutable");
    expect(migration).toContain("REVOKE ALL ON TABLE organization_memberships FROM opengeni_app");
    expect(migration).toContain("DELETE FROM workspaces");
    expect(migration).not.toContain("DELETE FROM sessions");
    const offboard = migration.slice(
      migration.indexOf("ELSIF action_name IN ('suspend', 'offboard')"),
    );
    const lockOrder = [
      "FROM workspace_inference_controls control",
      "PERFORM 1 FROM workspaces workspace",
      "FROM sessions affected",
      "FROM session_turns turn_row",
      "FROM session_turn_attempts attempt",
    ].map((needle) => offboard.indexOf(needle));
    expect(lockOrder.every((position) => position >= 0)).toBe(true);
    expect(lockOrder).toEqual([...lockOrder].sort((left, right) => left - right));
  });

  test("fresh custom-schema migrate and provision pins definers against TEMP shadows", async () => {
    const blank = await acquireBlankTestDatabase("migration-0263-custom-schema");
    if (!blank) return;
    const schemaName = `membership_lifecycle_${crypto.randomUUID().replaceAll("-", "")}`;
    const roleName = `membership_app_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const password = `pw-${crypto.randomUUID()}`;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    let appSql: postgres.Sql | null = null;
    try {
      await runMigrations(blank.databaseUrl, schemaName);
      await provisionRoles(blank.databaseUrl, {
        targetSchema: schemaName,
        rlsStrategy: "force",
        appRole: roleName,
        appPassword: password,
      });
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = roleName;
      appUrl.password = password;
      appSql = postgres(appUrl.toString(), {
        max: 1,
        connection: { search_path: `${schemaName},opengeni_private,public` },
      });

      const [posture] = await admin<
        Array<{
          execute: boolean;
          executeRetention: boolean;
          directInsert: boolean;
          directRetentionInsert: boolean;
          searchPath: string | null;
          retentionSearchPath: string | null;
        }>
      >`
        select
          has_function_privilege(
            ${roleName}::text,
            format('%I.organization_membership_command(jsonb)', ${schemaName}::text),
            'EXECUTE'
          ) as execute,
          has_function_privilege(
            ${roleName}::text,
            format('%I.claim_organization_retention_deletion(uuid,uuid,uuid[])', ${schemaName}::text),
            'EXECUTE'
          ) as "executeRetention",
          has_table_privilege(
            ${roleName}::text,
            format('%I.organization_membership_operation_receipts', ${schemaName}::text),
            'INSERT'
          ) as "directInsert",
          has_table_privilege(
            ${roleName}::text,
            format('%I.organization_user_retention_deletions', ${schemaName}::text),
            'INSERT'
          ) as "directRetentionInsert",
          (
            select config
            from pg_proc procedure
            join pg_namespace namespace on namespace.oid = procedure.pronamespace
            cross join lateral unnest(coalesce(procedure.proconfig, array[]::text[])) config
            where namespace.nspname = ${schemaName}::text
              and procedure.proname = 'organization_membership_command'
              and config like 'search_path=%'
          ) as "searchPath",
          (
            select config
            from pg_proc procedure
            join pg_namespace namespace on namespace.oid = procedure.pronamespace
            cross join lateral unnest(coalesce(procedure.proconfig, array[]::text[])) config
            where namespace.nspname = ${schemaName}::text
              and procedure.proname = 'claim_organization_retention_deletion'
              and config like 'search_path=%'
          ) as "retentionSearchPath"`;
      expect(posture).toEqual({
        execute: true,
        executeRetention: true,
        directInsert: false,
        directRetentionInsert: false,
        searchPath: `search_path=pg_catalog, ${schemaName}, pg_temp`,
        retentionSearchPath: `search_path=pg_catalog, ${schemaName}, pg_temp`,
      });

      const accountId = crypto.randomUUID();
      const membershipId = crypto.randomUUID();
      const workspaceId = crypto.randomUUID();
      const subjectId = `user:${crypto.randomUUID()}`;
      await admin.unsafe(`set search_path = "${schemaName}", opengeni_private, public`);
      await admin`
        insert into managed_accounts (id, name, external_source, external_id)
        values (${accountId}::uuid, 'Custom organization', 'test', ${crypto.randomUUID()})`;
      await admin`
        insert into workspaces (id, account_id, name, external_source, external_id)
        values (${workspaceId}::uuid, ${accountId}::uuid, 'Personal', 'test', ${crypto.randomUUID()})`;
      await admin`
        insert into organization_memberships
          (id, account_id, subject_id, role, status, personal_workspace_id)
        values (${membershipId}::uuid, ${accountId}::uuid, ${subjectId}, 'owner', 'active', ${workspaceId}::uuid)`;
      const rows = await appSql.begin(async (transaction) => {
        await transaction`select
          set_config('opengeni.account_id', ${accountId}, true),
          set_config('opengeni.workspace_id', '', true),
          set_config('opengeni.subject_id', ${subjectId}, true)`;
        await transaction`create temporary table organization_memberships (
          id uuid, account_id uuid, subject_id text, role text, status text,
          personal_workspace_id uuid, authorization_revision bigint,
          revoked_at timestamptz, personal_retention_until timestamptz,
          created_at timestamptz, updated_at timestamptz
        )`;
        await transaction`insert into organization_memberships values (
          ${crypto.randomUUID()}::uuid, ${accountId}::uuid, ${subjectId}, 'member', 'revoked',
          null, 99, now(), null, now(), now()
        )`;
        return await transaction.unsafe<
          Array<{ result: Array<{ id: string; role: string; status: string }> }>
        >(`select "${schemaName}".list_self_organization_memberships($1) as result`, [subjectId]);
      });
      expect(rows[0]?.result).toEqual([
        expect.objectContaining({
          id: membershipId,
          role: "owner",
          status: "active",
        }),
      ]);

      const revokedMembershipId = crypto.randomUUID();
      await admin`
        insert into organization_memberships (
          id, account_id, subject_id, role, status, revoked_at, personal_retention_until
        ) values (
          ${revokedMembershipId}::uuid, ${accountId}::uuid,
          ${`user:${crypto.randomUUID()}`}, 'member', 'revoked', now(), now() - interval '1 day'
        )`;
      const claimOperationId = crypto.randomUUID();
      const claimRows = await appSql.begin(async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${accountId}, true)`;
        await transaction`create temporary table organization_user_retention_deletions (
          account_id uuid, membership_id uuid, state text, claim_operation_id uuid
        )`;
        return await transaction.unsafe<Array<{ result: { membershipId: string } }>>(
          `select "${schemaName}".claim_organization_retention_deletion($1, $2, array[]::uuid[]) as result`,
          [accountId, claimOperationId],
        );
      });
      expect(claimRows[0]?.result.membershipId).toBe(revokedMembershipId);
    } finally {
      await appSql?.end().catch(() => undefined);
      await admin.unsafe(`drop owned by "${roleName}"`).catch(() => undefined);
      await admin.unsafe(`drop role if exists "${roleName}"`).catch(() => undefined);
      await admin.end().catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("binds invitation acceptance to the exact subject and replays exact operations", async () => {
    if (!shared || !client) return;
    const ownerId = `owner-${crypto.randomUUID()}`;
    const targetId = `target-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    const targetSubject = `user:${targetId}`;
    await provisionSelf(ownerId);
    const [ownerMembership] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    expect(ownerMembership?.role).toBe("owner");

    const operationId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId: ownerMembership!.organizationId,
      actorSubjectId: ownerSubject,
      operationId,
      targetSubjectId: targetSubject,
      targetEmail: `${targetId}@example.test`,
      role: "member",
      expiresAt,
    });
    expect(
      await createOrganizationInvitation(client.db, {
        organizationId: ownerMembership!.organizationId,
        actorSubjectId: ownerSubject,
        operationId,
        targetSubjectId: targetSubject,
        targetEmail: `${targetId}@example.test`,
        role: "member",
        expiresAt,
      }),
    ).toEqual(invitation);
    await expectSqlState(
      () =>
        acceptOrganizationInvitation(client!.db, {
          organizationId: ownerMembership!.organizationId,
          actorSubjectId: `user:foreign-${crypto.randomUUID()}`,
          operationId: crypto.randomUUID(),
          invitationId: invitation.id,
          expectedRevision: invitation.revision,
        }),
      "42501",
    );

    const acceptOperationId = crypto.randomUUID();
    const accepted = await acceptOrganizationInvitation(client.db, {
      organizationId: ownerMembership!.organizationId,
      actorSubjectId: targetSubject,
      operationId: acceptOperationId,
      invitationId: invitation.id,
      expectedRevision: invitation.revision,
    });
    expect(accepted.membership).toMatchObject({
      subjectId: targetSubject,
      role: "member",
      status: "active",
    });
    expect(
      await acceptOrganizationInvitation(client.db, {
        organizationId: ownerMembership!.organizationId,
        actorSubjectId: targetSubject,
        operationId: acceptOperationId,
        invitationId: invitation.id,
        expectedRevision: invitation.revision,
      }),
    ).toEqual(accepted);
    const promotedAdmin = await updateOrganizationMember(client.db, {
      organizationId: ownerMembership!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      membershipId: accepted.membership.id,
      transition: {
        kind: "change_role",
        role: "admin",
        expectedAuthorizationRevision: accepted.membership.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    await expectSqlState(
      () =>
        createOrganizationInvitation(client!.db, {
          organizationId: ownerMembership!.organizationId,
          actorSubjectId: targetSubject,
          operationId: crypto.randomUUID(),
          targetSubjectId: `user:${crypto.randomUUID()}`,
          targetEmail: `${crypto.randomUUID()}@example.test`,
          role: "admin",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      "22023",
    );
    await expectSqlState(
      () =>
        updateOrganizationMember(client!.db, {
          organizationId: ownerMembership!.organizationId,
          actorSubjectId: targetSubject,
          operationId: crypto.randomUUID(),
          membershipId: ownerMembership!.id,
          transition: {
            kind: "change_role",
            role: "member",
            expectedAuthorizationRevision: ownerMembership!.authorizationRevision,
            operationId: crypto.randomUUID(),
          },
        }),
      "42501",
    );
    await expectSqlState(
      () =>
        updateOrganizationMember(client!.db, {
          organizationId: ownerMembership!.organizationId,
          actorSubjectId: ownerSubject,
          operationId: crypto.randomUUID(),
          membershipId: ownerMembership!.id,
          transition: {
            kind: "suspend",
            expectedAuthorizationRevision: ownerMembership!.authorizationRevision,
            operationId: crypto.randomUUID(),
          },
        }),
      "55000",
    );
    expect(promotedAdmin).toMatchObject({ role: "admin", status: "active" });
    await expectSqlState(
      () =>
        createOrganizationInvitation(client!.db, {
          organizationId: ownerMembership!.organizationId,
          actorSubjectId: ownerSubject,
          operationId,
          targetSubjectId: `user:other-${crypto.randomUUID()}`,
          targetEmail: `other-${crypto.randomUUID()}@example.test`,
          role: "member",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      "23505",
    );

    const access = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: targetId,
      email: `${targetId}@example.test`,
      name: targetId,
    });
    expect(
      access.accessContext.accountGrants.some(
        (grant) => grant.accountId === ownerMembership!.organizationId,
      ),
    ).toBe(true);
    expect(
      access.accessContext.workspaceGrants.some(
        (grant) => grant.workspaceId === accepted.membership.personalWorkspaceId,
      ),
    ).toBe(true);
  });

  test("keyset-pages self invitation history and exact lookup never crosses subjects", async () => {
    if (!shared || !client) return;
    const ownerId = `page-owner-${crypto.randomUUID()}`;
    const targetId = `page-target-${crypto.randomUUID()}`;
    const foreignId = `page-foreign-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    const targetSubject = `user:${targetId}`;
    const foreignSubject = `user:${foreignId}`;
    await provisionSelf(ownerId);
    const [owner] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    const expectedIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const invitationId = crypto.randomUUID();
      expectedIds.push(invitationId);
      await shared.admin`
        insert into organization_membership_invitations (
          id, account_id, target_subject_id, target_email, role, status,
          created_by_membership_id, expires_at, created_at, updated_at
        ) values (
          ${invitationId}, ${owner!.organizationId}, ${targetSubject},
          ${`${targetId}@example.test`}, 'member', 'revoked', ${owner!.id},
          now() + interval '1 day',
          timestamptz '2026-01-01 00:00:00+00' + ${index} * interval '1 second',
          timestamptz '2026-01-01 00:00:00+00' + ${index} * interval '1 second'
        )`;
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listSelfOrganizationInvitations(client.db, {
        subjectId: targetSubject,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 2,
      });
      seen.push(...page.invitations.map((invitation) => invitation.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual([...expectedIds].reverse());
    expect(new Set(seen).size).toBe(5);

    expect(
      await getSelfOrganizationInvitation(client.db, {
        subjectId: targetSubject,
        invitationId: expectedIds[2]!,
      }),
    ).toMatchObject({ id: expectedIds[2] });
    await expectSqlState(
      () =>
        getSelfOrganizationInvitation(client!.db, {
          subjectId: foreignSubject,
          invitationId: expectedIds[2]!,
        }),
      "P0002",
    );
    await expectSqlState(
      () =>
        listSelfOrganizationInvitations(client!.db, {
          subjectId: foreignSubject,
          cursor: expectedIds[2]!,
          limit: 2,
        }),
      "P0002",
    );
  });

  test("uses CAS for transitions and revokes access immediately without deleting retained data", async () => {
    if (!shared || !client) return;
    const ownerId = `lifecycle-owner-${crypto.randomUUID()}`;
    const targetId = `lifecycle-target-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    const targetSubject = `user:${targetId}`;
    const ownerAccess = await provisionSelf(ownerId);
    const [owner] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: targetSubject,
      targetEmail: `${targetId}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    let member = (
      await acceptOrganizationInvitation(client.db, {
        organizationId: owner!.organizationId,
        actorSubjectId: targetSubject,
        operationId: crypto.randomUUID(),
        invitationId: invitation.id,
        expectedRevision: invitation.revision,
      })
    ).membership;

    const concurrent = await Promise.allSettled([
      updateOrganizationMember(client.db, {
        organizationId: owner!.organizationId,
        actorSubjectId: ownerSubject,
        operationId: crypto.randomUUID(),
        membershipId: member.id,
        transition: {
          kind: "change_role",
          role: "admin",
          expectedAuthorizationRevision: member.authorizationRevision,
          operationId: crypto.randomUUID(),
        },
      }),
      updateOrganizationMember(client.db, {
        organizationId: owner!.organizationId,
        actorSubjectId: ownerSubject,
        operationId: crypto.randomUUID(),
        membershipId: member.id,
        transition: {
          kind: "change_role",
          role: "member",
          expectedAuthorizationRevision: member.authorizationRevision,
          operationId: crypto.randomUUID(),
        },
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      concurrent.some(
        (result) =>
          result.status === "rejected" && nestedPostgresSqlState(result.reason) === "40001",
      ),
    ).toBe(true);
    member = (
      await listOrganizationMembers(client.db, {
        organizationId: owner!.organizationId,
        actorSubjectId: ownerSubject,
      })
    ).find((candidate) => candidate.id === member.id)!;
    const suspensionWorkspaceId = crypto.randomUUID();
    await shared.admin`
      insert into workspaces (id, account_id, name, external_source, external_id)
      values (${suspensionWorkspaceId}, ${owner!.organizationId}, 'Suspension shared', 'test', ${crypto.randomUUID()})`;
    await shared.admin`
      insert into workspace_inference_controls (account_id, workspace_id)
      values (${owner!.organizationId}, ${suspensionWorkspaceId})`;
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values
        (${owner!.organizationId}, ${suspensionWorkspaceId}, ${ownerSubject}, 'owner'),
        (${owner!.organizationId}, ${suspensionWorkspaceId}, ${targetSubject}, 'member')`;
    const sharedSession = await createSession(client.db, {
      accountId: owner!.organizationId,
      workspaceId: suspensionWorkspaceId,
      initialMessage: "owner shared session",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: ownerSubject },
      subjectId: ownerSubject,
      model: "test-model",
      sandboxBackend: "none",
    });
    const targetOwnedSession = await createSession(client.db, {
      accountId: owner!.organizationId,
      workspaceId: suspensionWorkspaceId,
      initialMessage: "member-owned work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: targetSubject },
      subjectId: targetSubject,
      model: "test-model",
      sandboxBackend: "none",
    });
    const initiatedTurnId = crypto.randomUUID();
    const initiatedAttemptId = crypto.randomUUID();
    await shared.admin.begin(async (tx) => {
      await tx`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model,
          reasoning_effort, sandbox_backend, execution_generation,
          initiator_kind, initiator_subject_id, initiator_context,
          initiating_human_subject_id
        ) values (
          ${initiatedTurnId}, ${owner!.organizationId}, ${suspensionWorkspaceId},
          ${sharedSession.id}, ${crypto.randomUUID()}, ${`suspend-${initiatedTurnId}`},
          'running', 'user', 1, 'member initiated shared work', 'test-model',
          'medium', 'none', 1, 'subject', ${targetSubject}, ${tx.json({ source: "test" })},
          ${targetSubject}
        )`;
      await tx`update sessions set active_turn_id = ${initiatedTurnId}, status = 'running'
        where id = ${sharedSession.id}`;
      await tx`update session_turns set active_attempt_id = ${initiatedAttemptId}
        where id = ${initiatedTurnId}`;
      await tx`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id,
          temporal_activity_id, verified_control_revision, mcp_approval_policies
        ) values (
          ${initiatedAttemptId}, ${owner!.organizationId}, ${suspensionWorkspaceId},
          ${sharedSession.id}, ${initiatedTurnId}, 1, 'running',
          ${`suspend-${initiatedTurnId}`}, ${`run-${initiatedAttemptId}`},
          ${`activity-${initiatedAttemptId}`}, 0, '{}'::jsonb
        )`;
    });
    const authorityId = crypto.randomUUID();
    const grantId = crypto.randomUUID();
    await shared.admin`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id
      ) values (
        ${authorityId}, ${owner!.organizationId}, ${member.id}, 'test_resource',
        ${crypto.randomUUID()}, ${suspensionWorkspaceId}
      )`;
    await shared.admin`
      insert into organization_user_resource_grants (
        id, account_id, authority_id, owner_organization_membership_id,
        workspace_id, action, mode, context
      ) values (
        ${grantId}, ${owner!.organizationId}, ${authorityId}, ${member.id},
        ${suspensionWorkspaceId}, 'test.use', 'always', 'workspace_shared'
      )`;
    member = await updateOrganizationMember(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      membershipId: member.id,
      transition: {
        kind: "suspend",
        expectedAuthorizationRevision: member.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    expect(member.status).toBe("suspended");
    const [suspensionFence] = await shared.admin<
      Array<{
        interruptionCount: number;
        authorityEpoch: number;
        grantStatus: string;
        authorityStatus: string;
        ownedSessionEpoch: number;
        ownedSessionEvents: number;
      }>
    >`
      select
        (select count(*)::int from session_attempt_interruptions interruption
          where interruption.attempt_id = ${initiatedAttemptId}) as "interruptionCount",
        (select authority_epoch::int from sessions where id = ${sharedSession.id})
          as "authorityEpoch",
        (select status from organization_user_resource_grants where id = ${grantId})
          as "grantStatus",
        (select status from organization_user_resource_authorities where id = ${authorityId})
          as "authorityStatus",
        (select authority_epoch::int from sessions where id = ${targetOwnedSession.id})
          as "ownedSessionEpoch",
        (select count(*)::int from session_events event_row
          where event_row.session_id = ${targetOwnedSession.id}
            and event_row.type = 'session.authority.suspended') as "ownedSessionEvents"`;
    expect(suspensionFence).toEqual({
      interruptionCount: 1,
      authorityEpoch: 1,
      grantStatus: "revoked",
      authorityStatus: "active",
      ownedSessionEpoch: 2,
      ownedSessionEvents: 1,
    });
    const suspendedAccess = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: targetId,
      email: `${targetId}@example.test`,
      name: targetId,
    });
    expect(
      suspendedAccess.accessContext.accountGrants.some(
        (grant) => grant.accountId === owner!.organizationId,
      ),
    ).toBe(false);

    member = await updateOrganizationMember(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      membershipId: member.id,
      transition: {
        kind: "reactivate",
        expectedAuthorizationRevision: member.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    for (const retentionDays of [29, 91]) {
      await expectSqlState(
        () =>
          updateOrganizationRetentionPolicy(client!.db, {
            organizationId: owner!.organizationId,
            actorSubjectId: ownerSubject,
            operationId: crypto.randomUUID(),
            mode: "delete_after",
            retentionDays,
            expectedVersion: 1,
          }),
        "22023",
      );
    }
    await updateOrganizationRetentionPolicy(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      mode: "delete_after",
      retentionDays: 30,
      expectedVersion: 1,
    });
    const personalWorkspaceId = member.personalWorkspaceId!;
    const sharedWorkspaceId = crypto.randomUUID();
    await shared.admin`
      insert into workspaces (id, account_id, name, external_source, external_id)
      values (${sharedWorkspaceId}, ${owner!.organizationId}, 'Lifecycle shared', 'test', ${crypto.randomUUID()})`;
    await shared.admin`
      insert into workspace_inference_controls (account_id, workspace_id)
      values (${owner!.organizationId}, ${sharedWorkspaceId})`;
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${owner!.organizationId}, ${sharedWorkspaceId}, ${targetSubject}, 'member')`;
    const privateSession = await createSession(client.db, {
      accountId: owner!.organizationId,
      workspaceId: sharedWorkspaceId,
      initialMessage: "private retained work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: targetSubject },
      subjectId: targetSubject,
      model: "test-model",
      sandboxBackend: "none",
    });
    const privateTransition = await transitionSessionVisibility(client.db, {
      workspaceId: sharedWorkspaceId,
      sessionId: privateSession.id,
      actorSubjectId: targetSubject,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `private:${crypto.randomUUID()}`,
    });
    expect(privateTransition.authorityEpoch).toBe(2);
    await shared.admin`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, execution_generation, position, prompt,
        model, reasoning_effort, latency_mode, sandbox_backend, initiator_kind,
        initiator_subject_id, initiating_human_subject_id
      ) values (
        ${crypto.randomUUID()}, ${owner!.organizationId}, ${sharedWorkspaceId},
        ${privateSession.id}, ${crypto.randomUUID()}, ${`offboard-${crypto.randomUUID()}`},
        'queued', 1, 1, 'queued private work', 'test-model', 'medium', 'standard',
        'none', 'subject', ${targetSubject}, ${targetSubject}
      )`;
    const secondWorkspaceId = crypto.randomUUID();
    await shared.admin`
      insert into workspaces (id, account_id, name, external_source, external_id)
      values (${secondWorkspaceId}, ${owner!.organizationId}, 'Lifecycle shared two', 'test', ${crypto.randomUUID()})`;
    await shared.admin`
      insert into workspace_inference_controls (account_id, workspace_id)
      values (${owner!.organizationId}, ${secondWorkspaceId})`;
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${owner!.organizationId}, ${secondWorkspaceId}, ${targetSubject}, 'member')`;
    const secondSession = await createSession(client.db, {
      accountId: owner!.organizationId,
      workspaceId: secondWorkspaceId,
      initialMessage: "second private retained work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: targetSubject },
      subjectId: targetSubject,
      model: "test-model",
      sandboxBackend: "none",
    });
    await transitionSessionVisibility(client.db, {
      workspaceId: secondWorkspaceId,
      sessionId: secondSession.id,
      actorSubjectId: targetSubject,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `private:${crypto.randomUUID()}`,
    });
    const offboardRace = await Promise.allSettled([
      updateOrganizationMember(client.db, {
        organizationId: owner!.organizationId,
        actorSubjectId: ownerSubject,
        operationId: crypto.randomUUID(),
        membershipId: member.id,
        transition: {
          kind: "offboard",
          expectedAuthorizationRevision: member.authorizationRevision,
          operationId: crypto.randomUUID(),
          reason: "employment ended",
        },
      }),
      transitionSessionVisibility(client.db, {
        workspaceId: secondWorkspaceId,
        sessionId: secondSession.id,
        actorSubjectId: targetSubject,
        targetVisibility: "workspace_shared",
        expectedAuthorityEpoch: 2,
        operationKey: `concurrent:${crypto.randomUUID()}`,
      }),
    ]);
    if (offboardRace[0]?.status !== "fulfilled") throw offboardRace[0]?.reason;
    member = offboardRace[0].value;
    if (offboardRace[1]?.status === "rejected") {
      expect(nestedPostgresSqlState(offboardRace[1].reason)).toBe("42501");
    }
    expect(member.status).toBe("revoked");
    expect(member.personalRetentionUntil).not.toBeNull();
    const [workspaceStillExists] = await shared.admin<{ id: string }[]>`
      select id from workspaces where id = ${personalWorkspaceId}`;
    expect(workspaceStillExists?.id).toBe(personalWorkspaceId);
    const [retainedSession] = await shared.admin<
      Array<{
        id: string;
        authorityEpoch: number;
        ownerMembershipId: string | null;
        cancelledTurns: number;
        revocationEvents: number;
      }>
    >`
      select id, authority_epoch::int as "authorityEpoch",
        owner_organization_membership_id as "ownerMembershipId",
        (select count(*)::int from session_turns turn_row
          where turn_row.session_id = sessions.id and turn_row.status = 'cancelled')
          as "cancelledTurns",
        (select count(*)::int from session_events event_row
          where event_row.session_id = sessions.id
            and event_row.type = 'session.authority.revoked') as "revocationEvents"
      from sessions where id = ${privateSession.id}`;
    expect(retainedSession).toEqual({
      id: privateSession.id,
      authorityEpoch: 3,
      ownerMembershipId: member.id,
      cancelledTurns: 1,
      revocationEvents: 1,
    });
    const [secondRetainedSession] = await shared.admin<
      Array<{ authorityEpoch: number; revocationEvents: number }>
    >`
      select authority_epoch::int as "authorityEpoch",
        (select count(*)::int from session_events event_row
          where event_row.session_id = sessions.id
            and event_row.type = 'session.authority.revoked') as "revocationEvents"
      from sessions where id = ${secondSession.id}`;
    expect(secondRetainedSession).toEqual({
      authorityEpoch: offboardRace[1]?.status === "fulfilled" ? 4 : 3,
      revocationEvents: 1,
    });
    const revokedAccess = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: targetId,
      email: `${targetId}@example.test`,
      name: targetId,
    });
    expect(
      revokedAccess.accessContext.accountGrants.some(
        (grant) => grant.accountId === owner!.organizationId,
      ),
    ).toBe(false);
    expect(ownerAccess.workspaceGrants.length).toBeGreaterThan(0);
  });

  test("keeps lifecycle tables non-writable and rejects cross-tenant command context", async () => {
    if (!client) return;
    const ownerId = `security-owner-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    await provisionSelf(ownerId);
    const [owner] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    await expectSqlState(
      () =>
        withRlsContext(
          client!.db,
          { accountId: owner!.organizationId, workspaceId: null },
          async (scopedDb) => {
            await setSubjectRlsContext(scopedDb, ownerSubject);
            await rawRows(
              scopedDb,
              sql`insert into organization_membership_operation_receipts
                (account_id, operation_id, action, input_hash, result)
                values (${owner!.organizationId}::uuid, ${crypto.randomUUID()}::uuid,
                  'invite', ${"0".repeat(64)}, '{}'::jsonb)`,
            );
          },
        ),
      "42501",
    );
    await expectSqlState(
      () =>
        createOrganizationInvitation(client!.db, {
          organizationId: crypto.randomUUID(),
          actorSubjectId: ownerSubject,
          operationId: crypto.randomUUID(),
          targetSubjectId: `user:${crypto.randomUUID()}`,
          targetEmail: `${crypto.randomUUID()}@example.test`,
          role: "member",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      "P0002",
    );
    await expectSqlState(
      () =>
        withRlsContext(
          client!.db,
          { accountId: owner!.organizationId, workspaceId: null },
          async (scopedDb) => {
            await rawRows(
              scopedDb,
              sql`insert into organization_user_retention_deletions (
                account_id, membership_id, retention_until, claim_operation_id,
                claim_expires_at
              ) values (
                ${owner!.organizationId}::uuid, ${owner!.id}::uuid, now(),
                ${crypto.randomUUID()}::uuid, now() + interval '15 minutes'
              )`,
            );
          },
        ),
      "42501",
    );
  });

  test("deletes an expired personal workspace only after exact object proof and preserves audit", async () => {
    if (!shared || !client) return;
    const ownerId = `retention-owner-${crypto.randomUUID()}`;
    const targetId = `retention-target-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    const targetSubject = `user:${targetId}`;
    await provisionSelf(ownerId);
    const [owner] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: targetSubject,
      targetEmail: `${targetId}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    let member = (
      await acceptOrganizationInvitation(client.db, {
        organizationId: owner!.organizationId,
        actorSubjectId: targetSubject,
        operationId: crypto.randomUUID(),
        invitationId: invitation.id,
        expectedRevision: invitation.revision,
      })
    ).membership;
    const personalWorkspaceId = member.personalWorkspaceId!;
    const fileId = crypto.randomUUID();
    const objectKey = `retention/${crypto.randomUUID()}`;
    await shared.admin`
      insert into files (
        id, account_id, workspace_id, status, filename, safe_filename,
        content_type, size_bytes, bucket, object_key
      ) values (
        ${fileId}, ${owner!.organizationId}, ${personalWorkspaceId}, 'ready',
        'retained.txt', 'retained.txt', 'text/plain', 8, 'test', ${objectKey}
      )`;
    const personalConnection = await createConnection(client.db, {
      accountId: owner!.organizationId,
      workspaceId: personalWorkspaceId,
      subjectId: targetSubject,
      providerDomain: "retention.example.test",
      kind: "api_key",
      credentialEncrypted: "retention-test-ciphertext",
      grantedScopes: ["read"],
      createdBySubjectId: targetSubject,
    });
    member = await updateOrganizationMember(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      membershipId: member.id,
      transition: {
        kind: "offboard",
        expectedAuthorizationRevision: member.authorizationRevision,
        operationId: crypto.randomUUID(),
        reason: "retention test",
      },
    });
    await shared.admin`update organization_memberships
      set personal_retention_until = now() - interval '1 second'
      where account_id = ${owner!.organizationId} and id = ${member.id}`;

    const operationId = crypto.randomUUID();
    const claim = await claimOrganizationRetentionDeletion(client.db, {
      organizationId: owner!.organizationId,
      operationId,
    });
    expect(claim).toMatchObject({
      membershipId: member.id,
      operationId,
      personalWorkspaceId,
      objectCount: 1,
    });
    expect(
      await claimOrganizationRetentionDeletion(client.db, {
        organizationId: owner!.organizationId,
        operationId,
      }),
    ).toEqual(claim);
    const objects = await listOrganizationRetentionDeletionObjects(client.db, {
      organizationId: owner!.organizationId,
      membershipId: member.id,
      operationId,
      limit: 100,
    });
    expect(objects).toEqual([{ fileId, objectKey }]);
    await expectSqlState(
      () =>
        finalizeOrganizationRetentionDeletion(client!.db, {
          organizationId: owner!.organizationId,
          membershipId: member.id,
          operationId,
        }),
      "55000",
    );
    await expectSqlState(
      () =>
        recordOrganizationRetentionObjectDeleted(client!.db, {
          organizationId: owner!.organizationId,
          membershipId: member.id,
          operationId,
          fileId,
          objectKey: `${objectKey}-forged`,
        }),
      "42501",
    );
    expect(
      await recordOrganizationRetentionObjectDeleted(client.db, {
        organizationId: owner!.organizationId,
        membershipId: member.id,
        operationId,
        fileId,
        objectKey,
      }),
    ).toBe(true);
    expect(
      await recordOrganizationRetentionObjectDeleted(client.db, {
        organizationId: owner!.organizationId,
        membershipId: member.id,
        operationId,
        fileId,
        objectKey,
      }),
    ).toBe(false);
    const completed = await finalizeOrganizationRetentionDeletion(client.db, {
      organizationId: owner!.organizationId,
      membershipId: member.id,
      operationId,
    });
    expect(completed).toMatchObject({
      membershipId: member.id,
      operationId,
      outcome: "completed",
      deletedResources: { files: 1, connections: 1, personalWorkspaces: 1 },
    });
    expect(
      await finalizeOrganizationRetentionDeletion(client.db, {
        organizationId: owner!.organizationId,
        membershipId: member.id,
        operationId,
      }),
    ).toEqual(completed);
    const [evidence] = await shared.admin<
      Array<{
        workspaceCount: number;
        membershipCount: number;
        personalWorkspaceId: string | null;
        lifecycleEvents: number;
        retentionEvents: number;
        objectReceipts: number;
        connectionCount: number;
      }>
    >`
      select
        (select count(*)::int from workspaces where id = ${personalWorkspaceId}) as "workspaceCount",
        (select count(*)::int from organization_memberships where id = ${member.id}) as "membershipCount",
        (select personal_workspace_id from organization_memberships where id = ${member.id}) as "personalWorkspaceId",
        (select count(*)::int from organization_membership_lifecycle_events
          where target_membership_id = ${member.id}) as "lifecycleEvents",
        (select count(*)::int from organization_user_retention_deletion_events
          where membership_id = ${member.id}) as "retentionEvents",
        (select count(*)::int from organization_user_retention_object_receipts
          where membership_id = ${member.id}) as "objectReceipts",
        (select count(*)::int from connections where id = ${personalConnection.id}) as "connectionCount"`;
    expect(evidence).toEqual({
      workspaceCount: 0,
      membershipCount: 1,
      personalWorkspaceId: null,
      lifecycleEvents: 2,
      retentionEvents: 2,
      objectReceipts: 1,
      connectionCount: 0,
    });
  });

  test("claims due memberships concurrently without duplicate ownership", async () => {
    if (!shared || !client) return;
    const ownerId = `claim-owner-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    await provisionSelf(ownerId);
    const [owner] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    const membershipIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const membershipId of membershipIds) {
      await shared.admin`
        insert into organization_memberships (
          id, account_id, subject_id, role, status, revoked_at, personal_retention_until
        ) values (
          ${membershipId}, ${owner!.organizationId}, ${`user:${crypto.randomUUID()}`},
          'member', 'revoked', now(), now() - interval '1 day'
        )`;
    }
    const operationIds = [crypto.randomUUID(), crypto.randomUUID()];
    const claims = await Promise.all(
      operationIds.map(
        async (operationId) =>
          await claimOrganizationRetentionDeletion(client!.db, {
            organizationId: owner!.organizationId,
            operationId,
          }),
      ),
    );
    expect(new Set(claims.map((claim) => claim?.membershipId))).toEqual(new Set(membershipIds));
    await Promise.all(
      claims.map(
        async (claim) =>
          await failOrganizationRetentionDeletion(client!.db, {
            organizationId: owner!.organizationId,
            membershipId: claim!.membershipId,
            operationId: claim!.operationId,
            reasonCode: "test_cleanup",
          }),
      ),
    );
  });

  test("revokes a pending invitation with CAS and preserves immutable replay", async () => {
    if (!client) return;
    const ownerId = `revoke-owner-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    await provisionSelf(ownerId);
    const [owner] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: `user:${crypto.randomUUID()}`,
      targetEmail: `${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const operationId = crypto.randomUUID();
    const revoked = await revokeOrganizationInvitation(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId,
      invitationId: invitation.id,
      expectedRevision: invitation.revision,
    });
    expect(revoked.status).toBe("revoked");
    expect(
      await revokeOrganizationInvitation(client.db, {
        organizationId: owner!.organizationId,
        actorSubjectId: ownerSubject,
        operationId,
        invitationId: invitation.id,
        expectedRevision: invitation.revision,
      }),
    ).toEqual(revoked);
  });

  test("administrators may revoke member invitations but not owner or admin invitations", async () => {
    if (!client) return;
    const ownerId = `revoke-role-owner-${crypto.randomUUID()}`;
    const adminId = `revoke-role-admin-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    const adminSubject = `user:${adminId}`;
    await provisionSelf(ownerId);
    const [owner] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    const adminInvitation = await createOrganizationInvitation(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: adminSubject,
      targetEmail: `${adminId}@example.test`,
      role: "admin",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await acceptOrganizationInvitation(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: adminSubject,
      operationId: crypto.randomUUID(),
      invitationId: adminInvitation.id,
      expectedRevision: adminInvitation.revision,
    });
    const pending = await Promise.all(
      (["owner", "admin", "member"] as const).map((role) =>
        createOrganizationInvitation(client!.db, {
          organizationId: owner!.organizationId,
          actorSubjectId: ownerSubject,
          operationId: crypto.randomUUID(),
          targetSubjectId: `user:${crypto.randomUUID()}`,
          targetEmail: `${crypto.randomUUID()}@example.test`,
          role,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ),
    );
    for (const invitation of pending.filter((candidate) => candidate.role !== "member")) {
      await expectSqlState(
        () =>
          revokeOrganizationInvitation(client!.db, {
            organizationId: owner!.organizationId,
            actorSubjectId: adminSubject,
            operationId: crypto.randomUUID(),
            invitationId: invitation.id,
            expectedRevision: invitation.revision,
          }),
        "42501",
      );
    }
    const memberInvitation = pending.find((candidate) => candidate.role === "member")!;
    expect(
      await revokeOrganizationInvitation(client.db, {
        organizationId: owner!.organizationId,
        actorSubjectId: adminSubject,
        operationId: crypto.randomUUID(),
        invitationId: memberInvitation.id,
        expectedRevision: memberInvitation.revision,
      }),
    ).toMatchObject({ status: "revoked", role: "member" });
  });

  test("pages organization invitations for admins without exposing them to members", async () => {
    if (!client) return;
    const ownerId = `page-owner-${crypto.randomUUID()}`;
    const memberId = `page-member-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    const memberSubject = `user:${memberId}`;
    await provisionSelf(ownerId);
    const [owner] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    const memberInvitation = await createOrganizationInvitation(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: memberSubject,
      targetEmail: `${memberId}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await acceptOrganizationInvitation(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: memberSubject,
      operationId: crypto.randomUUID(),
      invitationId: memberInvitation.id,
      expectedRevision: memberInvitation.revision,
    });
    const second = await createOrganizationInvitation(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: `user:${crypto.randomUUID()}`,
      targetEmail: `${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const firstPage = await listOrganizationInvitations(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      limit: 1,
    });
    expect(firstPage.invitations).toHaveLength(1);
    expect(firstPage.nextCursor).toBe(firstPage.invitations[0]!.id);
    const secondPage = await listOrganizationInvitations(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      cursor: firstPage.nextCursor!,
      limit: 1,
    });
    expect(secondPage.invitations).toHaveLength(1);
    expect(secondPage.invitations[0]?.id).not.toBe(firstPage.invitations[0]?.id);
    expect([memberInvitation.id, second.id]).toEqual(
      expect.arrayContaining([firstPage.invitations[0]!.id, secondPage.invitations[0]!.id]),
    );
    await expectSqlState(
      () =>
        listOrganizationInvitations(client!.db, {
          organizationId: owner!.organizationId,
          actorSubjectId: memberSubject,
          limit: 50,
        }),
      "42501",
    );
    await expectSqlState(
      () =>
        listOrganizationInvitations(client!.db, {
          organizationId: crypto.randomUUID(),
          actorSubjectId: ownerSubject,
          limit: 50,
        }),
      "42501",
    );
  });
});
