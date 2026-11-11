import { McpPersonalConnectionDelegations, McpConnectionAccountBinding } from "@opengeni/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "./database";
import { subscriptionExecutionAuthorityFromTurn } from "./accepted-subscription-authority";
import * as schema from "./schema";

type RouteSession = Pick<
  typeof schema.sessions.$inferSelect,
  "id" | "accountId" | "parentSessionId" | "parentTurnId"
>;

/** Where a child's blocking question goes, and the hop its authority comes from. */
export type ChildRequiresActionRoute = {
  targetSessionId: string;
  /** The session directly under the target on the child's path: the child itself for its parent. */
  via: RouteSession;
  /** The parent that could not act, when the question went further up. */
  escalatedFromSessionId: string | null;
};

/** Bounded walk: a question goes to the nearest ancestor that can act, never further. */
export const CHILD_REQUIRES_ACTION_ESCALATION_LIMIT = 32;

/**
 * Whether a session's agent can act on a child's question: it is not failed or
 * cancelled, and its frozen agent configuration has the session tools
 * (`subagents`, which carries session_human_input_respond). A legacy session
 * without a configuration counts as able.
 */
export function sessionCanActOnChildQuestion(row: {
  status: string;
  agentConfig: unknown;
}): boolean {
  if (row.status === "failed" || row.status === "cancelled") return false;
  const config = row.agentConfig as { capabilities?: { subagents?: unknown } } | null;
  return config?.capabilities?.subagents !== false;
}

async function routeSessionTx(tx: Database, workspaceId: string, sessionId: string) {
  const [row] = await tx
    .select({
      id: schema.sessions.id,
      accountId: schema.sessions.accountId,
      parentSessionId: schema.sessions.parentSessionId,
      parentTurnId: schema.sessions.parentTurnId,
      status: schema.sessions.status,
      agentConfig: schema.sessions.agentConfig,
    })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
    .limit(1);
  return row ?? null;
}

/**
 * The session a child's `child_requires_action` notice goes to. Normally its
 * parent. When the parent cannot act on it (see sessionCanActOnChildQuestion),
 * the nearest ancestor that can, so the question does not sit with an agent
 * that cannot handle it. Only one session gets it. With `targetSessionId`,
 * the route to that exact ancestor (a resolution follows its question).
 * Falls back to the parent when no ancestor qualifies or the chain is broken.
 */
export async function childRequiresActionRouteTx(
  tx: Database,
  workspaceId: string,
  session: RouteSession & { parentSessionId: string },
  targetSessionId?: string | null,
): Promise<ChildRequiresActionRoute> {
  const direct: ChildRequiresActionRoute = {
    targetSessionId: session.parentSessionId,
    via: session,
    escalatedFromSessionId: null,
  };
  if (targetSessionId === session.parentSessionId) return direct;
  let via: RouteSession = session;
  let currentId: string | null = session.parentSessionId;
  const seen = new Set<string>([session.id]);
  for (let hop = 0; currentId && hop < CHILD_REQUIRES_ACTION_ESCALATION_LIMIT; hop += 1) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const current = await routeSessionTx(tx, workspaceId, currentId);
    if (!current) break;
    const reached = targetSessionId
      ? current.id === targetSessionId
      : sessionCanActOnChildQuestion(current);
    if (reached) {
      return hop === 0
        ? direct
        : {
            targetSessionId: current.id,
            via,
            escalatedFromSessionId: session.parentSessionId,
          };
    }
    via = current;
    currentId = current.parentSessionId;
  }
  return direct;
}

/** The session the outbox sent this exact child question to, if it is still recorded. */
export async function recordedChildNoticeTargetTx(
  tx: Database,
  workspaceId: string,
  dedupeKey: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ targetSessionId: schema.sessionSystemUpdateOutbox.targetSessionId })
    .from(schema.sessionSystemUpdateOutbox)
    .where(
      and(
        eq(schema.sessionSystemUpdateOutbox.workspaceId, workspaceId),
        eq(schema.sessionSystemUpdateOutbox.dedupeKey, dedupeKey),
      ),
    )
    .limit(1);
  return row?.targetSessionId ?? null;
}

/** Preserve the accepted producer evidence identically for every notice kind. */
export async function parentOutboxAuthorityTx(
  tx: Database,
  workspaceId: string,
  session: Pick<typeof schema.sessions.$inferSelect, "id" | "accountId" | "parentTurnId"> & {
    parentSessionId: string;
  },
) {
  const [turn] = session.parentTurnId
    ? await tx
        .select()
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.accountId, session.accountId),
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, session.parentSessionId),
            eq(schema.sessionTurns.id, session.parentTurnId),
          ),
        )
        .limit(1)
    : [];
  if (session.parentTurnId && !turn) throw new Error("Child notice parent turn is unavailable");
  const personalConnectionDelegations = McpPersonalConnectionDelegations.parse(
    turn?.personalConnectionDelegations ?? [],
  );
  const mcpAccountBindings =
    turn?.mcpAccountBindings == null
      ? null
      : turn.mcpAccountBindings.map((binding) => McpConnectionAccountBinding.parse(binding));
  const workspace = { snapshot: { version: 1, scope: "workspace" } as const, subjectId: null };
  const xai = turn ? subscriptionExecutionAuthorityFromTurn(turn, "xai") : workspace;
  const claude = turn ? subscriptionExecutionAuthorityFromTurn(turn, "claude") : workspace;
  const human =
    turn?.initiatingHumanSubjectId ??
    (turn?.initiatorKind === "subject" ? turn.initiatorSubjectId : null);
  if (personalConnectionDelegations.length > 0 && !human)
    throw new Error("Child notice lost its parent connection authority subject");
  return {
    personalConnectionDelegations,
    mcpAccountBindings,
    xaiProviderAccountAuthoritySnapshot: xai.snapshot,
    claudeProviderAccountAuthoritySnapshot: claude.snapshot,
    // Codex v2 (M3 PR 3b): the exact spawning parent turn's frozen value,
    // copied like the v1 pools (null before the cutover).
    subscriptionAuthority: turn?.subscriptionAuthority ?? null,
    lineage: {
      childSessionId: session.id,
      parentSessionId: session.parentSessionId,
      ...(session.parentTurnId ? { parentTurnId: session.parentTurnId } : {}),
      ...(personalConnectionDelegations.length > 0 ? { connectionAuthoritySubjectId: human } : {}),
      ...(xai.subjectId ? { xaiAuthoritySubjectId: xai.subjectId } : {}),
      ...(claude.subjectId ? { claudeAuthoritySubjectId: claude.subjectId } : {}),
    },
  };
}
