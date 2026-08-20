import {
  ListOrganizationInvitationsResponse,
  ListOrganizationInvitationsPageResponse,
  ListOrganizationMembersResponse,
  ListSelfOrganizationMembershipsResponse,
  OrganizationInvitation,
  OrganizationAdministrationOverview,
  OrganizationMember,
  OrganizationRetentionDeletionClaim,
  OrganizationRetentionDatabaseFinalization,
  OrganizationRetentionDeletionObject,
  OrganizationRetentionDeletionPreview,
  OrganizationRetentionDeletionResult,
  OrganizationRetentionPolicy,
  OrganizationSummary,
  type OrganizationAdministrationOverview as OrganizationAdministrationOverviewType,
  type OrganizationInvitation as OrganizationInvitationType,
  type OrganizationMember as OrganizationMemberType,
  type OrganizationMembershipRole,
  type OrganizationRetentionDeletionClaim as OrganizationRetentionDeletionClaimType,
  type OrganizationRetentionDatabaseFinalization as OrganizationRetentionDatabaseFinalizationType,
  type OrganizationRetentionDeletionObject as OrganizationRetentionDeletionObjectType,
  type OrganizationRetentionDeletionPreview as OrganizationRetentionDeletionPreviewType,
  type OrganizationRetentionDeletionResult as OrganizationRetentionDeletionResultType,
  type OrganizationRetentionPolicy as OrganizationRetentionPolicyType,
  type OrganizationSummary as OrganizationSummaryType,
  type UpdateOrganizationMemberRequest,
} from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import {
  rawRows,
  setSubjectRlsContext,
  withRestoredSessionActivityRlsContext,
  withRlsContext,
} from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import { lockSessionEventWriteRows } from "./session-control";
import { closePendingSessionToolCallsInTransaction } from "./session-tool-call-settlement";
import * as schema from "./schema";

/**
 * Bounded replay of one exact organization-lifecycle transaction after a
 * PostgreSQL deadlock abort.
 *
 * A lifecycle command spans an entire organization and therefore touches many
 * rows that ordinary workspace writers touch too, so it can land in a lock
 * cycle with one. PostgreSQL resolves a cycle by aborting one of the two
 * transactions with `40P01`.
 *
 * Replay is exact rather than approximate: the whole lifecycle command runs in
 * one transaction keyed by its caller-supplied operation id
 * (`organization_membership_operation_receipts`) plus its CAS revisions, and a
 * deadlock abort rolls back every durable effect, so re-running the identical
 * command either applies it once or observes the newer authoritative state.
 *
 * Only `40P01` is replayed. `40001` is the lifecycle's own authoritative
 * stale-revision / stale-epoch conflict and must reach the caller unchanged,
 * and the original failure is rethrown untouched once the budget is spent.
 *
 * SCOPE - read this before assuming a deadlock cannot escape. PostgreSQL picks
 * ONE of the two transactions in the cycle as the victim, and it may pick the
 * ordinary workspace writer instead of the lifecycle command. That writer is a
 * plain caller of an unrelated module (`transitionSessionVisibility`, a session
 * event/goal/system-update insert, ...); nothing here can replay it. So this
 * covers exactly the lifecycle side of a cycle: it is a caller-side safety net,
 * NOT a lock-order fix. The known organization/workspace lock-order inversion
 * was removed in SQL by migration
 * `0299_organization_membership_lock_order.sql` (advisory-lock mutual exclusion
 * plus a downgraded `managed_accounts FOR KEY SHARE` row lock), and its
 * parallel-load probe reads `pg_stat_database.deadlocks` directly so this
 * replay cannot mask a regression. Do not treat this wrapper as licence to
 * reintroduce a conflicting organization row lock.
 *
 * Every lifecycle entry point whose command acquires workspace rows - and so
 * can be inside the cycle at all - is wrapped: `accept` (it inserts the
 * personal workspace) and `suspend`/`offboard` (they take the account's
 * `workspaces` rows `FOR KEY SHARE`). The remaining actions never reach a
 * workspace row, so they can block an ordinary writer but cannot close a cycle
 * with one.
 *
 * The wrapper must stay OUTSIDE any transaction it replays: retrying inside an
 * already-aborted transaction is not a retry.
 */
async function withOrganizationLifecycleDeadlockReplay<T>(operation: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || nestedPostgresSqlState(error) !== "40P01") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
    }
  }
}

type CommandBase = {
  organizationId: string;
  actorSubjectId: string;
  operationId: string;
};

