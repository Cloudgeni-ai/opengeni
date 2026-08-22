import { createHash } from "node:crypto";

import {
  type Permission,
  SlackUserLinkAccessRequest as SlackUserLinkAccessRequestSchema,
  type SlackUserLinkAccessRequest,
  type SlackUserLinkAccessRequestStatus,
} from "@opengeni/contracts";
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";

import { type Database, withWorkspaceRls } from "./database";
import { withLosslessContentWriteVersion } from "./lossless-json";
import * as schema from "./schema";
import { normalizeWorkspaceMembershipPermissions } from "./workspace-membership-permissions";

type RequestRow = typeof schema.slackUserLinkAccessRequests.$inferSelect;
type OperationKind = "request" | "cancel" | "approve" | "deny";

export class SlackUserLinkAccessPersistenceError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "subject_mismatch"
      | "claim_mismatch"
      | "version_conflict"
      | "state_conflict"
      | "idempotency_conflict"
      | "slack_identity_conflict",
  ) {
    super(code);
    this.name = "SlackUserLinkAccessPersistenceError";
  }
}

export type PrepareSlackUserLinkAccessInput = {
  accountId: string;
  workspaceId: string;
  tokenDigest: string;
  connectionId: string;
  slackTeamId: string;
  slackUserId: string;
  subjectId: string;
  subjectLabel?: string | null;
  expiresAt: Date;
};

export type SlackUserLinkAccessMutationInput = {
  workspaceId: string;
  requestId: string;
  actorSubjectId: string;
  expectedVersion: number;
  idempotencyKey: string;
};

export type ApproveSlackUserLinkAccessInput = SlackUserLinkAccessMutationInput & {
  role?: string;
  permissions: Permission[];
};

const activeStatuses: SlackUserLinkAccessRequestStatus[] = ["prepared", "pending"];

function isActiveStatus(status: string): status is (typeof activeStatuses)[number] {
  return activeStatuses.includes(status as (typeof activeStatuses)[number]);
}

/**
 * Persist one verified Slack bearer as token-free, subject-bound state. A
 * second fresh bearer for the same exact subject/provider principal supersedes
 * only that subject's older active intent; another subject's row is untouched.
 */
export async function prepareSlackUserLinkAccessRequest(
  db: Database,
  input: PrepareSlackUserLinkAccessInput,
  now = new Date(),
): Promise<SlackUserLinkAccessRequest> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const [existing] = await tx
          .select()
          .from(schema.slackUserLinkAccessRequests)
          .where(eq(schema.slackUserLinkAccessRequests.tokenDigest, input.tokenDigest))
          .for("update")
          .limit(1);
        if (existing) {
          assertExactClaims(existing, input);
          if (existing.subjectId !== input.subjectId) {
            throw new SlackUserLinkAccessPersistenceError("subject_mismatch");
          }
          return mapRequest(await expireLockedRequest(database, existing, now));
        }

        const superseded = await tx
          .select()
          .from(schema.slackUserLinkAccessRequests)
          .where(
            and(
              eq(schema.slackUserLinkAccessRequests.workspaceId, input.workspaceId),
              eq(schema.slackUserLinkAccessRequests.connectionId, input.connectionId),
              eq(schema.slackUserLinkAccessRequests.slackUserId, input.slackUserId),
              eq(schema.slackUserLinkAccessRequests.subjectId, input.subjectId),
              inArray(schema.slackUserLinkAccessRequests.status, activeStatuses),
              ne(schema.slackUserLinkAccessRequests.tokenDigest, input.tokenDigest),
            ),
          )
          .for("update");
        for (const row of superseded) {
          const current = await expireLockedRequest(database, row, now);
          if (!isActiveStatus(current.status)) continue;
          const [cancelled] = await tx
            .update(schema.slackUserLinkAccessRequests)
            .set({
              status: "cancelled",
              version: current.version + 1,
              decidedAt: now,
              decisionBySubjectId: input.subjectId,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.slackUserLinkAccessRequests.id, current.id),
                eq(schema.slackUserLinkAccessRequests.version, current.version),
              ),
            )
            .returning();
          if (cancelled) {
            await insertAudit(database, cancelled, input.subjectId, "slack.user_link.superseded");
          }
        }

        const [created] = await tx
          .insert(schema.slackUserLinkAccessRequests)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            tokenDigest: input.tokenDigest,
            connectionId: input.connectionId,
            slackTeamId: input.slackTeamId,
            slackUserId: input.slackUserId,
            subjectId: input.subjectId,
            subjectLabel: input.subjectLabel ?? null,
            expiresAt: input.expiresAt,
          })
          .returning();
        if (!created) throw new Error("Slack user-link access request insert returned no row");
        await insertAudit(database, created, input.subjectId, "slack.user_link.prepared");
        return mapRequest(created);
      }),
    { isolationLevel: "serializable" },
  );
}

