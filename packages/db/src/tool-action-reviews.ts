import { and, desc, eq, sql } from "drizzle-orm";
import { parseVerifiedAttemptToolCatalog } from "@opengeni/codemode";
import {
  approvalIdentifier,
  McpConnectionAccountBindings,
  ToolActionReview,
  toolReviewContextFromSchema,
  type ToolReviewContext,
  type ToolReviewReasonCode,
  toolReviewAction,
  toolReviewDetails,
  toolReviewFields,
  type ToolReviewStatus,
  decodeReviewArguments,
} from "@opengeni/contracts";
import { findAppAction } from "@opengeni/contracts/app-actions";
import { type Database, withRlsContext } from "./database";
import * as schema from "./schema";
import { hydrateStoredAttemptToolCatalog } from "./session-content-blobs";
import { connectorActionFingerprint } from "./connector-action-fingerprint";
import { fromPostgresLosslessJson } from "./lossless-json";
import { isGitHubGatewayApprovalId } from "./github-gateway";
import { PERSONAL_WORKSPACE_EXTERNAL_SOURCE } from "./personal-workspace-membership";
import {
  accountOwnerLabelForTurn,
  personalConnectionOwnerForTurn,
} from "./personal-connection-approval";

type ReviewScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  approvalId: string;
};

/** Live turn states in which a sibling decision is resuming the pause. */
const RESUMING_TURN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "recovering",
  "waiting_capacity",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Whether the decision endpoint takes a decision for this approval while its
 * turn resumes from a sibling decision. Mirrors `acceptSessionApprovalDecision`:
 * the turn is still the session's active one, the approval is in the turn's
 * latest pause, its call has not settled, and the next resume can still apply
 * it (a model tool call held for approval, or a programmatic call waiting on
 * review).
 */
async function decidableWhileResuming(
  db: Database,
  input: ReviewScope,
  turnId: string,
): Promise<boolean> {
  return await withRlsContext(db, input, async (scoped) => {
    const [session] = await scoped
      .select({ activeTurnId: schema.sessions.activeTurnId })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      )
      .limit(1);
    if (session?.activeTurnId !== turnId) return false;
    const [runState] = await scoped
      .select({
        pendingApprovals: schema.agentRunStates.pendingApprovals,
        pendingApprovalsCodecVersion: schema.agentRunStates.pendingApprovalsCodecVersion,
      })
      .from(schema.agentRunStates)
      .where(
        and(
          eq(schema.agentRunStates.workspaceId, input.workspaceId),
          eq(schema.agentRunStates.sessionId, input.sessionId),
          eq(schema.agentRunStates.turnId, turnId),
        ),
      )
      .orderBy(desc(schema.agentRunStates.stateVersion))
      .limit(1);
    if (!runState) return false;
    let pending: unknown;
    try {
      pending = fromPostgresLosslessJson(
        runState.pendingApprovals,
        runState.pendingApprovalsCodecVersion,
      );
    } catch {
      return false;
    }
    if (
      !Array.isArray(pending) ||
      !pending.some((item) => approvalIdentifier(item) === input.approvalId)
    )
      return false;
    const [call] = await scoped
      .select({
        interruptionKind: schema.sessionPendingToolCalls.interruptionKind,
        hasResult: sql<boolean>`${schema.sessionPendingToolCalls.resultItem} is not null`,
      })
      .from(schema.sessionPendingToolCalls)
      .where(
        and(
          eq(schema.sessionPendingToolCalls.workspaceId, input.workspaceId),
          eq(schema.sessionPendingToolCalls.turnId, turnId),
          eq(schema.sessionPendingToolCalls.callId, input.approvalId),
        ),
      )
      .limit(1);
    if (call)
      return (
        !call.hasResult &&
        (call.interruptionKind === "approval" ||
          call.interruptionKind === "interaction_intervention")
      );
    if (isGitHubGatewayApprovalId(input.approvalId)) {
      const [request] = await scoped
        .select({ id: schema.connectorActionRequests.id })
        .from(schema.connectorActionRequests)
        .where(
          and(
            eq(schema.connectorActionRequests.workspaceId, input.workspaceId),
            eq(schema.connectorActionRequests.sessionId, input.sessionId),
            eq(schema.connectorActionRequests.turnId, turnId),
            eq(schema.connectorActionRequests.approvalId, input.approvalId),
            eq(schema.connectorActionRequests.status, "pending"),
          ),
        )
        .limit(1);
      return request !== undefined;
    }
    if (!UUID_PATTERN.test(input.approvalId)) return false;
    const [operation] = await scoped
      .select({ operationId: schema.sessionAttemptCodemodeCalls.operationId })
      .from(schema.sessionAttemptCodemodeCalls)
      .where(
        and(
          eq(schema.sessionAttemptCodemodeCalls.workspaceId, input.workspaceId),
          eq(schema.sessionAttemptCodemodeCalls.sessionId, input.sessionId),
          eq(schema.sessionAttemptCodemodeCalls.turnId, turnId),
          eq(schema.sessionAttemptCodemodeCalls.operationId, input.approvalId),
          eq(schema.sessionAttemptCodemodeCalls.state, "waiting_for_approval"),
        ),
      )
      .limit(1);
    return operation !== undefined;
  });
}

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
 * Whose own (Only me) login an action runs on, with their frozen name, or
 * null for workspace logins. It never changes once the action exists, so a
 * card rendered from it is the same on every retry.
 *
 * The caller must independently authorize this session. RLS remains active here.
 */
