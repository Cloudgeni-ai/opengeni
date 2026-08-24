import {
  SessionAuthorizationActor,
  SessionAuthorizationDecision,
  SessionAuthorizationListScope,
  type AccessGrant,
  type SessionAuthorizationOperation,
  type SessionAuthorizationSurface,
  type SessionAuthorizationTarget,
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

type ResolvedSessionAuthorizationActor = {
  actor: SessionAuthorizationActor;
  callerParentSessionId: string | null;
};

type ResolvedSessionAuthorizationTarget = {
  target: SessionAuthorizationTarget;
  parentSessionId: string | null;
};

function grantHasAgentAttemptAuthority(grant: AccessGrant): boolean {
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
  const { actor } = await resolveSessionAuthorizationActor(deps.db, grant);
  // Standalone agents may retain compact workspace discovery, but only while
  // the signed caller attempt is still the exact live attempt.
  if (!port) return null;
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
  if (parsed.data.kind === "all") return parsed.data;
  return {
    kind: "scoped",
    rootSessionIds: [...new Set(parsed.data.rootSessionIds)],
    sessionIds: [...new Set(parsed.data.sessionIds)],
  };
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
  };
}
