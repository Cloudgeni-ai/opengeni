import { sql } from "drizzle-orm";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";

export type UserResourceAuthorityGrant = {
  grantId: string;
  targetWorkspaceId: string;
  targetSessionId: string | null;
  action: string;
  mode: "once" | "session" | "always";
  context: "user_private" | "workspace_shared";
  generation: number;
  status: "active" | "consumed" | "revoked" | "expired";
  expiresAt: string | null;
};

export type UserResourceAuthoritySummary = {
  authorityId: string;
  resourceKind: string;
  generation: number;
  status: "active" | "retained" | "revoked";
  grants: UserResourceAuthorityGrant[];
};

type AuthorityRow = Omit<UserResourceAuthorityGrant, "grantId" | "targetWorkspaceId"> & {
  authorityId: string;
  resourceKind: string;
  authorityGeneration: number;
  authorityStatus: UserResourceAuthoritySummary["status"];
  grantId: string | null;
  targetWorkspaceId: string | null;
};

async function withOwnerContext<T>(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await setSubjectRlsContext(scopedDb, input.subjectId);
    return await fn(scopedDb);
  });
}

export async function listSelfUserResourceAuthorities(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<UserResourceAuthoritySummary[]> {
  return await withOwnerContext(db, input, async (scopedDb) => {
    const rows = await rawRows<AuthorityRow>(
      scopedDb,
      sql`
      select authority_id as "authorityId", resource_kind as "resourceKind",
        authority_generation::int as "authorityGeneration",
        authority_status as "authorityStatus", grant_id as "grantId",
        target_workspace_id as "targetWorkspaceId", target_session_id as "targetSessionId",
        action, grant_mode as mode, grant_context as context,
        grant_generation::int as generation, grant_status as status,
        expires_at::text as "expiresAt"
      from list_self_user_resource_authorities(${input.accountId}::uuid)
    `,
    );
    const grouped = new Map<string, UserResourceAuthoritySummary>();
    for (const row of rows) {
      const authority = grouped.get(row.authorityId) ?? {
        authorityId: row.authorityId,
        resourceKind: row.resourceKind,
        generation: row.authorityGeneration,
        status: row.authorityStatus,
        grants: [],
      };
      if (row.grantId && row.targetWorkspaceId) {
        authority.grants.push({
          grantId: row.grantId,
          targetWorkspaceId: row.targetWorkspaceId,
          targetSessionId: row.targetSessionId,
          action: row.action,
          mode: row.mode,
          context: row.context,
          generation: row.generation,
          status: row.status,
          expiresAt: row.expiresAt,
        });
      }
      grouped.set(row.authorityId, authority);
    }
    return [...grouped.values()];
  });
}

export async function issueSelfUserResourceGrant(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    authorityId: string;
    action: string;
    mode: "once" | "session" | "always";
    context: "user_private" | "workspace_shared";
    sessionId?: string | null;
    workspaceSharedAcknowledged: boolean;
  },
): Promise<UserResourceAuthorityGrant> {
  return await withOwnerContext(db, input, async (scopedDb) => {
    const [row] = await rawRows<UserResourceAuthorityGrant>(
      scopedDb,
      sql`
      select grant_id as "grantId", target_workspace_id as "targetWorkspaceId",
        target_session_id as "targetSessionId", action, grant_mode as mode,
        grant_context as context, grant_generation::int as generation,
        grant_status as status, expires_at::text as "expiresAt"
      from issue_self_user_resource_grant(
        ${input.accountId}::uuid, ${input.authorityId}::uuid, ${input.workspaceId}::uuid,
        ${input.action}, ${input.mode}, ${input.context}, ${input.sessionId ?? null}::uuid,
        ${input.workspaceSharedAcknowledged}
      )
    `,
    );
    if (!row) throw new Error("user-resource grant was not returned");
    return row;
  });
}

export async function revokeSelfUserResourceGrant(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string; grantId: string },
): Promise<{ grantId: string; generation: number; status: "revoked"; revokedAt: string }> {
  return await withOwnerContext(db, input, async (scopedDb) => {
    const [row] = await rawRows<{
      grantId: string;
      generation: number;
      status: "revoked";
      revokedAt: string;
    }>(
      scopedDb,
      sql`
      select grant_id as "grantId", grant_generation::int as generation,
        grant_status as status, revoked_at::text as "revokedAt"
      from revoke_self_user_resource_grant(${input.accountId}::uuid, ${input.grantId}::uuid)
    `,
    );
    if (!row) throw new Error("user-resource grant was not returned");
    return row;
  });
}

export async function resolveSessionAttemptPersonalResources(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string | null; attemptId: string },
): Promise<void> {
  await withRlsContext(db, input, async (scopedDb) => {
    if (input.subjectId) await setSubjectRlsContext(scopedDb, input.subjectId);
    await scopedDb.execute(sql`select authorize_session_attempt_personal_resource_reads(
      ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.attemptId}::uuid
    )`);
  });
}

export type PersonalDocumentAuthority = {
  authorityId: string;
  ownerOrganizationMembershipId: string;
  authorityGeneration: number;
};

/**
 * Create the common organization-user authority before inserting a personal
 * Document. Call this inside the same database transaction as the Document
 * insert so a failed write cannot leave an orphan authority.
 */
export async function createPersonalDocumentAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    documentId: string;
  },
): Promise<PersonalDocumentAuthority> {
  await setSubjectRlsContext(db, input.subjectId);
  const [row] = await rawRows<PersonalDocumentAuthority>(
    db,
    sql`
      select authority_id as "authorityId",
        owner_organization_membership_id as "ownerOrganizationMembershipId",
        authority_generation::int as "authorityGeneration"
      from create_personal_document_authority(
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.documentId}::uuid
      )
    `,
  );
  if (!row) throw new Error("personal document authority was not returned");
  return row;
}