export async function getSlackUserLinkAccessRequestForSubject(
  db: Database,
  input: { workspaceId: string; requestId: string; subjectId: string },
  now = new Date(),
): Promise<SlackUserLinkAccessRequest | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.slackUserLinkAccessRequests)
        .where(
          and(
            eq(schema.slackUserLinkAccessRequests.workspaceId, input.workspaceId),
            eq(schema.slackUserLinkAccessRequests.id, input.requestId),
            eq(schema.slackUserLinkAccessRequests.subjectId, input.subjectId),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) return null;
      return mapRequest(await expireLockedRequest(tx as unknown as Database, row, now));
    });
  });
}

export async function requestSlackUserLinkWorkspaceAccess(
  db: Database,
  input: SlackUserLinkAccessMutationInput,
  now = new Date(),
): Promise<SlackUserLinkAccessRequest> {
  return await mutateRequest(db, input, "request", {}, now, async (database, row) => {
    if (row.subjectId !== input.actorSubjectId) {
      throw new SlackUserLinkAccessPersistenceError("subject_mismatch");
    }
    if (row.status !== "prepared") {
      throw new SlackUserLinkAccessPersistenceError("state_conflict");
    }
    const [updated] = await database
      .update(schema.slackUserLinkAccessRequests)
      .set({
        status: "pending",
        version: row.version + 1,
        requestedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.slackUserLinkAccessRequests.id, row.id),
          eq(schema.slackUserLinkAccessRequests.version, row.version),
        ),
      )
      .returning();
    if (!updated) throw new SlackUserLinkAccessPersistenceError("version_conflict");
    await insertAudit(database, updated, input.actorSubjectId, "workspace.access_request.created");
    return updated;
  });
}

export async function cancelSlackUserLinkAccessRequest(
  db: Database,
  input: SlackUserLinkAccessMutationInput,
  now = new Date(),
): Promise<SlackUserLinkAccessRequest> {
  return await mutateRequest(db, input, "cancel", {}, now, async (database, row) => {
    if (row.subjectId !== input.actorSubjectId) {
      throw new SlackUserLinkAccessPersistenceError("subject_mismatch");
    }
    if (row.status !== "prepared" && row.status !== "pending") {
      throw new SlackUserLinkAccessPersistenceError("state_conflict");
    }
    const [updated] = await database
      .update(schema.slackUserLinkAccessRequests)
      .set({
        status: "cancelled",
        version: row.version + 1,
        decidedAt: now,
        decisionBySubjectId: input.actorSubjectId,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.slackUserLinkAccessRequests.id, row.id),
          eq(schema.slackUserLinkAccessRequests.version, row.version),
        ),
      )
      .returning();
    if (!updated) throw new SlackUserLinkAccessPersistenceError("version_conflict");
    await insertAudit(
      database,
      updated,
      input.actorSubjectId,
      "workspace.access_request.cancelled",
    );
    return updated;
  });
}

export async function denySlackUserLinkAccessRequest(
  db: Database,
  input: SlackUserLinkAccessMutationInput,
  now = new Date(),
): Promise<SlackUserLinkAccessRequest> {
  return await mutateRequest(db, input, "deny", {}, now, async (database, row) => {
    if (row.status !== "pending") {
      throw new SlackUserLinkAccessPersistenceError("state_conflict");
    }
    const [updated] = await database
      .update(schema.slackUserLinkAccessRequests)
      .set({
        status: "denied",
        version: row.version + 1,
        decidedAt: now,
        decisionBySubjectId: input.actorSubjectId,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.slackUserLinkAccessRequests.id, row.id),
          eq(schema.slackUserLinkAccessRequests.version, row.version),
        ),
      )
      .returning();
    if (!updated) throw new SlackUserLinkAccessPersistenceError("version_conflict");
    await insertAudit(database, updated, input.actorSubjectId, "workspace.access_request.denied");
    return updated;
  });
}

