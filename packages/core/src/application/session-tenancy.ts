import {
  ForkSessionResponse,
  UpdateSessionVisibilityResponse,
  sessionVisibilityFromPublic,
  sessionVisibilityToPublic,
  type ForkSessionRequest,
  type SessionAuthorizationSurface,
  type UpdateSessionVisibilityRequest,
} from "@opengeni/contracts";
import {
  forkSessionContent,
  getSessionEventForSubject,
  isRetryableDatabaseTransportFailure,
  transitionSessionVisibility,
  type Database,
} from "@opengeni/db";
import { publishDurableSessionEvents, type EventBus } from "@opengeni/events";
import { requirePermission, type AccessGrantAuthorization } from "../access";
import { requireSessionAuthorization } from "../session-authorization";
import type { AppDependencies } from "../dependencies";

type SessionTenancyDependencies = Pick<AppDependencies, "db" | "bus" | "sessionAuthorization">;

export class SessionTenancyManagedHumanRequiredError extends Error {
  readonly name = "SessionTenancyManagedHumanRequiredError";
  constructor() {
    super("Session tenancy mutations require the owning managed-human session");
  }
}

export class SessionTenancyPersistenceOutcomeUnknownError extends Error {
  readonly name = "SessionTenancyPersistenceOutcomeUnknownError";
  constructor(options?: ErrorOptions) {
    super("The session tenancy mutation outcome is unknown", options);
  }
}

function requireCanonicalManagedHuman(
  authorization: AccessGrantAuthorization,
  workspaceId: string,
): void {
  if (
    !authorization.canonicalManagedHumanSession ||
    !authorization.contextIntegrity ||
    authorization.authenticatedSubjectId !== authorization.grant.subjectId ||
    authorization.grant.workspaceId !== workspaceId
  ) {
    throw new SessionTenancyManagedHumanRequiredError();
  }
}

async function publishExactCommittedEvent(
  deps: { db: Database; bus: EventBus },
  input: {
    workspaceId: string;
    sessionId: string;
    subjectId: string;
    eventId: string | null;
    eventSequence: number | null;
  },
): Promise<void> {
  if (input.eventId === null && input.eventSequence === null) return;
  if (input.eventId === null || input.eventSequence === null) {
    console.error("[session-tenancy] committed event receipt is incomplete", {
      errorClass: "SessionTenancyEventInvariantError",
      errorCode: "session_tenancy_event_receipt_incomplete",
      origin: "core",
      sessionId: input.sessionId,
    });
    return;
  }
  try {
    const event = await getSessionEventForSubject(
      deps.db,
      input.workspaceId,
      input.subjectId,
      input.eventId,
    );
    if (!event || event.sessionId !== input.sessionId || event.sequence !== input.eventSequence) {
      console.error("[session-tenancy] committed event receipt did not resolve exactly", {
        errorClass: "SessionTenancyEventInvariantError",
        errorCode: "session_tenancy_event_receipt_mismatch",
        origin: "core",
        sessionId: input.sessionId,
      });
      return;
    }
    await publishDurableSessionEvents(deps.bus, input.workspaceId, input.sessionId, [event]);
  } catch {
    // The mutation and event committed atomically before this read. Live fanout
    // is repairable from the durable stream, so a publication-side failure must
    // not turn a known successful mutation into an unknown client outcome.
    console.warn("[session-tenancy] committed event live publication was deferred to replay", {
      errorClass: "SessionTenancyEventPublishOperationError",
      errorCode: "session_tenancy_event_publish_deferred",
      origin: "core",
      sessionId: input.sessionId,
    });
  }
}

async function runTenancyMutation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isRetryableDatabaseTransportFailure(error)) {
      throw new SessionTenancyPersistenceOutcomeUnknownError({ cause: error });
    }
    throw error;
  }
}

export async function updateManagedHumanSessionVisibility(
  deps: SessionTenancyDependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  sessionId: string,
  request: UpdateSessionVisibilityRequest,
  authorizationSurface: SessionAuthorizationSurface = "core",
): Promise<UpdateSessionVisibilityResponse> {
  requireCanonicalManagedHuman(authorization, workspaceId);
  requirePermission(authorization.grant, "sessions:control");
  await requireSessionAuthorization(deps, authorization.grant, {
    sessionId,
    operation: "session.visibility.write",
    surface: authorizationSurface,
  });

  const result = await runTenancyMutation(
    async () =>
      await transitionSessionVisibility(deps.db, {
        workspaceId,
        sessionId,
        actorSubjectId: authorization.grant.subjectId,
        targetVisibility: sessionVisibilityFromPublic(request.visibility),
        expectedAuthorityEpoch: request.expectedAuthorityEpoch,
        operationKey: request.idempotencyKey,
      }),
  );
  const response = UpdateSessionVisibilityResponse.parse({
    operationId: result.operationId,
    eventId: result.eventId,
    eventSequence: result.eventSequence,
    visibility: sessionVisibilityToPublic(result.visibility),
    authorityEpoch: result.authorityEpoch,
    changed: result.changed,
    replay: result.replay,
    revokedGrantCount: result.revokedGrantCount,
  });
  await publishExactCommittedEvent(deps, {
    workspaceId,
    sessionId,
    subjectId: authorization.grant.subjectId,
    eventId: response.eventId,
    eventSequence: response.eventSequence,
  });
  return response;
}

export async function forkManagedHumanSessionPrivate(
  deps: SessionTenancyDependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  sourceSessionId: string,
  request: ForkSessionRequest,
  authorizationSurface: SessionAuthorizationSurface = "core",
): Promise<ForkSessionResponse> {
  requireCanonicalManagedHuman(authorization, workspaceId);
  requirePermission(authorization.grant, "sessions:read");
  requirePermission(authorization.grant, "sessions:create");
  await requireSessionAuthorization(deps, authorization.grant, {
    sessionId: sourceSessionId,
    operation: "session.fork.create",
    surface: authorizationSurface,
  });

  const result = await runTenancyMutation(
    async () =>
      await forkSessionContent(deps.db, {
        sourceWorkspaceId: workspaceId,
        sourceSessionId,
        actorSubjectId: authorization.grant.subjectId,
        destinationWorkspaceId: workspaceId,
        destinationVisibility: "user_private",
        operationKey: request.idempotencyKey,
      }),
  );
  const response = ForkSessionResponse.parse({
    operationId: result.operationId,
    eventId: result.eventId,
    eventSequence: result.eventSequence,
    sessionId: result.sessionId,
    workspaceId: result.workspaceId,
    visibility: sessionVisibilityToPublic(result.visibility),
    authorityEpoch: result.authorityEpoch,
    copiedHistoryItemCount: result.copiedHistoryItemCount,
    replay: result.replay,
  });
  await publishExactCommittedEvent(deps, {
    workspaceId,
    sessionId: response.sessionId,
    subjectId: authorization.grant.subjectId,
    eventId: response.eventId,
    eventSequence: response.eventSequence,
  });
  return response;
}
