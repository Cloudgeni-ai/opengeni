import { and, desc, eq } from "drizzle-orm";
import type { Database } from "./database";
import * as schema from "./schema";
import { humanTurnSenderLabel } from "./turn-initiator";

/**
 * Approving a call that runs on someone's own (Only me) connection is that
 * person's decision. Anyone who can control the chat may still decline it.
 *
 * The executing account is frozen on the turn when its message was accepted,
 * so an approval never changes whose account runs the call: without this rule
 * any member or workspace key could make an action happen as another person.
 */
export class SessionApprovalForbiddenError extends Error {
  override readonly name = "SessionApprovalForbiddenError";
  readonly code = "APPROVAL_REQUIRES_ACCOUNT_OWNER";

  constructor(readonly owner: PendingApprovalAccountOwner) {
    super(
      owner.label
        ? `Only ${owner.label} can approve this action, because it runs on their own account. Ask them to approve it, or decline it.`
        : "Only the person whose own account runs this action can approve it. Ask them to approve it, or decline it.",
    );
  }
}

/** The person who alone may approve an action, and their name when known. */
export type PendingApprovalAccountOwner = { subjectId: string; label: string | null };

/**
 * The owner's name as frozen on the turn. A personal account only runs for its
 * own sender's message, so the sender's label names the owner. Only a
 * person's own label is used: a bridge or key label never names the owner.
 */
export function accountOwnerLabelForTurn(
  owner: string,
  turn: {
    initiatorKind: string;
    initiatorSubjectId: string;
    initiatorContext: unknown;
  },
): string | null {
  if (turn.initiatorKind !== "subject" || turn.initiatorSubjectId !== owner) return null;
  return humanTurnSenderLabel(turn)?.trim().slice(0, 256) ?? null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function ownerText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The owner of `connectionId` when the turn uses it as someone's personal
 * account; null for a shared (workspace) connection. Reads the turn's frozen
 * account bindings and, for turns from before bindings, its personal
 * delegations; a personal row only executes through one of these.
 */
export function personalConnectionOwnerForTurn(input: {
  connectionId: string;
  mcpAccountBindings: unknown;
  personalConnectionDelegations: unknown;
}): string | null {
  for (const binding of records(input.mcpAccountBindings)) {
    if (binding.connectionId !== input.connectionId) continue;
    const owner = ownerText(binding.ownerSubjectId);
    if (binding.subjectScope === "subject" && owner) return owner;
  }
  for (const delegation of records(input.personalConnectionDelegations)) {
    if (delegation.connectionId !== input.connectionId) continue;
    const owner = ownerText(delegation.ownerSubjectId);
    if (owner) return owner;
  }
  return null;
}

/**
 * The person who alone may approve this pending action, or null when anyone
 * who can control the chat may: actions on shared connections and actions
 * without a connection (Opengeni's own tools keep their own rules).
 */
export async function pendingApprovalAccountOwner(
  db: Database,
  input: { workspaceId: string; sessionId: string; turnId: string; approvalId: string },
): Promise<PendingApprovalAccountOwner | null> {
  const [row] = await db
    .select({
      connectionId: schema.connectorActionRequests.connectionId,
      mcpAccountBindings: schema.sessionTurns.mcpAccountBindings,
      personalConnectionDelegations: schema.sessionTurns.personalConnectionDelegations,
      initiatorKind: schema.sessionTurns.initiatorKind,
      initiatorSubjectId: schema.sessionTurns.initiatorSubjectId,
      initiatorContext: schema.sessionTurns.initiatorContext,
    })
    .from(schema.connectorActionRequests)
    .innerJoin(
      schema.sessionTurns,
      and(
        eq(schema.sessionTurns.id, schema.connectorActionRequests.turnId),
        eq(schema.sessionTurns.workspaceId, schema.connectorActionRequests.workspaceId),
      ),
    )
    .where(
      and(
        eq(schema.connectorActionRequests.workspaceId, input.workspaceId),
        eq(schema.connectorActionRequests.sessionId, input.sessionId),
        eq(schema.connectorActionRequests.turnId, input.turnId),
        eq(schema.connectorActionRequests.approvalId, input.approvalId),
      ),
    )
    .orderBy(desc(schema.connectorActionRequests.createdAt))
    .limit(1);
  const owner = row ? personalConnectionOwnerForTurn(row) : null;
  return owner ? { subjectId: owner, label: accountOwnerLabelForTurn(owner, row!) } : null;
}
