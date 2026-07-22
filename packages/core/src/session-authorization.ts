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
  getSessionRootId,
  getSessionTurnForAttempt,
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

/**
 * Resolve and enforce the host ACL for one session. The target and agent actor
 * are reconstructed from workspace-scoped durable state. A request can supply
 * an immediate target id and signed attempt claims, but can never nominate a
 * lineage root or frozen initiator.
 *
 * Returns null when no host port is bound so standalone behavior stays byte-
 * for-byte unchanged and pays no additional lineage lookup.
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
  if (!port) return null;

  const [actor, target] = await Promise.all([
    resolveSessionAuthorizationActor(deps.db, grant),
    resolveSessionAuthorizationTarget(deps.db, grant, input.sessionId),
  ]);
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
    relatedSessionAccess: parsed.data.relatedSessionAccess ?? "target",
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
  if (!port) return null;
  const actor = await resolveSessionAuthorizationActor(deps.db, grant);
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
): Promise<SessionAuthorizationTarget> {
  const session = await getSession(db, grant.workspaceId, sessionId);
  if (!session || session.accountId !== grant.accountId) {
    throw new SessionAuthorizationDeniedError("not_found");
  }
  let rootSessionId: string | null;
  try {
    rootSessionId = await getSessionRootId(db, grant.workspaceId, session.id);
  } catch (error) {
    throw new SessionAuthorizationUnavailableError({ cause: error });
  }
  if (!rootSessionId) {
    throw new SessionAuthorizationDeniedError("not_found");
  }
  return { sessionId: session.id, rootSessionId };
}

async function resolveSessionAuthorizationActor(
  db: Database,
  grant: AccessGrant,
): Promise<SessionAuthorizationActor> {
  const callerSessionId = grant.metadata?.["sessionId"];
  const turnId = grant.metadata?.["turnId"];
  const attemptId = grant.metadata?.["attemptId"];
  const executionGeneration = grant.metadata?.["executionGeneration"];
  const hasAttemptClaim =
    turnId !== undefined || attemptId !== undefined || executionGeneration !== undefined;
  if (!hasAttemptClaim) {
    return SessionAuthorizationActor.parse({
      kind: "subject",
      subjectId: grant.subjectId,
      ...(grant.subjectLabel ? { subjectLabel: grant.subjectLabel } : {}),
    });
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
  const [callerSession, turn, callerRootSessionId] = await Promise.all([
    getSession(db, grant.workspaceId, callerSessionId),
    getSessionTurnForAttempt(db, grant.workspaceId, callerSessionId, attemptId),
    getSessionRootId(db, grant.workspaceId, callerSessionId).catch(() => null),
  ]);
  if (
    !callerSession ||
    callerSession.accountId !== grant.accountId ||
    !turn ||
    turn.id !== turnId ||
    turn.executionGeneration !== executionGeneration ||
    callerSession.activeTurnId !== turn.id ||
    !callerRootSessionId
  ) {
    throw new SessionAuthorizationDeniedError("caller_stale");
  }
  return SessionAuthorizationActor.parse({
    kind: "agent_attempt",
    subjectId: grant.subjectId,
    callerSessionId,
    callerRootSessionId,
    turnId,
    attemptId,
    executionGeneration,
    initiator: turn.initiator,
    initiatorContext: turn.initiatorContext,
  });
}