export async function approveSlackUserLinkAccessRequest(
  db: Database,
  input: ApproveSlackUserLinkAccessInput,
  now = new Date(),
): Promise<SlackUserLinkAccessRequest> {
  return await mutateRequest(
    db,
    input,
    "approve",
    { role: input.role ?? "member", permissions: input.permissions },
    now,
    async (database, row) => {
      if (row.status !== "pending") {
        throw new SlackUserLinkAccessPersistenceError("state_conflict");
      }
      await assertSlackIdentityAvailable(database, row);
      const role = input.role ?? "member";
      await database
        .insert(schema.workspaceMemberships)
        .values({
          accountId: row.accountId,
          workspaceId: row.workspaceId,
          subjectId: row.subjectId,
          subjectLabel: row.subjectLabel,
          role,
          permissions: input.permissions,
        })
        .onConflictDoUpdate({
          target: [schema.workspaceMemberships.subjectId, schema.workspaceMemberships.workspaceId],
          set: {
            subjectLabel: row.subjectLabel,
            role,
            permissions: input.permissions,
            updatedAt: now,
          },
        });
      const membership = await membershipAllowsSlackLink(database, row);
      if (!membership) throw new Error("Slack access approval did not create the required grant");
      await upsertSlackIdentityLink(database, row, input.actorSubjectId, now);
      const [updated] = await database
        .update(schema.slackUserLinkAccessRequests)
        .set({
          status: "completed",
          version: row.version + 1,
          decidedAt: now,
          decisionBySubjectId: input.actorSubjectId,
          approvedRole: role,
          approvedPermissions: input.permissions,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.slackUserLinkAccessRequests.id, row.id),
            eq(schema.slackUserLinkAccessRequests.version, row.version),
          ),
        )
        .returning();
      if (!updated) throw new SlackUserLinkAccessPersistenceError("version_conflict");
      await insertAudit(
        database,
        updated,
        input.actorSubjectId,
        "workspace.access_request.approved",
        {
          membershipRole: role,
          membershipPermissions: input.permissions,
        },
      );
      await insertAudit(database, updated, input.actorSubjectId, "slack.user_link.completed");
      return updated;
    },
  );
}

/**
 * Complete a prepared/pending link only when the subject's live membership
 * already grants sessions:create (or workspace:admin). This is used both for
 * ordinary already-authorized links and after a separate canonical member grant.
 */
export async function completeSlackUserLinkAccessIfGranted(
  db: Database,
  input: { workspaceId: string; requestId: string; subjectId: string },
  now = new Date(),
): Promise<SlackUserLinkAccessRequest | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const database = tx as unknown as Database;
      const [found] = await tx
        .select()
        .from(schema.slackUserLinkAccessRequests)
        .where(
          and(
            eq(schema.slackUserLinkAccessRequests.workspaceId, input.workspaceId),
            eq(schema.slackUserLinkAccessRequests.id, input.requestId),
            eq(schema.slackUserLinkAccessRequests.subjectId, input.subjectId),
          ),
        )
        .for("update")
        .limit(1);
      if (!found) return null;
      const row = await expireLockedRequest(database, found, now);
      if (row.status === "completed" || !isActiveStatus(row.status)) {
        return mapRequest(row);
      }
      if (!(await membershipAllowsSlackLink(database, row))) {
        return mapRequest(row);
      }
      await assertSlackIdentityAvailable(database, row);
      await upsertSlackIdentityLink(database, row, input.subjectId, now);
      const [updated] = await tx
        .update(schema.slackUserLinkAccessRequests)
        .set({
          status: "completed",
          version: row.version + 1,
          decidedAt: now,
          decisionBySubjectId: input.subjectId,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.slackUserLinkAccessRequests.id, row.id),
            eq(schema.slackUserLinkAccessRequests.version, row.version),
          ),
        )
        .returning();
      if (!updated) throw new SlackUserLinkAccessPersistenceError("version_conflict");
      await insertAudit(database, updated, input.subjectId, "slack.user_link.completed");
      return mapRequest(updated);
    });
  });
}

