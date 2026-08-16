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
  applyCreditLedgerEntry,
  claimOrganizationRetentionDeletion,
  completeOrganizationRetentionDeletion,
  createConnection,
  createSession,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUser,
  ensureManagedAccessForUserWithOrganizationMemberships,
  failOrganizationRetentionDeletion,
  finalizeOrganizationRetentionDeletion,
  getSelfOrganizationInvitation,
  getBillingBalance,
  listOrganizationMembers,
  listOrganizationRetentionDeletionObjects,
  listOrganizationInvitations,
  listSelfOrganizationInvitations,
  listSelfOrganizationMemberships,
  nestedPostgresSqlState,
  provisionRoles,
  recordOrganizationRetentionObjectDeleted,
  revokeOrganizationInvitation,
  settleSessionAttemptInterruptions,
  transitionSessionVisibility,
  updateOrganizationMember,
  updateOrganizationRetentionPolicy,
  runMigrations,
  type DbClient,
} from "../src";
import { rawRows, setSubjectRlsContext, withRlsContext } from "../src/database";
import {
  admitVideoGenerationOperation,
  updateWorkspaceVideoGenerationPolicy,
} from "../src/video-generation";

const migrationUrl = new URL(
  "../drizzle/0263_organization_membership_lifecycle.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const retentionObjectBucket = "test";
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

async function provisionOrganizationMember(label: string) {
  if (!client) throw new Error("test database unavailable");
  const ownerId = `${label}-owner-${crypto.randomUUID()}`;
  const targetId = `${label}-target-${crypto.randomUUID()}`;
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
  const member = (
    await acceptOrganizationInvitation(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: targetSubject,
      operationId: crypto.randomUUID(),
      invitationId: invitation.id,
      expectedRevision: invitation.revision,
    })
  ).membership;
  return { owner: owner!, member, ownerSubject, targetSubject };
}

async function expireOrganizationMember(
  input: Awaited<ReturnType<typeof provisionOrganizationMember>>,
) {
  if (!client || !shared) throw new Error("test database unavailable");
  const member = await updateOrganizationMember(client.db, {
    organizationId: input.owner.organizationId,
    actorSubjectId: input.ownerSubject,
    operationId: crypto.randomUUID(),
    membershipId: input.member.id,
    transition: {
      kind: "offboard",
      expectedAuthorizationRevision: input.member.authorizationRevision,
      operationId: crypto.randomUUID(),
      reason: "retention test",
    },
  });
  await shared.admin`update organization_memberships
    set personal_retention_until = now() - interval '1 second'
    where account_id = ${input.owner.organizationId} and id = ${member.id}`;
  return member;
}

async function insertRetainedScreenshotReference(input: {
  accountId: string;
  workspaceId: string;
  fileId: string;
  db?: postgres.Sql | postgres.TransactionSql;
}) {
  if (!shared) throw new Error("test database unavailable");
  const db = input.db ?? shared.admin;
  await db`
    insert into retained_screenshot_artifacts (
      artifact_id, account_id, workspace_id, session_id, turn_id, attempt_id,
      settlement_key, tool_call_id, tool_output_id, status, quota_state,
      media_type, size_bytes, sha256, width, height, retention_expires_at, ready_at
    ) values (
      ${input.fileId}, ${input.accountId}, ${input.workspaceId}, null, null, null,
      ${`retention-screenshot:${crypto.randomUUID()}`}, 'call', 'output', 'ready', 'ready',
      'image/png', 8, ${"a".repeat(64)}, 1, 1, now() + interval '1 day', now()
    )`;
}

