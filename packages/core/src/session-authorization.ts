import {
  SessionAuthorizationActor,
  SessionAuthorizationDecision,
  SessionAuthorizationListScope,
  type AccessGrant,
  type SessionAgentAccess,
  type SessionAgentAccessViewer,
  type SessionAuthorizationOperation,
  type SessionAuthorizationSurface,
  type SessionAuthorizationTarget,
  type SessionEndUser,
} from "@opengeni/contracts";
import {
  getSessionAuthorityProjection,
  getSession,
  getSessionTurnForAttempt,
  getSlackInteractionSessionAccessForSession,
  withSessionRlsActorContext,
  type Database,
  type SessionRlsActorContext,
} from "@opengeni/db";
import type { AppDependencies } from "./dependencies";

export type SessionAuthorizationDependencies = Pick<AppDependencies, "db" | "sessionAuthorization">;

/** Maximum time an omitted host hint leaves a live session stream unchecked. */
export const SESSION_AUTHORIZATION_DEFAULT_REAUTHORIZE_MS = 15_000;

export class SessionAuthorizationDeniedError extends Error {
  readonly code = "SESSION_NOT_FOUND_OR_DENIED";

  constructor(readonly reason: "not_found" | "forbidden" | "revoked" | "caller_stale") {
    super("Session not found or access denied");
    this.name = "SessionAuthorizationDeniedError";
  }
}

export class SessionAuthorizationUnavailableError extends Error {
  readonly code = "SESSION_AUTHORIZATION_UNAVAILABLE";

  constructor(options?: ErrorOptions) {
    super("Session authorization is unavailable", options);
    this.name = "SessionAuthorizationUnavailableError";
  }
}

export type ResolvedSessionAuthorization = {
  actor: SessionAuthorizationActor;
  target: SessionAuthorizationTarget;
  relatedSessionAccess: "target" | "root";
  reauthorizeAfterMs: number | null;
};

/** The frozen agent-access facts of one session, as the pairwise rule sees them. */
export type SessionAgentAccessFacts = {
  agentAccess: SessionAgentAccess;
  endUser: SessionEndUser | null;
};

type ResolvedSessionAuthorizationActor = {
  actor: SessionAuthorizationActor;
  callerParentSessionId: string | null;
  /** The caller session's own access facts; null for non-agent principals. */
  callerAccess: SessionAgentAccessFacts | null;
};

function sameEndUser(left: SessionEndUser | null, right: SessionEndUser | null): boolean {
  return left !== null && right !== null && left.source === right.source && left.id === right.id;
}

/**
 * The agent-to-agent reach rule (migration 0427) for one caller/target pair
 * that live in DIFFERENT root trees. A caller always keeps its own tree, so
 * this is never consulted for same-root access. The most restrictive side
 * wins: a `session` side denies everything; a `user` side requires both
 * sessions to carry the same non-null end-user label; two `workspace` sides
 * are today's behaviour. Humans and API keys never pass through here.
 */
export function agentAccessPermitsCrossTreeAccess(
  caller: SessionAgentAccessFacts,
  target: SessionAgentAccessFacts,
): boolean {
  if (caller.agentAccess === "session" || target.agentAccess === "session") return false;
  if (caller.agentAccess === "user" || target.agentAccess === "user") {
    return sameEndUser(caller.endUser, target.endUser);
  }
  return true;
}

/**
 * The in-database list scope for one calling attempt. A `session` caller is
 * pinned to its own root tree when the host does not narrow it. Every caller
 * carries the viewer so `sessionAuthorizationScopeFilter` intersects the host
 * scope with the same pairwise rule in SQL, including for session callers.
 */
export function agentAccessListScopeForViewer(
  viewer: SessionAgentAccessViewer,
  hostScope: SessionAuthorizationListScope | null = null,
): SessionAuthorizationListScope {
  if (viewer.agentAccess === "session" && (!hostScope || hostScope.kind === "all")) {
    return {
      kind: "scoped",
      rootSessionIds: [viewer.callerRootSessionId],
      sessionIds: [],
      agentAccessViewer: viewer,
    };
  }
  if (!hostScope || hostScope.kind === "all") {
    return { kind: "all", agentAccessViewer: viewer };
  }
  return {
    kind: "scoped",
    rootSessionIds: [...new Set(hostScope.rootSessionIds)],
    sessionIds: [...new Set(hostScope.sessionIds)],
    agentAccessViewer: viewer,
  };
}

