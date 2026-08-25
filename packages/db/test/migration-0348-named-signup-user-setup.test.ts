import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFileSync } from "node:fs";

import {
  completeSelfServiceOrganizationSetup,
  completeOrganizationUserSetup,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  ensureOrganizationUserSetupIntent,
  getSelfServiceOrganizationOnboardingState,
  listSelfOrganizationInvitations,
  listSelfOrganizationMemberships,
  nestedPostgresSqlState,
  preflightOrganizationUserSetup,
  type DbClient,
} from "../src";
import {
  FORCE_RLS_TABLES,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
} from "../src/runtime-posture";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0348-named-signup-user-setup");
  if (!shared && requireRealDatabase) throw new Error("migration 0348 requires PostgreSQL");
  if (shared) client = createDb(shared.appUrl, { max: 4 });
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

describe("migration 0348 named signup and invitation setup", () => {
  test("keeps both setup authorities lifecycle-only and preserves the organization lock order", async () => {
    const source = readFileSync(
      new URL("../drizzle/0348_named_signup_and_user_setup.sql", import.meta.url),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(source.match(/FROM pg_stat_activity/g)).toHaveLength(2);
    expect(source).toContain("requires an explicit application database role list");
    expect(source).toContain("LOCK TABLE managed_accounts IN ACCESS EXCLUSIVE MODE");
    expect(source).toContain("token_digest text NOT NULL");
    expect(source).not.toContain("token_plaintext");
    expect(source).not.toMatch(
      /FROM managed_accounts account\s+WHERE account\.id = setup\.account_id FOR UPDATE/i,
    );
    expect(source).toMatch(
      /FROM managed_accounts account\s+WHERE account\.id = locked_account_id_value FOR KEY SHARE/i,
    );
    expect(source).toContain("REVOKE ALL ON TABLE organization_user_setup_intents FROM PUBLIC");
    expect(source).toContain(
      "REVOKE ALL ON TABLE self_service_organization_setup_receipts FROM PUBLIC",
    );
    expect(source).toContain("CREATE FUNCTION complete_self_service_organization_setup");
    expect(source).not.toContain("onboarding_organization_name");
    expect(source).not.toContain("onboarding_workspace_name");
    const completionSource = source.slice(
      source.indexOf("CREATE FUNCTION complete_organization_user_setup"),
    );
    expect(completionSource.indexOf("organization-invitation-email:")).toBeGreaterThan(-1);
    expect(completionSource.indexOf("FOR locked_account_id_value IN")).toBeGreaterThan(
      completionSource.indexOf("organization-invitation-email:"),
    );
    expect(completionSource.indexOf("organization-membership:")).toBeGreaterThan(
      completionSource.indexOf("FOR locked_account_id_value IN"),
    );
    expect(
      completionSource.indexOf("WHERE candidate.token_digest = digest_value\n  FOR UPDATE"),
    ).toBeGreaterThan(completionSource.indexOf("organization-membership:"));
    for (const table of [
      "organization_user_setup_intents",
      "self_service_organization_setup_receipts",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
    }
    for (const routine of [
      "complete_self_service_organization_setup(jsonb)",
      "ensure_organization_user_setup_intent(jsonb)",
      "preflight_organization_user_setup(text)",
      "complete_organization_user_setup(jsonb)",
    ] as const) {
      expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(routine);
    }
    if (shared) {
      const [installed] = await shared.admin<Array<{ definition: string }>>`
        select pg_catalog.pg_get_functiondef(
          'complete_organization_user_setup(jsonb)'::regprocedure
        ) as definition`;
      expect(installed?.definition).toContain("FOR locked_account_id_value IN");
      expect(installed?.definition).toContain("ORDER BY relevant.account_id");
    }
  });

  test("creates one active organization with only its canonical personal workspace after sign-in", async () => {
    if (!shared || !client) return;
    const userId = crypto.randomUUID();
    const email = `${userId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${userId}, 'Signup owner', ${email}, true)`;

    const before = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email,
      name: "Signup owner",
      emailVerified: true,
      provisionFallbackOrganization: false,
    });
    expect(before.accessContext.defaultAccountId).toBeNull();
    expect(before.accessContext.defaultWorkspaceId).toBeNull();

    const operationId = crypto.randomUUID();
    const input = {
      authUserId: userId,
      actorSubjectId: `user:${userId}`,
      organizationName: "Northwind Research",
      operationId,
      requestFingerprint: "a".repeat(64),
    };
    const [completed, concurrentRetry] = await Promise.all([
      completeSelfServiceOrganizationSetup(client.db, input),
      completeSelfServiceOrganizationSetup(client.db, input),
    ]);
    expect(concurrentRetry).toEqual(completed);
    expect(await completeSelfServiceOrganizationSetup(client.db, input)).toEqual(completed);
    await expectSqlState(
      () =>
        completeSelfServiceOrganizationSetup(client!.db, {
          ...input,
          requestFingerprint: "b".repeat(64),
        }),
      "23505",
    );
    const [durable] = await shared.admin<
      Array<{
        organizationName: string;
        workspaces: number;
        workspaceMemberships: number;
        role: string;
        status: string;
        personalWorkspaceId: string;
      }>
    >`
      select account.name as "organizationName",
        (select count(*)::int from workspaces where account_id = account.id) as workspaces,
        (select count(*)::int from workspace_memberships where account_id = account.id)
          as "workspaceMemberships",
        membership.role, membership.status,
        membership.personal_workspace_id as "personalWorkspaceId"
      from managed_accounts account
      join organization_memberships membership on membership.account_id = account.id
        and membership.subject_id = ${`user:${userId}`}
      where account.id = ${completed.organizationId}`;
    expect(durable).toEqual({
      organizationName: "Northwind Research",
      workspaces: 1,
      workspaceMemberships: 0,
      role: "owner",
      status: "active",
      personalWorkspaceId: completed.personalWorkspaceId,
    });
    await expectSqlState(
      () =>
        completeSelfServiceOrganizationSetup(client!.db, {
          ...input,
          operationId: crypto.randomUUID(),
        }),
      "23505",
    );
  });

  test("atomically creates one verified credential, accepts its invitation, and converges retries", async () => {
    if (!shared || !client) return;
    const ownerId = crypto.randomUUID();
    const ownerEmail = `${ownerId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${ownerId}, 'Setup owner', ${ownerEmail}, true)`;
    const owner = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: ownerId,
      email: ownerEmail,
      name: "Setup owner",
      emailVerified: true,
    });
    const ownerSubject = `user:${ownerId}`;
    const [ownerMembership] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    expect(ownerMembership).toBeDefined();
    const organizationId = ownerMembership!.organizationId;
    const sharedWorkspaceId = owner.accessContext.defaultWorkspaceId!;
    const invitationOperationId = crypto.randomUUID();
    const invitedEmail = `provisioned-${crypto.randomUUID()}@example.test`;
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: invitationOperationId,
      targetSubjectId: null,
      targetEmail: invitedEmail,
      targetName: "Provisioned teammate",
      initialWorkspaceIds: [sharedWorkspaceId],
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const tokenDigest = crypto.randomUUID().replaceAll("-", "").repeat(2);
    await ensureOrganizationUserSetupIntent(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      invitationId: invitation.id,
      tokenDigest,
      expiresAt: invitation.expiresAt,
    });
    expect(await preflightOrganizationUserSetup(client.db, tokenDigest)).toBe("pending");
    expect(await preflightOrganizationUserSetup(client.db, "0".repeat(64))).toBe("unavailable");
    const [before] = await shared.admin<Array<{ users: number; plaintext: number }>>`
      select
        (select count(*)::int from auth_users where lower(email) = ${invitedEmail}) as users,
        (select count(*)::int from organization_user_setup_intents
          where token_digest = ${tokenDigest} and token_digest = ${"plain-setup-token"}) as plaintext`;
    expect(before).toEqual({ users: 0, plaintext: 0 });

    const operationId = crypto.randomUUID();
    const fingerprint = "a".repeat(64);
    const authUserId = crypto.randomUUID();
    const passwordHash = `scrypt:${"b".repeat(96)}`;
    expect(
      await completeOrganizationUserSetup(client.db, {
        tokenDigest,
        operationId,
        requestFingerprint: fingerprint,
        authUserId,
        name: "Provisioned teammate",
        passwordHash,
      }),
    ).toEqual({ status: "complete" });
    expect(await preflightOrganizationUserSetup(client.db, tokenDigest)).toBe("completed");
    expect(
      await completeOrganizationUserSetup(client.db, {
        tokenDigest,
        operationId,
        requestFingerprint: fingerprint,
        authUserId: crypto.randomUUID(),
        name: "Ignored after commit",
        passwordHash: `scrypt:${"c".repeat(96)}`,
      }),
    ).toEqual({ status: "complete" });

    const expiredInvitation = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: null,
      targetEmail: `expired-${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const expiredDigest = crypto.randomUUID().replaceAll("-", "").repeat(2);
    await ensureOrganizationUserSetupIntent(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      invitationId: expiredInvitation.id,
      tokenDigest: expiredDigest,
      expiresAt: expiredInvitation.expiresAt,
    });
    await shared.admin`
      update organization_user_setup_intents
      set expires_at = clock_timestamp() - interval '1 minute'
      where token_digest = ${expiredDigest}`;
    expect(await preflightOrganizationUserSetup(client.db, expiredDigest)).toBe("unavailable");

    const [durable] = await shared.admin<
      Array<{
        verified: boolean;
        password: string | null;
        setupStatus: string;
        memberships: number;
        workspaceGrants: number;
        fallbackOrganizations: number;
      }>
    >`
      select auth_user.email_verified as verified, identity.password,
        setup.status as "setupStatus",
        (select count(*)::int from organization_memberships membership
          where membership.subject_id = ${`user:${authUserId}`} and membership.status = 'active')
          as memberships,
        (select count(*)::int from workspace_memberships membership
          where membership.subject_id = ${`user:${authUserId}`}
            and membership.workspace_id = ${sharedWorkspaceId}) as "workspaceGrants",
        (select count(*)::int from managed_accounts account
          where account.external_source = 'better-auth:user'
            and account.external_id = ${authUserId}) as "fallbackOrganizations"
      from auth_users auth_user
      join auth_identities identity on identity.user_id = auth_user.id
        and identity.provider_id = 'credential'
      join organization_user_setup_intents setup
        on setup.completed_auth_user_id = auth_user.id
      where auth_user.id = ${authUserId}`;
    expect(durable).toEqual({
      verified: true,
      password: passwordHash,
      setupStatus: "completed",
      memberships: 1,
      workspaceGrants: 1,
      fallbackOrganizations: 0,
    });

    await expectSqlState(
      () =>
        completeOrganizationUserSetup(client!.db, {
          tokenDigest,
          operationId,
          requestFingerprint: "d".repeat(64),
          authUserId,
          name: "Changed",
          passwordHash,
        }),
      "23505",
    );
  });

  test("lets a verified user with only terminal membership choose a named pending invitation", async () => {
    if (!shared || !client) return;
    const ownerId = crypto.randomUUID();
    const ownerEmail = `${ownerId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${ownerId}, 'Invitation owner', ${ownerEmail}, true)`;
    const owner = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: ownerId,
      email: ownerEmail,
      name: "Invitation owner",
      emailVerified: true,
    });
    const ownerSubject = `user:${ownerId}`;
    const [ownerMembership] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    const organizationId = ownerMembership!.organizationId;
    await shared.admin`
      update managed_accounts set name = 'Named invitation organization'
      where id = ${organizationId}`;

    for (const priorStatus of ["suspended", "revoked"] as const) {
      const targetId = crypto.randomUUID();
      const targetEmail = `${priorStatus}-${targetId}@example.test`;
      await shared.admin`
        insert into auth_users (id, name, email, email_verified)
        values (${targetId}, ${`${priorStatus} target`}, ${targetEmail}, true)`;
      await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
        userId: targetId,
        email: targetEmail,
        name: `${priorStatus} target`,
        emailVerified: true,
      });
      await shared.admin`
        update organization_memberships set
          status = ${priorStatus},
          revoked_at = ${priorStatus === "revoked" ? new Date() : null},
          authorization_revision = authorization_revision + 1,
          updated_at = clock_timestamp()
        where subject_id = ${`user:${targetId}`}`;
      expect(
        await getSelfServiceOrganizationOnboardingState(client.db, {
          authUserId: targetId,
          email: targetEmail,
          emailVerified: true,
        }),
      ).toBe("unavailable");
      const terminalAccess = await ensureManagedAccessForUserWithOrganizationMemberships(
        client.db,
        {
          userId: targetId,
          email: targetEmail,
          name: `${priorStatus} target`,
          emailVerified: true,
          provisionFallbackOrganization: false,
        },
      );
      expect(terminalAccess.accessContext).toMatchObject({
        accountGrants: [],
        workspaceGrants: [],
        defaultAccountId: null,
        defaultWorkspaceId: null,
      });
      await createOrganizationInvitation(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
        operationId: crypto.randomUUID(),
        targetSubjectId: null,
        targetEmail,
        targetName: `${priorStatus} target`,
        initialWorkspaceIds: [owner.accessContext.defaultWorkspaceId!],
        role: "member",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

      expect(
        await getSelfServiceOrganizationOnboardingState(client.db, {
          authUserId: targetId,
          email: targetEmail,
          emailVerified: true,
        }),
      ).toBe("invitation_pending");
      const page = await listSelfOrganizationInvitations(client.db, {
        subjectId: `user:${targetId}`,
        limit: 100,
      });
      expect(page.invitations).toHaveLength(1);
      expect(page.invitations[0]?.organizationName).toBe("Named invitation organization");
    }
  });

  test("adopts an orphaned legacy fallback organization instead of dead-ending it", async () => {
    if (!shared || !client) return;
    // A pre-0348 image could leave a `better-auth:user` fallback organization
    // whose organization membership was never backfilled (migration 0290 only
    // anchored subjects that already held workspace access). Managed-access
    // convergence no longer self-heals that shape, so onboarding must adopt it:
    // refusing would strand the human permanently on a one-way cutover.
    const userId = crypto.randomUUID();
    const email = `${userId}@example.test`;
    const legacyAccountId = crypto.randomUUID();
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${userId}, 'Legacy user', ${email}, true)`;
    await shared.admin`
      insert into managed_accounts (id, name, external_source, external_id)
      values (${legacyAccountId}, 'Legacy user', 'better-auth:user', ${userId})`;

    expect(
      await getSelfServiceOrganizationOnboardingState(client.db, {
        authUserId: userId,
        email,
        emailVerified: true,
      }),
    ).toBe("required");

    const input = {
      authUserId: userId,
      actorSubjectId: `user:${userId}`,
      organizationName: "Adopted Industries",
      operationId: crypto.randomUUID(),
      requestFingerprint: "7".repeat(64),
    };
    const completed = await completeSelfServiceOrganizationSetup(client.db, input);
    // Adoption keeps the human's existing account identity rather than minting
    // a second organization for the same Better Auth user.
    expect(completed.organizationId).toBe(legacyAccountId);
    expect(await completeSelfServiceOrganizationSetup(client.db, input)).toEqual(completed);
    expect(
      await getSelfServiceOrganizationOnboardingState(client.db, {
        authUserId: userId,
        email,
        emailVerified: true,
      }),
    ).toBe("complete");

    const [durable] = await shared.admin<
      Array<{
        organizationName: string;
        organizations: number;
        role: string;
        status: string;
        personalWorkspaceId: string;
        workspaceMemberships: number;
      }>
    >`
      select account.name as "organizationName",
        (select count(*)::int from managed_accounts candidate
          where candidate.external_source = 'better-auth:user'
            and candidate.external_id = ${userId}) as organizations,
        membership.role, membership.status,
        membership.personal_workspace_id as "personalWorkspaceId",
        (select count(*)::int from workspace_memberships
          where account_id = account.id) as "workspaceMemberships"
      from managed_accounts account
      join organization_memberships membership on membership.account_id = account.id
        and membership.subject_id = ${`user:${userId}`}
      where account.id = ${legacyAccountId}`;
    expect(durable).toEqual({
      organizationName: "Adopted Industries",
      organizations: 1,
      role: "owner",
      status: "active",
      personalWorkspaceId: completed.personalWorkspaceId,
      workspaceMemberships: 0,
    });

    // A fallback account that already carries a membership is NOT adoptable:
    // granting owner there would be a privilege event, not a repair.
    const occupiedUserId = crypto.randomUUID();
    const occupiedEmail = `${occupiedUserId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${occupiedUserId}, 'Occupied', ${occupiedEmail}, true)`;
    await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: occupiedUserId,
      email: occupiedEmail,
      name: "Occupied",
      emailVerified: true,
    });
    await shared.admin`
      update organization_memberships set status = 'revoked', revoked_at = clock_timestamp()
      where subject_id = ${`user:${occupiedUserId}`}`;
    await expectSqlState(
      () =>
        completeSelfServiceOrganizationSetup(client!.db, {
          authUserId: occupiedUserId,
          actorSubjectId: `user:${occupiedUserId}`,
          organizationName: "Must not be adopted",
          operationId: crypto.randomUUID(),
          requestFingerprint: "8".repeat(64),
        }),
      "55000",
    );
  });

  test("a bound invitation wins and prevents a redundant self-service organization", async () => {
    if (!shared || !client) return;
    const ownerId = crypto.randomUUID();
    const invitedUserId = crypto.randomUUID();
    const invitedEmail = `${invitedUserId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified) values
        (${ownerId}, 'Invitation owner', ${`${ownerId}@example.test`}, true),
        (${invitedUserId}, 'Invited user', ${invitedEmail}, true)`;
    await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: ownerId,
      email: `${ownerId}@example.test`,
      name: "Invitation owner",
      emailVerified: true,
    });
    const [ownerMembership] = await listSelfOrganizationMemberships(client.db, `user:${ownerId}`);
    await createOrganizationInvitation(client.db, {
      organizationId: ownerMembership!.organizationId,
      actorSubjectId: `user:${ownerId}`,
      operationId: crypto.randomUUID(),
      targetSubjectId: `user:${invitedUserId}`,
      targetEmail: invitedEmail,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await expectSqlState(
      () =>
        completeSelfServiceOrganizationSetup(client!.db, {
          authUserId: invitedUserId,
          actorSubjectId: `user:${invitedUserId}`,
          organizationName: "Must not be created",
          operationId: crypto.randomUUID(),
          requestFingerprint: "9".repeat(64),
        }),
      "55000",
    );
    const [fallback] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from managed_accounts
      where external_source = 'better-auth:user'
        and external_id = ${invitedUserId}`;
    expect(fallback?.count).toBe(0);
  });

  test("never lets a setup bearer replace an existing account credential", async () => {
    if (!shared || !client) return;
    const ownerId = crypto.randomUUID();
    const ownerEmail = `${ownerId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${ownerId}, 'Existing guard owner', ${ownerEmail}, true)`;
    await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: ownerId,
      email: ownerEmail,
      name: "Existing guard owner",
      emailVerified: true,
    });
    const [ownerMembership] = await listSelfOrganizationMemberships(client.db, `user:${ownerId}`);
    const existingUserId = crypto.randomUUID();
    const existingEmail = `existing-${existingUserId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${existingUserId}, 'Existing user', ${existingEmail}, false)`;
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId: ownerMembership!.organizationId,
      actorSubjectId: `user:${ownerId}`,
      operationId: crypto.randomUUID(),
      targetSubjectId: null,
      targetEmail: existingEmail,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const tokenDigest = crypto.randomUUID().replaceAll("-", "").repeat(2);
    await ensureOrganizationUserSetupIntent(client.db, {
      organizationId: ownerMembership!.organizationId,
      actorSubjectId: `user:${ownerId}`,
      invitationId: invitation.id,
      tokenDigest,
      expiresAt: invitation.expiresAt,
    });
    await expectSqlState(
      () =>
        completeOrganizationUserSetup(client!.db, {
          tokenDigest,
          operationId: crypto.randomUUID(),
          requestFingerprint: "e".repeat(64),
          authUserId: crypto.randomUUID(),
          name: "Takeover attempt",
          passwordHash: `scrypt:${"f".repeat(96)}`,
        }),
      "P0002",
    );
    const [existing] = await shared.admin<Array<{ verified: boolean; credentials: number }>>`
      select email_verified as verified,
        (select count(*)::int from auth_identities where user_id = ${existingUserId}) as credentials
      from auth_users where id = ${existingUserId}`;
    expect(existing).toEqual({ verified: false, credentials: 0 });
  });
});