export async function listPendingSlackUserLinkAccessRequests(
  db: Database,
  workspaceId: string,
  now = new Date(),
): Promise<SlackUserLinkAccessRequest[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const database = tx as unknown as Database;
      const expired = await tx
        .select()
        .from(schema.slackUserLinkAccessRequests)
        .where(
          and(
            eq(schema.slackUserLinkAccessRequests.workspaceId, workspaceId),
            inArray(schema.slackUserLinkAccessRequests.status, activeStatuses),
          ),
        )
        .for("update");
      for (const row of expired) {
        if (row.expiresAt.getTime() <= now.getTime()) {
          await expireLockedRequest(database, row, now);
        }
      }
      const rows = await tx
        .select()
        .from(schema.slackUserLinkAccessRequests)
        .where(
          and(
            eq(schema.slackUserLinkAccessRequests.workspaceId, workspaceId),
            eq(schema.slackUserLinkAccessRequests.status, "pending"),
            gt(schema.slackUserLinkAccessRequests.expiresAt, now),
          ),
        )
        .orderBy(asc(schema.slackUserLinkAccessRequests.requestedAt));
      return rows.map(mapRequest);
    });
  });
}

async function mutateRequest(
  db: Database,
  input: SlackUserLinkAccessMutationInput,
  operation: OperationKind,
  protectedInput: Record<string, unknown>,
  now: Date,
  transition: (database: Database, row: RequestRow) => Promise<RequestRow>,
): Promise<SlackUserLinkAccessRequest> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const database = tx as unknown as Database;
      const requestDigest = digestOperation({
        operation,
        requestId: input.requestId,
        actorSubjectId: input.actorSubjectId,
        expectedVersion: input.expectedVersion,
        ...protectedInput,
      });
      const [found] = await tx
        .select()
        .from(schema.slackUserLinkAccessRequests)
        .where(
          and(
            eq(schema.slackUserLinkAccessRequests.workspaceId, input.workspaceId),
            eq(schema.slackUserLinkAccessRequests.id, input.requestId),
          ),
        )
        .for("update")
        .limit(1);
      if (!found) throw new SlackUserLinkAccessPersistenceError("not_found");
      const [replay] = await tx
        .select()
        .from(schema.slackUserLinkAccessRequestOperations)
        .where(
          and(
            eq(schema.slackUserLinkAccessRequestOperations.requestId, input.requestId),
            eq(schema.slackUserLinkAccessRequestOperations.actorSubjectId, input.actorSubjectId),
            eq(schema.slackUserLinkAccessRequestOperations.operation, operation),
            eq(schema.slackUserLinkAccessRequestOperations.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (replay) {
        if (
          replay.requestDigest !== requestDigest ||
          replay.expectedVersion !== input.expectedVersion
        ) {
          throw new SlackUserLinkAccessPersistenceError("idempotency_conflict");
        }
        return SlackUserLinkAccessRequestSchema.parse(replay.result);
      }
      const row = await expireLockedRequest(database, found, now);
      if (row.version !== input.expectedVersion) {
        throw new SlackUserLinkAccessPersistenceError("version_conflict");
      }
      const updated = await transition(database, row);
      const result = mapRequest(updated);
      await tx.insert(schema.slackUserLinkAccessRequestOperations).values({
        accountId: updated.accountId,
        workspaceId: updated.workspaceId,
        requestId: updated.id,
        actorSubjectId: input.actorSubjectId,
        operation,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        expectedVersion: input.expectedVersion,
        resultVersion: updated.version,
        resultStatus: updated.status,
        result,
      });
      return result;
    });
  });
}

async function expireLockedRequest(database: Database, row: RequestRow, now: Date) {
  if (!isActiveStatus(row.status) || row.expiresAt.getTime() > now.getTime()) {
    return row;
  }
  const [updated] = await database
    .update(schema.slackUserLinkAccessRequests)
    .set({
      status: "expired",
      version: row.version + 1,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.slackUserLinkAccessRequests.id, row.id),
        eq(schema.slackUserLinkAccessRequests.version, row.version),
      ),
    )
    .returning();
  if (!updated) throw new SlackUserLinkAccessPersistenceError("version_conflict");
  await insertAudit(database, updated, null, "workspace.access_request.expired");
  return updated;
}

