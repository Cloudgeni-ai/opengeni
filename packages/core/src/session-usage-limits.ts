import { HTTPException } from "hono/http-exception";
import {
  checkSessionUsageLimitAdmission,
  readSessionUsageLimit,
  SessionUsageLimitForbiddenError,
  SessionUsageLimitUnavailableError,
  setSessionUsageLimitInTransaction,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
  type Database,
  type SessionActivityDatabase,
  type SessionUsageLimitSetResult,
  type SessionUsageLimitWriteActor,
} from "@opengeni/db";
import {
  SESSION_USAGE_LIMIT_BASIS,
  type Session,
  type SessionUsageLimit,
  type SessionUsageLimitReachedRefusal,
  type SetSessionUsageLimitRequest,
} from "@opengeni/contracts";
import {
  isVerifiedDelegatedHumanAuthorization,
  requirePermission,
  verifiedDelegatedHumanAuthorizationForRequest,
  type AccessGrantAuthorization,
} from "./access";
import {
  requireSessionAuthorization,
  type SessionAuthorizationDependencies,
} from "./session-authorization";
import {
  recordSessionUsageLimitEvent,
  type SessionUsageLimitMetricBoundary,
  type SessionUsageLimitMetricOutcome,
  type SessionUsageLimitMetricsSink,
} from "./session-usage-limit-metrics";

/**
 * Producer flag for per-task usage limits. Off by default. When off, new
 * non-null limits are rejected (`session_usage_limit_disabled`), but limits
 * already persisted keep being enforced and clearing stays allowed, so turning
 * the flag off is never a way to lift a limit or strand one.
 */
export function sessionUsageLimitsProducerEnabled(settings: {
  sessionUsageLimitsEnabled?: boolean | undefined;
}): boolean {
  return settings.sessionUsageLimitsEnabled === true;
}

/** Typed route error with a stable `details.code`. */
export class SessionUsageLimitHttpError extends HTTPException {
  constructor(
    status: 403 | 404 | 409 | 422 | 503,
    readonly code:
      | "session_usage_limit_conflict"
      | "session_usage_limit_not_root"
      | "session_usage_limit_preparing"
      | "session_usage_limit_disabled"
      | "session_usage_limit_forbidden"
      | "session_usage_limit_unavailable"
      | "session_not_found",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(status, { message });
    this.name = "SessionUsageLimitHttpError";
  }
}

/**
 * Who may change a task's usage limit: an authenticated person acting
 * directly, or the trusted host's server key. Never an agent attempt, a
 * delegated-human or admin-access agent (an OAuth/MCP dispatch acting as a
 * person, or a personal API key), a service-delegated token or a session-scoped
 * bearer. `principalKind` alone is not proof of a present person.
 */
export function sessionUsageLimitWriteActorForAccess(
  access: AccessGrantAuthorization,
  request?: Request,
): SessionUsageLimitWriteActor {
  const { grant } = access;
  const forbidden = () =>
    new SessionUsageLimitHttpError(
      403,
      "session_usage_limit_forbidden",
      "Only a person or the application's server can change a task usage limit.",
    );
  if (
    (request && verifiedDelegatedHumanAuthorizationForRequest(request) !== null) ||
    isVerifiedDelegatedHumanAuthorization(access) ||
    grant.metadata?.attemptId !== undefined ||
    grant.metadata?.turnId !== undefined ||
    grant.metadata?.sessionId !== undefined
  ) {
    throw forbidden();
  }
  if (
    grant.principalKind === "human_session" &&
    access.contextIntegrity &&
    access.authenticatedSubjectId === grant.subjectId &&
    !grant.serviceInitiator &&
    !grant.serviceInitiatorContext
  ) {
    return { subjectId: grant.subjectId, type: "human" };
  }
  if (
    (grant.principalKind === "api_key" || grant.principalKind === "configured_key") &&
    access.contextIntegrity
  ) {
    return { subjectId: grant.subjectId, type: "host" };
  }
  throw forbidden();
}

/** Projection for a session whose usage state cannot be read right now. Never $0 or unlimited. */
export function unavailableSessionUsageLimit(
  session: Pick<Session, "id" | "rootSessionId">,
): SessionUsageLimit {
  return {
    basis: SESSION_USAGE_LIMIT_BASIS,
    rootSessionId: session.rootSessionId ?? session.id,
    inherited: (session.rootSessionId ?? session.id) !== session.id,
    status: "unavailable",
    limitMicros: null,
    usedMicros: null,
    version: 0,
    usageRevision: 0,
    history: "preparing",
    coverage: "partial",
    pricedCalls: 0,
    freeCalls: 0,
    unpricedCalls: 0,
    updatedAt: null,
  };
}

