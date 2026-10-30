import {
  PersonalResourceAttachmentSummary,
  type PersonalResourceAttachmentIntent,
  USER_RESOURCE_ACTION_BY_KIND,
  type UserResourceDelegation,
  type UserResourceKind,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { ClassifiedDatabaseRefusal, nestedPostgresSqlState } from "./persistence-errors";

export type UserResourceAuthorityGrant = {
  grantId: string;
  targetWorkspaceId: string;
  targetSessionId: string | null;
  action: (typeof USER_RESOURCE_ACTION_BY_KIND)[UserResourceKind];
  mode: "once" | "session" | "always";
  context: "user_private" | "workspace_shared";
  authorityEpoch: number | null;
  generation: number;
  status: "active" | "consumed" | "revoked" | "expired";
  expiresAt: string | null;
  delegation: UserResourceDelegation;
};

export type UserResourceAuthoritySummary = {
  authorityId: string;
  resourceKind: UserResourceKind;
  resourceId: string;
  originWorkspaceId: string | null;
  generation: number;
  status: "active" | "retained" | "revoked";
  grants: UserResourceAuthorityGrant[];
};

export type AcceptedTurnPersonalResourceAttachment = {
  summary: PersonalResourceAttachmentSummary;
  replay: boolean;
};

export class PersonalResourceAttachmentAcceptanceError extends ClassifiedDatabaseRefusal {
  readonly name = "PersonalResourceAttachmentAcceptanceError";
  constructor(
    readonly kind: "invalid" | "forbidden" | "conflict" | "stale",
    options?: ErrorOptions,
  ) {
    super(
      kind === "invalid"
        ? "The personal-resource attachment request is invalid"
        : kind === "forbidden"
          ? "The personal-resource attachment is not authorized"
          : kind === "stale"
            ? "This chat's access changed just before the message was sent. Check the attached resources and send it again."
            : "The personal-resource attachment conflicts with accepted work",
      options,
    );
  }
}

/**
 * Issue and freeze the locked session's personal Variable Set/Rig/Connected
 * Machine closure on
 * one already-inserted logical turn. The caller owns the surrounding accepted-
 * work transaction; this helper must never be called as a standalone grant
 * mutation.
 */
export async function acceptTurnPersonalResourceAttachmentInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    subjectId: string;
    intent: PersonalResourceAttachmentIntent & { expectedAuthorityEpoch: number };
  },
): Promise<AcceptedTurnPersonalResourceAttachment> {
  await setSubjectRlsContext(db, input.subjectId);
  // The caller already holds this session's row lock, so this plain read is
  // the epoch the database function will compare. Answering a stale epoch
  // here gives the client a retryable conflict instead of the function's
  // generic refusal, which it shares with a wrong initiator. The function
  // stays the authority for every other check.
  const [current] = await rawRows<{ authorityEpoch: number }>(
    db,
    sql`
      select authority_epoch::int as "authorityEpoch"
      from sessions
      where id = ${input.sessionId}::uuid
        and account_id = ${input.accountId}::uuid
        and workspace_id = ${input.workspaceId}::uuid
    `,
  );
  if (current && current.authorityEpoch !== input.intent.expectedAuthorityEpoch) {
    throw new PersonalResourceAttachmentAcceptanceError("stale");
  }
  let row:
    | {
        grantMode: "once" | "session" | "always";
        grantContext: "user_private" | "workspace_shared";
        resourceCount: number;
        resourceKinds: Array<"variable_set" | "rig" | "connected_machine">;
        sharedOutputWarningVersion: 1;
        replay: boolean;
      }
    | undefined;
  try {
    [row] = await rawRows(
      db,
      sql`
        select grant_mode as "grantMode", grant_context as "grantContext",
          resource_count::int as "resourceCount", resource_kinds as "resourceKinds",
          shared_output_warning_version::int as "sharedOutputWarningVersion", replay
        from accept_turn_personal_resource_attachment(
          ${input.accountId}::uuid, ${input.workspaceId}::uuid,
          ${input.sessionId}::uuid, ${input.turnId}::uuid, ${input.intent.mode},
          ${input.intent.expectedAuthorityEpoch},
          ${input.intent.workspaceSharedAcknowledged},
          ${input.intent.sharedOutputWarningVersion}
        )
      `,
    );
  } catch (error) {
    const sqlState = nestedPostgresSqlState(error);
    if (sqlState === "22023") {
      throw new PersonalResourceAttachmentAcceptanceError("invalid", { cause: error });
    }
    if (sqlState === "42501") {
      throw new PersonalResourceAttachmentAcceptanceError("forbidden", { cause: error });
    }
    if (sqlState === "23505") {
      throw new PersonalResourceAttachmentAcceptanceError("conflict", { cause: error });
    }
    throw error;
  }
  if (!row) throw new Error("atomic personal-resource attachment was not returned");
  return {
    summary: PersonalResourceAttachmentSummary.parse({
      mode: row.grantMode,
      context: row.grantContext,
      resourceCount: row.resourceCount,
      resourceKinds: row.resourceKinds,
      sharedOutputWarningVersion: row.sharedOutputWarningVersion,
    }),
    replay: row.replay,
  };
}

