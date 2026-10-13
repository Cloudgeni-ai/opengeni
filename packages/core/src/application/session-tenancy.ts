import {
  ForkSessionResponse,
  SessionVisibilityChangePreview,
  SessionTenancyCreateCapabilities,
  UpdateSessionVisibilityResponse,
  sessionVisibilityFromPublic,
  sessionVisibilityToPublic,
  type ForkSessionRequest,
  type SessionAuthorizationSurface,
  type SessionVisibility,
  type UpdateSessionVisibilityRequest,
  type VariableSet,
} from "@opengeni/contracts";
import {
  assertSessionIsNotImported,
  forkSessionContent,
  getSessionForSubject,
  getRig,
  getPrivateSessionCreatePolicy,
  getSessionEventForSubject,
  inspectSessionVisibilityChange,
  isRetryableDatabaseTransportFailure,
  nestedPostgresSqlState,
  replayAppliedSessionFork,
  sessionHasLiveAttempts,
  SessionTenancyAccessError,
  SessionTenancyInvalidRequestError,
  SessionVisibilityWorkConflictError,
  stopSessionWorkForVisibilityChange,
  transitionSessionVisibility,
  type Database,
  type ForkSessionContentResult,
  type TransitionSessionVisibilityResult,
} from "@opengeni/db";
import { publishDurableSessionEvents, type EventBus } from "@opengeni/events";
import {
  privacyDeploymentLimits,
  requireDeploymentAllowsOnlyMe,
  resolveOrganizationPrivacy,
} from "./organization-privacy";
import {
  requirePermission,
  hasVerifiedOwningUserAuthorization,
  type AccessGrantAuthorization,
} from "../access";
import { requireSessionAuthorization } from "../session-authorization";
import type { AppDependencies } from "../dependencies";
import { variableSetsRemovedError } from "../domain/encryption-key";
import { externalContinuationCommitAuthorizer } from "./external-continuation";

type SessionTenancyDependencies = Pick<
  AppDependencies,
  "db" | "bus" | "sessionAuthorization" | "settings"
>;

type SessionVisibilityDependencies = SessionTenancyDependencies & {
  workflowClient: Pick<AppDependencies["workflowClient"], "wakeSessionWorkflow">;
};

/**
 * How long one "make private anyway" request waits for a worker to settle the
 * response it is executing. Past it the request answers `stopping_active_work`
 * and the same idempotency key finishes the change on retry.
 */
const STOP_WORK_SETTLE_TIMEOUT_MS = 15_000;
const STOP_WORK_POLL_INTERVAL_MS = 400;

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