/**
 * Read a session's usage projection for an already-authorized session read.
 * A read failure yields the `unavailable` projection rather than failing the
 * whole session read. `prepare` advances a pending historical import inline.
 */
export async function sessionUsageLimitForRead(
  db: Database,
  session: Pick<Session, "id" | "rootSessionId" | "accountId" | "workspaceId">,
  options: { prepare?: boolean; subjectId?: string | null } = {},
): Promise<SessionUsageLimit | undefined> {
  try {
    const read = await readSessionUsageLimit(db, {
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      ...(options.subjectId ? { subjectId: options.subjectId } : {}),
      ...(options.prepare ? { prepare: true } : {}),
    });
    return read.outcome === "ok" ? read.state : undefined;
  } catch (error) {
    if (error instanceof SessionUsageLimitUnavailableError) {
      return unavailableSessionUsageLimit(session);
    }
    throw error;
  }
}

/** GET usage-limit: authorize a session read, then read (advancing a pending import). */
export async function getSessionUsageLimitForAccess(
  deps: SessionAuthorizationDependencies,
  access: AccessGrantAuthorization,
  sessionId: string,
): Promise<SessionUsageLimit> {
  const { grant } = access;
  requirePermission(grant, "sessions:read");
  await requireSessionAuthorization(deps, grant, {
    sessionId,
    operation: "session.read",
    surface: "core",
  });
  let read: Awaited<ReturnType<typeof readSessionUsageLimit>>;
  try {
    read = await readSessionUsageLimit(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      subjectId: grant.subjectId,
      prepare: true,
    });
  } catch (error) {
    if (error instanceof SessionUsageLimitUnavailableError) {
      throw new SessionUsageLimitHttpError(
        503,
        "session_usage_limit_unavailable",
        "Usage for this task is temporarily unavailable. Try again shortly.",
      );
    }
    throw error;
  }
  if (read.outcome !== "ok") {
    throw new SessionUsageLimitHttpError(404, "session_not_found", "session not found");
  }
  return read.state;
}

function setResultToHttp(result: SessionUsageLimitSetResult): SessionUsageLimit {
  switch (result.outcome) {
    case "ok":
    case "replayed":
      return result.state!;
    case "not_found":
      throw new SessionUsageLimitHttpError(404, "session_not_found", "session not found");
    case "not_root":
      throw new SessionUsageLimitHttpError(
        409,
        "session_usage_limit_not_root",
        "This chat shares its parent task's usage limit. Change it on the task's root chat.",
        result.rootSessionId ? { rootSessionId: result.rootSessionId } : {},
      );
    case "conflict":
      throw new SessionUsageLimitHttpError(
        409,
        "session_usage_limit_conflict",
        "The usage limit changed since it was read. Review the current limit and try again.",
        result.state ? { currentVersion: result.state.version } : {},
      );
    case "operation_conflict":
      throw new SessionUsageLimitHttpError(
        409,
        "session_usage_limit_conflict",
        "This operation id was already used for a different change.",
      );
    case "preparing":
      throw new SessionUsageLimitHttpError(
        409,
        "session_usage_limit_preparing",
        "Earlier usage for this task is still being counted. Try again shortly.",
      );
    case "disabled":
      throw new SessionUsageLimitHttpError(
        422,
        "session_usage_limit_disabled",
        "Usage limits are not enabled on this server. A limit can only be removed.",
      );
  }
}

/**
 * PUT usage-limit: a person or trusted host compare-and-sets a ROOT task's
 * limit. Appends `session.usage_limit.updated` on change. Never wakes or
 * resumes work: a paused goal stays paused until someone resumes it.
 */