type OrganizationMembershipProtocolSettlement = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  executionGeneration: number;
  turnAssociation: "current" | null;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseOrganizationMembershipProtocolSettlements(
  value: unknown,
): OrganizationMembershipProtocolSettlement[] {
  if (!Array.isArray(value)) {
    throw new Error("Organization membership protocol preparation returned a non-array result");
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Organization membership protocol preparation returned an invalid item");
    }
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.accountId !== "string" ||
      !uuidPattern.test(item.accountId) ||
      typeof item.workspaceId !== "string" ||
      !uuidPattern.test(item.workspaceId) ||
      typeof item.sessionId !== "string" ||
      !uuidPattern.test(item.sessionId) ||
      typeof item.turnId !== "string" ||
      !uuidPattern.test(item.turnId) ||
      typeof item.executionGeneration !== "number" ||
      !Number.isSafeInteger(item.executionGeneration) ||
      item.executionGeneration <= 0 ||
      (item.turnAssociation !== "current" && item.turnAssociation !== null)
    ) {
      throw new Error("Organization membership protocol preparation returned an invalid item");
    }
    return {
      accountId: item.accountId,
      workspaceId: item.workspaceId,
      sessionId: item.sessionId,
      turnId: item.turnId,
      executionGeneration: item.executionGeneration,
      turnAssociation: item.turnAssociation,
    };
  });
}

async function prepareOrganizationMembershipProtocolSettlements(
  db: Database,
  command: CommandBase & Record<string, unknown>,
): Promise<OrganizationMembershipProtocolSettlement[]> {
  return await withRlsContext(
    db,
    { accountId: command.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, command.actorSubjectId);
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select prepare_organization_membership_protocol_settlements(
          ${JSON.stringify(command)}::jsonb
        ) as result`,
      );
      return parseOrganizationMembershipProtocolSettlements(row?.result ?? []);
    },
  );
}

async function settleOrganizationMembershipProtocols(
  db: Database,
  settlements: OrganizationMembershipProtocolSettlement[],
): Promise<void> {
  const [prior] = await rawRows<{ subject_id: string; initiating_human_subject_id: string }>(
    db,
    sql`select
      coalesce(current_setting('opengeni.subject_id', true), '') as subject_id,
      coalesce(
        current_setting('opengeni.initiating_human_subject_id', true), ''
      ) as initiating_human_subject_id`,
  );
  try {
    // The SECURITY DEFINER preparation has already authorized and locked each
    // exact target turn. Canonical settlement needs the established internal
    // service RLS view because an administrator cannot otherwise see another
    // member's user-private session rows.
    await db.execute(sql`select
      set_config('opengeni.subject_id', '', true),
      set_config('opengeni.initiating_human_subject_id', '', true)`);
    const workspaceIds = [
      ...new Set(settlements.map((settlement) => settlement.workspaceId)),
    ].sort();
    for (const workspaceId of workspaceIds) {
      const workspaceSettlements = settlements
        .filter((settlement) => settlement.workspaceId === workspaceId)
        .sort(
          (left, right) =>
            left.sessionId.localeCompare(right.sessionId) ||
            left.turnId.localeCompare(right.turnId),
        );
      const accountId = workspaceSettlements[0]?.accountId;
      if (!accountId) continue;
      await withRestoredSessionActivityRlsContext(
        db,
        { accountId, workspaceId },
        async (scopedDb) => {
          for (const settlement of workspaceSettlements) {
            const locks = await lockSessionEventWriteRows(scopedDb, {
              workspaceId,
              controlLock: "already_locked",
              workspaceLock: "already_locked",
              sessionIds: [settlement.sessionId],
              turnIds: [settlement.turnId],
            });
            const session = locks.sessions[0];
            const turn = locks.turns[0];
            if (
              !session ||
              !turn ||
              session.accountId !== settlement.accountId ||
              turn.accountId !== settlement.accountId ||
              turn.sessionId !== settlement.sessionId ||
              turn.executionGeneration !== settlement.executionGeneration ||
              !["queued", "running", "requires_action", "recovering", "waiting_capacity"].includes(
                turn.status,
              )
            ) {
              throw new Error("Organization membership protocol settlement lost its locked turn");
            }
            const now = new Date();
            const closedTools = await closePendingSessionToolCallsInTransaction(scopedDb, {
              accountId: settlement.accountId,
              workspaceId,
              sessionId: settlement.sessionId,
              turnId: settlement.turnId,
              reason: "authority_changed",
              sequence: session.lastSequence,
              now,
              turnAssociation: settlement.turnAssociation,
            });
            if (closedTools.sequence !== session.lastSequence) {
              const [updated] = await scopedDb
                .update(schema.sessions)
                .set({ lastSequence: closedTools.sequence, updatedAt: now })
                .where(
                  and(
                    eq(schema.sessions.accountId, settlement.accountId),
                    eq(schema.sessions.workspaceId, workspaceId),
                    eq(schema.sessions.id, settlement.sessionId),
                    eq(schema.sessions.lastSequence, session.lastSequence),
                  ),
                )
                .returning({ id: schema.sessions.id });
              if (!updated) {
                throw new Error("Organization membership protocol sequence changed under its lock");
              }
            }
          }
        },
      );
    }
  } finally {
    await db.execute(sql`select
      set_config('opengeni.subject_id', ${prior?.subject_id ?? ""}, true),
      set_config(
        'opengeni.initiating_human_subject_id',
        ${prior?.initiating_human_subject_id ?? ""}, true
      )`);
  }
}

/**
 * Remove one workspace membership through the fenced SECURITY DEFINER
 * teardown (migration 0278): the same prepare/settle/command protocol as
 * organization offboarding, scoped to exactly one workspace and one subject.
 * Cancels the removed member's queued/live turns in the workspace, interrupts
 * live attempts, ends their realtime modes, advances their private sessions'
 * authority epochs, registers workflow wakes, deletes their per-workspace
 * personal rows, and deletes the membership - in one transaction. Returns
 * false when no membership row exists (idempotent retry).
 */
export async function removeWorkspaceMember(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    targetSubjectId: string;
  },
): Promise<boolean> {
  const command = {
    action: "remove",
    organizationId: input.accountId,
    workspaceId: input.workspaceId,
    actorSubjectId: input.actorSubjectId,
    targetSubjectId: input.targetSubjectId,
    operationId: crypto.randomUUID(),
  };
  return await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    // The personal-state fence first, exactly as the pre-0278 delete path took
    // it: session listing takes the shared counterpart and pin mutation the
    // same exclusive one. The removal command re-acquires it (reentrant within
    // this transaction), but taking it here keeps the wait observable and the
    // fence ordered before every other lock this transaction takes.
    await txDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(
        ${`session-personal-state:${input.workspaceId}:${input.targetSubjectId}`}, 0))`,
    );
    const settlements = await withRlsContext(
      txDb,
      { accountId: input.accountId, workspaceId: null },
      async (scopedDb) => {
        await setSubjectRlsContext(scopedDb, input.actorSubjectId);
        const [row] = await rawRows<{ result: unknown }>(
          scopedDb,
          sql`select prepare_workspace_membership_removal_settlements(
            ${JSON.stringify(command)}::jsonb
          ) as result`,
        );
        return parseOrganizationMembershipProtocolSettlements(row?.result ?? []);
      },
    );
    await settleOrganizationMembershipProtocols(txDb, settlements);
    return await withRlsContext(
      txDb,
      { accountId: input.accountId, workspaceId: null },
      async (scopedDb) => {
        await setSubjectRlsContext(scopedDb, input.actorSubjectId);
        const [row] = await rawRows<{ result: unknown }>(
          scopedDb,
          sql`select workspace_membership_removal_command(
            ${JSON.stringify(command)}::jsonb
          ) as result`,
        );
        if (!row) throw new Error("Workspace membership removal returned no result");
        return (row.result as { removed?: unknown } | null)?.removed === true;
      },
    );
  });
}

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

