/**
 * Approval for each agent use of chosen secrets (0952). Rules say which items
 * and fields need the acting person's approval; request rows record one
 * blocked use and, once decided, the grant it became. Nothing here holds or
 * reads a value. Reach to the items themselves stays with the vault routines:
 * callers check it before changing rules.
 */
import {
  SECRET_USE_APPROVAL_ONCE_TTL_MS,
  SECRET_USE_APPROVAL_WINDOW_MS,
  type SecretUseApprovalDecision,
  type SecretUseApprovalRequestView,
  type SecretUseApprovalTarget,
  type SecretUseGrantScope,
} from "@opengeni/contracts";
import { and, desc, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";

type Scope = { accountId: string; workspaceId: string };

export type SecretApprovalRuleRow = { itemId: string; fieldKey: string };

export type SecretUseApprovalRow = typeof schema.secretUseApprovals.$inferSelect;

/** A pending request is offered again for an identical blocked use this long. */
const PENDING_REUSE_MS = 60 * 60 * 1000;

/** The rules for these items: `fieldKey` is empty for the whole item. */
export async function listSecretApprovalRules(
  db: Database,
  scope: Scope,
  itemIds: readonly string[],
): Promise<SecretApprovalRuleRow[]> {
  if (itemIds.length === 0) return [];
  return await withRlsContext(db, scope, async (scoped) =>
    scoped
      .select({
        itemId: schema.secretApprovalRules.itemId,
        fieldKey: schema.secretApprovalRules.fieldKey,
      })
      .from(schema.secretApprovalRules)
      .where(
        and(
          eq(schema.secretApprovalRules.accountId, scope.accountId),
          inArray(schema.secretApprovalRules.itemId, [...new Set(itemIds)]),
        ),
      ),
  );
}

/**
 * Replace one item's rules: `item` marks every field, `fieldKeys` single
 * fields. Unchanged rules keep their author and time.
 */
export async function setSecretApprovalRules(
  db: Database,
  scope: Scope,
  input: {
    itemId: string;
    vaultId: string;
    item: boolean;
    fieldKeys: readonly string[];
    subjectId: string;
  },
): Promise<SecretApprovalRuleRow[]> {
  const wanted = [...new Set([...(input.item ? [""] : []), ...input.fieldKeys])];
  return await withRlsContext(db, scope, async (scoped) => {
    const owned = and(
      eq(schema.secretApprovalRules.accountId, scope.accountId),
      eq(schema.secretApprovalRules.itemId, input.itemId),
    );
    await scoped
      .delete(schema.secretApprovalRules)
      .where(
        wanted.length === 0
          ? owned
          : and(owned, notInArray(schema.secretApprovalRules.fieldKey, wanted)),
      );
    if (wanted.length > 0) {
      await scoped
        .insert(schema.secretApprovalRules)
        .values(
          wanted.map((fieldKey) => ({
            accountId: scope.accountId,
            itemId: input.itemId,
            fieldKey,
            vaultId: input.vaultId,
            createdBySubjectId: input.subjectId,
          })),
        )
        .onConflictDoNothing();
    }
    return wanted.map((fieldKey) => ({ itemId: input.itemId, fieldKey }));
  });
}

function liveGrant(now: Date) {
  return and(
    eq(schema.secretUseApprovals.status, "approved"),
    or(isNull(schema.secretUseApprovals.expiresAt), gt(schema.secretUseApprovals.expiresAt, now)),
  );
}

/**
 * The grants a run acting for `approverSubjectId` in `sessionId` may use: its
 * chat's once and chat grants, and the person's time-window grants in the
 * workspace. Callers match targets.
 */
export async function listUsableSecretUseGrants(
  db: Database,
  scope: Scope,
  input: { sessionId: string; approverSubjectId: string; now?: Date },
): Promise<SecretUseApprovalRow[]> {
  const now = input.now ?? new Date();
  return await withRlsContext(db, scope, async (scoped) =>
    scoped
      .select()
      .from(schema.secretUseApprovals)
      .where(
        and(
          eq(schema.secretUseApprovals.workspaceId, scope.workspaceId),
          eq(schema.secretUseApprovals.approverSubjectId, input.approverSubjectId),
          liveGrant(now),
          or(
            eq(schema.secretUseApprovals.scope, "window"),
            eq(schema.secretUseApprovals.sessionId, input.sessionId),
          ),
        ),
      ),
  );
}

function sameTargets(
  left: readonly SecretUseApprovalTarget[],
  right: readonly SecretUseApprovalTarget[],
): boolean {
  const key = (targets: readonly SecretUseApprovalTarget[]) =>
    targets
      .map((target) => `${target.itemId}|${target.fieldKey}`)
      .sort()
      .join(",");
  return key(left) === key(right);
}

/**
 * Record a blocked use for the person to decide. An identical use still
 * pending in the same chat is returned instead of a new request.
 */
export async function requestSecretUseApproval(
  db: Database,
  scope: Scope,
  input: {
    sessionId: string;
    approverSubjectId: string;
    targets: readonly SecretUseApprovalTarget[];
    surface: string;
    toolName: string;
    destination: string | null;
    now?: Date;
  },
): Promise<SecretUseApprovalRow> {
  const now = input.now ?? new Date();
  const destination = input.destination?.slice(0, 500) ?? null;
  const toolName = input.toolName.slice(0, 200) || "tool";
  return await withRlsContext(db, scope, async (scoped) => {
    const pending = await scoped
      .select()
      .from(schema.secretUseApprovals)
      .where(
        and(
          eq(schema.secretUseApprovals.workspaceId, scope.workspaceId),
          eq(schema.secretUseApprovals.sessionId, input.sessionId),
          eq(schema.secretUseApprovals.status, "pending"),
          eq(schema.secretUseApprovals.approverSubjectId, input.approverSubjectId),
          eq(schema.secretUseApprovals.surface, input.surface),
          eq(schema.secretUseApprovals.toolName, toolName),
          gt(schema.secretUseApprovals.createdAt, new Date(now.getTime() - PENDING_REUSE_MS)),
        ),
      )
      .orderBy(desc(schema.secretUseApprovals.createdAt))
      .limit(20);
    const reusable = pending.find(
      (row) => row.destination === destination && sameTargets(row.targets, input.targets),
    );
    if (reusable) return reusable;
    const [row] = await scoped
      .insert(schema.secretUseApprovals)
      .values({
        id: crypto.randomUUID(),
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: input.sessionId,
        approverSubjectId: input.approverSubjectId,
        targets: input.targets.map((target) => ({ ...target })),
        surface: input.surface,
        toolName,
        destination,
        createdAt: now,
      })
      .returning();
    return row!;
  });
}

/** Mark once grants used. Returns the ids this call used; a raced grant is missing. */
export async function useSecretUseOnceGrants(
  db: Database,
  scope: Scope,
  input: { ids: readonly string[]; now?: Date },
): Promise<string[]> {
  if (input.ids.length === 0) return [];
  const now = input.now ?? new Date();
  return await withRlsContext(db, scope, async (scoped) => {
    const rows = await scoped
      .update(schema.secretUseApprovals)
      .set({ status: "used", usedAt: now })
      .where(
        and(
          eq(schema.secretUseApprovals.workspaceId, scope.workspaceId),
          inArray(schema.secretUseApprovals.id, [...new Set(input.ids)]),
          eq(schema.secretUseApprovals.scope, "once"),
          liveGrant(now),
        ),
      )
      .returning({ id: schema.secretUseApprovals.id });
    return rows.map((row) => row.id);
  });
}

export function secretUseApprovalView(row: SecretUseApprovalRow): SecretUseApprovalRequestView {
  return {
    id: row.id,
    targets: row.targets,
    surface: row.surface,
    toolName: row.toolName,
    destination: row.destination,
  };
}

/**
 * Requests bound to cards in one chat, read inside the caller's transaction
 * (already in the chat's workspace scope).
 */
export async function secretUseApprovalsForSessionTx(
  tx: Database,
  input: { workspaceId: string; sessionId: string; ids: readonly string[] },
): Promise<Map<string, SecretUseApprovalRow>> {
  if (input.ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(schema.secretUseApprovals)
    .where(
      and(
        eq(schema.secretUseApprovals.workspaceId, input.workspaceId),
        eq(schema.secretUseApprovals.sessionId, input.sessionId),
        inArray(schema.secretUseApprovals.id, [...new Set(input.ids)]),
      ),
    );
  return new Map(rows.map((row) => [row.id, row]));
}

export function secretUseGrantExpiry(scope: SecretUseGrantScope, now: Date): Date | null {
  if (scope === "once") return new Date(now.getTime() + SECRET_USE_APPROVAL_ONCE_TTL_MS);
  if (scope === "window") return new Date(now.getTime() + SECRET_USE_APPROVAL_WINDOW_MS);
  return null;
}

/**
 * Apply the person's answer to a pending request inside the response
 * transaction. An already decided request keeps its first decision.
 */
export async function decideSecretUseApprovalTx(
  tx: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    approvalId: string;
    decision: SecretUseApprovalDecision;
    subjectId: string;
    now: Date;
  },
): Promise<SecretUseApprovalRow | null> {
  const [row] = await tx
    .update(schema.secretUseApprovals)
    .set(
      input.decision === "deny"
        ? { status: "denied", decidedAt: input.now, decidedBySubjectId: input.subjectId }
        : {
            status: "approved",
            scope: input.decision,
            expiresAt: secretUseGrantExpiry(input.decision, input.now),
            decidedAt: input.now,
            decidedBySubjectId: input.subjectId,
          },
    )
    .where(
      and(
        eq(schema.secretUseApprovals.workspaceId, input.workspaceId),
        eq(schema.secretUseApprovals.sessionId, input.sessionId),
        eq(schema.secretUseApprovals.id, input.approvalId),
        eq(schema.secretUseApprovals.status, "pending"),
      ),
    )
    .returning();
  return row ?? null;
}

/** Grants in force in this workspace that cover any field of one item. */
export async function listSecretUseGrantsForItem(
  db: Database,
  scope: Scope,
  input: { itemId: string; now?: Date },
): Promise<SecretUseApprovalRow[]> {
  const now = input.now ?? new Date();
  return await withRlsContext(db, scope, async (scoped) =>
    scoped
      .select()
      .from(schema.secretUseApprovals)
      .where(
        and(
          eq(schema.secretUseApprovals.workspaceId, scope.workspaceId),
          liveGrant(now),
          sql`${schema.secretUseApprovals.targets} @> ${JSON.stringify([{ itemId: input.itemId }])}::jsonb`,
        ),
      )
      .orderBy(desc(schema.secretUseApprovals.decidedAt)),
  );
}

/** Revoke one grant in force that covers the item. Returns whether one was revoked. */
export async function revokeSecretUseGrant(
  db: Database,
  scope: Scope,
  input: { grantId: string; itemId: string; subjectId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return await withRlsContext(db, scope, async (scoped) => {
    const rows = await scoped
      .update(schema.secretUseApprovals)
      .set({ status: "revoked", revokedAt: now, revokedBySubjectId: input.subjectId })
      .where(
        and(
          eq(schema.secretUseApprovals.workspaceId, scope.workspaceId),
          eq(schema.secretUseApprovals.id, input.grantId),
          liveGrant(now),
          sql`${schema.secretUseApprovals.targets} @> ${JSON.stringify([{ itemId: input.itemId }])}::jsonb`,
        ),
      )
      .returning({ id: schema.secretUseApprovals.id });
    return rows.length > 0;
  });
}