export async function setSessionUsageLimitForAccess(
  deps: SessionAuthorizationDependencies & {
    settings: { sessionUsageLimitsEnabled?: boolean | undefined };
    observability?: SessionUsageLimitMetricsSink | undefined;
  },
  access: AccessGrantAuthorization,
  sessionId: string,
  request: SetSessionUsageLimitRequest,
  rawRequest?: Request,
): Promise<SessionUsageLimit> {
  const { grant } = access;
  requirePermission(grant, "sessions:control");
  let actor: SessionUsageLimitWriteActor;
  try {
    actor = sessionUsageLimitWriteActorForAccess(access, rawRequest);
  } catch (error) {
    recordSessionUsageLimitEvent(deps.observability, "write", "forbidden");
    throw error;
  }
  await requireSessionAuthorization(deps, grant, {
    sessionId,
    operation: "session.control",
    surface: "core",
  });
  const write = async (tx: SessionActivityDatabase) =>
    await setSessionUsageLimitInTransaction(tx, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      limitMicros: request.limitMicros,
      expectedVersion: request.expectedVersion,
      operationId: request.operationId,
      actor,
      producerEnabled: sessionUsageLimitsProducerEnabled(deps.settings),
    });
  let result: SessionUsageLimitSetResult;
  try {
    result =
      actor.type === "human"
        ? await withWorkspaceSubjectSessionActivityRls(
            deps.db,
            grant.workspaceId,
            grant.subjectId,
            write,
          )
        : await withWorkspaceSessionActivityRls(deps.db, grant.workspaceId, write);
  } catch (error) {
    if (error instanceof SessionUsageLimitForbiddenError) {
      recordSessionUsageLimitEvent(deps.observability, "write", "forbidden");
      throw new SessionUsageLimitHttpError(403, "session_usage_limit_forbidden", error.message);
    }
    if (error instanceof SessionUsageLimitUnavailableError) {
      recordSessionUsageLimitEvent(deps.observability, "write", "unavailable");
    }
    throw error;
  }
  const metricOutcome = writeMetricOutcome(result, request.limitMicros);
  if (metricOutcome) recordSessionUsageLimitEvent(deps.observability, "write", metricOutcome);
  return setResultToHttp(result);
}

function writeMetricOutcome(
  result: SessionUsageLimitSetResult,
  limitMicros: number | null,
): SessionUsageLimitMetricOutcome | null {
  switch (result.outcome) {
    case "ok":
      return limitMicros === null ? "cleared" : "set";
    case "replayed":
      return "replayed";
    case "conflict":
    case "operation_conflict":
      return "cas_conflict";
    case "preparing":
      return "preparing";
    case "disabled":
      return "disabled";
    case "not_root":
      return "not_root";
    case "not_found":
      return null;
  }
}

/**
 * Apply a create-time limit inside the session-creating transaction, before
 * the initial turn can be claimed. Only a person or trusted host may set it
 * and only on a new root; children always share their root's limit.
 */
export async function applyInitialSessionUsageLimit(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    limitMicros: number;
    actor: SessionUsageLimitWriteActor;
    producerEnabled: boolean;
  },
): Promise<void> {
  const result = await setSessionUsageLimitInTransaction(tx as SessionActivityDatabase, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    limitMicros: input.limitMicros,
    expectedVersion: 0,
    operationId: `create:${input.sessionId}`,
    actor: input.actor,
    producerEnabled: input.producerEnabled,
    appendEvent: false,
  });
  if (result.outcome !== "ok" && result.outcome !== "replayed") setResultToHttp(result);
}

/**
 * Edge admission for per-task usage limits (OPE-798). Called after an exact
 * committed replay has been returned and before any queue, interrupt, draft or
 * turn side effect, so a refused Send/Steer leaves nothing behind and the
 * composer keeps its draft.
 *
 * - Reached: HTTP 402 whose cause is the typed refusal (`session_usage_limit_reached`).
 * - Unreadable state: HTTP 503 (`session_usage_limit_unavailable`), never unlimited.
 */
export async function requireSessionUsageLimitAllows(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
  metrics?: {
    sink: SessionUsageLimitMetricsSink | null | undefined;
    boundary: SessionUsageLimitMetricBoundary;
  },
): Promise<void> {
  let admission: Awaited<ReturnType<typeof checkSessionUsageLimitAdmission>>;
  try {
    admission = await checkSessionUsageLimitAdmission(db, input);
  } catch (error) {
    if (error instanceof SessionUsageLimitUnavailableError) {
      if (metrics) recordSessionUsageLimitEvent(metrics.sink, metrics.boundary, "unavailable");
      throw new HTTPException(503, { message: error.message, cause: error });
    }
    throw error;
  }
  if (!admission.allowed) {
    if (metrics) recordSessionUsageLimitEvent(metrics.sink, metrics.boundary, "reached");
    throw new HTTPException(402, {
      message: admission.refusal.message,
      cause: admission.refusal,
    });
  }
}

/** True when this error is the typed edge refusal raised above. */
export function sessionUsageLimitRefusalFromError(
  error: unknown,
): SessionUsageLimitReachedRefusal | null {
  if (!(error instanceof HTTPException) || error.status !== 402) return null;
  const cause = error.cause as Partial<SessionUsageLimitReachedRefusal> | undefined;
  return cause && typeof cause === "object" && cause.code === "session_usage_limit_reached"
    ? (cause as SessionUsageLimitReachedRefusal)
    : null;
}
