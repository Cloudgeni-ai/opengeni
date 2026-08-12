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
  getSession,
  getSessionTurnForAttempt,
  getSlackInteractionSessionAccessForSession,
  type Database,
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
 * Read-only access an immediate child may use against its parent. Upstream
 * mutation is deliberately limited to `session.append`: letting a child Pause,
 * Steer, or otherwise mutate its parent would let it influence siblings through
 * the parent's recursive control and shared state.
 */
const AGENT_PARENT_READ_OPERATIONS = new Set<SessionAuthorizationOperation>([
  "session.read",
  "session.events.read",
  "session.stream.read",
  "session.turns.read",
  "session.queue.read",
  "session.composer.read",
  "session.lineage.read",
  "session.capture.read",
  "session.files.read",
  "session.git.read",
  "session.terminal.read",
  "session.viewer.read",
  "session.goal.read",
  "session.human_input.read",
]);

function enforceAgentSessionHierarchy(
  actor: Extract<SessionAuthorizationActor, { kind: "agent_attempt" }>,
  callerParentSessionId: string | null,
  target: ResolvedSessionAuthorizationTarget,
  operation: SessionAuthorizationOperation,
): "target" | "root" {
  if (target.target.sessionId === actor.callerSessionId) return "root";

  // A manager may inspect and operate an immediate child. Existing permission
  // and host-policy checks still apply; lineage never grants a capability.
  if (target.parentSessionId === actor.callerSessionId) return "target";

  // A child may report to and inspect its immediate parent, but cannot mutate
  // the parent except through the canonical machine-input message boundary.
  if (callerParentSessionId === target.target.sessionId) {
    if (operation === "session.append" || AGENT_PARENT_READ_OPERATIONS.has(operation)) {
      return "target";
    }
    throw new SessionAuthorizationDeniedError("forbidden");
  }

  // Siblings, skipped generations, other branches, and unrelated roots are
  // never cross-session authority for a live agent attempt.
  throw new SessionAuthorizationDeniedError("forbidden");
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
  const slackAccessPromise = getSlackInteractionSessionAccessForSession(deps.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: input.sessionId,
  });
  const isAgentAttempt = grantHasAgentAttemptAuthority(grant);
  if (!port && !isAgentAttempt) {
    const slackAccess = await slackAccessPromise;
    if (slackAccess?.visibility !== "private") return null;
  }

  const [slackAccess, resolvedActor, agentTarget] = await Promise.all([
    slackAccessPromise,
    resolveSessionAuthorizationActor(deps.db, grant),
    isAgentAttempt
      ? resolveSessionAuthorizationTarget(deps.db, grant, input.sessionId)
      : Promise.resolve(null),
  ]);
  const actor = resolvedActor.actor;
  const resolvedTarget =
    agentTarget ??
    (slackAccess
      ? {
          target: { sessionId: input.sessionId, rootSessionId: slackAccess.rootSessionId },
          parentSessionId: null,
        }
      : await resolveSessionAuthorizationTarget(deps.db, grant, input.sessionId));
  const target = slackAccess
    ? { sessionId: input.sessionId, rootSessionId: slackAccess.rootSessionId }
    : resolvedTarget.target;
  const agentRelatedSessionAccess =
    actor.kind === "agent_attempt"
      ? enforceAgentSessionHierarchy(
          actor,
          resolvedActor.callerParentSessionId,
          resolvedTarget,
          input.operation,
        )
      : null;
  if (slackAccess?.visibility === "private") {
    const allowed =
      actor.kind === "subject"
        ? actor.subjectId === slackAccess.owningSubjectId
        : actor.callerRootSessionId === target.rootSessionId;
    if (!allowed) throw new SessionAuthorizationDeniedError("forbidden");
  }
  if (!port) {
    return agentRelatedSessionAccess
      ? {
          actor,
          target,
          relatedSessionAccess: agentRelatedSessionAccess,
          reauthorizeAfterMs: null,
        }
      : null;
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
