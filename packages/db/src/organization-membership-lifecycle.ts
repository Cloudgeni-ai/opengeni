import {
  ListOrganizationInvitationsResponse,
  ListOrganizationInvitationsPageResponse,
  ListOrganizationMembersResponse,
  ListSelfOrganizationMembershipsResponse,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationRetentionDeletionClaim,
  OrganizationRetentionDatabaseFinalization,
  OrganizationRetentionDeletionObject,
  OrganizationRetentionDeletionPreview,
  OrganizationRetentionDeletionResult,
  OrganizationRetentionPolicy,
  type OrganizationInvitation as OrganizationInvitationType,
  type OrganizationMember as OrganizationMemberType,
  type OrganizationMembershipRole,
  type OrganizationRetentionDeletionClaim as OrganizationRetentionDeletionClaimType,
  type OrganizationRetentionDatabaseFinalization as OrganizationRetentionDatabaseFinalizationType,
  type OrganizationRetentionDeletionObject as OrganizationRetentionDeletionObjectType,
  type OrganizationRetentionDeletionPreview as OrganizationRetentionDeletionPreviewType,
  type OrganizationRetentionDeletionResult as OrganizationRetentionDeletionResultType,
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

export async function assertActiveManagedHumanOrganizationMembership(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<number | null> {
  const [row] = await rawRows<{ authorization_revision: number | string | null }>(
    db,
    sql`select assert_active_managed_human_organization_membership(
      ${input.accountId}::uuid,
      ${input.subjectId}
    ) as authorization_revision`,
  );
  return row?.authorization_revision === null || row?.authorization_revision === undefined
    ? null
    : Number(row.authorization_revision);
}

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

async function runRetentionCapability<T>(
  db: Database,
  organizationId: string,
  query: (scopedDb: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: organizationId, workspaceId: null },
    async (scopedDb) => await query(scopedDb),
  );
}

export async function previewOrganizationRetentionDeletions(
  db: Database,
  input: { organizationId: string; limit?: number },
): Promise<OrganizationRetentionDeletionPreviewType[]> {
  return await runRetentionCapability(db, input.organizationId, async (scopedDb) => {
    const [row] = await rawRows<{ result: unknown }>(
      scopedDb,
      sql`select preview_organization_retention_deletions(
        ${input.organizationId}::uuid, ${input.limit ?? 25}
      ) as result`,
    );
    return OrganizationRetentionDeletionPreview.array().parse(row?.result ?? []);
  });
}

export async function claimOrganizationRetentionDeletion(
  db: Database,
  input: { organizationId: string; operationId: string; excludedMembershipIds?: string[] },
): Promise<OrganizationRetentionDeletionClaimType | null> {
  return await runRetentionCapability(db, input.organizationId, async (scopedDb) => {
    const excludedMembershipIds = input.excludedMembershipIds ?? [];
    const excludedMembershipArray =
      excludedMembershipIds.length === 0
        ? sql`ARRAY[]::uuid[]`
        : sql`ARRAY[${sql.join(
            excludedMembershipIds.map((membershipId) => sql`${membershipId}::uuid`),
            sql`, `,
          )}]::uuid[]`;
    const [row] = await rawRows<{ result: unknown }>(
      scopedDb,
      sql`select claim_organization_retention_deletion(
        ${input.organizationId}::uuid, ${input.operationId}::uuid,
        ${excludedMembershipArray}
      ) as result`,
    );
    return row?.result === null || row?.result === undefined
      ? null
      : OrganizationRetentionDeletionClaim.parse(row.result);
  });
}

export async function listOrganizationRetentionDeletionObjects(
  db: Database,
  input: {
    organizationId: string;
    membershipId: string;
    operationId: string;
    objectBucket: string;
    limit?: number;
  },
): Promise<OrganizationRetentionDeletionObjectType[]> {
  return await runRetentionCapability(db, input.organizationId, async (scopedDb) => {
    const [row] = await rawRows<{ result: unknown }>(
      scopedDb,
      sql`select list_organization_retention_deletion_objects(
        ${input.organizationId}::uuid,
        ${input.membershipId}::uuid,
        ${input.operationId}::uuid,
        ${input.objectBucket},
        ${input.limit ?? 100}
      ) as result`,
    );
    return OrganizationRetentionDeletionObject.array().parse(row?.result ?? []);
  });
}

export async function recordOrganizationRetentionObjectDeleted(
  db: Database,
  input: {
    organizationId: string;
    membershipId: string;
    operationId: string;
    objectKind: OrganizationRetentionDeletionObjectType["objectKind"];
    sourceId: string;
    objectBucket: string;
    objectKey: string;
  },
): Promise<boolean> {
  return await runRetentionCapability(db, input.organizationId, async (scopedDb) => {
    const [row] = await rawRows<{ result: boolean }>(
      scopedDb,
      sql`select record_organization_retention_object_deleted(
        ${input.organizationId}::uuid,
        ${input.membershipId}::uuid,
        ${input.operationId}::uuid,
        ${input.objectKind},
        ${input.sourceId},
        ${input.objectBucket},
        ${input.objectKey}
      ) as result`,
    );
    return row?.result === true;
  });
}

export async function failOrganizationRetentionDeletion(
  db: Database,
  input: {
    organizationId: string;
    membershipId: string;
    operationId: string;
    reasonCode: string;
  },
): Promise<boolean> {
  return await runRetentionCapability(db, input.organizationId, async (scopedDb) => {
    const [row] = await rawRows<{ result: boolean }>(
      scopedDb,
      sql`select fail_organization_retention_deletion(
        ${input.organizationId}::uuid,
        ${input.membershipId}::uuid,
        ${input.operationId}::uuid,
        ${input.reasonCode}
      ) as result`,
    );
    return row?.result === true;
  });
}

export async function finalizeOrganizationRetentionDeletion(
  db: Database,
  input: {
    organizationId: string;
    membershipId: string;
    operationId: string;
    objectBucket: string;
  },
): Promise<OrganizationRetentionDatabaseFinalizationType> {
  return await runRetentionCapability(db, input.organizationId, async (scopedDb) => {
    const [row] = await rawRows<{ result: unknown }>(
      scopedDb,
      sql`select finalize_organization_retention_deletion(
        ${input.organizationId}::uuid,
        ${input.membershipId}::uuid,
        ${input.operationId}::uuid,
        ${input.objectBucket}
      ) as result`,
    );
    return OrganizationRetentionDatabaseFinalization.parse(row?.result);
  });
}

export async function completeOrganizationRetentionDeletion(
  db: Database,
  input: {
    organizationId: string;
    membershipId: string;
    operationId: string;
    objectBucket: string;
  },
): Promise<OrganizationRetentionDeletionResultType> {
  return await runRetentionCapability(db, input.organizationId, async (scopedDb) => {
    const [row] = await rawRows<{ result: unknown }>(
      scopedDb,
      sql`select complete_organization_retention_deletion(
        ${input.organizationId}::uuid,
        ${input.membershipId}::uuid,
        ${input.operationId}::uuid,
        ${input.objectBucket}
      ) as result`,
    );
    return OrganizationRetentionDeletionResult.parse(row?.result);
  });
}