export async function getOrganizationAdministrationOverview(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
): Promise<OrganizationAdministrationOverviewType> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select get_organization_administration_overview(
          ${input.organizationId}::uuid,
          ${input.actorSubjectId}
        ) as result`,
      );
      return OrganizationAdministrationOverview.parse(row?.result);
    },
  );
}

export async function updateOrganizationName(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    name: string;
    expectedUpdatedAt: string;
    operationId: string;
  },
): Promise<OrganizationSummaryType> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select update_organization_name(
          ${input.organizationId}::uuid,
          ${input.actorSubjectId},
          ${input.name},
          ${input.expectedUpdatedAt}::timestamptz,
          ${input.operationId}::uuid
        ) as result`,
      );
      return OrganizationSummary.parse(row?.result);
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
  // `accept` inserts the invited human's personal workspace, so like
  // suspend/offboard it acquires workspace rows and can be inside a lock cycle
  // with an ordinary workspace writer. It needs the identical replay.
  const result = await withOrganizationLifecycleDeadlockReplay(async () =>
    runCommand(db, { action: "accept", ...input }),
  );
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
  const command = {
    action: transition.kind,
    ...base,
    expectedAuthorizationRevision: transition.expectedAuthorizationRevision,
    ...(transition.role === undefined ? {} : { role: transition.role }),
    ...(transition.reason === undefined ? {} : { reason: transition.reason }),
  };
  return await withOrganizationLifecycleDeadlockReplay(async () =>
    db.transaction(async (tx) => {
      if (transition.kind === "suspend" || transition.kind === "offboard") {
        const settlements = await prepareOrganizationMembershipProtocolSettlements(
          tx as unknown as Database,
          command,
        );
        await settleOrganizationMembershipProtocols(tx as unknown as Database, settlements);
      }
      return OrganizationMember.parse(await runCommand(tx as unknown as Database, command));
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