export function requireCanonicalManagedHuman(
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

export function requireVerifiedOwningUser(
  authorization: AccessGrantAuthorization,
  workspaceId: string,
): void {
  if (
    !hasVerifiedOwningUserAuthorization(authorization) ||
    authorization.grant.workspaceId !== workspaceId
  ) {
    throw new SessionTenancyManagedHumanRequiredError();
  }
}

export async function getManagedHumanSessionCreateCapabilities(
  deps: Pick<SessionTenancyDependencies, "db" | "settings">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
): Promise<SessionTenancyCreateCapabilities> {
  requirePermission(authorization.grant, "sessions:create");
  try {
    requireVerifiedOwningUser(authorization, workspaceId);
  } catch (error) {
    if (error instanceof SessionTenancyManagedHumanRequiredError) {
      return SessionTenancyCreateCapabilities.parse({
        activated: false,
        canCreatePrivate: false,
        reason: "managed_session_required",
      });
    }
    throw error;
  }
  // Mirror the database create fence exactly: every organization is
  // session-tenancy activated (migration 0611), so a member's own Personal
  // workspace is always private-capable, while a shared organization workspace
  // additionally needs the owner/admin Only-me product setting.
  let activated = false;
  let sharedWorkspace = false;
  try {
    const policy = await getPrivateSessionCreatePolicy(deps.db, {
      workspaceId,
      actorSubjectId: authorization.grant.subjectId,
    });
    sharedWorkspace = !policy.personalWorkspace;
    // A deployment that turns Only me off narrows every shared workspace.
    activated = policy.personalWorkspace
      ? policy.platformAvailable
      : policy.organizationEnabled && privacyDeploymentLimits(deps.settings).onlyMeAllowed;
  } catch (error) {
    // A canonical managed human without an active organization membership or
    // stated workspace authority (legacy managed access) is simply not
    // private-ready; the definer's 42501 is a capability answer here, not a
    // failure. Every other error still propagates.
    if (
      !(error instanceof SessionTenancyAccessError) &&
      nestedPostgresSqlState(error) !== "42501"
    ) {
      throw error;
    }
  }
  // The organization's default audience applies to shared workspaces where
  // Only me is available; a Personal workspace has nobody else to share with.
  const defaultVisibility =
    activated && sharedWorkspace
      ? (await resolveOrganizationPrivacy(deps, authorization.grant.accountId)).defaultVisibility
      : "workspace";
  return SessionTenancyCreateCapabilities.parse({
    activated,
    canCreatePrivate: activated,
    reason: activated ? "available" : "not_activated",
    defaultVisibility,
  });
}

export async function requireManagedHumanPrivateSessionCreate(
  deps: Pick<SessionTenancyDependencies, "db" | "settings">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
): Promise<void> {
  // Target-free readiness preflight only. The owner/admin organization setting
  // is enforced by the create transaction itself (under the organization
  // fence, after keyed replay resolution), so a committed keyed success still
  // replays after the setting is disabled while a fresh key fails closed.
  await requireSessionTenancyMutationGate(deps, authorization, workspaceId, ["sessions:create"]);
  await requireDeploymentAllowsOnlyMe(deps, {
    workspaceId,
    actorSubjectId: authorization.grant.subjectId,
  });
}

async function requireSessionTenancyMutationGate(
  deps: Pick<SessionTenancyDependencies, "db">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  permissions: ReadonlyArray<"sessions:read" | "sessions:create" | "sessions:control">,
): Promise<void> {
  // These checks are deliberately target-free. A rejected principal must not
  // cause a session lookup or embedding-host callback that distinguishes a
  // missing, shared, or another owner's private session.
  requireVerifiedOwningUser(authorization, workspaceId);
  for (const permission of permissions) requirePermission(authorization.grant, permission);
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

async function projectAndPublishSessionFork(
  deps: SessionTenancyDependencies,
  actorSubjectId: string,
  result: ForkSessionContentResult,
): Promise<ForkSessionResponse> {
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
    workspaceId: response.workspaceId,
    sessionId: response.sessionId,
    subjectId: actorSubjectId,
    eventId: response.eventId,
    eventSequence: response.eventSequence,
  });
  return response;
}

