import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  acceptOrganizationInvitation,
  bindPendingOrganizationInvitationsForVerifiedEmail,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUser,
  ensureManagedAccessForUserWithOrganizationMemberships,
  listSelfOrganizationInvitations,
  listSelfOrganizationMemberships,
  nestedPostgresSqlState,
  revokeOrganizationInvitation,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0314-unregistered-invitations");
  if (!shared && requireRealDatabase) throw new Error("migration 0314 requires PostgreSQL");
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

async function waitForAdvisoryWaiterHeldBy(holderPid: number): Promise<void> {
  if (!shared) throw new Error("test database unavailable");
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [row] = await shared.admin<Array<{ matching: number }>>`
      select count(*)::int as matching
      from pg_locks waiting
      join pg_stat_activity waiter on waiter.pid = waiting.pid
      join pg_locks held
        on held.locktype = 'advisory'
        and held.granted
        and held.classid = waiting.classid
        and held.objid = waiting.objid
        and held.objsubid = waiting.objsubid
      where waiting.locktype = 'advisory'
        and not waiting.granted
        and waiter.datname = current_database()
        and held.pid = ${holderPid}`;
    if ((row?.matching ?? 0) > 0) return;
    await Bun.sleep(25);
  }
  throw new Error("verified convergence did not park on the invitation email fence");
}