type AuthorityRow = Omit<
  UserResourceAuthorityGrant,
  "grantId" | "targetWorkspaceId" | "delegation"
> & {
  authorityId: string;
  organizationId: string;
  resourceKind: UserResourceKind;
  resourceId: string;
  originWorkspaceId: string | null;
  authorityGeneration: number;
  authorityStatus: UserResourceAuthoritySummary["status"];
  grantId: string | null;
  targetWorkspaceId: string | null;
};

function rfc3339(value: string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid database timestamptz projection");
  return date.toISOString();
}

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
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    resourceKind: UserResourceKind;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<{ authorities: UserResourceAuthoritySummary[]; nextCursor: string | null }> {
  return await withOwnerContext(db, input, async (scopedDb) => {
    const rows = await rawRows<AuthorityRow>(
      scopedDb,
      sql`
      select authority_id as "authorityId", organization_id as "organizationId",
        resource_kind as "resourceKind", resource_id as "resourceId",
        origin_workspace_id as "originWorkspaceId",
        authority_generation::int as "authorityGeneration",
        authority_status as "authorityStatus", grant_id as "grantId",
        target_workspace_id as "targetWorkspaceId", target_session_id as "targetSessionId",
        action, grant_mode as mode, grant_context as context,
        authority_epoch::int as "authorityEpoch",
        grant_generation::int as generation, grant_status as status,
        expires_at::text as "expiresAt"
      from list_self_user_resource_authorities(
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.resourceKind},
        ${input.cursor ?? null}::uuid, ${input.limit + 1}
      )
    `,
    );
    const grouped = new Map<string, UserResourceAuthoritySummary>();
    for (const row of rows) {
      const authority = grouped.get(row.authorityId) ?? {
        authorityId: row.authorityId,
        resourceKind: row.resourceKind,
        resourceId: row.resourceId,
        originWorkspaceId: row.originWorkspaceId,
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
          authorityEpoch: row.authorityEpoch,
          generation: row.generation,
          status: row.status,
          expiresAt: rfc3339(row.expiresAt),
          delegation: {
            authorityId: row.authorityId,
            grantId: row.grantId,
            organizationId: row.organizationId,
            workspaceId: row.targetWorkspaceId,
            sessionId: row.targetSessionId,
            action: row.action,
            mode: row.mode,
            context: row.context,
            authorityEpoch: row.authorityEpoch,
            authorityGeneration: row.authorityGeneration,
            grantGeneration: row.generation,
          },
        });
      }
      grouped.set(row.authorityId, authority);
    }
    const values = [...grouped.values()];
    const hasMore = values.length > input.limit;
    const authorities = hasMore ? values.slice(0, input.limit) : values;
    return {
      authorities,
      nextCursor: hasMore ? (authorities.at(-1)?.authorityId ?? null) : null,
    };
  });
}

