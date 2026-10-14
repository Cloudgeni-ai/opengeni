import { and, desc, eq } from "drizzle-orm";
import { parseVerifiedAttemptToolCatalog } from "@opengeni/codemode";
import {
  McpConnectionAccountBindings,
  ToolActionReview,
  toolReviewContextFromSchema,
  type ToolReviewContext,
  toolReviewAction,
  toolReviewDetails,
  toolReviewFields,
  type ToolReviewStatus,
  decodeReviewArguments,
} from "@opengeni/contracts";
import { type Database, withRlsContext } from "./database";
import * as schema from "./schema";
import { hydrateStoredAttemptToolCatalog } from "./session-content-blobs";
import { connectorActionFingerprint } from "./connector-action-fingerprint";
import { fromPostgresLosslessJson } from "./lossless-json";
import { legacyToolActionReview } from "./legacy-tool-action-reviews";

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
        // Recovery is best effort: one unreadable state must not hide the
        // decision. Unrecovered arguments leave decline as the only response.
        let pending: unknown;
        try {
          pending = fromPostgresLosslessJson(
            state.pendingApprovals,
            state.pendingApprovalsCodecVersion,
          );
        } catch {
          continue;
        }
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
          let fingerprint: string;
          try {
            fingerprint = connectorActionFingerprint({ ...record.request, arguments: args });
          } catch {
            continue;
          }
          if (fingerprint !== record.request.actionFingerprint) continue;
          record.request.reviewArguments = JSON.stringify(args);
          break;
        }
        if (record.request.reviewArguments !== null) break;
      }
      // Recovered bytes predate the saved review context, so the context that
      // hides schema-protected fields must be proven from the immutable catalog of
      // the attempt that created the request. Without that proof the arguments
      // stay hidden and decline remains the only response.
      if (record.request.reviewArguments !== null && record.request.reviewContext === null) {
        const context = await catalogReviewContext(scoped, input, record);
        if (context) record.request.reviewContext = context;
        else record.request.reviewArguments = null;
      }
    }
    return record;
  });
}

async function catalogReviewContext(
  scoped: Database,
  input: ReviewScope,
  record: {
    request: typeof schema.connectorActionRequests.$inferSelect;
    turn: typeof schema.sessionTurns.$inferSelect;
  },
): Promise<ToolReviewContext | null> {
  try {
    const { request, turn } = record;
    const [stored] = await scoped
      .select({
        catalog: schema.sessionAttemptToolCatalogs.catalog,
        contentRefs: schema.sessionAttemptToolCatalogs.contentRefs,
      })
      .from(schema.sessionAttemptToolCatalogs)
      .where(
        and(
          eq(schema.sessionAttemptToolCatalogs.accountId, input.accountId),
          eq(schema.sessionAttemptToolCatalogs.workspaceId, input.workspaceId),
          eq(schema.sessionAttemptToolCatalogs.sessionId, input.sessionId),
          eq(schema.sessionAttemptToolCatalogs.turnId, request.turnId),
          eq(schema.sessionAttemptToolCatalogs.attemptId, request.creationAttemptId),
          eq(
            schema.sessionAttemptToolCatalogs.executionGeneration,
            request.creationExecutionGeneration,
          ),
        ),
      )
      .limit(1);
    if (!stored) return null;
    const entries = parseVerifiedAttemptToolCatalog(
      await hydrateStoredAttemptToolCatalog(scoped, stored),
    ).entries.filter(
      (item) =>
        item.identity.serverId === request.serverId && item.identity.toolName === request.toolName,
    );
    if (entries.length !== 1) return null;
    const entry = entries[0]!;
    const bindings = McpConnectionAccountBindings.safeParse(turn.mcpAccountBindings);
    const binding = bindings.success
      ? bindings.data.find((item) => item.serverId === request.serverId)
      : undefined;
    return toolReviewContextFromSchema(entry.inputSchema, {
      kind:
        entry.source === "mcp" && binding?.providerDomain === "gmailmcp.googleapis.com"
          ? "gmail"
          : "generic",
      ...(entry.title ? { title: entry.title } : {}),
      ...(binding?.accountLabel ? { accountLabel: binding.accountLabel } : {}),
    });
  } catch {
    return null;
  }
}

/**
 * Older approvals have no saved review. Their presentation is best effort: any
 * failure to rebuild it answers "no saved review", and clients then fall back to
 * the approval's own arguments instead of hiding the decision.
 */
async function presentableLegacyReview(db: Database, input: ReviewScope) {
  try {
    return await legacyToolActionReview(db, input);
  } catch {
    return null;
  }
}

/** The HTTP/core caller must independently authorize this session. RLS remains active here. */
export async function getToolActionReview(
  db: Database,
  input: ReviewScope,
): Promise<ToolActionReview | null> {
  const record = await reviewSnapshot(db, input);
  if (!record) return (await presentableLegacyReview(db, input))?.review ?? null;
  const { request, operation, turn } = record;
  let status: ToolReviewStatus =
    request.status === "uncertain"
      ? "unknown"
      : request.status === "blocked"
        ? "blocked"
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
  // A person can always decline a waiting action. Approving needs the exact saved
  // arguments; when an older request's arguments cannot be recovered, decline is
  // the only safe decision and keeps the session from staying stuck.
  const waiting = status === "pending" && turn.status === "requires_action";
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
      status === "blocked"
        ? request.policySource === "explicit"
          ? "Your permission settings block this action."
          : request.policySource === "ambiguous"
            ? "Two permission settings conflict, so this action is blocked."
            : "This action is blocked by default."
        : request.policySource === "explicit"
          ? "This action is set to Ask first."
          : "This action asks first by default.",
    createdAt: request.createdAt.toISOString(),
    updatedAt: (operation?.updatedAt ?? request.updatedAt).toISOString(),
    availableActions: waiting
      ? request.reviewArguments !== null
        ? ["approve", "reject"]
        : ["reject"]
      : [],
    detailsAvailable: args !== null,
  });
}

export async function getToolReviewDetailsPage(
  db: Database,
  input: ReviewScope & { actionDigest: string; path: string; offset: number },
) {
  const record = await reviewSnapshot(db, input);
  if (!record) {
    const legacy = await presentableLegacyReview(db, input);
    if (!legacy?.proven || legacy.review.actionDigest !== input.actionDigest) return null;
    try {
      return {
        version: 1 as const,
        id: input.approvalId,
        actionDigest: input.actionDigest,
        ...toolReviewDetails(legacy.args, legacy.context, input.path, input.offset),
      };
    } catch {
      return null;
    }
  }
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
