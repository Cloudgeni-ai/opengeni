import { createHash, randomUUID } from "node:crypto";
import {
  WorkspaceLearningMode,
  WorkspaceLearningPolicySnapshot,
  WORKSPACE_LEARNING_POLICY_REASON_MAX_CHARS,
  canonicalizeWorkspaceLearningSourceOverrides,
  type WorkspaceLearningPolicyActivationEvent,
  type WorkspaceLearningPolicyActivationType,
  type WorkspaceLearningPolicyHead,
  type WorkspaceLearningPolicyRevision,
  type WorkspaceLearningSourceOverrideInput,
} from "@opengeni/contracts";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withRlsContext } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import * as schema from "./schema";

export class WorkspaceLearningPolicyConflictError extends Error {
  readonly name = "WorkspaceLearningPolicyConflictError";
  readonly code = "WORKSPACE_LEARNING_POLICY_CONFLICT";

  constructor(readonly currentHead: WorkspaceLearningPolicyHead | null) {
    super("The active workspace learning policy changed in another request");
  }
}

export class WorkspaceLearningPolicyOperationReuseError extends Error {
  readonly name = "WorkspaceLearningPolicyOperationReuseError";
  readonly code = "WORKSPACE_LEARNING_POLICY_OPERATION_REUSED";

  constructor() {
    super("The workspace learning-policy operation id was already used for another request");
  }
}

export class WorkspaceLearningPolicyNotFoundError extends Error {
  readonly name = "WorkspaceLearningPolicyNotFoundError";

  constructor(message = "Workspace learning-policy revision was not found") {
    super(message);
  }
}

export class WorkspaceLearningPolicyInvalidOperationError extends Error {
  readonly name = "WorkspaceLearningPolicyInvalidOperationError";
}

export class WorkspaceLearningPolicyAuthorityError extends Error {
  readonly name = "WorkspaceLearningPolicyAuthorityError";
}

export type WorkspaceLearningPolicyAttemptClaims = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

type RevisionRow = typeof schema.workspaceLearningPolicyRevisions.$inferSelect;
type HeadRow = typeof schema.workspaceLearningPolicyHeads.$inferSelect;
type EventRow = typeof schema.workspaceLearningPolicyActivationEvents.$inferSelect;
type SnapshotRow = typeof schema.workspaceLearningPolicySnapshots.$inferSelect;

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function revisionIdentity(row: RevisionRow) {
  return { id: row.id, revision: row.revision, policyHash: row.policyHash };
}

function revisionFromRow(row: RevisionRow): WorkspaceLearningPolicyRevision {
  return {
    ...revisionIdentity(row),
    operationId: row.operationId,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    workspaceMode: WorkspaceLearningMode.parse(row.workspaceMode),
    sourceOverrides: canonicalizeWorkspaceLearningSourceOverrides(row.sourceOverrides),
    supersedesRevisionId: row.supersedesRevisionId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  };
}

function headFromRow(row: HeadRow): WorkspaceLearningPolicyHead {
  return {
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    revisionId: row.revisionId,
    revision: row.revision,
    policyHash: row.policyHash,
    activationVersion: row.activationVersion,
    activatedAt: iso(row.activatedAt),
  };
}

function eventFromRow(row: EventRow): WorkspaceLearningPolicyActivationEvent {
  return {
    id: row.id,
    operationId: row.operationId,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    type: row.type as WorkspaceLearningPolicyActivationType,
    activationVersion: row.activationVersion,
    oldRevision:
      row.oldRevisionId === null
        ? null
        : {
            id: row.oldRevisionId,
            revision: row.oldRevision!,
            policyHash: row.oldPolicyHash!,
          },
    newRevision: {
      id: row.newRevisionId,
      revision: row.newRevision,
      policyHash: row.newPolicyHash,
    },
    actorSubjectId: row.actorSubjectId,
    reason: row.reason,
    createdAt: iso(row.createdAt),
  };
}

function snapshotFromRow(row: SnapshotRow): WorkspaceLearningPolicySnapshot {
  return WorkspaceLearningPolicySnapshot.parse({
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    attemptId: row.attemptId,
    executionGeneration: row.executionGeneration,
    revision:
      row.revisionId === null
        ? null
        : { id: row.revisionId, revision: row.revision, policyHash: row.policyHash },
    activationVersion: row.activationVersion,
    activatedAt: row.activatedAt === null ? null : iso(row.activatedAt),
    workspaceMode: row.workspaceMode,
    sourceOverrides: row.sourceOverrides,
    snapshotHash: row.snapshotHash,
    createdAt: iso(row.createdAt),
  });
}