describe("migration 0263 organization membership lifecycle", () => {
  test("declares a closed lifecycle capability and immutable FORCE-RLS evidence", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(7);
    expect(migration.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(7);
    expect(migration).toContain("organization_membership_command(p_command jsonb)");
    expect(migration).toContain("invitation.target_subject_id IS DISTINCT FROM actor_subject");
    expect(migration).toContain("organization operation id was reused with different input");
    expect(migration).toContain("cannot remove the last active organization owner");
    expect(migration).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(migration).toContain("organization_membership_operation_receipts_immutable");
    expect(migration).toContain("organization_membership_lifecycle_events_immutable");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.organization_membership_history_immutable() FROM PUBLIC",
    );
    expect(migration).toMatch(
      /"mode" = 'delete_after'\s+AND "retention_days" IS NOT NULL\s+AND "retention_days" BETWEEN 30 AND 90/u,
    );
    for (const table of ["organization_memberships", "organization_user_resource_grants"]) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY organization_tenancy_lifecycle ON "${table}"[\\s\\S]*?` +
            `'managed_human_provisioning',[\\s\\S]*?'session_visibility_activation',[\\s\\S]*?` +
            `'organization_membership_lifecycle'`,
          "u",
        ),
      );
    }
    expect(migration.match(/assert_organization_retention_account\(p_account_id\)/gu)).toHaveLength(
      9,
    );
    expect(migration).toContain("REVOKE ALL ON TABLE organization_memberships FROM opengeni_app");
    expect(migration).toContain("DELETE FROM workspaces");
    expect(migration).not.toContain("DELETE FROM sessions");
    for (const source of [
      "'file'::text",
      "'session_recording'",
      "'browser_state_artifact'",
      "'browser_state_upload'",
      "'transcription_recording_object'",
      "'video_staging_reference'",
      "'workspace_artifact_version'",
      "'editable_artifact_blob'",
      "'workspace_capture_manifest'",
      "'workspace_capture_tree_index'",
      "'workspace_capture_blob'",
    ]) {
      expect(migration).toContain(source);
    }
    for (const sourceTable of [
      "FROM session_recordings",
      "FROM browser_state_artifacts",
      "FROM browser_state_uploads",
      "FROM transcription_recording_objects",
      "FROM video_generation_references",
      "FROM workspace_artifact_versions",
      "FROM editable_artifact_blob_refs",
      "FROM workspace_captures",
    ]) {
      expect(migration).toContain(sourceTable);
    }
    expect(migration).toContain("committed.object_key = upload.object_key");
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

  test("rejects a delete-after policy without an explicit bounded duration", async () => {
    if (!shared) return;
    const accountId = crypto.randomUUID();
    await shared.admin`
      insert into managed_accounts (id, name, external_source, external_id)
      values (${accountId}, 'Retention bounds', 'test', ${crypto.randomUUID()})`;
    await expectSqlState(
      async () =>
        await shared!.admin`
          insert into organization_user_retention_policies (account_id, mode)
          values (${accountId}, 'delete_after')`,
      "23514",
    );
  });

  test("separates causal subject provenance from authenticated managed-human admission", async () => {
    if (!client) return;
    const fixture = await provisionOrganizationMember("session-create-admission");
    const workspaceId = fixture.member.personalWorkspaceId!;
    const baseInput = {
      accountId: fixture.owner.organizationId,
      workspaceId,
      initialMessage: "managed-human admission fence",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject" as const, subjectId: fixture.targetSubject },
      model: "test-model",
      sandboxBackend: "none" as const,
    };

    const serviceCreated = await createSession(client.db, baseInput);
    expect(serviceCreated.createdBy).toEqual(baseInput.createdBy);

    await expect(
      createSession(client.db, {
        ...baseInput,
        subjectId: fixture.ownerSubject,
      }),
    ).rejects.toThrow("Managed-human session creator does not match authenticated subject");

    const suspended = await updateOrganizationMember(client.db, {
      organizationId: fixture.owner.organizationId,
      actorSubjectId: fixture.ownerSubject,
      operationId: crypto.randomUUID(),
      membershipId: fixture.member.id,
      transition: {
        kind: "suspend",
        expectedAuthorizationRevision: fixture.member.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    expect(suspended.status).toBe("suspended");
    await expectSqlState(
      () =>
        createSession(client!.db, {
          ...baseInput,
          subjectId: fixture.targetSubject,
        }),
      "42501",
    );
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
      await runMigrations(blank.databaseUrl, schemaName, {
        applicationDatabaseRoles: [roleName],
      });
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
          executePreparation: boolean;
          executeAdmission: boolean;
          executeRetention: boolean;
          executeRetentionComplete: boolean;
          directInsert: boolean;
          directRetentionInsert: boolean;
          directRetentionReceiptInsert: boolean;
          searchPath: string | null;
          preparationSearchPath: string | null;
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
            format(
              '%I.prepare_organization_membership_protocol_settlements(jsonb)',
              ${schemaName}::text
            ),
            'EXECUTE'
          ) as "executePreparation",
          has_function_privilege(
            ${roleName}::text,
            format(
              '%I.assert_active_managed_human_organization_membership(uuid,text)',
              ${schemaName}::text
            ),
            'EXECUTE'
          ) as "executeAdmission",
          has_function_privilege(
            ${roleName}::text,
            format('%I.claim_organization_retention_deletion(uuid,uuid,uuid[])', ${schemaName}::text),
            'EXECUTE'
          ) as "executeRetention",
          has_function_privilege(
            ${roleName}::text,
            format('%I.complete_organization_retention_deletion(uuid,uuid,uuid,text)', ${schemaName}::text),
            'EXECUTE'
          ) as "executeRetentionComplete",
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
          has_table_privilege(
            ${roleName}::text,
            format(
              '%I.organization_user_retention_object_deletion_receipts',
              ${schemaName}::text
            ),
            'INSERT'
          ) as "directRetentionReceiptInsert",
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
              and procedure.proname = 'prepare_organization_membership_protocol_settlements'
              and config like 'search_path=%'
          ) as "preparationSearchPath",
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
        executePreparation: true,
        executeAdmission: true,
        executeRetention: true,
        executeRetentionComplete: true,
        directInsert: false,
        directRetentionInsert: false,
        directRetentionReceiptInsert: false,
        searchPath: `search_path=pg_catalog, ${schemaName}, pg_temp`,
        preparationSearchPath: `search_path=pg_catalog, ${schemaName}, pg_temp`,
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
        const [admission] = await transaction.unsafe<Array<{ revision: number }>>(
          `select "${schemaName}".assert_active_managed_human_organization_membership($1, $2)::int as revision`,
          [accountId, subjectId],
        );
        expect(admission?.revision).toBe(1);
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
        interruptionKind: string;
        workflowWakeCount: number;
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
            and event_row.type = 'session.authority.suspended') as "ownedSessionEvents",
        (select kind from session_attempt_interruptions interruption
          where interruption.attempt_id = ${initiatedAttemptId}) as "interruptionKind",
        (select count(*)::int from session_workflow_wake_outbox wake
          where wake.session_id in (${sharedSession.id}, ${targetOwnedSession.id}))
          as "workflowWakeCount"`;
    expect(suspensionFence).toEqual({
      interruptionCount: 1,
      authorityEpoch: 1,
      grantStatus: "revoked",
      authorityStatus: "active",
      ownedSessionEpoch: 2,
      ownedSessionEvents: 1,
      interruptionKind: "organization_membership_revoked",
      workflowWakeCount: 1,
    });
    const interruptionSettlement = await settleSessionAttemptInterruptions(
      client.db,
      suspensionWorkspaceId,
      sharedSession.id,
      initiatedAttemptId,
    );
    expect(interruptionSettlement.outcome).toBe("cancelled");
    const [terminalized] = await shared.admin<Array<{ turnStatus: string; sessionStatus: string }>>`
      select turn_row.status as "turnStatus", session_row.status as "sessionStatus"
      from session_turns turn_row
      join sessions session_row on session_row.id = turn_row.session_id
      where turn_row.id = ${initiatedTurnId}`;
    expect(terminalized).toEqual({ turnStatus: "cancelled", sessionStatus: "idle" });
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
    const approvalSession = await createSession(client.db, {
      accountId: owner!.organizationId,
      workspaceId: sharedWorkspaceId,
      initialMessage: "approval retained work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: targetSubject },
      subjectId: targetSubject,
      model: "test-model",
      sandboxBackend: "none",
    });
    const recoveringSession = await createSession(client.db, {
      accountId: owner!.organizationId,
      workspaceId: sharedWorkspaceId,
      initialMessage: "recovering retained work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: targetSubject },
      subjectId: targetSubject,
      model: "test-model",
      sandboxBackend: "none",
    });
    const capacitySession = await createSession(client.db, {
      accountId: owner!.organizationId,
      workspaceId: sharedWorkspaceId,
      initialMessage: "capacity retained work",
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
    const queuedTurnId = crypto.randomUUID();
    const requiresActionTurnId = crypto.randomUUID();
    const recoveringTurnId = crypto.randomUUID();
    const waitingCapacityTurnId = crypto.randomUUID();
    const requiresActionAttemptId = crypto.randomUUID();
    const pendingToolCallId = `call-${crypto.randomUUID()}`;
    const humanInputRequestId = crypto.randomUUID();
    const deliveredUpdateId = crypto.randomUUID();
    const deliveredHistoryItemId = crypto.randomUUID();
    await shared.admin`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, execution_generation, position, prompt,
        model, reasoning_effort, latency_mode, sandbox_backend, initiator_kind,
        initiator_subject_id, initiating_human_subject_id
      ) values
      (
        ${queuedTurnId}, ${owner!.organizationId}, ${sharedWorkspaceId},
        ${approvalSession.id}, ${crypto.randomUUID()}, ${`offboard-${crypto.randomUUID()}`},
        'queued', 1, 1, 'queued private work', 'test-model', 'medium', 'standard',
        'none', 'subject', ${targetSubject}, ${targetSubject}
      ),
      (
        ${requiresActionTurnId}, ${owner!.organizationId}, ${sharedWorkspaceId},
        ${recoveringSession.id}, ${crypto.randomUUID()}, ${`offboard-${crypto.randomUUID()}`},
        'running', 1, 2, 'approval private work', 'test-model', 'medium', 'standard',
        'none', 'subject', ${targetSubject}, ${targetSubject}
      ),
      (
        ${recoveringTurnId}, ${owner!.organizationId}, ${sharedWorkspaceId},
        ${capacitySession.id}, ${crypto.randomUUID()}, ${`offboard-${crypto.randomUUID()}`},
        'recovering', 1, 3, 'recovering private work', 'test-model', 'medium', 'standard',
        'none', 'subject', ${targetSubject}, ${targetSubject}
      ),
      (
        ${waitingCapacityTurnId}, ${owner!.organizationId}, ${sharedWorkspaceId},
        ${privateSession.id}, ${crypto.randomUUID()}, ${`offboard-${crypto.randomUUID()}`},
        'waiting_capacity', 1, 4, 'waiting private work', 'test-model', 'medium', 'standard',
        'none', 'subject', ${targetSubject}, ${targetSubject}
      )`;
    await shared.admin.begin(async (tx) => {
      await tx`update sessions
        set active_turn_id = ${requiresActionTurnId}, status = 'running'
        where id = ${recoveringSession.id}`;
      await tx`update session_turns
        set active_attempt_id = ${requiresActionAttemptId}
        where id = ${requiresActionTurnId}`;
      await tx`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id,
          temporal_activity_id, verified_control_revision, mcp_approval_policies
        ) values (
          ${requiresActionAttemptId}, ${owner!.organizationId}, ${sharedWorkspaceId},
          ${recoveringSession.id}, ${requiresActionTurnId}, 1, 'running',
          ${`offboard-${requiresActionTurnId}`}, ${`run-${requiresActionAttemptId}`},
          ${`activity-${requiresActionAttemptId}`}, 0, '{}'::jsonb
        )`;
      await tx`update session_turn_attempts
        set state = 'closed', outcome = 'requires_action', closed_at = now()
        where id = ${requiresActionAttemptId}`;
      await tx`update session_turns
        set status = 'requires_action', active_attempt_id = null
        where id = ${requiresActionTurnId}`;
      await tx`update sessions
        set status = 'requires_action'
        where id = ${recoveringSession.id}`;
    });
    await shared.admin`
      insert into session_pending_tool_calls (
        account_id, workspace_id, session_id, turn_id, execution_generation,
        attempt_id, call_id, call_type, call_item, call_item_codec_version
      ) values (
        ${owner!.organizationId}, ${sharedWorkspaceId}, ${recoveringSession.id},
        ${requiresActionTurnId}, 1, ${requiresActionAttemptId}, ${pendingToolCallId},
        'function_call',
        ${shared.admin.json({
          type: "function_call",
          name: "request_human_input",
          callId: pendingToolCallId,
          arguments: "{}",
        })},
        1
      )`;
    await shared.admin`
      insert into session_human_input_requests (
        id, account_id, workspace_id, session_id, turn_id, turn_generation,
        creation_attempt_id, tool_call_id, questions, allow_skip
      ) values (
        ${humanInputRequestId}, ${owner!.organizationId}, ${sharedWorkspaceId},
        ${recoveringSession.id}, ${requiresActionTurnId}, 1,
        ${requiresActionAttemptId}, ${pendingToolCallId},
        ${shared.admin.json([
          {
            id: "approval",
            header: "Approval",
            question: "Continue?",
            options: [
              { label: "Yes", description: "Continue." },
              { label: "No", description: "Stop." },
            ],
          },
        ])},
        false
      )`;
    await shared.admin`
      insert into session_history_items (
        id, account_id, workspace_id, session_id, turn_id, position, item
      ) values (
        ${deliveredHistoryItemId}, ${owner!.organizationId}, ${sharedWorkspaceId},
        ${recoveringSession.id}, ${requiresActionTurnId}, 100,
        ${shared.admin.json({
          type: "message",
          role: "user",
          content: "delivered machine input",
        })}
      )`;
    await shared.admin`
      insert into session_system_updates (
        id, account_id, workspace_id, session_id, kind, classification,
        source_id, dedupe_key, summary, payload, lineage, state,
        delivered_turn_id, delivered_history_item_id, delivered_at
      ) values (
        ${deliveredUpdateId}, ${owner!.organizationId}, ${sharedWorkspaceId},
        ${recoveringSession.id}, 'agent_message', 'info', 'test-agent',
        ${`delivered-${crypto.randomUUID()}`}, 'Delivered lifecycle input',
        ${shared.admin.json({
          type: "agent_message",
          text: "Delivered lifecycle input",
          operationId: crypto.randomUUID(),
        })}, '{}'::jsonb, 'delivered', ${requiresActionTurnId},
        ${deliveredHistoryItemId}, now()
      )`;
    await applyCreditLedgerEntry(client.db, {
      accountId: owner!.organizationId,
      workspaceId: sharedWorkspaceId,
      type: "test_credit",
      amountMicros: 1_000_000,
      sourceType: "test",
      sourceId: sharedWorkspaceId,
      idempotencyKey: `test:membership-lifecycle-video:${sharedWorkspaceId}`,
    });
    const videoPolicy = await withRlsContext(
      client.db,
      { accountId: owner!.organizationId, workspaceId: sharedWorkspaceId },
      async (scopedDb) => {
        await setSubjectRlsContext(scopedDb, targetSubject);
        return await updateWorkspaceVideoGenerationPolicy(scopedDb, {
          accountId: owner!.organizationId,
          workspaceId: sharedWorkspaceId,
          subjectId: targetSubject,
          expectedRevision: 0,
          fundingSource: "opengeni_credits",
          enabledModelIds: ["bytedance/seedance-2.5"],
          defaultModelId: "bytedance/seedance-2.5",
        });
      },
    );
    const videoOperationId = crypto.randomUUID();
    const videoReferenceCleanupAfter = new Date(Date.now() + 86_400_000);
    await withRlsContext(
      client.db,
      { accountId: owner!.organizationId, workspaceId: sharedWorkspaceId },
      async (scopedDb) => {
        await setSubjectRlsContext(scopedDb, targetSubject);
        await admitVideoGenerationOperation(scopedDb, {
          id: videoOperationId,
          accountId: owner!.organizationId,
          workspaceId: sharedWorkspaceId,
          sessionId: recoveringSession.id,
          turnId: requiresActionTurnId,
          attemptId: requiresActionAttemptId,
          toolCallId: pendingToolCallId,
          admissionKey: "a".repeat(64),
          requestDigest: "b".repeat(64),
          promptDigest: "c".repeat(64),
          requestEncrypted: "encrypted-request",
          modelId: "bytedance/seedance-2.5",
          sourceMode: "first_frame",
          capabilityRevision: "d".repeat(64),
          policyRevision: videoPolicy.revision,
          fundingSource: "opengeni_credits",
          pricedCostMicros: 620_000,
          connectionId: null,
          credentialVersion: 1,
          credentialEncrypted: "encrypted-managed-credential",
          providerIdempotencyKey: `membership-lifecycle-${videoOperationId}`,
          expectedArtifactId: crypto.randomUUID(),
          expectedFileId: crypto.randomUUID(),
          workspaceQuotaBytes: 1024 * 1024 * 1024,
          maxConcurrentPerWorkspace: 2,
          recoveryDeadlineAt: new Date(Date.now() + 60_000),
          references: [
            {
              ordinal: 0,
              role: "first_frame",
              contentType: "image/png",
              sizeBytes: 8,
              sha256: "e".repeat(64),
              stagingObjectKey: `video-staging/${videoOperationId}`,
              cleanupAfter: videoReferenceCleanupAfter,
            },
          ],
        });
      },
    );
    expect((await getBillingBalance(client.db, owner!.organizationId)).balanceMicros).toBe(380_000);
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
    const realtimeId = crypto.randomUUID();
    await shared.admin`
      insert into session_realtime_modes (
        id, account_id, workspace_id, session_id, operation_id,
        owner_subject_id, browser_instance_id, owner_key_hash, model,
        state, version, connection_epoch, lease_expires_at, last_heartbeat_at
      ) values (
        ${realtimeId}, ${owner!.organizationId}, ${sharedWorkspaceId},
        ${privateSession.id}, ${crypto.randomUUID()}, ${targetSubject},
        ${`browser-${crypto.randomUUID()}`}, ${"a".repeat(64)},
        'opengeni-gateway/openai/gpt-realtime-mini', 'active', 1, 1,
        now() + interval '1 minute', now()
      )`;
    await shared.admin`
      insert into session_realtime_connections (
        account_id, workspace_id, session_id, realtime_id, operation_id,
        connection_epoch, state
      ) values (
        ${owner!.organizationId}, ${sharedWorkspaceId}, ${privateSession.id},
        ${realtimeId}, ${crypto.randomUUID()}, 1, 'negotiating'
      )`;
    const offboardOperationId = crypto.randomUUID();
    const directCommand = {
      action: "offboard",
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: offboardOperationId,
      membershipId: member.id,
      expectedAuthorizationRevision: member.authorizationRevision,
      reason: "employment ended",
    };
    await expectSqlState(
      () =>
        withRlsContext(
          client!.db,
          { accountId: owner!.organizationId, workspaceId: null },
          async (scopedDb) => {
            await setSubjectRlsContext(scopedDb, ownerSubject);
            await rawRows(
              scopedDb,
              sql`select organization_membership_command(
                ${JSON.stringify(directCommand)}::jsonb
              )`,
            );
          },
        ),
      "55000",
    );
    const [directRollback] = await shared.admin<
      Array<{ status: string; turnStatus: string; pendingToolCalls: number; receipts: number }>
    >`
      select membership.status,
        (select status from session_turns where id = ${requiresActionTurnId}) as "turnStatus",
        (select count(*)::int from session_pending_tool_calls
          where turn_id = ${requiresActionTurnId}) as "pendingToolCalls",
        (select count(*)::int from organization_membership_operation_receipts
          where account_id = ${owner!.organizationId}
            and operation_id = ${offboardOperationId}) as receipts
      from organization_memberships membership where membership.id = ${member.id}`;
    expect(directRollback).toEqual({
      status: "active",
      turnStatus: "requires_action",
      pendingToolCalls: 1,
      receipts: 0,
    });
    const [directVideoRollback] = await shared.admin<
      Array<{ status: string; creditState: string; quotaState: string }>
    >`
      select status, credit_state as "creditState", quota_state as "quotaState"
      from video_generation_operations where id = ${videoOperationId}`;
    expect(directVideoRollback).toEqual({
      status: "preparing",
      creditState: "debited",
      quotaState: "reserved",
    });
    const offboardRace = await Promise.allSettled([
      updateOrganizationMember(client.db, {
        organizationId: owner!.organizationId,
        actorSubjectId: ownerSubject,
        operationId: offboardOperationId,
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
        stateMatrixCancelledTurns: number;
        revocationEvents: number;
        realtimeState: string;
        realtimeEndReason: string;
        realtimeConnectionState: string;
      }>
    >`
      select id, authority_epoch::int as "authorityEpoch",
        owner_organization_membership_id as "ownerMembershipId",
        (select count(*)::int from session_turns turn_row
          where turn_row.session_id = sessions.id and turn_row.status = 'cancelled')
          as "cancelledTurns",
        (select count(*)::int from session_turns turn_row
          where turn_row.session_id in (
            ${privateSession.id}, ${approvalSession.id}, ${recoveringSession.id}, ${capacitySession.id}
          ) and turn_row.status = 'cancelled') as "stateMatrixCancelledTurns",
        (select count(*)::int from session_events event_row
          where event_row.session_id = sessions.id
            and event_row.type = 'session.authority.revoked') as "revocationEvents",
        (select state from session_realtime_modes where id = ${realtimeId}) as "realtimeState",
        (select end_reason from session_realtime_modes where id = ${realtimeId}) as "realtimeEndReason",
        (select state from session_realtime_connections where realtime_id = ${realtimeId})
          as "realtimeConnectionState"
      from sessions where id = ${privateSession.id}`;
    expect(retainedSession).toEqual({
      id: privateSession.id,
      authorityEpoch: 3,
      ownerMembershipId: member.id,
      cancelledTurns: 1,
      stateMatrixCancelledTurns: 4,
      revocationEvents: 1,
      realtimeState: "ended",
      realtimeEndReason: "authority_revoked",
      realtimeConnectionState: "closed",
    });
    const [protocolSettlement] = await shared.admin<
      Array<{
        pendingToolCalls: number;
        humanInputStatus: string;
        interruptedHistoryItems: number;
        toolOutputEvents: number;
        humanInputEvents: number;
        systemUpdateEvents: number;
        cancelledTurnEvents: number;
        lastSequence: number;
      }>
    >`
      select
        (select last_sequence::int from sessions
          where id = ${recoveringSession.id}) as "lastSequence",
        (select count(*)::int from session_pending_tool_calls pending
          where pending.workspace_id = ${sharedWorkspaceId}
            and pending.turn_id = ${requiresActionTurnId}) as "pendingToolCalls",
        (select status from session_human_input_requests request_row
          where request_row.id = ${humanInputRequestId}) as "humanInputStatus",
        (select count(*)::int from session_history_items history
          where history.workspace_id = ${sharedWorkspaceId}
            and history.session_id = ${recoveringSession.id}
            and history.turn_id = ${requiresActionTurnId}
            and history.item ->> 'type' = 'function_call_result'
            and history.item ->> 'callId' = ${pendingToolCallId}
            and history.item ->> 'status' = 'incomplete') as "interruptedHistoryItems",
        (select count(*)::int from session_events event_row
          where event_row.workspace_id = ${sharedWorkspaceId}
            and event_row.session_id = ${recoveringSession.id}
            and event_row.turn_id = ${requiresActionTurnId}
            and event_row.type = 'agent.toolCall.output'
            and event_row.payload ->> 'id' = ${pendingToolCallId}) as "toolOutputEvents",
        (select count(*)::int from session_events event_row
          where event_row.workspace_id = ${sharedWorkspaceId}
            and event_row.session_id = ${recoveringSession.id}
            and event_row.turn_id = ${requiresActionTurnId}
            and event_row.type = 'user.humanInputResponse'
            and event_row.payload ->> 'requestId' = ${humanInputRequestId}) as "humanInputEvents",
        (select count(*)::int from session_events event_row
          where event_row.workspace_id = ${sharedWorkspaceId}
            and event_row.session_id = ${recoveringSession.id}
            and event_row.turn_id = ${requiresActionTurnId}
            and event_row.type = 'system.update.settled'
            and event_row.payload -> 'updateIds' = jsonb_build_array(${deliveredUpdateId}::uuid)
            and event_row.payload ->> 'historyItemId' = ${deliveredHistoryItemId})
          as "systemUpdateEvents",
        (select count(*)::int from session_events event_row
          where event_row.workspace_id = ${sharedWorkspaceId}
            and event_row.session_id = ${recoveringSession.id}
            and event_row.turn_id = ${requiresActionTurnId}
            and event_row.type = 'turn.cancelled') as "cancelledTurnEvents"`;
    expect(protocolSettlement).toEqual({
      pendingToolCalls: 0,
      humanInputStatus: "cancelled",
      interruptedHistoryItems: 1,
      toolOutputEvents: 1,
      humanInputEvents: 1,
      systemUpdateEvents: 1,
      cancelledTurnEvents: 1,
      lastSequence: expect.any(Number),
    });
    const [videoSettlement] = await shared.admin<
      Array<{
        status: string;
        creditState: string;
        quotaState: string;
        terminalUpdateState: string;
        reservedBytes: number;
        referenceCleanupAdvanced: boolean;
        usageEvents: number;
      }>
    >`
      select operation.status, operation.credit_state as "creditState",
        operation.quota_state as "quotaState",
        operation.terminal_update_state as "terminalUpdateState",
        quota.reserved_bytes::int as "reservedBytes",
        reference.cleanup_after < ${videoReferenceCleanupAfter} as "referenceCleanupAdvanced",
        (select count(*)::int from usage_events usage
          where usage.source_resource_type = 'video_generation_operation'
            and usage.source_resource_id = ${videoOperationId}
            and usage.event_type in ('video_generation.cost', 'video_generation.refund'))
          as "usageEvents"
      from video_generation_operations operation
      join workspace_video_generation_quotas quota
        on quota.workspace_id = operation.workspace_id
      join video_generation_references reference
        on reference.operation_id = operation.id and reference.ordinal = 0
      where operation.id = ${videoOperationId}`;
    expect(videoSettlement).toEqual({
      status: "cancelled_before_submit",
      creditState: "refunded",
      quotaState: "released",
      terminalUpdateState: "suppressed",
      reservedBytes: 0,
      referenceCleanupAdvanced: true,
      usageEvents: 2,
    });
    expect((await getBillingBalance(client.db, owner!.organizationId)).balanceMicros).toBe(
      1_000_000,
    );
    const replayedMember = await updateOrganizationMember(client.db, {
      organizationId: owner!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: offboardOperationId,
      membershipId: member.id,
      transition: {
        kind: "offboard",
        expectedAuthorizationRevision: member.authorizationRevision - 1,
        operationId: crypto.randomUUID(),
        reason: "employment ended",
      },
    });
    expect(replayedMember).toEqual(member);
    const [replayEvidence] = await shared.admin<
      Array<{
        pendingToolCalls: number;
        interruptedHistoryItems: number;
        lifecycleProtocolEvents: number;
        lastSequence: number;
      }>
    >`
      select
        (select count(*)::int from session_pending_tool_calls
          where workspace_id = ${sharedWorkspaceId}
            and turn_id = ${requiresActionTurnId}) as "pendingToolCalls",
        (select count(*)::int from session_history_items history
          where history.workspace_id = ${sharedWorkspaceId}
            and history.session_id = ${recoveringSession.id}
            and history.turn_id = ${requiresActionTurnId}
            and history.item ->> 'type' = 'function_call_result'
            and history.item ->> 'callId' = ${pendingToolCallId}
            and history.item ->> 'status' = 'incomplete') as "interruptedHistoryItems",
        (select count(*)::int from session_events event_row
          where event_row.workspace_id = ${sharedWorkspaceId}
            and event_row.session_id = ${recoveringSession.id}
            and event_row.turn_id = ${requiresActionTurnId}
            and event_row.type in (
              'agent.toolCall.output', 'user.humanInputResponse',
              'system.update.settled', 'turn.cancelled'
            )) as "lifecycleProtocolEvents",
        (select last_sequence::int from sessions
          where id = ${recoveringSession.id}) as "lastSequence"`;
    expect(replayEvidence).toEqual({
      pendingToolCalls: 0,
      interruptedHistoryItems: 1,
      lifecycleProtocolEvents: 4,
      lastSequence: protocolSettlement!.lastSequence,
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

  test("binds every retention operator capability to the exact organization context", async () => {
    if (!client) return;
    const currentOwnerId = `retention-context-current-${crypto.randomUUID()}`;
    const targetOwnerId = `retention-context-target-${crypto.randomUUID()}`;
    await provisionSelf(currentOwnerId);
    await provisionSelf(targetOwnerId);
    const [currentOrganization] = await listSelfOrganizationMemberships(
      client.db,
      `user:${currentOwnerId}`,
    );
    const [targetOrganization] = await listSelfOrganizationMemberships(
      client.db,
      `user:${targetOwnerId}`,
    );
    const membershipId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const invokeAsCurrentOrganization = async (statement: ReturnType<typeof sql>) =>
      await withRlsContext(
        client!.db,
        { accountId: currentOrganization!.organizationId, workspaceId: null },
        async (scopedDb) => await rawRows(scopedDb, statement),
      );
    const targetAccount = sql`${targetOrganization!.organizationId}::uuid`;

    for (const statement of [
      sql`select preview_organization_retention_deletions(${targetAccount}, 25)`,
      sql`select claim_organization_retention_deletion(
        ${targetAccount}, ${operationId}::uuid, ARRAY[]::uuid[]
      )`,
      sql`select list_organization_retention_deletion_objects(
        ${targetAccount}, ${membershipId}::uuid, ${operationId}::uuid, ${retentionObjectBucket}, 100
      )`,
      sql`select record_organization_retention_object_deleted(
        ${targetAccount}, ${membershipId}::uuid, ${operationId}::uuid,
        'file', ${sourceId}, ${retentionObjectBucket}, 'retention/object'
      )`,
      sql`select fail_organization_retention_deletion(
        ${targetAccount}, ${membershipId}::uuid, ${operationId}::uuid, 'cross_tenant_test'
      )`,
      sql`select finalize_organization_retention_deletion(
        ${targetAccount}, ${membershipId}::uuid, ${operationId}::uuid, ${retentionObjectBucket}
      )`,
      sql`select complete_organization_retention_deletion(
        ${targetAccount}, ${membershipId}::uuid, ${operationId}::uuid, ${retentionObjectBucket}
      )`,
    ]) {
      await expectSqlState(() => invokeAsCurrentOrganization(statement), "42501");
    }
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
    const databaseFinalized = await finalizeOrganizationRetentionDeletion(client.db, {
      organizationId: owner!.organizationId,
      membershipId: member.id,
      operationId,
      objectBucket: retentionObjectBucket,
    });
    expect(databaseFinalized).toMatchObject({
      outcome: "cleanup_pending",
      objectCount: 1,
      deletedResources: { files: 1, connections: 1, personalWorkspaces: 1 },
    });
    const objects = await listOrganizationRetentionDeletionObjects(client.db, {
      organizationId: owner!.organizationId,
      membershipId: member.id,
      operationId,
      objectBucket: retentionObjectBucket,
      limit: 100,
    });
    expect(objects).toEqual([
      {
        objectKind: "file",
        sourceId: fileId,
        objectBucket: retentionObjectBucket,
        objectKey,
      },
    ]);
    await expectSqlState(
      () =>
        finalizeOrganizationRetentionDeletion(client!.db, {
          organizationId: owner!.organizationId,
          membershipId: member.id,
          operationId,
          objectBucket: "reconfigured-retention-bucket",
        }),
      "40001",
    );
    await expectSqlState(
      () =>
        listOrganizationRetentionDeletionObjects(client!.db, {
          organizationId: owner!.organizationId,
          membershipId: member.id,
          operationId,
          objectBucket: "reconfigured-retention-bucket",
          limit: 100,
        }),
      "40001",
    );
    await expectSqlState(
      () =>
        recordOrganizationRetentionObjectDeleted(client!.db, {
          organizationId: owner!.organizationId,
          membershipId: member.id,
          operationId,
          objectKind: "file",
          sourceId: fileId,
          objectBucket: "reconfigured-retention-bucket",
          objectKey,
        }),
      "40001",
    );
    await expectSqlState(
      () =>
        completeOrganizationRetentionDeletion(client!.db, {
          organizationId: owner!.organizationId,
          membershipId: member.id,
          operationId,
          objectBucket: "reconfigured-retention-bucket",
        }),
      "40001",
    );
    await expectSqlState(
      () =>
        completeOrganizationRetentionDeletion(client!.db, {
          organizationId: owner!.organizationId,
          membershipId: member.id,
          operationId,
          objectBucket: retentionObjectBucket,
        }),
      "55000",
    );
    await expectSqlState(
      () =>
        recordOrganizationRetentionObjectDeleted(client!.db, {
          organizationId: owner!.organizationId,
          membershipId: member.id,
          operationId,
          objectKind: "file",
          sourceId: fileId,
          objectBucket: retentionObjectBucket,
          objectKey: `${objectKey}-forged`,
        }),
      "42501",
    );
    expect(
      await recordOrganizationRetentionObjectDeleted(client.db, {
        organizationId: owner!.organizationId,
        membershipId: member.id,
        operationId,
        objectKind: "file",
        sourceId: fileId,
        objectBucket: retentionObjectBucket,
        objectKey,
      }),
    ).toBe(true);
    expect(
      await recordOrganizationRetentionObjectDeleted(client.db, {
        organizationId: owner!.organizationId,
        membershipId: member.id,
        operationId,
        objectKind: "file",
        sourceId: fileId,
        objectBucket: retentionObjectBucket,
        objectKey,
      }),
    ).toBe(false);
    const completed = await completeOrganizationRetentionDeletion(client.db, {
      organizationId: owner!.organizationId,
      membershipId: member.id,
      operationId,
      objectBucket: retentionObjectBucket,
    });
    expect(completed).toMatchObject({
      membershipId: member.id,
      operationId,
      outcome: "completed",
      deletedResources: { files: 1, connections: 1, personalWorkspaces: 1 },
    });
    expect(
      await completeOrganizationRetentionDeletion(client.db, {
        organizationId: owner!.organizationId,
        membershipId: member.id,
        operationId,
        objectBucket: retentionObjectBucket,
      }),
    ).toEqual(completed);
    expect(
      await claimOrganizationRetentionDeletion(client.db, {
        organizationId: owner!.organizationId,
        operationId,
      }),
    ).toEqual(claim);
    const [evidence] = await shared.admin<
      Array<{
        workspaceCount: number;
        membershipCount: number;
        personalWorkspaceId: string | null;
        lifecycleEvents: number;
        retentionEvents: number;
        objectObligations: number;
        objectDeletionReceipts: number;
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
        (select count(*)::int from organization_user_retention_object_obligations
          where membership_id = ${member.id}) as "objectObligations",
        (select count(*)::int from organization_user_retention_object_deletion_receipts
          where membership_id = ${member.id}) as "objectDeletionReceipts",
        (select count(*)::int from connections where id = ${personalConnection.id}) as "connectionCount"`;
    expect(evidence).toEqual({
      workspaceCount: 0,
      membershipCount: 1,
      personalWorkspaceId: null,
      lifecycleEvents: 2,
      retentionEvents: 2,
      objectObligations: 1,
      objectDeletionReceipts: 1,
      connectionCount: 0,
    });
  });

  test("replays an exact concurrent retention completion after the deletion-row lock", async () => {
    if (!shared || !client) return;
    const fixture = await provisionOrganizationMember("retention-complete-race");
    const member = await expireOrganizationMember(fixture);
    const operationId = crypto.randomUUID();
    await claimOrganizationRetentionDeletion(client.db, {
      organizationId: fixture.owner.organizationId,
      operationId,
    });
    await finalizeOrganizationRetentionDeletion(client.db, {
      organizationId: fixture.owner.organizationId,
      membershipId: member.id,
      operationId,
      objectBucket: retentionObjectBucket,
    });

    let releaseLock!: () => void;
    let lockAcquired!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const locking = shared.admin.begin(async (tx) => {
      await tx`select 1 from organization_user_retention_deletions
        where account_id = ${fixture.owner.organizationId} and membership_id = ${member.id}
        for update`;
      lockAcquired();
      await release;
    });
    await acquired;
    let settled = 0;
    const completions = [0, 1].map(() =>
      completeOrganizationRetentionDeletion(client!.db, {
        organizationId: fixture.owner.organizationId,
        membershipId: member.id,
        operationId,
        objectBucket: retentionObjectBucket,
      }).finally(() => {
        settled += 1;
      }),
    );
    await Bun.sleep(75);
    expect(settled).toBe(0);
    releaseLock();
    await locking;
    const [first, second] = await Promise.all(completions);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      membershipId: member.id,
      operationId,
      outcome: "completed",
    });
    const [completedEventCount] = await shared.admin<Array<{ completedEvents: number }>>`
      select count(*)::int as "completedEvents"
      from organization_user_retention_deletion_events
      where account_id = ${fixture.owner.organizationId}
        and membership_id = ${member.id}
        and operation_id = ${operationId}
        and kind = 'completed'`;
    expect(completedEventCount?.completedEvents).toBe(1);
  });

  test("serializes exact concurrent retention failure and database finalization retries", async () => {
    if (!shared || !client) return;
    const failedFixture = await provisionOrganizationMember("retention-concurrent-fail");
    const failedMember = await expireOrganizationMember(failedFixture);
    const failedOperationId = crypto.randomUUID();
    await claimOrganizationRetentionDeletion(client.db, {
      organizationId: failedFixture.owner.organizationId,
      operationId: failedOperationId,
    });

    let releaseFailureLock!: () => void;
    let failureLockAcquired!: () => void;
    const releaseFailure = new Promise<void>((resolve) => {
      releaseFailureLock = resolve;
    });
    const acquiredFailure = new Promise<void>((resolve) => {
      failureLockAcquired = resolve;
    });
    const failureLock = shared.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(
        ${`organization-retention:${failedOperationId}`}, 0
      ))`;
      failureLockAcquired();
      await releaseFailure;
    });
    await acquiredFailure;
    let failedSettled = 0;
    const failures = [0, 1].map(() =>
      failOrganizationRetentionDeletion(client!.db, {
        organizationId: failedFixture.owner.organizationId,
        membershipId: failedMember.id,
        operationId: failedOperationId,
        reasonCode: "concurrent_cleanup",
      }).finally(() => {
        failedSettled += 1;
      }),
    );
    await Bun.sleep(75);
    expect(failedSettled).toBe(0);
    releaseFailureLock();
    await failureLock;
    expect(await Promise.all(failures)).toEqual([true, true]);

    const finalizedFixture = await provisionOrganizationMember("retention-concurrent-finalize");
    const finalizedMember = await expireOrganizationMember(finalizedFixture);
    const finalizedOperationId = crypto.randomUUID();
    await claimOrganizationRetentionDeletion(client.db, {
      organizationId: finalizedFixture.owner.organizationId,
      operationId: finalizedOperationId,
    });
    let releaseFinalizationLock!: () => void;
    let finalizationLockAcquired!: () => void;
    const releaseFinalization = new Promise<void>((resolve) => {
      releaseFinalizationLock = resolve;
    });
    const acquiredFinalization = new Promise<void>((resolve) => {
      finalizationLockAcquired = resolve;
    });
    const finalizationLock = shared.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(
        ${`organization-retention:${finalizedOperationId}`}, 0
      ))`;
      finalizationLockAcquired();
      await releaseFinalization;
    });
    await acquiredFinalization;
    let finalizedSettled = 0;
    const finalizations = [0, 1].map(() =>
      finalizeOrganizationRetentionDeletion(client!.db, {
        organizationId: finalizedFixture.owner.organizationId,
        membershipId: finalizedMember.id,
        operationId: finalizedOperationId,
        objectBucket: retentionObjectBucket,
      }).finally(() => {
        finalizedSettled += 1;
      }),
    );
    await Bun.sleep(75);
    expect(finalizedSettled).toBe(0);
    releaseFinalizationLock();
    await finalizationLock;
    const [firstFinalization, secondFinalization] = await Promise.all(finalizations);
    expect(secondFinalization).toEqual(firstFinalization);
    expect(firstFinalization).toMatchObject({
      membershipId: finalizedMember.id,
      operationId: finalizedOperationId,
      objectBucket: retentionObjectBucket,
    });
  });

  test("rejects a legacy File bucket mismatch before database finalization", async () => {
    if (!shared || !client) return;
    const fixture = await provisionOrganizationMember("retention-bucket-mismatch");
    const workspaceId = fixture.member.personalWorkspaceId!;
    const fileId = crypto.randomUUID();
    await shared.admin`
      insert into files (
        id, account_id, workspace_id, status, filename, safe_filename,
        content_type, size_bytes, bucket, object_key
      ) values (
        ${fileId}, ${fixture.owner.organizationId}, ${workspaceId}, 'ready',
        'legacy-bucket.txt', 'legacy-bucket.txt', 'text/plain', 8,
        'legacy-retention-bucket', ${`retention/${crypto.randomUUID()}`}
      )`;
    const member = await expireOrganizationMember(fixture);
    const operationId = crypto.randomUUID();
    await claimOrganizationRetentionDeletion(client.db, {
      organizationId: fixture.owner.organizationId,
      operationId,
    });
    await expectSqlState(
      () =>
        finalizeOrganizationRetentionDeletion(client!.db, {
          organizationId: fixture.owner.organizationId,
          membershipId: member.id,
          operationId,
          objectBucket: retentionObjectBucket,
        }),
      "55000",
    );
    const [evidence] = await shared.admin<
      Array<{
        workspaceCount: number;
        fileCount: number;
        obligationCount: number;
        databaseFinalizedAt: string | null;
      }>
    >`
      select
        (select count(*)::int from workspaces where id = ${workspaceId}) as "workspaceCount",
        (select count(*)::int from files where id = ${fileId}) as "fileCount",
        (select count(*)::int from organization_user_retention_object_obligations
          where membership_id = ${member.id}) as "obligationCount",
        (select database_finalized_at::text from organization_user_retention_deletions
          where membership_id = ${member.id}) as "databaseFinalizedAt"`;
    expect(evidence).toEqual({
      workspaceCount: 1,
      fileCount: 1,
      obligationCount: 0,
      databaseFinalizedAt: null,
    });
  });

  test("fails database finalization before object deletion when a retained non-document consumer exists", async () => {
    if (!shared || !client) return;
    const fixture = await provisionOrganizationMember("retained-consumer");
    const workspaceId = fixture.member.personalWorkspaceId!;
    const fileId = crypto.randomUUID();
    const objectKey = `retention/${crypto.randomUUID()}`;
    await shared.admin`
      insert into files (
        id, account_id, workspace_id, status, filename, safe_filename,
        content_type, size_bytes, bucket, object_key
      ) values (
        ${fileId}, ${fixture.owner.organizationId}, ${workspaceId}, 'ready',
        'retained.png', 'retained.png', 'image/png', 8, 'test', ${objectKey}
      )`;
    await insertRetainedScreenshotReference({
      accountId: fixture.owner.organizationId,
      workspaceId,
      fileId,
    });
    const member = await expireOrganizationMember(fixture);
    const operationId = crypto.randomUUID();
    await claimOrganizationRetentionDeletion(client.db, {
      organizationId: fixture.owner.organizationId,
      operationId,
    });
    await expectSqlState(
      () =>
        finalizeOrganizationRetentionDeletion(client!.db, {
          organizationId: fixture.owner.organizationId,
          membershipId: member.id,
          operationId,
          objectBucket: retentionObjectBucket,
        }),
      "23503",
    );
    const [evidence] = await shared.admin<
      Array<{
        workspaceCount: number;
        fileCount: number;
        consumerCount: number;
        obligationCount: number;
        databaseFinalizedAt: string | null;
      }>
    >`
      select
        (select count(*)::int from workspaces where id = ${workspaceId}) as "workspaceCount",
        (select count(*)::int from files where id = ${fileId}) as "fileCount",
        (select count(*)::int from retained_screenshot_artifacts
          where artifact_id = ${fileId}) as "consumerCount",
        (select count(*)::int from organization_user_retention_object_obligations
          where membership_id = ${member.id}) as "obligationCount",
        (select database_finalized_at::text from organization_user_retention_deletions
          where membership_id = ${member.id}) as "databaseFinalizedAt"`;
    expect(evidence).toEqual({
      workspaceCount: 1,
      fileCount: 1,
      consumerCount: 1,
      obligationCount: 0,
      databaseFinalizedAt: null,
    });
  });

  test("serializes a concurrent retained reference before database finalization", async () => {
    if (!shared || !client) return;
    const fixture = await provisionOrganizationMember("retained-race");
    const workspaceId = fixture.member.personalWorkspaceId!;
    const fileId = crypto.randomUUID();
    await shared.admin`
      insert into files (
        id, account_id, workspace_id, status, filename, safe_filename,
        content_type, size_bytes, bucket, object_key
      ) values (
        ${fileId}, ${fixture.owner.organizationId}, ${workspaceId}, 'ready',
        'racing.png', 'racing.png', 'image/png', 8, 'test',
        ${`retention/${crypto.randomUUID()}`}
      )`;
    const member = await expireOrganizationMember(fixture);
    const operationId = crypto.randomUUID();
    await claimOrganizationRetentionDeletion(client.db, {
      organizationId: fixture.owner.organizationId,
      operationId,
    });

    let releaseInsert!: () => void;
    let insertionStarted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    const started = new Promise<void>((resolve) => {
      insertionStarted = resolve;
    });
    const inserting = shared.admin.begin(async (tx) => {
      await insertRetainedScreenshotReference({
        accountId: fixture.owner.organizationId,
        workspaceId,
        fileId,
        db: tx,
      });
      insertionStarted();
      await release;
    });
    await started;
    let finalizerSettled = false;
    const finalizing = finalizeOrganizationRetentionDeletion(client.db, {
      organizationId: fixture.owner.organizationId,
      membershipId: member.id,
      operationId,
      objectBucket: retentionObjectBucket,
    }).finally(() => {
      finalizerSettled = true;
    });
    await Bun.sleep(75);
    expect(finalizerSettled).toBe(false);
    releaseInsert();
    await inserting;
    await expectSqlState(() => finalizing, "23503");

    const [evidence] = await shared.admin<
      Array<{ workspaceCount: number; fileCount: number; obligationCount: number }>
    >`
      select
        (select count(*)::int from workspaces where id = ${workspaceId}) as "workspaceCount",
        (select count(*)::int from files where id = ${fileId}) as "fileCount",
        (select count(*)::int from organization_user_retention_object_obligations
          where membership_id = ${member.id}) as "obligationCount"`;
    expect(evidence).toEqual({ workspaceCount: 1, fileCount: 1, obligationCount: 0 });
  });

  test("fails closed on an unrepresentable external-object inventory", async () => {
    if (!shared || !client) return;
    const fixture = await provisionOrganizationMember("malformed-inventory");
    const workspaceId = fixture.member.personalWorkspaceId!;
    const session = await createSession(client.db, {
      accountId: fixture.owner.organizationId,
      workspaceId,
      initialMessage: "malformed capture inventory",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: fixture.targetSubject },
      subjectId: fixture.targetSubject,
      model: "test-model",
      sandboxBackend: "none",
    });
    await shared.admin`
      insert into workspace_captures (
        id, account_id, workspace_id, session_id, revision, lease_epoch, state, blob_keys
      ) values (
        ${crypto.randomUUID()}, ${fixture.owner.organizationId}, ${workspaceId},
        ${session.id}, 1, 1, 'available', ${shared.admin.json({ unknown: "shape" })}
      )`;
    const member = await expireOrganizationMember(fixture);
    const operationId = crypto.randomUUID();
    await claimOrganizationRetentionDeletion(client.db, {
      organizationId: fixture.owner.organizationId,
      operationId,
    });
    await expectSqlState(
      () =>
        finalizeOrganizationRetentionDeletion(client!.db, {
          organizationId: fixture.owner.organizationId,
          membershipId: member.id,
          operationId,
          objectBucket: retentionObjectBucket,
        }),
      "55000",
    );
    const [evidence] = await shared.admin<
      Array<{ workspaceCount: number; databaseFinalizedAt: string | null }>
    >`
      select
        (select count(*)::int from workspaces where id = ${workspaceId}) as "workspaceCount",
        (select database_finalized_at::text from organization_user_retention_deletions
          where membership_id = ${member.id}) as "databaseFinalizedAt"`;
    expect(evidence).toEqual({ workspaceCount: 1, databaseFinalizedAt: null });
  });

  test("transfers session recording and workspace capture keys into immutable obligations", async () => {
    if (!shared || !client) return;
    const fixture = await provisionOrganizationMember("external-obligations");
    const workspaceId = fixture.member.personalWorkspaceId!;
    const session = await createSession(client.db, {
      accountId: fixture.owner.organizationId,
      workspaceId,
      initialMessage: "external cleanup obligations",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: fixture.targetSubject },
      subjectId: fixture.targetSubject,
      model: "test-model",
      sandboxBackend: "none",
    });
    const recordingId = crypto.randomUUID();
    const captureId = crypto.randomUUID();
    const recordingKey = `recordings/${crypto.randomUUID()}`;
    const manifestKey = `captures/${crypto.randomUUID()}/manifest`;
    const treeKey = `captures/${crypto.randomUUID()}/tree`;
    const blobKeys = [
      `captures/${crypto.randomUUID()}/blob-1`,
      `captures/${crypto.randomUUID()}/blob-2`,
    ];
    await shared.admin`
      insert into session_recordings (
        id, account_id, workspace_id, session_id, state, mode, codec,
        storage_key, size_bytes, duration_seconds, width, height, finalized_at
      ) values (
        ${recordingId}, ${fixture.owner.organizationId}, ${workspaceId}, ${session.id},
        'available', 'manual', 'h264-mp4', ${recordingKey}, 8, 1, 1, 1, now()
      )`;
    await shared.admin`
      insert into workspace_captures (
        id, account_id, workspace_id, session_id, revision, lease_epoch, state,
        manifest_key, tree_index_key, blob_keys
      ) values (
        ${captureId}, ${fixture.owner.organizationId}, ${workspaceId}, ${session.id},
        1, 1, 'available', ${manifestKey}, ${treeKey}, ${shared.admin.json(blobKeys)}
      )`;
    const member = await expireOrganizationMember(fixture);
    const operationId = crypto.randomUUID();
    await claimOrganizationRetentionDeletion(client.db, {
      organizationId: fixture.owner.organizationId,
      operationId,
    });
    const finalized = await finalizeOrganizationRetentionDeletion(client.db, {
      organizationId: fixture.owner.organizationId,
      membershipId: member.id,
      operationId,
      objectBucket: retentionObjectBucket,
    });
    expect(finalized.objectCount).toBe(5);
    const obligations = await listOrganizationRetentionDeletionObjects(client.db, {
      organizationId: fixture.owner.organizationId,
      membershipId: member.id,
      operationId,
      objectBucket: retentionObjectBucket,
      limit: 100,
    });
    expect(obligations).toEqual([
      {
        objectKind: "session_recording",
        sourceId: recordingId,
        objectBucket: retentionObjectBucket,
        objectKey: recordingKey,
      },
      {
        objectKind: "workspace_capture_blob",
        sourceId: `${captureId}:1`,
        objectBucket: retentionObjectBucket,
        objectKey: blobKeys[0]!,
      },
      {
        objectKind: "workspace_capture_blob",
        sourceId: `${captureId}:2`,
        objectBucket: retentionObjectBucket,
        objectKey: blobKeys[1]!,
      },
      {
        objectKind: "workspace_capture_manifest",
        sourceId: captureId,
        objectBucket: retentionObjectBucket,
        objectKey: manifestKey,
      },
      {
        objectKind: "workspace_capture_tree_index",
        sourceId: captureId,
        objectBucket: retentionObjectBucket,
        objectKey: treeKey,
      },
    ]);
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
    await expectSqlState(
      () =>
        claimOrganizationRetentionDeletion(client!.db, {
          organizationId: owner!.organizationId,
          operationId: operationIds[0]!,
          excludedMembershipIds: [claims[0]!.membershipId],
        }),
      "23505",
    );
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

  test("rejects null retention bounds and malformed failed evidence at the app boundary", async () => {
    if (!client) return;
    const ownerId = `retention-null-${crypto.randomUUID()}`;
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
            return await rawRows(
              scopedDb,
              sql`select preview_organization_retention_deletions(
                ${owner!.organizationId}::uuid, null::integer
              )`,
            );
          },
        ),
      "22023",
    );
    await expectSqlState(
      () =>
        withRlsContext(
          client!.db,
          { accountId: owner!.organizationId, workspaceId: null },
          async (scopedDb) => {
            await setSubjectRlsContext(scopedDb, ownerSubject);
            return await rawRows(
              scopedDb,
              sql`select list_organization_retention_deletion_objects(
                ${owner!.organizationId}::uuid, ${crypto.randomUUID()}::uuid,
                ${crypto.randomUUID()}::uuid, ${retentionObjectBucket}, null::integer
              )`,
            );
          },
        ),
      "22023",
    );
    await expectSqlState(
      () =>
        withRlsContext(
          client!.db,
          { accountId: owner!.organizationId, workspaceId: null },
          async (scopedDb) => {
            await setSubjectRlsContext(scopedDb, ownerSubject);
            return await rawRows(
              scopedDb,
              sql`select fail_organization_retention_deletion(
                ${owner!.organizationId}::uuid, ${crypto.randomUUID()}::uuid,
                ${crypto.randomUUID()}::uuid, null::text
              )`,
            );
          },
        ),
      "22023",
    );
  });

  test("keeps revoked membership terminal while preserving unrelated organization grants", async () => {
    if (!shared || !client) return;
    const userId = `terminal-self-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    await provisionSelf(userId);
    const [selfMembership] = await listSelfOrganizationMemberships(client.db, subjectId);
    const secondOwnerSubject = `user:second-owner-${crypto.randomUUID()}`;
    const secondOwnerId = crypto.randomUUID();
    const secondOwnerWorkspaceId = crypto.randomUUID();
    await shared.admin`
      insert into workspaces (id, account_id, name, external_source, external_id)
      values (
        ${secondOwnerWorkspaceId}, ${selfMembership!.organizationId}, 'Second owner personal',
        'test', ${crypto.randomUUID()}
      )`;
    await shared.admin`
      insert into workspace_inference_controls (account_id, workspace_id)
      values (${selfMembership!.organizationId}, ${secondOwnerWorkspaceId})`;
    await shared.admin`
      insert into organization_memberships (
        id, account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${secondOwnerId}, ${selfMembership!.organizationId}, ${secondOwnerSubject},
        'owner', 'active', ${secondOwnerWorkspaceId}
      )`;

    const otherOwnerId = `terminal-other-owner-${crypto.randomUUID()}`;
    const otherOwnerSubject = `user:${otherOwnerId}`;
    await provisionSelf(otherOwnerId);
    const [otherOwner] = await listSelfOrganizationMemberships(client.db, otherOwnerSubject);
    const otherInvitation = await createOrganizationInvitation(client.db, {
      organizationId: otherOwner!.organizationId,
      actorSubjectId: otherOwnerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: subjectId,
      targetEmail: `${userId}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const otherMember = (
      await acceptOrganizationInvitation(client.db, {
        organizationId: otherOwner!.organizationId,
        actorSubjectId: subjectId,
        operationId: crypto.randomUUID(),
        invitationId: otherInvitation.id,
        expectedRevision: otherInvitation.revision,
      })
    ).membership;
    const ordinaryWorkspaceId = crypto.randomUUID();
    await shared.admin`
      insert into workspaces (id, account_id, name, external_source, external_id)
      values (${ordinaryWorkspaceId}, ${otherOwner!.organizationId}, 'Other shared', 'test', ${crypto.randomUUID()})`;
    await shared.admin`
      insert into workspace_inference_controls (account_id, workspace_id)
      values (${otherOwner!.organizationId}, ${ordinaryWorkspaceId})`;
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${otherOwner!.organizationId}, ${ordinaryWorkspaceId}, ${subjectId}, 'member')`;

    const suspendedSelf = await updateOrganizationMember(client.db, {
      organizationId: selfMembership!.organizationId,
      actorSubjectId: secondOwnerSubject,
      operationId: crypto.randomUUID(),
      membershipId: selfMembership!.id,
      transition: {
        kind: "suspend",
        expectedAuthorizationRevision: selfMembership!.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    expect(suspendedSelf.status).toBe("suspended");
    const projected = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: userId,
    });
    expect(
      projected.accessContext.workspaceGrants.some(
        (grant) => grant.workspaceId === ordinaryWorkspaceId,
      ),
    ).toBe(true);
    expect(
      projected.accessContext.workspaceGrants.some(
        (grant) => grant.workspaceId === otherMember.personalWorkspaceId,
      ),
    ).toBe(true);
    expect(
      projected.accessContext.workspaceGrants.some(
        (grant) => grant.accountId === selfMembership!.organizationId,
      ),
    ).toBe(false);
    expect(projected.accessContext.defaultAccountId).toBe(otherOwner!.organizationId);
    expect(projected.accessContext.defaultWorkspaceId).not.toBeNull();
    expect(
      projected.accessContext.workspaceGrants.some(
        (grant) =>
          grant.accountId === projected.accessContext.defaultAccountId &&
          grant.workspaceId === projected.accessContext.defaultWorkspaceId,
      ),
    ).toBe(true);

    const reactivatedSelf = await updateOrganizationMember(client.db, {
      organizationId: selfMembership!.organizationId,
      actorSubjectId: secondOwnerSubject,
      operationId: crypto.randomUUID(),
      membershipId: selfMembership!.id,
      transition: {
        kind: "reactivate",
        expectedAuthorizationRevision: suspendedSelf.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    const revokedSelf = await updateOrganizationMember(client.db, {
      organizationId: selfMembership!.organizationId,
      actorSubjectId: secondOwnerSubject,
      operationId: crypto.randomUUID(),
      membershipId: selfMembership!.id,
      transition: {
        kind: "offboard",
        expectedAuthorizationRevision: reactivatedSelf.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    expect(revokedSelf.status).toBe("revoked");
    await expectSqlState(
      () =>
        createOrganizationInvitation(client!.db, {
          organizationId: selfMembership!.organizationId,
          actorSubjectId: secondOwnerSubject,
          operationId: crypto.randomUUID(),
          targetSubjectId: subjectId,
          targetEmail: `${userId}@example.test`,
          role: "member",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      "55000",
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
