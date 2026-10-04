import { and, desc, eq } from "drizzle-orm";
import {
  ToolActionReview,
  toolReviewAction,
  toolReviewDetails,
  toolReviewFields,
  type ToolReviewStatus,
  decodeReviewArguments,
} from "@opengeni/contracts";
import { type Database, withRlsContext } from "./database";
import * as schema from "./schema";
import { connectorActionFingerprint } from "./connector-action-fingerprint";
import { fromPostgresLosslessJson } from "./lossless-json";

type ReviewScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  approvalId: string;
};

async function reviewSnapshot(db: Database, input: ReviewScope) {
  return await withRlsContext(db, input, async (scoped) => {
    const [record] = await scoped
      .select({
        request: schema.connectorActionRequests,
        turn: schema.sessionTurns,
        operation: schema.sessionAttemptCodemodeCalls,
      })
      .from(schema.connectorActionRequests)
      .innerJoin(
        schema.sessionTurns,
        and(
          eq(schema.sessionTurns.id, schema.connectorActionRequests.turnId),
          eq(schema.sessionTurns.workspaceId, input.workspaceId),
        ),
      )
      .leftJoin(
        schema.sessionAttemptCodemodeCalls,
        eq(schema.sessionAttemptCodemodeCalls.approvalRequestId, schema.connectorActionRequests.id),
      )
      .where(
        and(
          eq(schema.connectorActionRequests.accountId, input.accountId),
          eq(schema.connectorActionRequests.workspaceId, input.workspaceId),
          eq(schema.connectorActionRequests.sessionId, input.sessionId),
          eq(schema.connectorActionRequests.approvalId, input.approvalId),
        ),
      )
      .orderBy(desc(schema.connectorActionRequests.createdAt))
      .limit(1);
    if (!record) return null;
    if (record.request.reviewArguments === null) {
      // Compatibility for existing reviews. Recover only bytes matching the original digest.
      const states = await scoped
        .select()
        .from(schema.agentRunStates)
        .where(
          and(
            eq(schema.agentRunStates.workspaceId, input.workspaceId),
            eq(schema.agentRunStates.sessionId, input.sessionId),
            eq(schema.agentRunStates.turnId, record.request.turnId),
          ),
        )
        .orderBy(desc(schema.agentRunStates.stateVersion))
        .limit(32);
      for (const state of states) {
        const pending = fromPostgresLosslessJson(
          state.pendingApprovals,
          state.pendingApprovalsCodecVersion,
        );
        if (!Array.isArray(pending)) continue;
        for (const value of pending) {
          if (!value || typeof value !== "object") continue;
          const item = value as Record<string, unknown>;
          const raw =
            item.rawItem && typeof item.rawItem === "object"
              ? (item.rawItem as Record<string, unknown>)
              : {};
          if ((raw.callId ?? raw.id ?? item.id ?? item.callId) !== input.approvalId) continue;
          let args = item.arguments ?? raw.arguments;
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              continue;
            }
          }
          if (
            connectorActionFingerprint({ ...record.request, arguments: args }) !==
            record.request.actionFingerprint
          )
            continue;
          record.request.reviewArguments = JSON.stringify(args);
          break;
        }
        if (record.request.reviewArguments !== null) break;
      }
    }
    return record;
  });
}

/** The HTTP/core caller must independently authorize this session. RLS remains active here. */
export async function getToolActionReview(
  db: Database,
  input: ReviewScope,
): Promise<ToolActionReview | null> {
  const record = await reviewSnapshot(db, input);
  if (!record) return null;
  const { request, operation, turn } = record;
  let status: ToolReviewStatus =
    request.status === "uncertain"
      ? "unknown"
      : request.status === "blocked"
        ? "revoked"
        : request.status;
  if (operation?.state === "outcome_unknown") status = "unknown";
  else if (operation?.state === "cancelled")
    status =
      operation.errorCode === "approval_stale"
        ? "stale"
        : operation.errorCode === "approval_rejected"
          ? "rejected"
          : "cancelled";
  else if (operation?.state === "completed") status = "completed";
  else if (operation?.state === "failed") status = "failed";
  else if (operation?.executionStartedAt) status = "executing";
  else if (
    ["completed", "failed", "cancelled", "superseded"].includes(turn.status) &&
    ["pending", "approved"].includes(status)
  )
    status = "cancelled";
  const available =
    status === "pending" && turn.status === "requires_action" && request.reviewArguments !== null;
  const args = request.reviewArguments;
  const context = request.reviewContext ?? undefined;
  const parsed = decodeReviewArguments(args);
  return ToolActionReview.parse({
    version: 1,
    id: request.approvalId,
    actionDigest: request.actionFingerprint,
    revision: `${request.updatedAt.toISOString()}:${operation?.updatedAt.toISOString() ?? turn.updatedAt.toISOString()}`,
    status,
    ...toolReviewAction(request.toolName, args, context),
    ...(context?.accountLabel ? { accountLabel: context.accountLabel } : {}),
    ...(context?.samples
      ? {
          samples: context.samples.filter((sample) => {
            return (
              parsed &&
              (parsed.messageId === sample.id ||
                (Array.isArray(parsed.messageIds) && parsed.messageIds.includes(sample.id)))
            );
          }),
        }
      : {}),
    ...toolReviewFields(args, context),
    reason:
      request.policySource === "explicit"
        ? "Your permission setting for this action is Ask."
        : request.policySource === "ambiguous"
          ? "Overlapping permission settings require a review."
          : "This action asks for approval by default.",
    createdAt: request.createdAt.toISOString(),
    updatedAt: (operation?.updatedAt ?? request.updatedAt).toISOString(),
    availableActions: available ? ["approve", "reject"] : [],
    detailsAvailable: args !== null,
  });
}

export async function getToolReviewDetailsPage(
  db: Database,
  input: ReviewScope & { actionDigest: string; path: string; offset: number },
) {
  const record = await reviewSnapshot(db, input);
  if (
    !record ||
    record.request.actionFingerprint !== input.actionDigest ||
    record.request.reviewArguments === null
  )
    return null;
  // Only invalid saved-field navigation is a missing detail. Database failures
  // above remain failures, so clients can distinguish a retryable outage.
  let details;
  try {
    details = toolReviewDetails(
      record.request.reviewArguments,
      record.request.reviewContext ?? undefined,
      input.path,
      input.offset,
    );
  } catch {
    return null;
  }
  return {
    version: 1 as const,
    id: record.request.approvalId,
    actionDigest: record.request.actionFingerprint,
    ...details,
  };
}