type ResolvedSessionAuthorizationTarget = {
  target: SessionAuthorizationTarget;
  parentSessionId: string | null;
};

/**
 * Whether a grant acts with live agent-attempt authority: an explicit
 * `agent_attempt` principal kind, or (for legacy tokens without one) any
 * worker-signed exact attempt claim. Shared by the session seam and by the
 * narrowing fences that let a human widen a session an agent may only narrow.
 */
export function grantHasAgentAttemptAuthority(grant: AccessGrant): boolean {
  const hasAgentAttemptClaim =
    grant.metadata?.["turnId"] !== undefined ||
    grant.metadata?.["attemptId"] !== undefined ||
    grant.metadata?.["executionGeneration"] !== undefined;
  return grant.principalKind ? grant.principalKind === "agent_attempt" : hasAgentAttemptClaim;
}

/**
 * Live agent attempts may address any workspace session that later private,
 * Slack-owner, and optional host checks still allow. Parent/child lineage is
 * not an access deny. Cross-session projections stay exact-target so a peer
 * read does not receive another session's derived metadata.
 */
function relatedSessionAccessForAgentAttempt(
  actor: Extract<SessionAuthorizationActor, { kind: "agent_attempt" }>,
  targetSessionId: string,
): "target" | "root" {
  return targetSessionId === actor.callerSessionId ? "root" : "target";
}

export function sessionRlsActorForAuthorization(
  authorization: ResolvedSessionAuthorization,
): SessionRlsActorContext {
  return authorization.actor.kind === "agent_attempt"
    ? {
        subjectId: authorization.actor.subjectId,
        initiatingHumanSubjectId: authorization.actor.initiatingHumanSubjectId,
      }
    : { subjectId: authorization.actor.subjectId };
}

export async function withResolvedSessionAuthorization<T>(
  authorization: ResolvedSessionAuthorization,
  fn: () => Promise<T>,
): Promise<T> {
  return await withSessionRlsActorContext(sessionRlsActorForAuthorization(authorization), fn);
}

/**
 * Prove that a first-party request belongs to the exact currently active
 * attempt of the named caller session. Unlike the optional embedding-host ACL
 * port, this database fence is mandatory for high-trust operations.
 */
export async function requireLiveAgentAttemptAuthorization(
  db: Database,
  grant: AccessGrant,
  callerSessionId: string,
): Promise<Extract<SessionAuthorizationActor, { kind: "agent_attempt" }>> {
  const { actor } = await resolveSessionAuthorizationActor(db, grant);
  if (actor.kind !== "agent_attempt" || actor.callerSessionId !== callerSessionId) {
    throw new SessionAuthorizationDeniedError("caller_stale");
  }
  return actor;
}

/**
 * Resolve and enforce the host ACL for one session. The target and agent actor
 * are reconstructed from workspace-scoped durable state. A request can supply
 * an immediate target id and signed attempt claims, but can never nominate a
 * lineage root or frozen initiator.
 *
 * Slack-owned private sessions are enforced here even when no embedding-host
 * authorization port is bound. That durable ownership fence covers every
 * session surface which uses this shared seam, rather than relying on list/UI
 * filtering or caller-controlled session metadata.
 */