export async function updateManagedHumanSessionVisibility(
  deps: SessionVisibilityDependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  sessionId: string,
  request: UpdateSessionVisibilityRequest,
  authorizationSurface: SessionAuthorizationSurface = "core",
): Promise<UpdateSessionVisibilityResponse> {
  const beforeCommit = externalContinuationCommitAuthorizer(authorization);
  await requireSessionTenancyMutationGate(deps, authorization, workspaceId, ["sessions:control"]);
  await requireSessionAuthorization(deps, authorization.grant, {
    sessionId,
    operation: "session.visibility.write",
    surface: authorizationSurface,
  });
  if (request.visibility === "private") {
    await requireDeploymentAllowsOnlyMe(deps, {
      workspaceId,
      actorSubjectId: authorization.grant.subjectId,
    });
  }

  const actorSubjectId = authorization.grant.subjectId;
  const transition = async () =>
    await runTenancyMutation(
      async () =>
        await transitionSessionVisibility(deps.db, {
          workspaceId,
          sessionId,
          actorSubjectId,
          targetVisibility: sessionVisibilityFromPublic(request.visibility),
          expectedAuthorityEpoch: request.expectedAuthorityEpoch,
          operationKey: request.idempotencyKey,
          ...(request.stopActiveWork === true ? { stopActiveWork: true } : {}),
          ...(beforeCommit ? { beforeCommit } : {}),
        }),
    );
  let result: TransitionSessionVisibilityResult;
  try {
    result = await transition();
  } catch (error) {
    if (
      !(error instanceof SessionVisibilityWorkConflictError) ||
      request.stopActiveWork !== true ||
      error.liveAttemptCount === 0
    ) {
      throw error;
    }
    // A worker is executing a response. Stopping it is asynchronous: durably
    // interrupt it (and cancel everything queued or parked) first, let the
    // worker cancel the turn, then make the same transition.
    await stopLiveSessionWorkForVisibilityChange(deps, {
      workspaceId,
      sessionId,
      actorSubjectId,
      expectedAuthorityEpoch: request.expectedAuthorityEpoch,
      operationKey: `${request.idempotencyKey}:stop-work`,
    });
    result = await transitionAfterLiveWorkSettles(deps, {
      workspaceId,
      sessionId,
      actorSubjectId,
      transition,
      conflict: error,
    });
  }
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
  await publishCommittedEventIds(deps, {
    workspaceId,
    sessionId,
    subjectId: actorSubjectId,
    eventIds: result.settledEventIds,
  });
  await publishExactCommittedEvent(deps, {
    workspaceId,
    sessionId,
    subjectId: actorSubjectId,
    eventId: response.eventId,
    eventSequence: response.eventSequence,
  });
  await wakeSessionWorkflowAfterVisibilityWork(deps, result.workflowWake);
  return response;
}

/**
 * Owner-only preview for the audience dialog: what a change to `visibility`
 * would stop, and what would still refuse it. Same gates as the change itself,
 * so a non-owner learns nothing a refused change would not tell them.
 */
export async function previewManagedHumanSessionVisibilityChange(
  deps: SessionTenancyDependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  sessionId: string,
  targetVisibility: SessionVisibility,
  authorizationSurface: SessionAuthorizationSurface = "core",
): Promise<SessionVisibilityChangePreview> {
  await requireSessionTenancyMutationGate(deps, authorization, workspaceId, ["sessions:control"]);
  await requireSessionAuthorization(deps, authorization.grant, {
    sessionId,
    operation: "session.visibility.write",
    surface: authorizationSurface,
  });
  const preview = await inspectSessionVisibilityChange(deps.db, {
    workspaceId,
    sessionId,
    actorSubjectId: authorization.grant.subjectId,
  });
  const current = sessionVisibilityToPublic(preview.visibility);
  // Only a change to Only me stops work or meets owner-only blocks; sharing a
  // private chat with the workspace never needs either.
  const changesToPrivate = targetVisibility === "private" && current !== "private";
  return SessionVisibilityChangePreview.parse({
    visibility: current,
    targetVisibility,
    authorityEpoch: preview.authorityEpoch,
    work: changesToPrivate
      ? preview.work
      : { runningTurnCount: 0, queuedTurnCount: 0, activeGoal: false },
    blocker: changesToPrivate ? preview.blocker : null,
  });
}

async function stopLiveSessionWorkForVisibilityChange(
  deps: SessionVisibilityDependencies,
  input: Parameters<typeof stopSessionWorkForVisibilityChange>[1],
): Promise<void> {
  const stopped = await runTenancyMutation(
    async () => await stopSessionWorkForVisibilityChange(deps.db, input),
  );
  await publishCommittedEventIds(deps, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    subjectId: input.actorSubjectId,
    eventIds: stopped.eventIds,
  });
  await wakeSessionWorkflowAfterVisibilityWork(deps, stopped.workflowWake);
}