function operationFingerprint(operation: string, fields: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["workspace_learning_policy_operation", 1, operation, fields]), "utf8")
    .digest("hex");
}

function requireHumanAuthority(input: {
  actorSubjectId: string;
  principalKind: string | undefined;
}): void {
  if (input.principalKind !== "human_session" || input.actorSubjectId.trim().length === 0) {
    throw new WorkspaceLearningPolicyAuthorityError(
      "Workspace learning-policy changes require an exact authenticated human actor",
    );
  }
}

function requireActivationInput(input: {
  expectedActivationVersion: number;
  actorSubjectId: string;
  reason: string;
}): void {
  if (
    !Number.isSafeInteger(input.expectedActivationVersion) ||
    input.expectedActivationVersion < 0
  ) {
    throw new WorkspaceLearningPolicyInvalidOperationError(
      "Workspace learning-policy activation version must be a nonnegative safe integer",
    );
  }
  if (input.actorSubjectId.trim() !== input.actorSubjectId || input.actorSubjectId.length > 1_024) {
    throw new WorkspaceLearningPolicyInvalidOperationError(
      "Workspace learning-policy actor identity is invalid",
    );
  }
  if (
    input.reason.trim().length === 0 ||
    input.reason.trim() !== input.reason ||
    input.reason.length > WORKSPACE_LEARNING_POLICY_REASON_MAX_CHARS
  ) {
    throw new WorkspaceLearningPolicyInvalidOperationError(
      `Workspace learning-policy reason must contain 1-${WORKSPACE_LEARNING_POLICY_REASON_MAX_CHARS} non-edge-whitespace characters`,
    );
  }
}

async function setHumanAuthority(
  db: Database,
  input: { actorSubjectId: string; principalKind: string },
): Promise<void> {
  await db.execute(sql`select set_config('opengeni.subject_id', ${input.actorSubjectId}, true)`);
  await db.execute(sql`select set_config('opengeni.principal_kind', ${input.principalKind}, true)`);
}