export async function requireSessionAuthorization(
  deps: SessionAuthorizationDependencies,
  grant: AccessGrant,
  input: {
    sessionId: string;
    operation: SessionAuthorizationOperation;
    surface: SessionAuthorizationSurface;
  },
): Promise<ResolvedSessionAuthorization | null> {
  const port = deps.sessionAuthorization;
  const isAgentAttempt = grantHasAgentAttemptAuthority(grant);
  const [slackAccess, authority] = await Promise.all([
    getSlackInteractionSessionAccessForSession(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: input.sessionId,
    }),
    getSessionAuthorityProjection(deps.db, grant.workspaceId, input.sessionId),
  ]);

  // Preserve the standalone workspace-shared path. Private sessions continue
  // through the durable actor and ownership checks even without a host port.
  if (
    !port &&
    !isAgentAttempt &&
    slackAccess?.visibility !== "private" &&
    authority?.visibility !== "user_private"
  ) {
    return null;
  }
  if (!authority) throw new SessionAuthorizationDeniedError("not_found");

  const [resolvedActor, resolvedTarget] = await Promise.all([
    resolveSessionAuthorizationActor(deps.db, grant),
    resolveSessionAuthorizationTarget(deps.db, grant, input.sessionId),
  ]);
  const actor = resolvedActor.actor;
  const target = resolvedTarget.target;
  const agentRelatedSessionAccess =
    actor.kind === "agent_attempt"
      ? relatedSessionAccessForAgentAttempt(actor, target.sessionId)
      : null;

  // Tool approvals are a human decision. An agent attempt may answer another
  // session's structured human-input request (`session.human_input.write`,
  // through `session_human_input_respond`) but may never approve or reject a
  // pending tool approval on any session, including a child it spawned; an
  // embedding-host port cannot widen this.
  if (actor.kind === "agent_attempt" && input.operation === "session.approval.write") {
    throw new SessionAuthorizationDeniedError("forbidden");
  }

  if (authority.visibility === "user_private") {
    const allowed =
      authority.ownerSubjectId !== null &&
      (actor.kind === "subject"
        ? actor.subjectId === authority.ownerSubjectId
        : actor.initiatingHumanSubjectId === authority.ownerSubjectId);
    if (!allowed) throw new SessionAuthorizationDeniedError("forbidden");
  }
  if (slackAccess?.visibility === "private") {
    const allowed =
      actor.kind === "subject"
        ? actor.subjectId === slackAccess.owningSubjectId
        : actor.callerRootSessionId === target.rootSessionId;
    if (!allowed) throw new SessionAuthorizationDeniedError("forbidden");
  }
  // Agent-access scope (migration 0427): an attempt always keeps its own root
  // tree; across trees the most restrictive of the caller's and the target's
  // declared reach wins. Both sides are read from durable session rows, never
  // from the request, and an embedding-host port cannot widen this.
  if (actor.kind === "agent_attempt" && target.rootSessionId !== actor.callerRootSessionId) {
    const callerAccess = resolvedActor.callerAccess;
    if (
      !callerAccess ||
      !agentAccessPermitsCrossTreeAccess(callerAccess, {
        agentAccess: authority.agentAccess,
        endUser: authority.endUser,
      })
    ) {
      throw new SessionAuthorizationDeniedError("forbidden");
    }
  }
  if (!port) {
    return {
      actor,
      target,
      relatedSessionAccess: agentRelatedSessionAccess ?? "root",
      reauthorizeAfterMs: null,
    };
  }

  let rawDecision: unknown;
  try {
    rawDecision = await port.authorizeSession({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor,
      target,
      operation: input.operation,
      surface: input.surface,
    });
  } catch (error) {
    throw new SessionAuthorizationUnavailableError({ cause: error });
  }
  const parsed = SessionAuthorizationDecision.safeParse(rawDecision);
  if (!parsed.success) {
    throw new SessionAuthorizationUnavailableError({ cause: parsed.error });
  }
  if (!parsed.data.allowed) {
    throw new SessionAuthorizationDeniedError(parsed.data.reason);
  }
  return {
    actor,
    target,
    relatedSessionAccess:
      agentRelatedSessionAccess === "target"
        ? "target"
        : (parsed.data.relatedSessionAccess ?? "target"),
    reauthorizeAfterMs: parsed.data.reauthorizeAfterMs ?? null,
  };
}

