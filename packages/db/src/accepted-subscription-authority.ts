import { XaiProviderAccountAuthoritySnapshotV1 } from "@opengeni/contracts";
import { and, desc, eq, isNull } from "drizzle-orm";
import { resolveClaudeSharedPoolAuthoritySnapshotInTransaction } from "./claude-subscription-accounts";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";
import { resolveXaiSharedPoolAuthoritySnapshotInTransaction } from "./xai-subscription";

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

/**
 * Resolve the organization or workspace pool for acceptance that has no exact
 * accepting human (service/operator actors, organization API keys, bridges,
 * non-subject creators, and internal producers without causal authority).
 * The result is never user-scoped, so this cannot widen access to a personal
 * pool. The transaction must already carry the account/workspace RLS context.
 */
export async function sharedPoolSubscriptionAuthoritySnapshotsInTransaction(
  db: Database,
  workspaceId: string,
): Promise<{
  xai: XaiProviderAccountAuthoritySnapshotV1;
  claude: XaiProviderAccountAuthoritySnapshotV1;
}> {
  return {
    xai: await resolveXaiSharedPoolAuthoritySnapshotInTransaction(db, { workspaceId }),
    claude: await resolveClaudeSharedPoolAuthoritySnapshotInTransaction(db, { workspaceId }),
  };
}

/**
 * Pool scope for agent-originated work delivered to `sessionId` (Agent Message,
 * Agent Steer, agent-submitted prompts). The pool belongs to the receiving
 * session's accepted work, never to the sender. It comes from, in order: the
 * receiver's execution-context turn (its latest started user/API turn, the
 * same context the claim path uses for informational input), its most recently
 * accepted turn, or its frozen initial snapshot before any turn exists.
 *
 * A user-scoped (personal) pool is retained only when its exact owner is the
 * same human who caused this work. Otherwise the receiver falls back to its
 * organization or workspace pool, so another human's work never inherits a
 * personal pool. Call under the receiving session's lock.
 */
export async function receiverSubscriptionAuthorityInTransaction(
  db: Database,
  input: { workspaceId: string; sessionId: string; causalHumanSubjectId: string | null },
): Promise<Record<SubscriptionProvider, FrozenSubscriptionExecutionAuthority>> {
  const turnColumns = {
    xai: schema.sessionTurns.xaiProviderAccountAuthoritySnapshot,
    claude: schema.sessionTurns.claudeProviderAccountAuthoritySnapshot,
    initiatingHumanSubjectId: schema.sessionTurns.initiatingHumanSubjectId,
    initiatorKind: schema.sessionTurns.initiatorKind,
    initiatorSubjectId: schema.sessionTurns.initiatorSubjectId,
  };
  const turnOwner = (turn: {
    initiatingHumanSubjectId: string | null;
    initiatorKind: string;
    initiatorSubjectId: string;
  }) =>
    turn.initiatingHumanSubjectId ??
    (turn.initiatorKind === "subject" ? turn.initiatorSubjectId : null);
  const [session] = await db
    .select({
      xai: schema.sessions.initialXaiProviderAccountAuthoritySnapshot,
      claude: schema.sessions.initialClaudeProviderAccountAuthoritySnapshot,
      createdByKind: schema.sessions.createdByKind,
      createdBySubjectId: schema.sessions.createdBySubjectId,
      parentSessionId: schema.sessions.parentSessionId,
      parentTurnId: schema.sessions.parentTurnId,
      executionContextTurnId: schema.sessions.executionContextTurnId,
    })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.workspaceId, input.workspaceId),
        eq(schema.sessions.id, input.sessionId),
      ),
    )
    .limit(1);
  if (!session) throw new Error(`Receiving session not found: ${input.sessionId}`);
  const [contextTurn] = session.executionContextTurnId
    ? await db
        .select(turnColumns)
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, input.workspaceId),
            eq(schema.sessionTurns.sessionId, input.sessionId),
            eq(schema.sessionTurns.id, session.executionContextTurnId),
          ),
        )
        .limit(1)
    : [];
  const [turn] = contextTurn
    ? [contextTurn]
    : await db
        .select(turnColumns)
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, input.workspaceId),
            eq(schema.sessionTurns.sessionId, input.sessionId),
          ),
        )
        // Acceptance order, not queue position: Send, Steer, internal and
        // compaction turns assign positions independently of acceptance time.
        .orderBy(
          desc(schema.sessionTurns.createdAt),
          desc(schema.sessionTurns.position),
          desc(schema.sessionTurns.id),
        )
        .limit(1);
  let source: { xai: unknown; claude: unknown; owner: string | null };
  if (turn) {
    source = { xai: turn.xai, claude: turn.claude, owner: turnOwner(turn) };
  } else if (session.parentSessionId && session.parentTurnId) {
    // A child's initial snapshot is copied from its exact spawning parent turn,
    // so that turn's human owns any personal scope in it.
    const [parentTurn] = await db
      .select(turnColumns)
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, input.workspaceId),
          eq(schema.sessionTurns.sessionId, session.parentSessionId),
          eq(schema.sessionTurns.id, session.parentTurnId),
        ),
      )
      .limit(1);
    source = {
      xai: session.xai,
      claude: session.claude,
      owner: parentTurn ? turnOwner(parentTurn) : null,
    };
  } else {
    source = {
      xai: session.xai,
      claude: session.claude,
      owner:
        session.createdByKind === "subject" && !session.parentSessionId
          ? session.createdBySubjectId
          : null,
    };
  }
  let shared: Awaited<
    ReturnType<typeof sharedPoolSubscriptionAuthoritySnapshotsInTransaction>
  > | null = null;
  const resolve = async (
    provider: SubscriptionProvider,
  ): Promise<FrozenSubscriptionExecutionAuthority> => {
    const snapshot = XaiProviderAccountAuthoritySnapshotV1.parse(source[provider]);
    if (snapshot.scope !== "user") return { snapshot, subjectId: null };
    if (source.owner && input.causalHumanSubjectId === source.owner)
      return { snapshot, subjectId: source.owner };
    shared ??= await sharedPoolSubscriptionAuthoritySnapshotsInTransaction(db, input.workspaceId);
    return { snapshot: shared[provider], subjectId: null };
  };
  return { xai: await resolve("xai"), claude: await resolve("claude") };
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