async function currentHeadInTransaction(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<WorkspaceLearningPolicyHead | null> {
  const [row] = await db
    .select()
    .from(schema.workspaceLearningPolicyHeads)
    .where(
      and(
        eq(schema.workspaceLearningPolicyHeads.accountId, accountId),
        eq(schema.workspaceLearningPolicyHeads.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row ? headFromRow(row) : null;
}

export async function createWorkspaceLearningPolicyRevision(
  db: Database,
  input: {
    operationId?: string;
    accountId: string;
    workspaceId: string;
    workspaceMode: "off" | "suggest" | "automatic";
    sourceOverrides?: WorkspaceLearningSourceOverrideInput[];
    supersedesRevisionId?: string | null;
    actorSubjectId: string;
    principalKind: string | undefined;
  },
): Promise<WorkspaceLearningPolicyRevision> {
  requireHumanAuthority(input);
  const operationId = input.operationId ?? randomUUID();
  const workspaceMode = WorkspaceLearningMode.parse(input.workspaceMode);
  const sourceOverrides = canonicalizeWorkspaceLearningSourceOverrides(input.sourceOverrides ?? []);
  const supersedesRevisionId = input.supersedesRevisionId ?? null;
  const requestFingerprint = operationFingerprint("create_revision", [
    input.accountId,
    input.workspaceId,
    workspaceMode,
    sourceOverrides,
    supersedesRevisionId,
    input.actorSubjectId,
  ]);

  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [existing] = await scopedDb
        .select()
        .from(schema.workspaceLearningPolicyRevisions)
        .where(
          and(
            eq(schema.workspaceLearningPolicyRevisions.workspaceId, input.workspaceId),
            eq(schema.workspaceLearningPolicyRevisions.operationId, operationId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new WorkspaceLearningPolicyOperationReuseError();
        }
        return revisionFromRow(existing);
      }
      const [eventReuse] = await scopedDb
        .select({ id: schema.workspaceLearningPolicyActivationEvents.id })
        .from(schema.workspaceLearningPolicyActivationEvents)
        .where(
          and(
            eq(schema.workspaceLearningPolicyActivationEvents.workspaceId, input.workspaceId),
            eq(schema.workspaceLearningPolicyActivationEvents.operationId, operationId),
          ),
        )
        .limit(1);
      if (eventReuse) throw new WorkspaceLearningPolicyOperationReuseError();

      try {
        const [row] = await scopedDb
          .insert(schema.workspaceLearningPolicyRevisions)
          .values({
            operationId,
            requestFingerprint,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            workspaceMode,
            sourceOverrides,
            policyHash: sql<string>`workspace_learning_policy_hash(${workspaceMode}, ${JSON.stringify(
              sourceOverrides,
            )}::jsonb)`,
            supersedesRevisionId,
            createdBySubjectId: input.actorSubjectId,
          })
          .returning();
        if (!row) throw new Error("Workspace learning-policy revision was not recorded");
        return revisionFromRow(row);
      } catch (error) {
        if (nestedPostgresSqlState(error) === "23505") {
          throw new WorkspaceLearningPolicyOperationReuseError();
        }
        if (nestedPostgresSqlState(error) === "23514") {
          throw new WorkspaceLearningPolicyInvalidOperationError(
            "Workspace learning-policy revision failed immutable scope validation",
          );
        }
        throw error;
      }
    },
  );
}

async function changeActiveWorkspaceLearningPolicy(
  db: Database,
  input: {
    operationId?: string;
    accountId: string;
    workspaceId: string;
    targetRevisionId: string;
    expectedCurrentRevisionId: string | null;
    expectedActivationVersion: number;
    actorSubjectId: string;
    principalKind: string | undefined;
    reason: string;
    type: WorkspaceLearningPolicyActivationType;
  },
) {
  requireHumanAuthority(input);
  requireActivationInput(input);
  const operationId = input.operationId ?? randomUUID();
  const requestFingerprint = operationFingerprint(`change_active:${input.type}`, [
    input.accountId,
    input.workspaceId,
    input.targetRevisionId,
    input.expectedCurrentRevisionId,
    input.expectedActivationVersion,
    input.actorSubjectId,
    input.reason,
  ]);
  try {
    return await withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      async (scopedDb) => {
        await setHumanAuthority(scopedDb, {
          actorSubjectId: input.actorSubjectId,
          principalKind: input.principalKind!,
        });
        const [receipt] = await rawRows<{ eventId: string }>(
          scopedDb,
          sql`select event_id as "eventId"
              from workspace_learning_policy_apply_activation(
                ${operationId}::uuid,
                ${requestFingerprint},
                ${input.accountId}::uuid,
                ${input.workspaceId}::uuid,
                ${input.targetRevisionId}::uuid,
                ${input.expectedCurrentRevisionId}::uuid,
                ${input.expectedActivationVersion}::bigint,
                ${input.type},
                ${input.actorSubjectId},
                ${input.reason}
              )`,
        );
        if (!receipt) throw new Error("Workspace learning-policy activation returned no receipt");
        const [[event], [head]] = await Promise.all([
          scopedDb
            .select()
            .from(schema.workspaceLearningPolicyActivationEvents)
            .where(eq(schema.workspaceLearningPolicyActivationEvents.id, receipt.eventId))
            .limit(1),
          scopedDb
            .select()
            .from(schema.workspaceLearningPolicyHeads)
            .where(eq(schema.workspaceLearningPolicyHeads.workspaceId, input.workspaceId))
            .limit(1),
        ]);
        if (!event || !head) throw new Error("Workspace learning-policy activation was incomplete");
        return { head: headFromRow(head), event: eventFromRow(event) };
      },
    );
  } catch (error) {
    const state = nestedPostgresSqlState(error);
    if (state === "40001") {
      const currentHead = await withRlsContext(
        db,
        { accountId: input.accountId, workspaceId: input.workspaceId },
        async (scopedDb) =>
          await currentHeadInTransaction(scopedDb, input.accountId, input.workspaceId),
      );
      throw new WorkspaceLearningPolicyConflictError(currentHead);
    }
    if (state === "42501") {
      throw new WorkspaceLearningPolicyAuthorityError(
        "Workspace learning-policy activation was not authorized",
      );
    }
    if (state === "23503") throw new WorkspaceLearningPolicyNotFoundError();
    if (state === "P1471") throw new WorkspaceLearningPolicyOperationReuseError();
    if (state === "22023") {
      throw new WorkspaceLearningPolicyInvalidOperationError(
        "Workspace learning-policy activation input is invalid",
      );
    }
    if (state === "23514") {
      throw new WorkspaceLearningPolicyInvalidOperationError(
        input.type === "rollback"
          ? "Workspace learning-policy rollback requires a distinct previously active revision"
          : "Workspace learning-policy revision cannot be activated",
      );
    }
    throw error;
  }
}

export async function activateWorkspaceLearningPolicyRevision(
  db: Database,
  input: Omit<
    Parameters<typeof changeActiveWorkspaceLearningPolicy>[1],
    "type" | "targetRevisionId"
  > & {
    revisionId: string;
  },
) {
  return await changeActiveWorkspaceLearningPolicy(db, {
    ...input,
    targetRevisionId: input.revisionId,
    type: "activate",
  });
}

export async function rollbackWorkspaceLearningPolicyRevision(
  db: Database,
  input: Omit<Parameters<typeof changeActiveWorkspaceLearningPolicy>[1], "type">,
) {
  return await changeActiveWorkspaceLearningPolicy(db, { ...input, type: "rollback" });
}

export async function listWorkspaceLearningPolicyHistory(
  db: Database,
  input: { accountId: string; workspaceId: string; limit?: number },
): Promise<{
  head: WorkspaceLearningPolicyHead | null;
  revisions: WorkspaceLearningPolicyRevision[];
  events: WorkspaceLearningPolicyActivationEvent[];
}> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [heads, revisions, events] = await Promise.all([
        scopedDb
          .select()
          .from(schema.workspaceLearningPolicyHeads)
          .where(eq(schema.workspaceLearningPolicyHeads.workspaceId, input.workspaceId))
          .limit(1),
        scopedDb
          .select()
          .from(schema.workspaceLearningPolicyRevisions)
          .where(eq(schema.workspaceLearningPolicyRevisions.workspaceId, input.workspaceId))
          .orderBy(desc(schema.workspaceLearningPolicyRevisions.revision))
          .limit(limit),
        scopedDb
          .select()
          .from(schema.workspaceLearningPolicyActivationEvents)
          .where(eq(schema.workspaceLearningPolicyActivationEvents.workspaceId, input.workspaceId))
          .orderBy(
            desc(schema.workspaceLearningPolicyActivationEvents.activationVersion),
            asc(schema.workspaceLearningPolicyActivationEvents.id),
          )
          .limit(limit),
      ]);
      return {
        head: heads[0] ? headFromRow(heads[0]) : null,
        revisions: revisions.map(revisionFromRow),
        events: events.map(eventFromRow),
      };
    },
  );
}

