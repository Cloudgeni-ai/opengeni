import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { parseVerifiedAttemptToolCatalog } from "@opengeni/codemode";
import {
  McpConnectionAccountBindings,
  ToolActionReview,
  decodeReviewArguments,
  ToolDisplayMetadata,
  stableJson,
  toolReviewAction,
  toolReviewContextFromSchema,
  toolReviewFields,
  type ToolReviewContext,
} from "@opengeni/contracts";
import { type Database, withRlsContext } from "./database";
import { fromPostgresLosslessJson } from "./lossless-json";
import * as schema from "./schema";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function approval(value: unknown) {
  const item = object(value);
  const raw = object(item?.rawItem);
  if (!item) return null;
  return {
    id: raw?.callId ?? raw?.id ?? item.id ?? item.callId,
    name: item.name ?? item.toolName ?? raw?.name,
    args: decodeReviewArguments(item.arguments ?? raw?.arguments),
  };
}

/** Read-only presentation for SDK approvals created before durable connector
 * reviews. Neither current catalogs nor display labels establish a provider.
 * This never creates a request, changes a policy, or resumes an operation. */
export async function legacyToolActionReview(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; approvalId: string },
) {
  return await withRlsContext(db, input, async (tx) => {
    const [snapshot] = await tx
      .select({
        state: {
          id: schema.agentRunStates.id,
          pending: schema.agentRunStates.pendingApprovals,
          codec: schema.agentRunStates.pendingApprovalsCodecVersion,
        },
        turn: schema.sessionTurns,
        session: { status: schema.sessions.status, activeTurnId: schema.sessions.activeTurnId },
      })
      .from(schema.agentRunStates)
      .innerJoin(schema.sessionTurns, eq(schema.sessionTurns.id, schema.agentRunStates.turnId))
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.agentRunStates.sessionId))
      .where(
        and(
          eq(schema.agentRunStates.accountId, input.accountId),
          eq(schema.agentRunStates.workspaceId, input.workspaceId),
          eq(schema.agentRunStates.sessionId, input.sessionId),
        ),
      )
      .orderBy(desc(schema.agentRunStates.stateVersion))
      .limit(1);
    if (!snapshot) return null;
    const pending = fromPostgresLosslessJson(snapshot.state.pending, snapshot.state.codec);
    const matching = Array.isArray(pending)
      ? pending.map(approval).filter((item) => item?.id === input.approvalId)
      : [];
    if (matching.length !== 1) return null;
    const saved = matching[0]!;
    if (typeof saved.name !== "string" || saved.args === null) return null;
    const args = saved.args;
    const { turn, session } = snapshot;
    const scope = and(
      eq(schema.sessionEvents.accountId, input.accountId),
      eq(schema.sessionEvents.workspaceId, input.workspaceId),
      eq(schema.sessionEvents.sessionId, input.sessionId),
      eq(schema.sessionEvents.turnId, turn.id),
      eq(schema.sessionEvents.turnAssociation, "current"),
      isNull(schema.sessionEvents.duplicateOfEventId),
    );
    const [waiting] = await tx
      .select()
      .from(schema.sessionEvents)
      .where(and(scope, eq(schema.sessionEvents.type, "session.requiresAction")))
      .orderBy(desc(schema.sessionEvents.sequence))
      .limit(1);
    if (!waiting?.turnAttemptId || waiting.turnGeneration === null) return null;
    const waitPayload = object(
      fromPostgresLosslessJson(waiting.payload, waiting.payloadCodecVersion),
    );
    const waitApprovals = Array.isArray(waitPayload?.approvals)
      ? waitPayload.approvals.map(approval).filter((item) => item?.id === input.approvalId)
      : [];
    if (
      waitApprovals.length !== 1 ||
      waitApprovals[0]!.name !== saved.name ||
      stableJson(waitApprovals[0]!.args) !== stableJson(args)
    )
      return null;

    let toolName = saved.name;
    let context: ToolReviewContext = { kind: "generic" };
    // Only the immutable attempt catalog proves which fields its schema protects.
    // Without that proof no argument value is shown and approval is unavailable.
    let proven = false;
    const calls = await tx
      .select()
      .from(schema.sessionEvents)
      .where(
        and(
          scope,
          eq(schema.sessionEvents.turnAttemptId, waiting.turnAttemptId),
          eq(schema.sessionEvents.turnGeneration, waiting.turnGeneration),
          eq(schema.sessionEvents.type, "agent.toolCall.created"),
          sql`${schema.sessionEvents.payload}->>'id' = ${input.approvalId}`,
        ),
      )
      .limit(2);
    if (calls.length === 1 && calls[0]!.sequence < waiting.sequence) {
      const call = object(
        fromPostgresLosslessJson(calls[0]!.payload, calls[0]!.payloadCodecVersion),
      );
      if (
        call?.name === saved.name &&
        stableJson(decodeReviewArguments(call.arguments)) === stableJson(args)
      ) {
        const displayResult = ToolDisplayMetadata.safeParse(call.display);
        const display = displayResult.success ? displayResult.data : undefined;
        if (display)
          context = {
            kind: "generic",
            title: (display.title ?? display.toolName.replaceAll("_", " ")).slice(0, 256),
            ...(display.accountLabel ? { accountLabel: display.accountLabel.slice(0, 256) } : {}),
          };
        const [stored] = await tx
          .select()
          .from(schema.sessionAttemptToolCatalogs)
          .where(
            and(
              eq(schema.sessionAttemptToolCatalogs.accountId, input.accountId),
              eq(schema.sessionAttemptToolCatalogs.workspaceId, input.workspaceId),
              eq(schema.sessionAttemptToolCatalogs.sessionId, input.sessionId),
              eq(schema.sessionAttemptToolCatalogs.turnId, turn.id),
              eq(schema.sessionAttemptToolCatalogs.attemptId, waiting.turnAttemptId),
              eq(schema.sessionAttemptToolCatalogs.executionGeneration, waiting.turnGeneration),
            ),
          )
          .limit(1);
        // The immutable model-name map supplies schema privacy and exact tool
        // identity; the accepted account binding independently supplies provider.
        if (stored) {
          const catalog = parseVerifiedAttemptToolCatalog(stored.catalog);
          const entry = catalog.entries.find((item) => item.modelName === saved.name);
          if (entry) {
            const bindings = McpConnectionAccountBindings.safeParse(turn.mcpAccountBindings);
            const binding = bindings.success
              ? bindings.data.find((item) => item.serverId === entry.identity.serverId)
              : undefined;
            proven = true;
            toolName = entry.identity.toolName;
            context = toolReviewContextFromSchema(entry.inputSchema, {
              kind:
                entry.source === "mcp" && binding?.providerDomain === "gmailmcp.googleapis.com"
                  ? "gmail"
                  : "generic",
              ...(entry.title ? { title: entry.title } : {}),
              ...(binding?.accountLabel
                ? { accountLabel: binding.accountLabel }
                : context.accountLabel
                  ? { accountLabel: context.accountLabel }
                  : {}),
            });
          }
        }
      }
    }
    const [decision] = await tx
      .select({ payload: schema.sessionEvents.payload })
      .from(schema.sessionEvents)
      .where(
        and(
          scope,
          eq(schema.sessionEvents.type, "user.approvalDecision"),
          gt(schema.sessionEvents.sequence, waiting.sequence),
          sql`${schema.sessionEvents.payload}->>'approvalId' = ${input.approvalId}`,
        ),
      )
      .orderBy(desc(schema.sessionEvents.sequence))
      .limit(1);
    const active =
      !decision &&
      turn.status === "requires_action" &&
      session.status === "requires_action" &&
      session.activeTurnId === turn.id;
    const status = decision
      ? object(decision.payload)?.decision === "reject"
        ? "rejected"
        : "approved"
      : active
        ? "pending"
        : "cancelled";
    const actionDigest = createHash("sha256")
      .update(
        stableJson({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: turn.id,
          approvalId: input.approvalId,
          name: saved.name,
          args,
        }),
      )
      .digest("hex");
    return {
      args,
      context,
      proven,
      review: ToolActionReview.parse({
        version: 1,
        id: input.approvalId,
        actionDigest,
        revision: `${snapshot.state.id}:${turn.updatedAt.toISOString()}:${status}`,
        status,
        ...(proven
          ? {
              ...toolReviewAction(toolName, args, context),
              ...toolReviewFields(args, context),
            }
          : { ...toolReviewAction(toolName, null, context), fields: [], moreFields: 0 }),
        ...(context.accountLabel ? { accountLabel: context.accountLabel } : {}),
        reason: "This action asks first.",
        createdAt: waiting.createdAt.toISOString(),
        updatedAt: turn.updatedAt.toISOString(),
        availableActions: active ? (proven ? ["approve", "reject"] : ["reject"]) : [],
        detailsAvailable: proven,
      }),
    };
  });
}