async function membershipAllowsSlackLink(database: Database, row: RequestRow) {
  const [membership] = await database
    .select({ permissions: schema.workspaceMemberships.permissions })
    .from(schema.workspaceMemberships)
    .where(
      and(
        eq(schema.workspaceMemberships.workspaceId, row.workspaceId),
        eq(schema.workspaceMemberships.subjectId, row.subjectId),
      ),
    )
    .limit(1);
  return workspaceMembershipPermissionsAllowSlackLink(membership?.permissions);
}

export function workspaceMembershipPermissionsAllowSlackLink(value: unknown): boolean {
  const permissions = normalizeWorkspaceMembershipPermissions(value);
  return permissions.includes("sessions:create") || permissions.includes("workspace:admin");
}

async function assertSlackIdentityAvailable(database: Database, row: RequestRow) {
  const [existing] = await database
    .select({ subjectId: schema.slackBotUserLinks.subjectId })
    .from(schema.slackBotUserLinks)
    .where(
      and(
        eq(schema.slackBotUserLinks.connectionId, row.connectionId),
        eq(schema.slackBotUserLinks.slackUserId, row.slackUserId),
      ),
    )
    .for("update")
    .limit(1);
  if (existing && existing.subjectId !== row.subjectId) {
    throw new SlackUserLinkAccessPersistenceError("slack_identity_conflict");
  }
}

async function upsertSlackIdentityLink(
  database: Database,
  row: RequestRow,
  actorSubjectId: string,
  now: Date,
) {
  const [created] = await database
    .insert(schema.slackBotUserLinks)
    .values({
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      connectionId: row.connectionId,
      slackTeamId: row.slackTeamId,
      slackUserId: row.slackUserId,
      subjectId: row.subjectId,
      linkedBySubjectId: actorSubjectId,
    })
    .onConflictDoNothing({
      target: [schema.slackBotUserLinks.connectionId, schema.slackBotUserLinks.slackUserId],
    })
    .returning({ id: schema.slackBotUserLinks.id });
  if (created) return;

  const [existing] = await database
    .select({ id: schema.slackBotUserLinks.id, subjectId: schema.slackBotUserLinks.subjectId })
    .from(schema.slackBotUserLinks)
    .where(
      and(
        eq(schema.slackBotUserLinks.connectionId, row.connectionId),
        eq(schema.slackBotUserLinks.slackUserId, row.slackUserId),
      ),
    )
    .for("update")
    .limit(1);
  if (!existing || existing.subjectId !== row.subjectId) {
    throw new SlackUserLinkAccessPersistenceError("slack_identity_conflict");
  }
  await database
    .update(schema.slackBotUserLinks)
    .set({
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      slackTeamId: row.slackTeamId,
      linkedBySubjectId: actorSubjectId,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.slackBotUserLinks.id, existing.id),
        eq(schema.slackBotUserLinks.subjectId, row.subjectId),
      ),
    );
}

async function insertAudit(
  database: Database,
  row: RequestRow,
  actorSubjectId: string | null,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await database.insert(schema.auditEvents).values(
    withLosslessContentWriteVersion(
      {
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        subjectId: actorSubjectId,
        action,
        targetType: "slack_user_link_access_request",
        targetId: row.id,
        metadata: {
          status: row.status,
          version: row.version,
          connectionId: row.connectionId,
          ...metadata,
        },
      },
      "metadata",
      "metadataCodecVersion",
    ),
  );
}

function assertExactClaims(row: RequestRow, input: PrepareSlackUserLinkAccessInput) {
  if (
    row.accountId !== input.accountId ||
    row.workspaceId !== input.workspaceId ||
    row.connectionId !== input.connectionId ||
    row.slackTeamId !== input.slackTeamId ||
    row.slackUserId !== input.slackUserId ||
    row.expiresAt.getTime() !== input.expiresAt.getTime()
  ) {
    throw new SlackUserLinkAccessPersistenceError("claim_mismatch");
  }
}

function digestOperation(value: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mapRequest(row: RequestRow): SlackUserLinkAccessRequest {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceDisplayName: null,
    subjectLabel: row.subjectLabel,
    status: row.status as SlackUserLinkAccessRequestStatus,
    version: row.version,
    expiresAt: row.expiresAt.toISOString(),
    requestedAt: row.requestedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