/**
 * Where a person turned their own logins on (D-54): for each of their personal
 * connections that is turned on in `workspaceId`, the standing grant that does
 * it. A turned-on login has an active `always` `connection.use` grant for this
 * workspace. Their Personal workspace needs none; callers decide that.
 */
export async function listOwnLoginsTurnedOn(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<Map<string, string>> {
  const turnedOn = new Map<string, string>();
  let cursor: string | undefined;
  // Bounded: a person has few logins, and a broken cursor must not loop.
  for (let page = 0; page < 50; page += 1) {
    const listed = await listSelfUserResourceAuthorities(db, {
      ...input,
      resourceKind: "connection",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const now = Date.now();
    for (const authority of listed.authorities) {
      if (authority.status !== "active") continue;
      const grant = authority.grants.find(
        (each) =>
          each.targetWorkspaceId === input.workspaceId &&
          each.action === "connection.use" &&
          each.mode === "always" &&
          each.context === "workspace_shared" &&
          each.status === "active" &&
          (each.expiresAt === null || Date.parse(each.expiresAt) > now),
      );
      if (grant) turnedOn.set(authority.resourceId, grant.grantId);
    }
    if (!listed.nextCursor) break;
    cursor = listed.nextCursor;
  }
  return turnedOn;
}

export async function issueSelfUserResourceGrant(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    authorityId: string;
    resourceKind: UserResourceKind;
    mode: "session" | "always";
    context: "user_private" | "workspace_shared";
    sessionId?: string | null;
    expectedAuthorityEpoch?: number | null;
    workspaceSharedAcknowledged: boolean;
  },
): Promise<UserResourceAuthorityGrant> {
  return await withOwnerContext(db, input, async (scopedDb) => {
    const [row] = await rawRows<
      Omit<UserResourceAuthorityGrant, "delegation"> & {
        organizationId: string;
        authorityGeneration: number;
      }
    >(
      scopedDb,
      sql`
      select grant_id as "grantId", organization_id as "organizationId",
        authority_generation::int as "authorityGeneration",
        target_workspace_id as "targetWorkspaceId",
        target_session_id as "targetSessionId", action, grant_mode as mode,
        grant_context as context, authority_epoch::int as "authorityEpoch",
        grant_generation::int as generation,
        grant_status as status, expires_at::text as "expiresAt"
      from issue_self_user_resource_grant(
        ${input.accountId}::uuid, ${input.authorityId}::uuid, ${input.workspaceId}::uuid,
        ${input.resourceKind}, ${input.mode}, ${input.context},
        ${input.sessionId ?? null}::uuid, ${input.expectedAuthorityEpoch ?? null}::integer,
        ${input.workspaceSharedAcknowledged}
      )
    `,
    );
    if (!row) throw new Error("user-resource grant was not returned");
    const { organizationId, authorityGeneration, ...grant } = row;
    return {
      ...grant,
      expiresAt: rfc3339(grant.expiresAt),
      delegation: {
        authorityId: input.authorityId,
        grantId: grant.grantId,
        organizationId,
        workspaceId: grant.targetWorkspaceId,
        sessionId: grant.targetSessionId,
        action: grant.action,
        mode: grant.mode,
        context: grant.context,
        authorityEpoch: grant.authorityEpoch,
        authorityGeneration,
        grantGeneration: grant.generation,
      },
    };
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
      from revoke_self_user_resource_grant(
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.grantId}::uuid
      )
    `,
    );
    if (!row) throw new Error("user-resource grant was not returned");
    return { ...row, revokedAt: rfc3339(row.revokedAt)! };
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
 * Document. Returns null for a configured/local or rolling-legacy subject that
 * has no eligible active organization membership, preserving the existing
 * workspace-anchored personal lane. Call this inside the same database
 * transaction as the Document insert so a failed write cannot leave an orphan
 * authority.
 */
export async function createPersonalDocumentAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    documentId: string;
  },
): Promise<PersonalDocumentAuthority | null> {
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
  return row ?? null;
}
