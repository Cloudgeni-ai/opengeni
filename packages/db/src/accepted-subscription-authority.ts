import { XaiProviderAccountAuthoritySnapshotV1 } from "@opengeni/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

type SubscriptionProvider = "xai" | "claude";
export type FrozenSubscriptionExecutionAuthority = {
  snapshot: XaiProviderAccountAuthoritySnapshotV1;
  subjectId: string | null;
};
const workspaceAuthority = { version: 1, scope: "workspace" } as const;

export function subscriptionExecutionAuthorityFromTurn(
  turn: Pick<
    typeof schema.sessionTurns.$inferSelect,
    | "id"
    | "xaiProviderAccountAuthoritySnapshot"
    | "claudeProviderAccountAuthoritySnapshot"
    | "initiatingHumanSubjectId"
    | "initiatorKind"
    | "initiatorSubjectId"
  >,
  provider: SubscriptionProvider,
): FrozenSubscriptionExecutionAuthority {
  const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(
    provider === "xai"
      ? turn.xaiProviderAccountAuthoritySnapshot
      : turn.claudeProviderAccountAuthoritySnapshot,
  );
  const subjectId =
    snapshot.scope === "user"
      ? (turn.initiatingHumanSubjectId ??
        (turn.initiatorKind === "subject" ? turn.initiatorSubjectId : null))
      : null;
  if (snapshot.scope === "user" && !subjectId)
    throw new Error(`Accepted turn lost its user-scoped ${provider} subject: ${turn.id}`);
  return { snapshot, subjectId };
}

/** Reads accepted authority only. This helper never resolves a current account pool. */
export async function subscriptionAuthorityForTurnInTransaction(
  db: Database,
  provider: SubscriptionProvider,
  workspaceId: string,
  sessionId: string,
  turnId: string,
): Promise<XaiProviderAccountAuthoritySnapshotV1> {
  const [row] = await db
    .select({
      snapshot:
        provider === "xai"
          ? schema.sessionTurns.xaiProviderAccountAuthoritySnapshot
          : schema.sessionTurns.claudeProviderAccountAuthoritySnapshot,
    })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        eq(schema.sessionTurns.sessionId, sessionId),
        eq(schema.sessionTurns.id, turnId),
      ),
    )
    .limit(1);
  return row ? XaiProviderAccountAuthoritySnapshotV1.parse(row.snapshot) : workspaceAuthority;
}

export async function getAcceptedSubscriptionTurnAuthority(
  db: Database,
  provider: SubscriptionProvider,
  workspaceId: string,
  sessionId: string,
  turnId: string,
) {
  return withWorkspaceRls(db, workspaceId, (tx) =>
    subscriptionAuthorityForTurnInTransaction(tx, provider, workspaceId, sessionId, turnId),
  );
}

export async function getAcceptedSubscriptionTaskAuthority(
  db: Database,
  provider: SubscriptionProvider,
  workspaceId: string,
  taskId: string,
): Promise<XaiProviderAccountAuthoritySnapshotV1> {
  return withWorkspaceRls(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        snapshot:
          provider === "xai"
            ? schema.scheduledTasks.xaiProviderAccountAuthoritySnapshot
            : schema.scheduledTasks.claudeProviderAccountAuthoritySnapshot,
      })
      .from(schema.scheduledTasks)
      .where(
        and(
          eq(schema.scheduledTasks.workspaceId, workspaceId),
          eq(schema.scheduledTasks.id, taskId),
          isNull(schema.scheduledTasks.deletedAt),
        ),
      )
      .limit(1);
    return row ? XaiProviderAccountAuthoritySnapshotV1.parse(row.snapshot) : workspaceAuthority;
  });
}

export async function getAcceptedSubscriptionParentAuthority(
  db: Database,
  provider: SubscriptionProvider,
  workspaceId: string,
  childSessionId: string,
): Promise<FrozenSubscriptionExecutionAuthority> {
  return withWorkspaceRls(db, workspaceId, async (tx) => {
    const [child] = await tx
      .select({
        parentSessionId: schema.sessions.parentSessionId,
        parentTurnId: schema.sessions.parentTurnId,
      })
      .from(schema.sessions)
      .where(
        and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, childSessionId)),
      )
      .limit(1);
    if (!child?.parentSessionId || !child.parentTurnId)
      return { snapshot: workspaceAuthority, subjectId: null };
    const [turn] = await tx
      .select({
        id: schema.sessionTurns.id,
        snapshot:
          provider === "xai"
            ? schema.sessionTurns.xaiProviderAccountAuthoritySnapshot
            : schema.sessionTurns.claudeProviderAccountAuthoritySnapshot,
        xaiProviderAccountAuthoritySnapshot:
          schema.sessionTurns.xaiProviderAccountAuthoritySnapshot,
        claudeProviderAccountAuthoritySnapshot:
          schema.sessionTurns.claudeProviderAccountAuthoritySnapshot,
        initiatingHumanSubjectId: schema.sessionTurns.initiatingHumanSubjectId,
        initiatorKind: schema.sessionTurns.initiatorKind,
        initiatorSubjectId: schema.sessionTurns.initiatorSubjectId,
      })
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          eq(schema.sessionTurns.sessionId, child.parentSessionId),
          eq(schema.sessionTurns.id, child.parentTurnId),
        ),
      )
      .limit(1);
    if (!turn) throw new Error(`Parent turn not found for child session ${childSessionId}`);
    return subscriptionExecutionAuthorityFromTurn(turn, provider);
  });
}