export async function getToolActionAccountOwner(
  db: Database,
  input: ReviewScope,
): Promise<{ subjectId: string; label: string | null } | null> {
  const record = await reviewSnapshot(db, input);
  if (!record) return null;
  const owner = personalConnectionOwnerForTurn({
    connectionId: record.request.connectionId,
    mcpAccountBindings: record.turn.mcpAccountBindings,
    personalConnectionDelegations: record.turn.personalConnectionDelegations,
  });
  return owner ? { subjectId: owner, label: accountOwnerLabelForTurn(owner, record.turn) } : null;
}

/** The HTTP/core caller must independently authorize this session. RLS remains active here. */
export async function getToolActionReview(
  db: Database,
  input: ReviewScope & {
    /**
     * Who is looking. An action that runs on another person's own account
     * offers this viewer only Decline; omitted, the review is unpersonalized.
     */
    viewerSubjectId?: string;
  },
): Promise<ToolActionReview | null> {
  const { viewerSubjectId, ...scope } = input;
  const record = await reviewSnapshot(db, scope);
  if (!record) return null;
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
  // Deciding one of a pause's approvals resumes the turn (queued, running,
  // ...); the others stay waiting meanwhile wherever the decision endpoint
  // still takes their decision. A turn that ended already made its pending
  // actions "cancelled" above.
  const waiting =
    status === "pending" &&
    (turn.status === "requires_action" ||
      (RESUMING_TURN_STATUSES.has(turn.status) &&
        (await decidableWhileResuming(db, scope, turn.id))));
  const args = request.reviewArguments;
  const context = request.reviewContext ?? undefined;
  const parsed = decodeReviewArguments(args);
  const accountOwner = personalConnectionOwnerForTurn({
    connectionId: request.connectionId,
    mcpAccountBindings: turn.mcpAccountBindings,
    personalConnectionDelegations: turn.personalConnectionDelegations,
  });
  const ownerOnly =
    waiting &&
    viewerSubjectId !== undefined &&
    accountOwner !== null &&
    accountOwner !== viewerSubjectId;
  const ownerLabel = ownerOnly ? accountOwnerLabelForTurn(accountOwner!, turn) : null;
  // In a chat shared with the workspace, the owner is told the decision is
  // theirs alone; in their own chats that goes without saying.
  const approvedByViewer =
    waiting &&
    accountOwner !== null &&
    accountOwner === viewerSubjectId &&
    request.reviewArguments !== null &&
    (await sessionSharedWithWorkspace(db, scope));
  return ToolActionReview.parse({
    version: 1,
    id: request.approvalId,
    actionDigest: request.actionFingerprint,
    revision: `${request.updatedAt.toISOString()}:${operation?.updatedAt.toISOString() ?? turn.updatedAt.toISOString()}`,
    status,
    ...toolReviewAction(request.toolName, args, context),
    toolName: request.toolName.slice(0, 256),
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
    ...toolReviewFields(args, context, request.toolName),
    ...toolReviewReason(status, request.policySource),
    createdAt: request.createdAt.toISOString(),
    updatedAt: (operation?.updatedAt ?? request.updatedAt).toISOString(),
    availableActions: waiting
      ? request.reviewArguments !== null && !ownerOnly
        ? ["approve", "reject"]
        : ["reject"]
      : [],
    ...(ownerOnly
      ? { approvedBy: "account_owner", ...(ownerLabel ? { accountOwnerLabel: ownerLabel } : {}) }
      : approvedByViewer
        ? { approvedBy: "you" }
        : {}),
    detailsAvailable: args !== null,
  });
}

/**
 * Why an action waits or is blocked: a code a host words in its own language,
 * and the English sentence for everyone else.
 */
function toolReviewReason(
  status: ToolReviewStatus,
  policySource: string,
): { reason: string; reasonCode: ToolReviewReasonCode } {
  if (status === "blocked")
    return policySource === "explicit"
      ? { reason: "Your permission settings block this action.", reasonCode: "blocked_by_setting" }
      : policySource === "ambiguous"
        ? {
            reason: "Two permission settings conflict, so this action is blocked.",
            reasonCode: "blocked_by_conflict",
          }
        : { reason: "This action is blocked by default.", reasonCode: "blocked_by_default" };
  return policySource === "explicit"
    ? { reason: "This action is set to Ask first.", reasonCode: "asks_by_setting" }
    : { reason: "This action asks first by default.", reasonCode: "asks_by_default" };
}

/** A chat other people can see: shared with a workspace that isn't someone's Personal one. */
async function sessionSharedWithWorkspace(db: Database, scope: ReviewScope): Promise<boolean> {
  return await withRlsContext(db, scope, async (scoped) => {
    const [session] = await scoped
      .select({
        visibility: schema.sessions.visibility,
        workspaceSource: schema.workspaces.externalSource,
      })
      .from(schema.sessions)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.sessions.workspaceId))
      .where(
        and(
          eq(schema.sessions.accountId, scope.accountId),
          eq(schema.sessions.workspaceId, scope.workspaceId),
          eq(schema.sessions.id, scope.sessionId),
        ),
      )
      .limit(1);
    return (
      session?.visibility === "workspace_shared" &&
      session.workspaceSource !== PERSONAL_WORKSPACE_EXTERNAL_SOURCE
    );
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
      25,
      record.request.toolName,
      // Only Opengeni's own app actions are named from its catalog.
      record.request.serverId === "opengeni" ? (id) => findAppAction(id) !== undefined : undefined,
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