describe("migration 0314 unregistered organization invitations", () => {
  test("binds only a verified email and joins without provisioning a second organization", async () => {
    if (!shared || !client) return;
    const ownerId = `invite-owner-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    const ownerAccess = await ensureManagedAccessForUser(client.db, {
      userId: ownerId,
      email: `${ownerId}@example.test`,
      name: "Invitation owner",
    });
    await shared.admin`
      update workspaces set name = 'Engineering'
      where id = ${ownerAccess.defaultWorkspaceId!}`;
    await ensureManagedAccessForUser(client.db, {
      userId: ownerId,
      email: `${ownerId}@example.test`,
      name: "Invitation owner",
    });
    const [renamedWorkspace] = await shared.admin<{ name: string }[]>`
      select name from workspaces where id = ${ownerAccess.defaultWorkspaceId!}`;
    expect(renamedWorkspace?.name).toBe("Engineering");
    const [ownerMembership] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    expect(ownerMembership).toBeDefined();
    const organizationId = ownerMembership!.organizationId;
    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (
        ${organizationId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'migration-0314-test'
      ) on conflict (account_id) do nothing`;

    const revokedTargetUserId = crypto.randomUUID();
    const revokedTargetSubject = `user:${revokedTargetUserId}`;
    const revokedTargetEmail = `revoked-${revokedTargetUserId}@example.test`;
    const revokedInvitation = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: null,
      targetEmail: revokedTargetEmail,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${revokedTargetUserId}, 'Revoked target', ${revokedTargetEmail}, true)`;
    expect(
      await bindPendingOrganizationInvitationsForVerifiedEmail(client.db, {
        subjectId: revokedTargetSubject,
        email: revokedTargetEmail,
      }),
    ).toBe(1);
    await revokeOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      invitationId: revokedInvitation.id,
      expectedRevision: revokedInvitation.revision + 1,
    });
    const revokedTargetAccess = await ensureManagedAccessForUserWithOrganizationMemberships(
      client.db,
      {
        userId: revokedTargetUserId,
        email: revokedTargetEmail,
        name: "Revoked target",
        emailVerified: true,
      },
    );
    expect(revokedTargetAccess.accessContext.defaultAccountId).not.toBe(organizationId);
    expect(revokedTargetAccess.accessContext.defaultAccountId).not.toBeNull();

    const initialWorkspaceId = crypto.randomUUID();
    await shared.admin`
      insert into workspaces (id, account_id, name, external_source, external_id)
      values (
        ${initialWorkspaceId}, ${organizationId}, 'Product', 'migration-0314',
        ${crypto.randomUUID()}
      )`;

    const targetUserId = crypto.randomUUID();
    const targetSubject = `user:${targetUserId}`;
    const targetEmail = `new-${targetUserId}@example.test`;
    await expectSqlState(
      () =>
        createOrganizationInvitation(client!.db, {
          organizationId,
          actorSubjectId: ownerSubject,
          operationId: crypto.randomUUID(),
          targetSubjectId: null,
          targetEmail: `personal-${targetEmail}`,
          initialWorkspaceIds: [ownerMembership!.personalWorkspaceId!],
          role: "member",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      "22023",
    );
    const invitationOperationId = crypto.randomUUID();
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: invitationOperationId,
      targetSubjectId: null,
      targetEmail,
      targetName: "New teammate",
      initialWorkspaceIds: [initialWorkspaceId],
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(invitation).toMatchObject({
      targetName: "New teammate",
      initialWorkspaceIds: [initialWorkspaceId],
      revision: 1,
    });
    const secondOwnerId = `invite-second-owner-${crypto.randomUUID()}`;
    const secondOwnerSubject = `user:${secondOwnerId}`;
    await ensureManagedAccessForUser(client.db, {
      userId: secondOwnerId,
      email: `${secondOwnerId}@example.test`,
      name: "Second invitation owner",
    });
    const [secondOwnerMembership] = await listSelfOrganizationMemberships(
      client.db,
      secondOwnerSubject,
    );
    expect(secondOwnerMembership).toBeDefined();
    const secondInvitation = await createOrganizationInvitation(client.db, {
      organizationId: secondOwnerMembership!.organizationId,
      actorSubjectId: secondOwnerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: null,
      targetEmail,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const [invitationEvent] = await shared.admin<
      Array<{ actorMembershipId: string; kind: string; targetMembershipId: string | null }>
    >`
      select actor_membership_id as "actorMembershipId", kind,
        target_membership_id as "targetMembershipId"
      from organization_membership_lifecycle_events
      where account_id = ${organizationId} and operation_id = ${invitationOperationId}`;
    expect(invitationEvent).toEqual({
      actorMembershipId: ownerMembership!.id,
      kind: "invite",
      targetMembershipId: null,
    });

    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${targetUserId}, 'New teammate', ${targetEmail}, false)`;
    await expectSqlState(
      () =>
        bindPendingOrganizationInvitationsForVerifiedEmail(client!.db, {
          subjectId: targetSubject,
          email: targetEmail,
        }),
      "42501",
    );
    await shared.admin`
      update auth_users set email_verified = true where id = ${targetUserId}`;
    await expectSqlState(
      () =>
        bindPendingOrganizationInvitationsForVerifiedEmail(client!.db, {
          subjectId: targetSubject,
          email: `wrong-${targetEmail}`,
        }),
      "42501",
    );
    expect(
      await bindPendingOrganizationInvitationsForVerifiedEmail(client.db, {
        subjectId: targetSubject,
        email: targetEmail,
      }),
    ).toBe(2);
    const [bindingEvent] = await shared.admin<
      Array<{ targetSubjectId: string; resultingRevision: number }>
    >`
      select target_subject_id as "targetSubjectId",
        resulting_revision::int as "resultingRevision"
      from organization_invitation_binding_events
      where account_id = ${organizationId} and invitation_id = ${invitation.id}`;
    expect(bindingEvent).toEqual({ targetSubjectId: targetSubject, resultingRevision: 2 });
    await expectSqlState(
      () =>
        shared!.admin`
          update organization_invitation_binding_events
          set resulting_revision = resulting_revision + 1
          where account_id = ${organizationId} and invitation_id = ${invitation.id}`,
      "55000",
    );

    const pendingAccess = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: targetUserId,
      email: targetEmail,
      name: "New teammate",
      emailVerified: true,
    });
    expect(pendingAccess.accessContext).toMatchObject({
      accountGrants: [],
      workspaceGrants: [],
      defaultAccountId: null,
      defaultWorkspaceId: null,
    });
    const [fallbackAccount] = await shared.admin<{ id: string }[]>`
      select id from managed_accounts
      where external_source = 'better-auth:user' and external_id = ${targetUserId}`;
    expect(fallbackAccount).toBeUndefined();

    const selfInvitations = await listSelfOrganizationInvitations(client.db, {
      subjectId: targetSubject,
      limit: 10,
    });
    expect(selfInvitations.invitations).toHaveLength(2);
    expect(selfInvitations.invitations.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining([invitation.id, secondInvitation.id]),
    );
    expect(
      (
        await listSelfOrganizationInvitations(client.db, {
          subjectId: targetSubject,
          limit: 10,
        })
      ).invitations.map((candidate) => candidate.id),
    ).toEqual(selfInvitations.invitations.map((candidate) => candidate.id));
    const selectedInvitation = selfInvitations.invitations.find(
      (candidate) => candidate.id === invitation.id,
    );
    expect(selectedInvitation?.revision).toBe(2);
    const accepted = await acceptOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: targetSubject,
      operationId: crypto.randomUUID(),
      invitationId: invitation.id,
      expectedRevision: selectedInvitation!.revision,
    });
    expect(accepted.membership).toMatchObject({
      organizationId,
      subjectId: targetSubject,
      status: "active",
    });

    const access = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: targetUserId,
      email: targetEmail,
      name: "New teammate",
      emailVerified: true,
    });
    expect(access.accessContext.defaultAccountId).toBe(organizationId);
    expect(access.accessContext.defaultWorkspaceId).toBe(accepted.membership.personalWorkspaceId);
    expect(
      access.accessContext.workspaceGrants.some(
        (grant) =>
          grant.workspaceId === initialWorkspaceId &&
          grant.permissions.includes("sessions:create") &&
          !grant.permissions.includes("workspace:admin"),
      ),
    ).toBe(true);
    const [initialWorkspaceMembership] = await shared.admin<
      Array<{ subjectLabel: string; role: string }>
    >`
      select subject_label as "subjectLabel", role
      from workspace_memberships
      where workspace_id = ${initialWorkspaceId} and subject_id = ${targetSubject}`;
    expect(initialWorkspaceMembership).toEqual({
      subjectLabel: "New teammate",
      role: "member",
    });
    const [stillNoFallbackAccount] = await shared.admin<{ id: string }[]>`
      select id from managed_accounts
      where external_source = 'better-auth:user' and external_id = ${targetUserId}`;
    expect(stillNoFallbackAccount).toBeUndefined();
    expect(
      (await listSelfOrganizationMemberships(client.db, targetSubject)).map(
        (membership) => membership.organizationId,
      ),
    ).not.toContain(secondOwnerMembership!.organizationId);
    expect(
      (
        await listSelfOrganizationInvitations(client.db, {
          subjectId: targetSubject,
          limit: 10,
        })
      ).invitations.find((candidate) => candidate.id === secondInvitation.id),
    ).toMatchObject({ status: "pending", revision: 2 });
  }, 180_000);

  test("serializes verified signup convergence behind a committing email invitation", async () => {
    if (!shared || !client) return;
    const ownerId = `invite-race-owner-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    await ensureManagedAccessForUser(client.db, {
      userId: ownerId,
      email: `${ownerId}@example.test`,
      name: "Invitation race owner",
    });
    const [ownerMembership] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    expect(ownerMembership).toBeDefined();
    const organizationId = ownerMembership!.organizationId;
    const targetUserId = crypto.randomUUID();
    const targetSubject = `user:${targetUserId}`;
    const targetEmail = `invite-race-${targetUserId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${targetUserId}, 'Invitation race target', ${targetEmail}, true)`;

    let releaseCreator!: () => void;
    const creatorGate = new Promise<void>((resolve) => {
      releaseCreator = resolve;
    });
    let markInvitationInserted!: (holderPid: number) => void;
    let rejectInvitationInserted!: (error: unknown) => void;
    const invitationInserted = new Promise<number>((resolve, reject) => {
      markInvitationInserted = resolve;
      rejectInvitationInserted = reject;
    });
    const creator = postgres(shared.appUrl, { max: 1, prepare: false });
    const command = {
      action: "invite",
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: null,
      targetEmail,
      initialWorkspaceIds: [],
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    let creatorOperation: Promise<unknown> | undefined;
    try {
      creatorOperation = creator
        .begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${organizationId}, true)`;
          await tx`select set_config('opengeni.workspace_id', '', true)`;
          await tx`select set_config('opengeni.subject_id', ${ownerSubject}, true)`;
          const [authority] = await tx<
            Array<{ accountId: string | null; subjectId: string | null }>
          >`
            select opengeni_private.current_account_id()::text as "accountId",
                   opengeni_private.current_subject_id() as "subjectId"`;
          expect(authority).toEqual({ accountId: organizationId, subjectId: ownerSubject });
          const [backend] = await tx<Array<{ pid: number }>>`
            select pg_backend_pid()::int as pid`;
          const [parsedCommand] = await tx<
            Array<{
              accountId: string | null;
              actorSubjectId: string | null;
              operationId: string | null;
            }>
          >`
            select command ->> 'organizationId' as "accountId",
                   command ->> 'actorSubjectId' as "actorSubjectId",
                   command ->> 'operationId' as "operationId"
            from (select ${tx.json(command)}::jsonb as command) candidate`;
          expect(parsedCommand).toEqual({
            accountId: organizationId,
            actorSubjectId: ownerSubject,
            operationId: command.operationId,
          });
          await tx`select create_organization_invitation_v2(${tx.json(command)}::jsonb)`;
          markInvitationInserted(backend!.pid);
          await creatorGate;
        })
        .catch((error: unknown) => {
          rejectInvitationInserted(error);
          throw error;
        });
      const holderPid = await invitationInserted;
      let convergenceSettled = false;
      const convergence = ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
        userId: targetUserId,
        email: targetEmail,
        name: "Invitation race target",
        emailVerified: true,
      }).finally(() => {
        convergenceSettled = true;
      });

      await waitForAdvisoryWaiterHeldBy(holderPid);
      expect(convergenceSettled).toBe(false);
      releaseCreator();
      await creatorOperation;
      const access = await convergence;
      expect(access.accessContext).toMatchObject({
        accountGrants: [],
        workspaceGrants: [],
        defaultAccountId: null,
        defaultWorkspaceId: null,
      });
      const [fallbackAccount] = await shared.admin<{ id: string }[]>`
        select id from managed_accounts
        where external_source = 'better-auth:user' and external_id = ${targetUserId}`;
      expect(fallbackAccount).toBeUndefined();
      expect(
        (
          await listSelfOrganizationInvitations(client.db, {
            subjectId: targetSubject,
            limit: 10,
          })
        ).invitations,
      ).toHaveLength(1);
    } finally {
      releaseCreator();
      await creatorOperation?.catch(() => undefined);
      await creator.end({ timeout: 5 }).catch(() => undefined);
    }
  }, 180_000);

  test("declares bounded fields, exact verified binding and runtime-only capabilities", async () => {
    const source = await Bun.file(
      new URL("../drizzle/0314_unregistered_organization_invitations.sql", import.meta.url),
    ).text();
    expect(source).toStartWith("-- deployment-mode: maintenance");
    expect(source).toContain("requires an explicit application database role list");
    expect(source).toContain(
      "requires all configured OpenGeni application database sessions to be stopped",
    );
    expect(source).toContain("ALTER COLUMN target_subject_id DROP NOT NULL");
    expect(source).toContain("initial_workspace_ids uuid[] NOT NULL");
    expect(source).toContain("auth_user.email_verified IS TRUE");
    expect(source).toContain("invitation.target_email = normalized_email");
    expect(source).toContain("has_pending_organization_invitation_for_subject");
    expect(source).toContain("organization_invitation_binding_events");
    expect(source).toContain("organization_membership_lifecycle_events");
    expect(source).toContain("organization-membership:");
    expect(source).toContain("organization-invitation-email:");
    expect(source).toContain("FOR KEY SHARE");
    expect(source).toContain("REVOKE ALL ON FUNCTION create_organization_invitation_v2");
    expect(source).toContain("REVOKE ALL ON TABLE organization_invitation_binding_events");
    expect(source).not.toContain("GRANT SELECT ON organization_membership_invitations");
  });
});