/** Resolve the host's complete current list scope for an in-database query. */
export async function requireSessionAuthorizationListScope(
  deps: SessionAuthorizationDependencies,
  grant: AccessGrant,
  surface: SessionAuthorizationSurface,
): Promise<SessionAuthorizationListScope | null> {
  const port = deps.sessionAuthorization;
  const isAgentAttempt = grantHasAgentAttemptAuthority(grant);
  if (!port && !isAgentAttempt) return null;
  const { actor, callerAccess } = await resolveSessionAuthorizationActor(deps.db, grant);
  // Standalone agents retain compact workspace discovery only while the signed
  // caller attempt is still the exact live attempt, and only within their own
  // declared agent-access reach (migration 0427). The viewer is derived from
  // the caller session row and applied as one SQL predicate by every list.
  const viewer: SessionAgentAccessViewer | null =
    actor.kind === "agent_attempt" && callerAccess
      ? {
          callerRootSessionId: actor.callerRootSessionId,
          agentAccess: callerAccess.agentAccess,
          endUser: callerAccess.endUser,
        }
      : null;
  if (!port) return viewer ? agentAccessListScopeForViewer(viewer) : null;
  let rawScope: unknown;
  try {
    rawScope = await port.resolveListScope({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor,
      surface,
    });
  } catch (error) {
    throw new SessionAuthorizationUnavailableError({ cause: error });
  }
  const parsed = SessionAuthorizationListScope.safeParse(rawScope);
  if (!parsed.success) {
    throw new SessionAuthorizationUnavailableError({ cause: parsed.error });
  }
  // A host never supplies the viewer: OpenGeni resolved it above from durable
  // state, so a host-returned value is dropped before the intersection.
  const hostScope: SessionAuthorizationListScope =
    parsed.data.kind === "all"
      ? { kind: "all" }
      : {
          kind: "scoped",
          rootSessionIds: [...new Set(parsed.data.rootSessionIds)],
          sessionIds: [...new Set(parsed.data.sessionIds)],
        };
  return viewer ? agentAccessListScopeForViewer(viewer, hostScope) : hostScope;
}

async function resolveSessionAuthorizationTarget(
  db: Database,
  grant: AccessGrant,
  sessionId: string,
): Promise<ResolvedSessionAuthorizationTarget> {
  const session = await getSession(db, grant.workspaceId, sessionId);
  if (!session || session.accountId !== grant.accountId) {
    throw new SessionAuthorizationDeniedError("not_found");
  }
  return {
    target: { sessionId: session.id, rootSessionId: session.rootSessionId },
    parentSessionId: session.parentSessionId,
  };
}
async function resolveSessionAuthorizationActor(
  db: Database,
  grant: AccessGrant,
): Promise<ResolvedSessionAuthorizationActor> {
  const callerSessionId = grant.metadata?.["sessionId"];
  const turnId = grant.metadata?.["turnId"];
  const attemptId = grant.metadata?.["attemptId"];
  const executionGeneration = grant.metadata?.["executionGeneration"];
  const isAgentAttempt = grantHasAgentAttemptAuthority(grant);
  if (!isAgentAttempt) {
    return {
      actor: SessionAuthorizationActor.parse({
        kind: "subject",
        subjectId: grant.subjectId,
        ...(grant.subjectLabel ? { subjectLabel: grant.subjectLabel } : {}),
      }),
      callerParentSessionId: null,
      callerAccess: null,
    };
  }
  if (
    typeof callerSessionId !== "string" ||
    typeof turnId !== "string" ||
    typeof attemptId !== "string" ||
    typeof executionGeneration !== "number" ||
    !Number.isSafeInteger(executionGeneration) ||
    executionGeneration < 1
  ) {
    throw new SessionAuthorizationDeniedError("caller_stale");
  }
  const [callerSession, turn] = await Promise.all([
    getSession(db, grant.workspaceId, callerSessionId),
    getSessionTurnForAttempt(db, grant.workspaceId, callerSessionId, attemptId),
  ]);
  if (
    !callerSession ||
    callerSession.accountId !== grant.accountId ||
    !turn ||
    turn.id !== turnId ||
    turn.executionGeneration !== executionGeneration ||
    callerSession.activeTurnId !== turn.id
  ) {
    throw new SessionAuthorizationDeniedError("caller_stale");
  }
  return {
    actor: SessionAuthorizationActor.parse({
      kind: "agent_attempt",
      subjectId: grant.subjectId,
      callerSessionId,
      callerRootSessionId: callerSession.rootSessionId,
      turnId,
      attemptId,
      executionGeneration,
      initiator: turn.initiator,
      initiatorContext: turn.initiatorContext,
      initiatingHumanSubjectId:
        turn.initiatingHumanSubjectId ??
        (turn.initiator.kind === "subject" ? turn.initiator.subjectId : null),
    }),
    callerParentSessionId: callerSession.parentSessionId,
    callerAccess: { agentAccess: callerSession.agentAccess, endUser: callerSession.endUser },
  };
}
