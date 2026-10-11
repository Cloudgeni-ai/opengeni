import {
  SubscriptionPersonalAuthorityV2,
  XaiProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { resolveClaudeSharedPoolAuthoritySnapshotInTransaction } from "./claude-subscription-accounts";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";
import {
  coreSubscriptionAuthorityV2ActiveInTransaction,
  coreSubscriptionAuthorityV2OrEmptyInTransaction,
  EMPTY_SUBSCRIPTION_AUTHORITY_V2,
} from "./subscription-core-acceptance-authority";
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
  const source = await receiverAuthoritySourceInTransaction(db, input);
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

/**
 * The v2 accepted authority for agent-originated work delivered to
 * `sessionId` (Agent Message, Agent Steer; design 3.7, EP-T14), for every
 * provider on the shared core (the frozen value holds each provider's
 * entry, all with the same owner, so one rule narrows them all): the same
 * receiving source as the v1 pools above, copied and never recomputed. Its
 * personal entry is kept only when the receiving source's exact owner is the
 * human who caused this work; otherwise the empty value (shared capacity
 * only). A child session without turns uses its exact spawning parent turn's
 * value. A source accepted before the cutover (no v2 value) yields the empty
 * value. Returns `null` (write nothing; v1 authoritative) unless some
 * provider's cutover is active. Call under the receiving session's lock.
 */
export async function receiverSubscriptionAuthorityV2InTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    causalHumanSubjectId: string | null;
  },
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  if (!(await coreSubscriptionAuthorityV2ActiveInTransaction(db, input.accountId))) return null;
  const source = await receiverAuthoritySourceInTransaction(db, input);
  const frozen =
    source.codexV2 === null || source.codexV2 === undefined
      ? null
      : SubscriptionPersonalAuthorityV2.parse(source.codexV2);
  if (
    frozen &&
    frozen.personal.length > 0 &&
    source.owner !== null &&
    input.causalHumanSubjectId === source.owner
  ) {
    return frozen;
  }
  return EMPTY_SUBSCRIPTION_AUTHORITY_V2;
}

/** The Codex name of the receiver's v2 value (kept for existing callers). */
export const receiverCodexSubscriptionAuthorityV2InTransaction =
  receiverSubscriptionAuthorityV2InTransaction;

async function receiverAuthoritySourceInTransaction(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<{ xai: unknown; claude: unknown; codexV2: unknown; owner: string | null }> {
  const turnColumns = {
    xai: schema.sessionTurns.xaiProviderAccountAuthoritySnapshot,
    claude: schema.sessionTurns.claudeProviderAccountAuthoritySnapshot,
    codexV2: schema.sessionTurns.subscriptionAuthority,
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
  let source: { xai: unknown; claude: unknown; codexV2: unknown; owner: string | null };
  if (turn) {
    source = { xai: turn.xai, claude: turn.claude, codexV2: turn.codexV2, owner: turnOwner(turn) };
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
      // No v2 initial snapshot: the exact spawning parent turn's value.
      codexV2: parentTurn ? parentTurn.codexV2 : null,
      owner: parentTurn ? turnOwner(parentTurn) : null,
    };
  } else {
    source = {
      xai: session.xai,
      claude: session.claude,
      codexV2: null,
      owner:
        session.createdByKind === "subject" && !session.parentSessionId
          ? session.createdBySubjectId
          : null,
    };
  }
  return source;
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

/**
 * The Codex v2 value a scheduled firing copies (M3 PR 3b, EP-T15): the task's
 * value frozen at creation, never recomputed. When the task's current
 * revision was authorized by anyone but its owner, the firing gets the empty
 * value (another person's edit never inherits the owner's personal entry).
 */
export async function getScheduledTaskSubscriptionAuthority(
  db: Database,
  input: {
    workspaceId: string;
    taskId: string;
    taskAuthorityRevision?: number;
    revisionAuthorizerSubjectId: string | null;
  },
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  return withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        accountId: schema.scheduledTasks.accountId,
        ownerSubjectId: schema.scheduledTasks.ownerSubjectId,
        subscriptionAuthority: sql<unknown>`opengeni_private.subscription_core_revision_authority_v2(
          ${schema.scheduledTasks.accountId}, ${schema.scheduledTasks.workspaceId},
          ${schema.scheduledTasks.id}, coalesce(${input.taskAuthorityRevision ?? null}::bigint, ${schema.scheduledTasks.authorityRevision}))`,
      })
      .from(schema.scheduledTasks)
      .where(
        and(
          eq(schema.scheduledTasks.workspaceId, input.workspaceId),
          eq(schema.scheduledTasks.id, input.taskId),
          isNull(schema.scheduledTasks.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    const frozen =
      row.subscriptionAuthority === null || row.subscriptionAuthority === undefined
        ? null
        : SubscriptionPersonalAuthorityV2.parse(row.subscriptionAuthority);
    if (
      frozen &&
      frozen.personal.length > 0 &&
      input.revisionAuthorizerSubjectId !== row.ownerSubjectId
    ) {
      return EMPTY_SUBSCRIPTION_AUTHORITY_V2;
    }
    return coreSubscriptionAuthorityV2OrEmptyInTransaction(tx, row.accountId, frozen);
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