async function transitionAfterLiveWorkSettles(
  deps: SessionVisibilityDependencies,
  input: {
    workspaceId: string;
    sessionId: string;
    actorSubjectId: string;
    transition: () => Promise<TransitionSessionVisibilityResult>;
    conflict: SessionVisibilityWorkConflictError;
  },
): Promise<TransitionSessionVisibilityResult> {
  const deadline = Date.now() + STOP_WORK_SETTLE_TIMEOUT_MS;
  for (;;) {
    const live = await sessionHasLiveAttempts(deps.db, input);
    if (!live) {
      try {
        return await input.transition();
      } catch (error) {
        // A worker claimed a new attempt between the read and the transition.
        if (!(error instanceof SessionVisibilityWorkConflictError) || error.liveAttemptCount === 0)
          throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new SessionVisibilityWorkConflictError(
        "stopping_active_work",
        input.conflict.work,
        input.conflict.liveAttemptCount,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, STOP_WORK_POLL_INTERVAL_MS));
  }
}

async function publishCommittedEventIds(
  deps: { db: Database; bus: EventBus },
  input: { workspaceId: string; sessionId: string; subjectId: string; eventIds: string[] },
): Promise<void> {
  for (const eventId of input.eventIds) {
    try {
      const event = await getSessionEventForSubject(
        deps.db,
        input.workspaceId,
        input.subjectId,
        eventId,
      );
      if (!event || event.sessionId !== input.sessionId) continue;
      await publishDurableSessionEvents(deps.bus, input.workspaceId, input.sessionId, [event]);
    } catch {
      // Committed; live fanout is repairable from the durable stream.
      console.warn("[session-tenancy] settled event live publication was deferred to replay", {
        errorClass: "SessionTenancyEventPublishOperationError",
        errorCode: "session_tenancy_event_publish_deferred",
        origin: "core",
        sessionId: input.sessionId,
      });
    }
  }
}

async function wakeSessionWorkflowAfterVisibilityWork(
  deps: SessionVisibilityDependencies,
  wake: TransitionSessionVisibilityResult["workflowWake"],
): Promise<void> {
  if (!wake) return;
  try {
    await deps.workflowClient.wakeSessionWorkflow({
      accountId: wake.accountId,
      workspaceId: wake.workspaceId,
      sessionId: wake.sessionId,
      workflowId: wake.temporalWorkflowId,
      wakeRevision: wake.wakeRevision,
      interruptionRequested: true,
    });
  } catch {
    // The wake revision committed with the change; the durable outbox retries.
    console.warn("[session-tenancy] immediate workflow wake failed; durable outbox will retry", {
      errorClass: "WorkflowWakeOperationError",
      errorCode: "session_tenancy_wake_failed",
      origin: "core",
    });
  }
}

export async function forkManagedHumanSession(
  deps: SessionTenancyDependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  sourceSessionId: string,
  request: ForkSessionRequest,
  authorizationSurface: SessionAuthorizationSurface = "core",
): Promise<ForkSessionResponse> {
  await requireSessionTenancyMutationGate(deps, authorization, workspaceId, [
    "sessions:read",
    "sessions:create",
  ]);
  if (request.visibility === "private") {
    await requireDeploymentAllowsOnlyMe(deps, {
      workspaceId,
      actorSubjectId: authorization.grant.subjectId,
    });
  }
  const beforeCommit = externalContinuationCommitAuthorizer(authorization);
  const forkInput = {
    sourceWorkspaceId: workspaceId,
    sourceSessionId,
    ...(request.sourceEventId ? { sourceEventId: request.sourceEventId } : {}),
    actorSubjectId: authorization.grant.subjectId,
    destinationWorkspaceId: workspaceId,
    destinationVisibility:
      request.visibility === "private" ? ("user_private" as const) : ("workspace_shared" as const),
    workspaceSharedAcknowledged: request.workspaceSharedAcknowledged,
    operationKey: request.idempotencyKey,
    ...(beforeCommit ? { beforeCommit } : {}),
    ...(request.rigId !== undefined || request.variableSetIds !== undefined
      ? {
          runtimeRequest: {
            rigId: request.rigId ?? null,
            variableSetIds: request.variableSetIds ?? [],
          },
        }
      : {}),
  };
  const recoverAppliedReceipt = async () =>
    await runTenancyMutation(async () => await replayAppliedSessionFork(deps.db, forkInput));
  const runtimeSetupRequested = request.rigId !== undefined || request.variableSetIds !== undefined;
  let runtimeConfigurationPromise: Promise<{
    variableSetIds: string[];
    rigId: string | null;
    rigVersionId: string | null;
  }> | null = null;
  const resolveRuntimeConfiguration = async () => {
    if (runtimeConfigurationPromise) return await runtimeConfigurationPromise;
    runtimeConfigurationPromise = (async () => {
      // Variable Sets were replaced by vaults (RM-1).
      if (request.variableSetIds?.length) throw variableSetsRemovedError("variableSetIds");
      const variableSets: VariableSet[] = [];
      let rigVersionId: string | null = null;
      if (request.rigId) {
        requirePermission(authorization.grant, "rigs:use");
        const rig = await getRig(deps.db, authorization.grant, request.rigId);
        if (!rig?.activeVersion) {
          throw new SessionTenancyInvalidRequestError();
        }
        rigVersionId = rig.activeVersion.id;
      }
      return {
        variableSetIds: variableSets.map((variableSet) => variableSet.id),
        rigId: request.rigId ?? null,
        rigVersionId,
      };
    })();
    return await runtimeConfigurationPromise;
  };
  const publishRuntimeConfiguration = async (result: ForkSessionContentResult) => {
    if (!result.runtimeEventId || !result.runtimeEventSequence) return;
    await publishExactCommittedEvent(deps, {
      workspaceId,
      sessionId: result.sessionId,
      subjectId: authorization.grant.subjectId,
      eventId: result.runtimeEventId,
      eventSequence: result.runtimeEventSequence,
    });
  };

  // A committed response is owned by the exact actor/key/request tuple and no
  // longer depends on mutable source visibility. Resolve it before source/host
  // authorization so a lost response remains recoverable after the source
  // owner makes a formerly shared session private.
  const applied = await recoverAppliedReceipt();
  if (applied) {
    const response = await projectAndPublishSessionFork(
      deps,
      authorization.grant.subjectId,
      applied,
    );
    await publishRuntimeConfiguration(applied);
    return response;
  }

  try {
    await requireSessionAuthorization(deps, authorization.grant, {
      sessionId: sourceSessionId,
      operation: "session.fork.create",
      surface: authorizationSurface,
    });
  } catch (authorizationError) {
    // Close the race where a duplicate request checked before the first commit
    // but mutable source/host authority changed immediately after it. Only an
    // exact applied receipt can convert the authorization failure into replay.
    const racedApplied = await recoverAppliedReceipt();
    if (racedApplied) {
      const response = await projectAndPublishSessionFork(
        deps,
        authorization.grant.subjectId,
        racedApplied,
      );
      await publishRuntimeConfiguration(racedApplied);
      return response;
    }
    throw authorizationError;
  }

  // Validate all requested runtime resources before committing the independent
  // fork so ordinary authorization failures cannot leave an unusable copy.
  const source = await getSessionForSubject(
    deps.db,
    workspaceId,
    sourceSessionId,
    authorization.grant.subjectId,
  );
  if (source) assertSessionIsNotImported(source);
  const runtimeConfiguration = runtimeSetupRequested ? await resolveRuntimeConfiguration() : null;
  const result = await runTenancyMutation(
    async () =>
      await forkSessionContent(deps.db, {
        ...forkInput,
        ...(runtimeConfiguration ? { runtimeConfiguration } : {}),
      }),
  );
  const response = await projectAndPublishSessionFork(deps, authorization.grant.subjectId, result);
  await publishRuntimeConfiguration(result);
  return response;
}
