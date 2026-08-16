import {
  ListOrganizationInvitationsResponse,
  ListOrganizationInvitationsPageResponse,
  ListOrganizationMembersResponse,
  ListSelfOrganizationMembershipsResponse,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationRetentionPolicy,
  type OrganizationInvitation as OrganizationInvitationType,
  type OrganizationMember as OrganizationMemberType,
  type OrganizationMembershipRole,
  type OrganizationRetentionPolicy as OrganizationRetentionPolicyType,
  type UpdateOrganizationMemberRequest,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, setSubjectRlsContext, withRlsContext } from "./database";

type CommandBase = {
  organizationId: string;
  actorSubjectId: string;
  operationId: string;
};

async function runCommand(
  db: Database,
  command: CommandBase & Record<string, unknown>,
): Promise<unknown> {
  return await withRlsContext(
    db,
    { accountId: command.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, command.actorSubjectId);
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select organization_membership_command(${JSON.stringify(command)}::jsonb) as result`,
      );
      if (!row) throw new Error("Organization membership command returned no result");
      return row.result;
    },
  );
}

export async function listSelfOrganizationMemberships(
  db: Database,
  subjectId: string,
): Promise<OrganizationMemberType[]> {
  return await db.transaction(async (tx) => {
    await setSubjectRlsContext(tx as unknown as Database, subjectId);
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`select list_self_organization_memberships(${subjectId}) as result`,
    );
    return ListSelfOrganizationMembershipsResponse.parse({
      memberships: row?.result ?? [],
    }).memberships;
  });
}

export async function listSelfOrganizationInvitations(
  db: Database,
  input: { subjectId: string; cursor?: string; limit: number },
): Promise<{
  invitations: OrganizationInvitationType[];
  nextCursor: string | null;
}> {
  return await db.transaction(async (tx) => {
    await setSubjectRlsContext(tx as unknown as Database, input.subjectId);
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`select list_self_organization_invitations(
        ${input.subjectId},
        ${input.cursor ?? null}::uuid,
        ${input.limit}
      ) as result`,
    );
    const candidates = ListOrganizationInvitationsResponse.parse({
      invitations: row?.result ?? [],
    }).invitations;
    const hasMore = candidates.length > input.limit;
    const invitations = candidates.slice(0, input.limit);
    return ListOrganizationInvitationsPageResponse.parse({
      invitations,
      nextCursor: hasMore ? (invitations.at(-1)?.id ?? null) : null,
    });
  });
}

export async function getSelfOrganizationInvitation(
  db: Database,
  input: { subjectId: string; invitationId: string },
): Promise<OrganizationInvitationType> {
  return await db.transaction(async (tx) => {
    await setSubjectRlsContext(tx as unknown as Database, input.subjectId);
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`select get_self_organization_invitation(
        ${input.subjectId},
        ${input.invitationId}::uuid
      ) as result`,
    );
    if (!row) throw new Error("Self organization invitation lookup returned no result");
    return OrganizationInvitation.parse(row.result);
  });
}

export async function listOrganizationMembers(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
): Promise<OrganizationMemberType[]> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select list_organization_members(
          ${input.organizationId}::uuid,
          ${input.actorSubjectId}
        ) as result`,
      );
      return ListOrganizationMembersResponse.parse({
        members: row?.result ?? [],
      }).members;
    },
  );
}

export async function listOrganizationInvitations(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    cursor?: string;
    limit: number;
  },
): Promise<{
  invitations: OrganizationInvitationType[];
  nextCursor: string | null;
}> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select list_organization_invitations(
          ${input.organizationId}::uuid,
          ${input.actorSubjectId},
          ${input.cursor ?? null}::uuid,
          ${input.limit}
        ) as result`,
      );
      const candidates = ListOrganizationInvitationsResponse.parse({
        invitations: row?.result ?? [],
      }).invitations;
      const hasMore = candidates.length > input.limit;
      const invitations = candidates.slice(0, input.limit);
      return ListOrganizationInvitationsPageResponse.parse({
        invitations,
        nextCursor: hasMore ? (invitations.at(-1)?.id ?? null) : null,
      });
    },
  );
}

export async function createOrganizationInvitation(
  db: Database,
  input: CommandBase & {
    targetSubjectId: string;
    targetEmail: string;
    role: OrganizationMembershipRole;
    expiresAt: string;
  },
): Promise<OrganizationInvitationType> {
  return OrganizationInvitation.parse(await runCommand(db, { action: "invite", ...input }));
}

export async function acceptOrganizationInvitation(
  db: Database,
  input: CommandBase & { invitationId: string; expectedRevision: number },
): Promise<{
  invitation: OrganizationInvitationType;
  membership: OrganizationMemberType;
}> {
  const result = await runCommand(db, { action: "accept", ...input });
  return {
    invitation: OrganizationInvitation.parse((result as { invitation?: unknown }).invitation),
    membership: OrganizationMember.parse((result as { membership?: unknown }).membership),
  };
}

export async function revokeOrganizationInvitation(
  db: Database,
  input: CommandBase & { invitationId: string; expectedRevision: number },
): Promise<OrganizationInvitationType> {
  return OrganizationInvitation.parse(
    await runCommand(db, { action: "revoke_invitation", ...input }),
  );
}

export async function updateOrganizationMember(
  db: Database,
  input: CommandBase & {
    membershipId: string;
    transition: UpdateOrganizationMemberRequest;
  },
): Promise<OrganizationMemberType> {
  const { transition, ...base } = input;
  return OrganizationMember.parse(
    await runCommand(db, {
      action: transition.kind,
      ...base,
      expectedAuthorizationRevision: transition.expectedAuthorizationRevision,
      ...(transition.role === undefined ? {} : { role: transition.role }),
      ...(transition.reason === undefined ? {} : { reason: transition.reason }),
    }),
  );
}

export async function getOrganizationRetentionPolicy(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
): Promise<OrganizationRetentionPolicyType> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select get_organization_retention_policy(
          ${input.organizationId}::uuid,
          ${input.actorSubjectId}
        ) as result`,
      );
      return OrganizationRetentionPolicy.parse(row?.result);
    },
  );
}

export async function updateOrganizationRetentionPolicy(
  db: Database,
  input: CommandBase & {
    mode: "retain" | "delete_after";
    retentionDays: number | null;
    expectedVersion: number;
  },
): Promise<OrganizationRetentionPolicyType> {
  return OrganizationRetentionPolicy.parse(await runCommand(db, { action: "retention", ...input }));
}
