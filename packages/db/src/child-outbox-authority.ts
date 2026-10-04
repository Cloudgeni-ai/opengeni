import { McpPersonalConnectionDelegations, McpConnectionAccountBinding } from "@opengeni/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "./database";
import { subscriptionExecutionAuthorityFromTurn } from "./accepted-subscription-authority";
import * as schema from "./schema";

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