export async function getOrCreateWorkspaceLearningPolicySnapshot(
  db: Database,
  claims: WorkspaceLearningPolicyAttemptClaims,
): Promise<WorkspaceLearningPolicySnapshot> {
  try {
    return await withRlsContext(
      db,
      { accountId: claims.accountId, workspaceId: claims.workspaceId },
      async (scopedDb) => {
        const [receipt] = await rawRows<{ snapshotId: string }>(
          scopedDb,
          sql`select snapshot_id as "snapshotId"
              from workspace_learning_policy_get_or_create_snapshot(
                ${claims.accountId}::uuid,
                ${claims.workspaceId}::uuid,
                ${claims.sessionId}::uuid,
                ${claims.turnId}::uuid,
                ${claims.attemptId}::uuid,
                ${claims.executionGeneration}::integer
              )`,
        );
        if (!receipt) throw new Error("Workspace learning-policy snapshot returned no receipt");
        const [row] = await scopedDb
          .select()
          .from(schema.workspaceLearningPolicySnapshots)
          .where(
            and(
              eq(schema.workspaceLearningPolicySnapshots.id, receipt.snapshotId),
              eq(schema.workspaceLearningPolicySnapshots.accountId, claims.accountId),
              eq(schema.workspaceLearningPolicySnapshots.workspaceId, claims.workspaceId),
              eq(schema.workspaceLearningPolicySnapshots.attemptId, claims.attemptId),
            ),
          )
          .limit(1);
        if (!row) throw new Error("Workspace learning-policy snapshot was not recorded");
        return snapshotFromRow(row);
      },
    );
  } catch (error) {
    const state = nestedPostgresSqlState(error);
    if (state === "42501") {
      throw new WorkspaceLearningPolicyAuthorityError(
        "Workspace learning-policy snapshot was not authorized",
      );
    }
    if (state === "23514") {
      throw new WorkspaceLearningPolicyInvalidOperationError(
        "Workspace learning-policy snapshot requires the exact active attempt",
      );
    }
    throw error;
  }
}
