import { attachedBrowserViewer } from "../attached-browser-viewer";
import {
  assertEphemeralBrowserCreateEnabled,
  ephemeralBrowserPartition,
} from "../browser-ephemeral";
import { createHash, randomUUID } from "node:crypto";
import {
  environmentsEncryptionKeyBytes,
  resolveFirstPartyDelegationSecret,
  resolveStreamTokenSecret,
  sandboxWarmRateMicrosPerSecond,
} from "@opengeni/config";
import {
  BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX,
  EPHEMERAL_CHROMIUM_DRIVER_ID,
  browserSessionStorageMode,
  BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
  BROWSER_CONTROL_PORT,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_PROFILE_ARTIFACT_FORMAT,
  BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
  AttachedBrowserDevice,
  AttachedBrowserDeviceListResponse,
  BrowserActionCommand,
  browserActionSecretTexts,
  BrowserActionRequest,
  BrowserDiagnosticKind,
  BrowserDownload,
  BrowserDownloadSaveRequest,
  BrowserDownloadSaveResponse,
  BrowserRecordingSaveProgress,
  BrowserRecordingSaveRequest,
  BrowserRecordingSaveResponse,
  BrowserRecordingStartRequest,
  BrowserRecordingSummary,
  type RecordingVisibility,
  BrowserDownloadListResponse,
  BrowserDomReadRequest,
  BrowserDomReadResponse,
  BrowserExternalAuthCommand,
  BrowserOpenTargetRequest,
  BrowserObservation,
  BrowserSessionAttachment,
  BrowserSessionAttachmentRequest,
  BrowserSessionHeartbeatResponse,
  BrowserSessionLifecycleRequest,
  BrowserSessionListResponse,
  BrowserSessionMutationResponse,
  type BrowserTarget,
  BrowserTargetListResponse,
  BrowserTargetState,
  BrowserWorkingCopyAdoptionRequest,
  BrowserWorkingCopyAdoptionResponse,
  BrowserWorkingCopyInspection,
  CreateBrowserSessionRequest,
  ExternalAuthInteractiveRequest,
  ExternalAuthInteractiveResponse,
  ExternalAuthRunRequest,
  ExternalAuthRunResponse,
  InteractionActor,
  ReportAuthRunRequest,
  StartAuthRunRequest,
  VerifyAuthRunRequest,
  PublishBrowserRevisionRequest,
  PublishBrowserRevisionResponse,
  type AccessGrant,
  type BrowserActionRequest as BrowserActionRequestValue,
  type BrowserDownload as BrowserDownloadValue,
  type BrowserSession as BrowserSessionValue,
  type BrowserWorkingCopyAdoption as BrowserWorkingCopyAdoptionValue,
  type BrowserWorkingCopyRefusal as BrowserWorkingCopyRefusalValue,
  type FileAsset,
  type CreateBrowserSessionRequest as CreateBrowserSessionRequestValue,
  type InteractionPlacement,
  type InteractionCredentialAuthorityRef,
  type BrowserRevisionMaterialization as BrowserRevisionMaterializationValue,
  type Session,
  type SessionAuthorizationOperation,
} from "@opengeni/contracts";
import {
  getSessionAuthorityEpoch,
  acquireLease,
  activateBrowserSession,
  ATTACHED_BROWSER_SESSION_CAPABILITIES,
  EXTERNAL_BROWSER_SESSION_CAPABILITIES,
  LIGHTPANDA_BROWSER_SESSION_CAPABILITIES,
  bindBrowserSessionNetworkRouteAuthority,
  AttachedBrowserDeviceNotFoundError,
  BrowserIdentityConflictError,
  BrowserIdentityNotFoundError,
  BrowserIdentityStateError,
  BrowserStateUploadStateError,
  clearSuspendedBrowserSessionController,
  BrowserSessionNotFoundError,
  BrowserSessionOperationConflictError,
  BrowserSessionStateError,
  SandboxPaidComputeAdmissionError,
  completeBrowserSessionEnd,
  completeExternalAuth,
  completeBrowserDownloadSave,
  completeFileUpload,
  commitBrowserSessionSuspension,
  commitBrowserRevisionPublication,
  dispatchBrowserRevisionPublication,
  dispatchBrowserDownloadSave,
  dispatchBrowserSessionOperation,
  dispatchExternalAuth,
  failBrowserSessionOperation,
  failPreparedBrowserSessionEnd,
  failPreparedBrowserSessionSuspend,
  failBrowserSessionResume,
  failBrowserSessionResumePreparation,
  getExpiredBrowserSessionResume,
  failBrowserSessionSuspension,
  failBrowserRevisionPublication,
  findBrowserSessionControlRecordByOperation,
  findBrowserDownloadSave,
  getBrowserDownloadPrivateOwner,
  getBrowserSessionControlRecord,
  getRetainedBrowserDownload,
  listRetainedBrowserDownloads,
  getComputerSessionControlRecord,
  getBrowserIdentity,
  getBrowserPrivateCheckpointAuthority,
  getAttachedBrowserDevice,
  getBrowserRevisionArtifactAuthority,
  getLiveEnrollmentConnection,
  getExternalAuthInteractiveContext,
  getFilesForSubject,
  getFileUpload,
  getAuthRun,
  getExternalAuthPreparation,
  getSession,
  getSessionAuthorityProjection,
  browserRecordingBundleObjectKey,
  findBrowserRecording,
  getBrowserRecordingVideo,
  InteractionResourceConflictError,
  InteractionResourceNotFoundError,
  InteractionResourceStateError,
  listAuthRuns,
  listBrowserCapacitySuspendCandidates,
  BrowserCapacitySuspendClaimRejectedError,
  type BrowserCapacitySuspendClaim,
  listBrowserSessions,
  listAttachedBrowserDevices,
  interactionControllerGone,
  prepareBrowserSessionCreate,
  markEphemeralBrowserSessionLost,
  prepareExternalAuth,
  prepareBrowserDownloadSave,
  prepareBrowserSessionEnd,
  prepareBrowserSessionResume,
  settleExpiredBrowserSessionResume,
  continueExpiredBrowserSessionResume,
  prepareBrowserSessionSuspend,
  prepareBrowserRevisionPublication,
  reportAuthRun,
  releaseLeaseHolder,
  readLease,
  recordLeaseControllerDataPlaneUrl,
  loadConnectionCredentialForBroker,
  startAuthRun,
  touchBrowserSessionController,
  verifyAuthRun,
  settleBrowserDownloadSaveFailure,
  readActiveSandbox,
  terminalizeStaleConnectedInteractionPlacement,
  recordAuditEvent,
  type BrowserSessionControlRecord,
  type BrowserPrivateCheckpointAuthority,
  type BrowserRevisionArtifactAuthority,
  type LeaseSnapshot,
} from "@opengeni/db";
import {
  requireAccessGrant,
  requireSessionAuthorization,
  withSessionAuthorizationReadReuse,
  recordWorkspaceUsage,
  requireLimit,
  relayConfigFromSettings,
  resolveSessionSandboxRuntime,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  type ApiRouteDeps,
  type ResolvedSessionAuthorization,
  retainCompletedBrowserDownloads,
  withBrowserDownloadFileOwner,
} from "@opengeni/core";
import {
  BrowserControlProtocolError,
  BrowserControlClient,
  BrowserControlRequestError,
  BrowserControlServerError,
  BrowserControlServerUnsupportedError,
  BrowserControlTransportError,
  BrowserControlUnsupportedError,
  buildStreamUrl,
  exposedPortEndpointFromUrl,
  buildSelfhostedBackendSession,
  ensureDisplayStack,
  mintStreamToken,
  NatsControlRpc,
  NatsOpStreamTransport,
  provisionBrowserControlClient,
  renewSandboxProviderExpiration,
  type BrowserControlPlacementSession,
  type BrowserControlScreenshotOptions,
  type BrowserControlFrame,
  type PlacementBrowserStateCaptureReceipt,
  type PlacementBrowserWorkingCopyAdoption,
  type PlacementBrowserWorkingCopyAuthority,
  type PlacementBrowserWorkingCopyInspection,
  type PlacementBrowserNetworkRoute,
  type PlacementBrowserTransport,
  type RestorePlacementBrowserStateInput,
} from "@opengeni/runtime/sandbox";
import { retryWhileMissing } from "@opengeni/storage";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  deriveBrowserControllerAdminToken,
  deriveBrowserNetworkRouteAuthorityDigest,
  deriveBrowserSessionControllerTokens,
  deriveBrowserViewGrantToken,
  deriveComputerSessionControllerTokens,
} from "../browser-controller-authority";
import {
  controllerCacheAllowsHostFetch,
  controllerCachedUrlIsUsable,
  controllerHasCacheableDataPlane,
  shouldPersistControllerDataPlaneUrl,
  isRetryableControllerTransport,
  withCachedController,
  withControllerTransportRecovery,
} from "../controller-data-plane";
import {
  filterInteractionSessionsForGrant,
  parseInteractionSessionListQuery,
} from "../interaction-agent-access";
import { withInteractionHolderHeartbeat } from "../interaction-holder-heartbeat";
import {
  browserStateArtifactAad,
  browserStateManifestDigest,
  browserStateObjectKey,
  deriveBrowserStateDataKey,
  unwrapBrowserStateDataKey,
  wrapBrowserStateDataKey,
} from "../browser-state-authority";
import { managedNetworkRouteForPlacement } from "../browser-network-route";
import {
  endBrowserDiscardingLostRuntime,
  endExpiredResumeSettingAsideInterruptedLaunch,
} from "../browser-lost-runtime-end";
import { resolveBrowserActionFences, type BrowserActionFences } from "../browser-action-fences";
import { InteractionRouteStages, reportInteractionRouteStages } from "../interaction-route-stages";
import { validateInteractionRequestOrigin } from "../http/cors";
import { ApiHttpError } from "../http/api-error";
import {
  interactionControlApiError,
  legacyInteractionCapacityError,
  legacyInteractionCapacityFailure,
} from "../http/interaction-control-error";
import {
  createInteractionFrameProxyAttachment,
  placementUsesInteractionFrameProxy,
} from "../interaction-frame-proxy";
import {
  observeAuthMutation,
  observeBrowserActionResult,
  observeBrowserRevisionPublication,
  observeLifecycleResult,
} from "../interaction-metrics";
import { withChannelA, withChannelARead, type ChannelAOperation } from "../sandbox/channel-a";
import { publishSandboxFileArtifact } from "../sandbox-file-artifacts";
import {
  BROWSER_RECORDING_SAVE_RETRY_AFTER_MS,
  browserRecordingFailureStatus,
  browserRecordingOwner,
  stageBrowserRecordingBundle,
} from "../browser-recording-save";
import {
  recordSourcePlacementMove,
  retireFormerPlacementControllers,
  retireSourceFormerPlacements,
} from "../former-placement-retirement";
import { sanitizeFilename } from "./files";
import { USER_CONTENT_SECURITY_HEADERS } from "../http/user-content";
import {
  wrongInteractionPlacementMessage,
  wrongPlacementInsteadOfOffline,
} from "./interaction-placement-message";
import {
  releaseBrowserPasskeys,
  resolveInteractionSecretValues,
  syncBrowserPasskeys,
  type InteractionSecretsPort,
} from "../interaction-secrets";
import { requirePlacementAcceptsSecretValues } from "../interaction-agent-version";

const BROWSER_DRIVER_ID = "opengeni.cdp.v1";
const LIGHTPANDA_DRIVER_ID = "opengeni.lightpanda.cdp.v1";
const EXTERNAL_BROWSER_DRIVER_ID = "opengeni.external.cdp.v1";
const BROWSER_WORKSPACE_FILE_AUTHORITY_TTL_SECONDS = 20 * 60;
const BROWSER_STATE_UPLOAD_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1_000;

type BrowserPlacement = {
  placement: InteractionPlacement;
  controllerHostSandboxGroupId: string | null;
  placementInstanceId: string;
  session: BrowserControlPlacementSession;
  lease: LeaseSnapshot | null;
  transport: PlacementBrowserTransport;
  /** Where an attached device's Chrome profile is stored: its machine's
   *  enrollment workspace, which can be another workspace. */
  attachedDeviceWorkspaceId?: string;
};

export function registerBrowserSessionRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: { interactionSecrets?: InteractionSecretsPort | null } = {},
): void {
  const interactionSecrets = options.interactionSecrets ?? null;
  const channelServices = {
    db: deps.db,
    settings: deps.settings,
    bus: deps.bus,
    observability: deps.observability,
  };

  app.get("/v1/workspaces/:workspaceId/attached-browsers", async (context) => {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:read");
    const includeDisconnected = context.req.query("includeDisconnected") === "true";
    return context.json(
      AttachedBrowserDeviceListResponse.parse(
        await listAttachedBrowserDevices(deps.db, {
          ...(await attachedBrowserViewer(deps, grant, workspaceId)),
          includeDisconnected,
        }),
      ),
    );
  });

  app.get("/v1/workspaces/:workspaceId/attached-browsers/:deviceId", async (context) => {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:read");
    const deviceId = requireUuidParam(context, "deviceId");
    try {
      return context.json(
        AttachedBrowserDevice.parse(
          await getAttachedBrowserDevice(deps.db, {
            ...(await attachedBrowserViewer(deps, grant, workspaceId)),
            deviceId,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof AttachedBrowserDeviceNotFoundError) {
        throw new HTTPException(404, { message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/browser-sessions", async (context) => {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:read");
    const listed = await listBrowserSessions(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      ...parseInteractionSessionListQuery(context.req.query()),
    });
    return context.json(
      BrowserSessionListResponse.parse({
        ...listed,
        sessions: await filterInteractionSessionsForGrant(deps, grant, listed.sessions),
      }),
    );
  });

  app.get("/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:read");
    const browserSessionId = requireUuidParam(context, "browserSessionId");
    try {
      const record = await getBrowserSessionControlRecord(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        browserSessionId,
      });
      await authorizeSourceSession(deps, grant, record.sourceSessionId, "session.read");
      return context.json(record.session);
    } catch (error) {
      throw browserRouteError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/browser-sessions", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:control");
    const request = await parseJsonBody(context, CreateBrowserSessionRequest);
    const startedAtMs = performance.now();
    const stages = new InteractionRouteStages("create");
    // The replay lookup and the source session are read alongside the
    // authorization check. A denial still wins, and neither read is used
    // until the request is authorized; each failure surfaces where it did.
    const [authorized, existingRead, sourceRead] = await Promise.allSettled([
      authorizeSourceSession(deps, grant, request.sessionId, "session.control"),
      findBrowserSessionControlRecordByOperation(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        operationId: request.operationId,
      }),
      requireSourceSession(deps, workspaceId, request.sessionId),
    ]);
    if (authorized.status === "rejected") throw authorized.reason;
    stages.mark("authorize");
    const origin = requestOrigin(context, deps.settings);
    const authority = browserAuthorityRoot(deps);
    let prepared: Awaited<ReturnType<typeof prepareBrowserSessionCreate>> | null = null;
    // What the controller showed when it launched this browser, returned so
    // the caller can present the opened tab without two more reads.
    const launch: { result: Awaited<ReturnType<BrowserControlClient["createSession"]>> | null } = {
      result: null,
    };

    try {
      assertEphemeralBrowserCreateEnabled(
        request,
        deps.settings.experimentalBrowserContextPoolEnabled,
      );
      if (existingRead.status === "rejected") throw existingRead.reason;
      const existing = existingRead.value;
      if (existing && existing.sourceSessionId !== request.sessionId) {
        throw new BrowserSessionOperationConflictError(
          "BrowserSession create operation belongs to another source session",
        );
      }
      if (existing) assertCreateReplay(request, existing.session);
      stages.mark("replay_check");
      prepared = existing
        ? await prepareBrowserSessionCreate(
            deps.db,
            browserCreateInput(grant, workspaceId, request, existing.session.placement),
          )
        : null;
      if (prepared && isTerminalOperation(prepared.operation.state)) {
        const parsed = BrowserSessionMutationResponse.parse(prepared);
        observeLifecycleResult(deps.observability, startedAtMs, parsed);
        return context.json(parsed, 200);
      }

      // Reject an unavailable explicit identity before acquiring or waking the
      // browser placement. prepareBrowserSessionCreate repeats this check in its
      // transaction, so an archive racing this preflight is still fenced.
      if (!existing && request.identityId) {
        const identity = await getBrowserIdentity(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          identityId: request.identityId,
        });
        if (identity.status !== "active") {
          throw new BrowserIdentityStateError("BrowserIdentity is archived");
        }
      }

      if (sourceRead.status === "rejected") throw sourceRead.reason;
      const sourceSession = sourceRead.value;
      stages.mark("source_session");
      // A full controller makes room once by saving its least recently used
      // idle browser; the create then runs again under the same operation.
      let capacitySuspendAllowed = true;
      const createOnPlacement = async () =>
        await withBrowserPlacement(
          sourceSession,
          grant,
          existing?.session.placement ?? request.placement ?? null,
          existing?.deviceWorkspaceId ?? null,
          existing?.session.controller?.placementInstanceId ?? null,
          "browser.create",
          context.req.raw.signal,
          async (placement) => {
            stages.mark("placement_resolve");
            let revisionAuthority: BrowserRevisionArtifactAuthority | null = null;
            if (!prepared) {
              prepared = await prepareBrowserSessionCreate(
                deps.db,
                browserCreateInput(
                  grant,
                  workspaceId,
                  request,
                  placement.placement,
                  placement.attachedDeviceWorkspaceId,
                ),
              );
            }
            stages.mark("prepare");
            if (isTerminalOperation(prepared.operation.state)) return prepared;

            if (prepared.session.baseRevisionId && !revisionAuthority) {
              if (!prepared.session.identityId) {
                throw new BrowserIdentityStateError("BrowserSession base revision has no identity");
              }
              revisionAuthority = await getBrowserRevisionArtifactAuthority(deps.db, {
                accountId: grant.accountId,
                workspaceId,
                identityId: prepared.session.identityId,
                revisionId: prepared.session.baseRevisionId,
              });
            }
            const restore = await prepareBrowserStateRestore(
              deps,
              grant,
              prepared.session,
              placement.placement,
              revisionAuthority,
            );
            stages.mark("restore");

            try {
              const networkRoute = await resolveBrowserNetworkRouteLaunch({
                deps,
                grant,
                workspaceId,
                browserSessionId: prepared.session.id,
                operationId: request.operationId,
                rootSecret: authority,
                placement: placement.placement,
              });
              stages.mark("network_route");
              const interactionHeld = await ensureInteractionHolder(
                deps,
                grant,
                sourceSession,
                prepared.session.id,
                placement,
                context.req.raw.signal,
              );
              stages.mark("holder");
              const record = await ensureDispatchedGeneration(
                deps,
                grant,
                workspaceId,
                prepared.session.id,
                request.operationId,
                placement.placementInstanceId,
              ).catch(async (error: unknown) => {
                if (interactionHeld) {
                  await releaseInteractionHolder(
                    deps,
                    grant,
                    workspaceId,
                    prepared!.session.id,
                    placement.controllerHostSandboxGroupId,
                  ).catch(() => undefined);
                }
                throw error;
              });
              stages.mark("generation");
              const preparedSession = prepared.session;
              const controllerGeneration = requireOperationGeneration(record);
              const adminToken = deriveBrowserControllerAdminToken({
                rootSecret: authority,
                accountId: grant.accountId,
                workspaceId,
                placement: placement.placement,
                placementInstanceId: placement.placementInstanceId,
              });
              const tokens = deriveBrowserSessionControllerTokens({
                rootSecret: authority,
                accountId: grant.accountId,
                workspaceId,
                browserSessionId: prepared.session.id,
                placement: placement.placement,
                placementInstanceId: placement.placementInstanceId,
                controllerGeneration,
                tokenGeneration: record.tokenGeneration,
              });
              try {
                // The heartbeat covers everything after dispatch, including
                // provisioning the controller, so a slow machine never lets the
                // transition expire while this request is still working on it.
                await withInteractionHolderHeartbeat(
                  deps,
                  {
                    grant,
                    workspaceId,
                    sandboxGroupId: placement.controllerHostSandboxGroupId,
                    holderId: interactionHolderId(preparedSession.id),
                    operationId: request.operationId,
                    resourceId: preparedSession.id,
                    controllerGeneration,
                  },
                  async () =>
                    await withBrowserCreationController(
                      deps,
                      grant,
                      workspaceId,
                      placement,
                      adminToken,
                      origin,
                      async (client) => {
                        const linkedComputer = await ensureLinkedComputerController(
                          deps,
                          grant,
                          preparedSession,
                          placement,
                          client,
                        );
                        stages.mark("provision");
                        await ensureHeadedBrowserDisplayStack(
                          placement.session,
                          preparedSession.headless,
                          linkedComputer !== null,
                        );
                        stages.mark("display");
                        launch.result = await client.createSession({
                          browserSessionId: preparedSession.id,
                          controllerGeneration,
                          tokenGeneration: record.tokenGeneration,
                          ...tokens,
                          headed: !preparedSession.headless,
                          transport: browserRuntimeTransport(
                            preparedSession,
                            placement.transport,
                            placement.placementInstanceId,
                            authority,
                          ),
                          ...(linkedComputer ? { linkedComputer } : {}),
                          ...(networkRoute ? { networkRoute } : {}),
                          ...(request.initialUrl ? { initialUrl: request.initialUrl } : {}),
                          ...(restore ? { restore } : {}),
                        });
                        return launch.result;
                      },
                    ),
                );
                stages.mark("launch");
                await cacheBrowserControllerPlacement(grant, workspaceId, placement).catch(
                  () => placement,
                );
                stages.mark("placement_cache_write");
              } catch (error) {
                // A full supervisor from an older agent claims to be retryable,
                // but nothing frees capacity on its own: fail the create so it
                // does not sit in "starting" until the transition expires.
                if (
                  error instanceof BrowserControlTransportError ||
                  (error instanceof BrowserControlRequestError &&
                    error.retryable &&
                    !legacyInteractionCapacityError(error, "browser")) ||
                  isAbort(error)
                )
                  throw error;
                if (capacitySuspendAllowed && browserControllerCapacityExhausted(error)) {
                  capacitySuspendAllowed = false;
                  throw new BrowserControllerFull(
                    placement.placement,
                    placement.placementInstanceId,
                    {
                      operationId: request.operationId,
                      browserSessionId: preparedSession.id,
                      sandboxGroupId: placement.controllerHostSandboxGroupId,
                      controllerGeneration,
                    },
                  );
                }
                const failure = interactionFailure(error);
                const failed = await failBrowserSessionOperation(deps.db, {
                  accountId: grant.accountId,
                  workspaceId,
                  operationId: request.operationId,
                  browserSessionId: prepared.session.id,
                  ...(error instanceof BrowserControlProtocolError
                    ? { state: "outcome_unknown" as const }
                    : {}),
                  error: failure,
                });
                if (interactionHeld && !(error instanceof BrowserControlProtocolError)) {
                  await releaseInteractionHolder(
                    deps,
                    grant,
                    workspaceId,
                    prepared.session.id,
                    placement.controllerHostSandboxGroupId,
                  ).catch(() => undefined);
                }
                return failed;
              }
              // Once the controller has accepted the exact binding, a persistence
              // failure is retried against that same idempotent physical session.
              // Never terminalize or release its placement authority here.
              const activated = await activateBrowserSession(deps.db, {
                accountId: grant.accountId,
                workspaceId,
                operationId: request.operationId,
                browserSessionId: prepared.session.id,
                controller: {
                  controllerId: "opengeni-browserd",
                  controllerGeneration,
                  placementInstanceId: placement.placementInstanceId,
                },
                engineVersion: null,
              });
              stages.mark("activate");
              return activated;
            } finally {
              restore?.dataKey.fill(0);
              restore?.aad.fill(0);
            }
          },
        );
      let response: Awaited<ReturnType<typeof createOnPlacement>>;
      try {
        response = await createOnPlacement();
      } catch (error) {
        if (!(error instanceof BrowserControllerFull)) throw error;
        await suspendLeastRecentlyUsedBrowser(
          context,
          grant,
          workspaceId,
          sourceSession,
          error,
          prepared!.session.id,
        );
        response = await createOnPlacement();
      }
      const parsed = BrowserSessionMutationResponse.parse(withInitialView(response, launch.result));
      observeLifecycleResult(deps.observability, startedAtMs, parsed);
      reportInteractionRouteStages(context, deps.observability, stages);
      return context.json(
        parsed,
        parsed.operation.state === "completed" && !parsed.operation.replayed ? 201 : 200,
      );
    } catch (error) {
      if (prepared) {
        // The operation lock fences a concurrent dispatch. Once a controller
        // binding exists, retain its exact receipt for physical reconciliation.
        await failBrowserSessionOperation(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          operationId: request.operationId,
          browserSessionId: prepared.session.id,
          onlyIfPreparedCreate: true,
          error: interactionFailure(error),
        }).catch(() => undefined);
      }
      throw browserRouteError(error);
    }
  });

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient, binding }) =>
          BrowserTargetListResponse.parse({
            browserSessionId,
            controllerGeneration: binding.controllerGeneration,
            targets: await sessionClient.listTargets(),
          }),
      );
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      const request = await parseJsonBody(context, BrowserOpenTargetRequest);
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.control",
        async ({ sessionClient }) =>
          BrowserObservation.parse(await sessionClient.openTarget(request.url)),
      );
      return context.json(result, 201);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/open-with-inventory",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      const request = await parseJsonBody(context, BrowserOpenTargetRequest);
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.control",
        async ({ sessionClient }) =>
          BrowserTargetListResponse.parse(await sessionClient.openTargetWithInventory(request.url)),
      );
      return context.json(result, 201);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/select",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      await parseEmptyJsonBody(context);
      const targetId = requireOpaqueParam(context, "targetId");
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.control",
        async ({ sessionClient }) =>
          BrowserObservation.parse(await sessionClient.selectTarget(targetId)),
      );
      return context.json(result);
    },
  );

  app.delete(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      const targetId = requireOpaqueParam(context, "targetId");
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.control",
        async ({ sessionClient, binding }) =>
          BrowserTargetListResponse.parse({
            browserSessionId,
            controllerGeneration: binding.controllerGeneration,
            targets: await sessionClient.closeTarget(targetId),
          }),
      );
      return context.json(result);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/downloads",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const retained = await retainedDownloadsFor(grant, workspaceId, browserSessionId);
      if (retained.notRunning) {
        if (retained.downloads.length === 0) {
          throw new BrowserSessionStateError("BrowserSession is not active");
        }
        return context.json(
          BrowserDownloadListResponse.parse({
            browserSessionId,
            controllerGeneration: retained.downloads.at(-1)!.download.controllerGeneration,
            downloads: retained.downloads.map((entry) => entry.download),
          }),
        );
      }
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient }) => await sessionClient.listDownloads(),
      );
      // Downloads kept from before an earlier suspension stay listed after
      // the browser resumed; the running controller only knows its own.
      const live = new Set(result.downloads.map((download) => download.id));
      const earlier = retained.downloads
        .map((entry) => entry.download)
        .filter((download) => !live.has(download.id));
      return context.json(
        BrowserDownloadListResponse.parse({
          ...result,
          downloads: [...earlier, ...result.downloads],
        }),
      );
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/downloads/:downloadId",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const downloadId = requireUuidParam(context, "downloadId");
      const retained = await retainedDownloadsFor(grant, workspaceId, browserSessionId, downloadId);
      const kept = retained.downloads[0];
      if (kept && (retained.notRunning || kept.download.status === "completed")) {
        return context.json(BrowserDownload.parse(kept.download));
      }
      if (retained.notRunning) throw new BrowserSessionStateError("BrowserSession is not active");
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient }) => await sessionClient.download(downloadId),
      );
      return context.json(BrowserDownload.parse(result));
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/downloads/:downloadId/save",
    async (context) => {
      const workspaceId = context.req.param("workspaceId") ?? "";
      const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:control");
      await requireAccessGrant(context, deps, workspaceId, "files:upload");
      const browserSessionId = requireUuidParam(context, "browserSessionId");
      const downloadId = requireUuidParam(context, "downloadId");
      const request = await parseJsonBody(context, BrowserDownloadSaveRequest);
      const objectStorage = deps.objectStorage;
      const identity = {
        accountId: grant.accountId,
        workspaceId,
        actorSubjectId: grant.subjectId,
        browserSessionId,
        downloadId,
        request,
      };

      try {
        // A private chat's downloads are files private to its owner: once the
        // chat is authorized, read and write them as that owner.
        const ownerRecord = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        });
        await authorizeSourceSession(deps, grant, ownerRecord.sourceSessionId, "session.control");
        const owner = await getBrowserDownloadPrivateOwner(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
          sourceSessionId: ownerRecord.sourceSessionId,
        });
        return await withBrowserDownloadFileOwner(owner, async () => {
          let save = await findBrowserDownloadSave(deps.db, identity);
          if (save?.response) {
            return context.json(BrowserDownloadSaveResponse.parse(save.response), 200);
          }
          if (!objectStorage) {
            throw new HTTPException(503, { message: "object storage is not configured" });
          }
          if (save && isTerminalOperation(save.state)) {
            throw new InteractionResourceStateError(
              `Browser download save is ${save.state.replace("_", " ")}`,
            );
          }

          if (!save) {
            // A download kept as a workspace file before its browser stopped
            // running is saved from that file, wherever the task runs now.
            const kept = await getRetainedBrowserDownload(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              browserSessionId,
              downloadId,
            });
            if (kept) {
              const keptRecord = await getBrowserSessionControlRecord(deps.db, {
                accountId: grant.accountId,
                workspaceId,
                browserSessionId,
              });
              await authorizeSourceSession(
                deps,
                grant,
                keptRecord.sourceSessionId,
                "session.control",
              );
              save = await prepareBrowserDownloadSave(deps.db, {
                ...identity,
                sourceSessionId: keptRecord.sourceSessionId,
                download: kept.download,
                fileId: kept.fileId,
                safeFilename: kept.safeFilename,
                contentType: kept.contentType,
                bucket: objectStorage.bucket,
                objectKey: kept.objectKey,
                uploadExpiresAt: new Date(
                  Date.now() + BROWSER_WORKSPACE_FILE_AUTHORITY_TTL_SECONDS * 1_000,
                ),
                retained: { fileId: kept.fileId, uploadId: kept.uploadId },
              });
            }
          }
          if (!save) {
            const source = await withActiveBrowserController(
              context,
              grant,
              workspaceId,
              browserSessionId,
              "session.control",
              "browser.read",
              async ({ sessionClient, record, binding }) => {
                const download = await sessionClient.download(downloadId);
                if (
                  download.status !== "completed" ||
                  !download.sha256 ||
                  download.controllerGeneration !== binding.controllerGeneration
                ) {
                  throw new InteractionResourceStateError("Browser download is not ready to save");
                }
                return { download, sourceSessionId: record.sourceSessionId };
              },
            );
            if (source.download.receivedBytes > objectStorage.maxSinglePutSizeBytes) {
              throw new HTTPException(413, {
                message: `browser download exceeds single PUT limit of ${objectStorage.maxSinglePutSizeBytes} bytes`,
              });
            }
            const fileId = randomUUID();
            const safeFilename = sanitizeFilename(source.download.filename);
            save = await prepareBrowserDownloadSave(deps.db, {
              ...identity,
              sourceSessionId: source.sourceSessionId,
              download: source.download,
              fileId,
              safeFilename,
              contentType: "application/octet-stream",
              bucket: objectStorage.bucket,
              objectKey: `workspaces/${workspaceId}/files/${fileId}/original/${safeFilename}`,
              uploadExpiresAt: new Date(
                Date.now() + BROWSER_WORKSPACE_FILE_AUTHORITY_TTL_SECONDS * 1_000,
              ),
            });
          }

          if (save.download.receivedBytes > objectStorage.maxSinglePutSizeBytes) {
            throw new HTTPException(413, {
              message: `browser download exceeds single PUT limit of ${objectStorage.maxSinglePutSizeBytes} bytes`,
            });
          }
          await requireLimit(deps, {
            accountId: grant.accountId,
            workspaceId,
            action: "file:upload",
            quantity: save.download.receivedBytes,
          });

          let upload = await getFileUpload(deps.db, workspaceId, save.uploadId);
          if (
            !upload ||
            upload.file.id !== save.fileId ||
            upload.file.objectKey !== save.objectKey
          ) {
            throw new InteractionResourceStateError(
              "Browser download file authority is unavailable",
            );
          }
          const controllerRecord = await getBrowserSessionControlRecord(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
          });
          if (upload.status === "pending") {
            if (save.state !== "prepared") {
              throw new InteractionResourceStateError(
                "Browser download save was dispatched before its bytes were published",
              );
            }
            const put = await objectStorage.createPutUrl({
              key: save.objectKey,
              contentType: save.contentType,
              sha256: save.download.sha256,
              expiresInSeconds: BROWSER_WORKSPACE_FILE_AUTHORITY_TTL_SECONDS,
              audience: signedUrlAudienceForPlacement(controllerRecord.session.placement),
            });
            save = await prepareBrowserDownloadSave(deps.db, {
              ...identity,
              sourceSessionId: save.sourceSessionId,
              download: save.download,
              fileId: save.fileId,
              safeFilename: save.safeFilename,
              contentType: save.contentType,
              bucket: upload.file.bucket,
              objectKey: save.objectKey,
              uploadExpiresAt: put.expiresAt,
            });
            const preparedSave = save;
            const receipt = await withActiveBrowserController(
              context,
              grant,
              workspaceId,
              browserSessionId,
              "session.control",
              "browser.control",
              async ({ sessionClient, record, binding }) => {
                if (
                  record.sourceSessionId !== preparedSave.sourceSessionId ||
                  binding.controllerGeneration !== preparedSave.controllerGeneration
                ) {
                  throw new InteractionResourceStateError(
                    "Browser download belongs to a stale controller",
                  );
                }
                const current = await sessionClient.download(downloadId);
                assertBrowserDownloadSaveSource(current, preparedSave.download);
                return await sessionClient.exportDownload(downloadId, {
                  operationId: request.operationId,
                  downloadId,
                  upload: {
                    url: put.url,
                    requiredHeaders: put.requiredHeaders,
                    expiresAt: put.expiresAt.toISOString(),
                  },
                });
              },
            );
            if (
              receipt.sizeBytes !== save.download.receivedBytes ||
              receipt.sha256 !== save.download.sha256
            ) {
              throw new BrowserControlProtocolError(
                "browser controller returned another download export",
              );
            }
            upload = await finalizeBrowserDownloadFile(deps, grant, workspaceId, save.uploadId);
          } else if (upload.status === "completed" && upload.file.status === "ready") {
            await recordBrowserDownloadFileUsage(deps, grant, workspaceId, upload.file);
          } else {
            throw new InteractionResourceStateError(
              `Browser download file upload is ${upload.status.replace("_", " ")}`,
            );
          }

          if (upload.file.status !== "ready") {
            throw new InteractionResourceStateError("Browser download file is not ready");
          }
          const sourceSession = await requireSourceSession(deps, workspaceId, save.sourceSessionId);
          // The task's current placement imports the file: a Connected Machine
          // the task moved to reads a public URL even when the browser ran in
          // a sandbox.
          const get = await objectStorage.createGetUrl({
            key: upload.file.objectKey,
            expiresInSeconds: BROWSER_WORKSPACE_FILE_AUTHORITY_TTL_SECONDS,
            audience: sourceSession.activeSandboxId
              ? "public"
              : signedUrlAudienceForPlacement(controllerRecord.session.placement),
          });
          await authorizeSourceSession(deps, grant, save.sourceSessionId, "session.control");
          const dispatched = await dispatchBrowserDownloadSave(deps.db, identity);
          const imported = await withChannelA(
            channelServices,
            {
              accountId: grant.accountId,
              workspaceId,
              session: sourceSession,
              subjectId: grant.subjectId,
              grant,
              waitSignal: context.req.raw.signal,
              operation: "browser.download.save",
            },
            async ({ service }) =>
              await service.importWorkspaceFile({
                operationId: request.operationId,
                destinationPath: save.destinationPath,
                overwrite: save.overwrite,
                mayReplaceExisting: save.overwrite && dispatched.dispatchedNow,
                // Missing folders on the relative destination are created; the
                // import still confines every existing ancestor to the workspace.
                createParents: true,
                sizeBytes: save.download.receivedBytes,
                sha256: save.download.sha256!,
                source: {
                  url: get.url,
                  expiresAt: get.expiresAt.toISOString(),
                },
              }),
          );
          if (
            imported.destinationPath !== save.destinationPath ||
            imported.sizeBytes !== save.download.receivedBytes ||
            imported.sha256 !== save.download.sha256
          ) {
            await settleBrowserDownloadSaveFailure(deps.db, {
              ...identity,
              state: "outcome_unknown",
              errorCode: "workspace_import_receipt_mismatch",
            });
            throw new InteractionResourceStateError(
              "Browser download workspace import outcome is unknown",
            );
          }
          const response = await completeBrowserDownloadSave(deps.db, identity);
          return context.json(
            BrowserDownloadSaveResponse.parse(response),
            response.replayed ? 200 : 201,
          );
        });
      } catch (error) {
        throw browserRouteError(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/recordings",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      const request = await parseJsonBody(context, BrowserRecordingStartRequest);
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.control",
        async ({ sessionClient }) => await sessionClient.startRecording(request.targetId),
      );
      return context.json(BrowserRecordingSummary.parse(result), 201);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/recordings/:recordingId",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const recordingId = requireUuidParam(context, "recordingId");
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient }) => await sessionClient.recording(recordingId),
      );
      return context.json(BrowserRecordingSummary.parse(result));
    },
  );

  /** Stops a recording and saves it in the source session's workspace as an
   * MP4 plus its action log, then publishes the MP4 so it plays in the chat.
   * The browser host only uploads its frame bundle. That makes it a
   * recording, and the worker encodes its video, so no browser host and no
   * API request needs a video encoder. While the bundle is still uploading
   * over a slow link, or its video is being made, this answers 202 with
   * `retryAfterMs`; repeating the request with the same operationId joins
   * that work instead of starting it again. */
  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/recordings/:recordingId/save",
    async (context) => {
      const workspaceId = context.req.param("workspaceId") ?? "";
      const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:control");
      await requireAccessGrant(context, deps, workspaceId, "files:upload");
      const browserSessionId = requireUuidParam(context, "browserSessionId");
      const recordingId = requireUuidParam(context, "recordingId");
      const request = await parseJsonBody(context, BrowserRecordingSaveRequest);
      const objectStorage = deps.objectStorage;
      if (!objectStorage) {
        throw new HTTPException(503, { message: "object storage is not configured" });
      }
      const startVideo = deps.workflowClient.startBrowserRecordingVideo;
      if (!startVideo) {
        throw new HTTPException(503, { message: "browser recording videos are not available" });
      }
      // A bundle no save comes back for is deleted on a durable deadline;
      // without that, the save waits for the whole upload instead.
      const scheduleDeletion = deps.workflowClient.scheduleTransientObjectDeletion;
      try {
        const staged = await withActiveBrowserController(
          context,
          grant,
          workspaceId,
          browserSessionId,
          "session.control",
          "browser.control",
          async ({ sessionClient, record }) => {
            const sourceSessionId = record.sourceSessionId;
            const authorization = await authorizeSourceSession(
              deps,
              grant,
              sourceSessionId,
              "session.control",
            );
            const owner = browserRecordingOwner({
              authorization,
              grantSubjectId: grant.subjectId,
              chat: await getSessionAuthorityProjection(deps.db, workspaceId, sourceSessionId),
            });
            const existing = await findBrowserRecording(deps.db, {
              workspaceId,
              subjectId: owner.subjectId,
              recordingId,
            });
            if (existing) {
              return {
                sourceSessionId,
                owner,
                existing,
                recording: await sessionClient.stopRecording(recordingId),
                bundle: null,
              };
            }
            return {
              sourceSessionId,
              owner,
              existing: null,
              ...(await stageBrowserRecordingBundle({
                sessionClient,
                objectStorage,
                recordingId,
                bundleKey: ({ sha256 }) =>
                  browserRecordingBundleObjectKey({ workspaceId, recordingId, sha256 }),
                audience: signedUrlAudienceForPlacement(record.session.placement),
                uploadTtlSeconds: BROWSER_WORKSPACE_FILE_AUTHORITY_TTL_SECONDS,
                scheduleDeletion:
                  scheduleDeletion &&
                  (async (objectKeys, deleteAfter) =>
                    await scheduleDeletion({ workspaceId, objectKeys, deleteAfter })),
              })),
            };
          },
        );
        const { recording, sourceSessionId, existing } = staged;
        const progress = (state: "uploading" | "encoding") =>
          context.json(
            BrowserRecordingSaveProgress.parse({
              state,
              recording,
              retryAfterMs: BROWSER_RECORDING_SAVE_RETRY_AFTER_MS,
            }),
            202,
          );
        const makeVideo = async (
          ownerSubjectId: string,
          visibility: RecordingVisibility,
          bundle: { sizeBytes: number; sha256: string },
        ) => {
          // Starting it again while it runs, or after it finished, does nothing.
          await startVideo({
            accountId: grant.accountId,
            workspaceId,
            recordingId,
            ownerSubjectId,
            visibility,
            startedAt: recording.startedAt,
            durationMilliseconds: recording.durationMs,
            bundle: { byteLength: bundle.sizeBytes, sha256: bundle.sha256 },
          });
        };
        if (!existing) {
          if (!staged.bundle) return progress("uploading");
          await makeVideo(staged.owner.subjectId, staged.owner.visibility, staged.bundle);
          return progress("encoding");
        }
        if (existing.recording.state === "processing") {
          // Should its workflow have been lost, this starts it again.
          if (recording.bundle) {
            await makeVideo(
              existing.recording.ownerSubjectId,
              existing.recording.visibility,
              recording.bundle,
            );
          }
          return progress("encoding");
        }
        if (existing.recording.state === "failed") {
          throw new HTTPException(browserRecordingFailureStatus(existing.recording.errorCode), {
            message: existing.errorMessage ?? "the recording could not be encoded",
          });
        }
        const actor = {
          workspaceId,
          subjectId: existing.recording.ownerSubjectId,
          recordingId,
        };
        const video =
          existing.recording.state === "ready"
            ? await getBrowserRecordingVideo(deps.db, actor)
            : null;
        if (!video) return progress("encoding");
        const actionLog = await objectStorage.getObjectBytes(video.actionLogObjectKey);
        if (!actionLog) {
          throw new HTTPException(503, {
            message: "browser recording action log is not available",
          });
        }
        await authorizeSourceSession(deps, grant, sourceSessionId, "session.control");
        const sourceSession = await requireSourceSession(deps, workspaceId, sourceSessionId);
        const videoPath =
          request.destinationPath ?? defaultBrowserRecordingPath(recording.startedAt);
        const actionLogPath = `${videoPath.replace(/\.[^./]*$/u, "")}.actions.json`;
        const outputs = [
          {
            name: "video.mp4",
            path: videoPath,
            key: video.objectKey,
            sizeBytes: video.bytes,
            sha256: video.sha256,
          },
          {
            name: "actions.json",
            path: actionLogPath,
            key: video.actionLogObjectKey,
            sizeBytes: actionLog.bytes.byteLength,
            sha256: createHash("sha256").update(actionLog.bytes).digest("hex"),
          },
        ];
        await requireLimit(deps, {
          accountId: grant.accountId,
          workspaceId,
          action: "file:upload",
          quantity: outputs.reduce((total, output) => total + output.sizeBytes, 0),
        });
        await withChannelA(
          channelServices,
          {
            accountId: grant.accountId,
            workspaceId,
            session: sourceSession,
            subjectId: grant.subjectId,
            grant,
            waitSignal: context.req.raw.signal,
            operation: "browser.recording.save",
          },
          async ({ service, lease }) => {
            for (const output of outputs) {
              // A Connected Machine reaches storage on its public endpoint; a
              // leased managed sandbox uses the sandbox-facing one.
              const get = await objectStorage.createGetUrl({
                key: output.key,
                expiresInSeconds: BROWSER_WORKSPACE_FILE_AUTHORITY_TTL_SECONDS,
                audience: lease ? "sandbox" : "public",
              });
              const imported = await service.importWorkspaceFile({
                operationId: derivedOperationId(request.operationId, output.name),
                destinationPath: output.path,
                overwrite: false,
                mayReplaceExisting: false,
                createParents: true,
                sizeBytes: output.sizeBytes,
                sha256: output.sha256,
                source: { url: get.url, expiresAt: get.expiresAt.toISOString() },
              });
              if (imported.sha256 !== output.sha256) {
                throw new InteractionResourceStateError(
                  "Browser recording workspace import outcome is unknown",
                );
              }
            }
          },
        );
        const published = await publishSandboxFileArtifact(deps, {
          grant,
          session: sourceSession,
          path: videoPath,
          signal: context.req.raw.signal,
        });
        return context.json(
          BrowserRecordingSaveResponse.parse({
            recording,
            video: {
              path: videoPath,
              artifactId: published.artifact.artifactId,
              sizeBytes: video.bytes,
              durationMs: video.durationMilliseconds,
              width: video.width,
              height: video.height,
              frameCount: video.frameCount,
            },
            actionLogPath,
          }),
          201,
        );
      } catch (error) {
        throw browserRouteError(error);
      }
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/observation",
    async (context) => {
      const stages = new InteractionRouteStages("observe");
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const targetId = requireOpaqueParam(context, "targetId");
      stages.mark("auth");
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient }) => {
          stages.mark("placement");
          try {
            return await sessionClient.observe(targetId);
          } finally {
            stages.mark("dispatch");
          }
        },
        true,
        stages,
      );
      reportInteractionRouteStages(context, deps.observability, stages);
      return context.json(result);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/state",
    async (context) => {
      const stages = new InteractionRouteStages("target_state");
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const targetId = requireOpaqueParam(context, "targetId");
      stages.mark("auth");
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient }) => {
          stages.mark("placement");
          try {
            return await sessionClient.targetState(targetId);
          } finally {
            stages.mark("dispatch");
          }
        },
        true,
        stages,
      );
      reportInteractionRouteStages(context, deps.observability, stages);
      return context.json(BrowserTargetState.parse(result));
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/dom-read",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const targetId = requireOpaqueParam(context, "targetId");
      const request = await parseJsonBody(context, BrowserDomReadRequest);
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient }) => await sessionClient.readDom(targetId, request),
      );
      return context.json(BrowserDomReadResponse.parse(result));
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/screenshot",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const targetId = requireOpaqueParam(context, "targetId");
      const captureOptions = parseBrowserScreenshotOptions(new URL(context.req.url).searchParams);
      const frame = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient, record }) => {
          if (!record.session.capabilities.screenshots) {
            throw new BrowserControlUnsupportedError(
              "This browser engine does not render page screenshots; use semantic observation",
            );
          }
          try {
            return await sessionClient.capture(targetId, captureOptions);
          } catch (error) {
            throw browserScreenshotError(error);
          }
        },
      );
      return browserScreenshotResponse(frame);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/actions",
    async (context) => {
      const stages = new InteractionRouteStages("act");
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      const request = await parseJsonBody(context, BrowserActionRequest);
      const workspaceFileIds = browserUploadFileIds(request.action);
      if (workspaceFileIds.length > 0) {
        await requireAccessGrant(context, deps, workspaceId, "files:read");
      }
      stages.mark("auth");
      const startedAtMs = performance.now();
      // Omitted fences mean the target's current state. Read them once from the
      // live controller in this request (a recovery retry of the callback must
      // replay the same command digest, so it reuses the first read).
      let resolvedFences: BrowserActionFences | null = null;
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.action",
        async ({ sessionClient, binding, record, sourceAuthorization }) => {
          stages.mark("placement");
          const passkeySync = (refresh: boolean) =>
            syncBrowserPasskeys({
              port: interactionSecrets,
              grant,
              browserSessionId,
              controllerGeneration: binding.controllerGeneration,
              client: sessionClient,
              refresh,
              log: (event, fields) => console.warn(event, { browserSessionId, ...fields }),
            });
          // Before the action this browser takes over the principal's passkeys.
          // It is independent of the fence read, so both run together; the
          // action is dispatched only after the takeover settles.
          const passkeyTakeover = passkeySync(true);
          resolvedFences ??= await resolveBrowserActionFences(request, () =>
            sessionClient.targetState(request.targetId),
          );
          stages.mark("fences");
          const commandFields = {
            protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
            operationId: request.operationId,
            browserSessionId,
            controllerGeneration: binding.controllerGeneration,
            targetId: request.targetId,
            ...resolvedFences,
            actor: interactionActorForGrant(grant),
            observationMode: request.observationMode,
            action: request.action,
          };
          // Validate the public command before resolving any reference.
          BrowserActionCommand.parse(commandFields);
          if (workspaceFileIds.length > 0) {
            let alreadyAdmitted = false;
            try {
              await sessionClient.receipt(request.operationId);
              alreadyAdmitted = true;
            } catch (error) {
              if (!(error instanceof BrowserControlRequestError && error.status === 404)) {
                throw error;
              }
            }
            if (!alreadyAdmitted) {
              if (!deps.objectStorage) {
                throw new HTTPException(503, {
                  message: "object storage is not configured",
                });
              }
              const files = await getFilesForSubject(deps.db, {
                accountId: grant.accountId,
                workspaceId,
                subjectId: browserFileAuthoritySubjectId(grant, sourceAuthorization),
                fileIds: workspaceFileIds,
              });
              const ordered = requireAuthorizedBrowserUploadFiles(workspaceFileIds, files);
              const authorities = await Promise.all(
                ordered.map(async (file) => {
                  const signed = await deps.objectStorage!.createGetUrl({
                    key: file.objectKey,
                    expiresInSeconds: BROWSER_WORKSPACE_FILE_AUTHORITY_TTL_SECONDS,
                    audience: signedUrlAudienceForPlacement(record.session.placement),
                  });
                  return {
                    fileId: file.id,
                    safeFilename: browserUploadFilename(file.safeFilename),
                    sizeBytes: file.sizeBytes,
                    sha256: browserUploadSha256(file.sha256),
                    download: {
                      url: signed.url,
                      expiresAt: signed.expiresAt.toISOString(),
                    },
                  };
                }),
              );
              await sessionClient.stageWorkspaceFiles({
                operationId: request.operationId,
                files: authorities,
              });
            }
          }
          await passkeyTakeover;
          stages.mark("passkey_pre");
          // Resolved last, right before dispatch, so TOTP codes are fresh (Q-33).
          const secretValues = await resolveInteractionSecretValues({
            port: interactionSecrets,
            grant,
            texts: browserActionSecretTexts(request.action),
            use: {
              surface: "browser",
              toolName: "browser_act",
              operationId: request.operationId,
            },
            beforeResolve: requirePlacementAcceptsSecretValues(
              deps.db,
              grant,
              workspaceId,
              record.session.placement,
            ),
          });
          stages.mark("secrets");
          try {
            return await sessionClient.action(
              BrowserActionCommand.parse({
                ...commandFields,
                ...(secretValues === undefined ? {} : { secretValues }),
              }),
            );
          } finally {
            stages.mark("dispatch");
            // Write back what the action did (new registrations, sign counts)
            // without holding the response: unacknowledged events stay in
            // browserd, and the session's next sync waits for this one.
            void passkeySync(false);
          }
        },
        true,
        stages,
      );
      observeBrowserActionResult(deps.observability, startedAtMs, request, result);
      reportInteractionRouteStages(context, deps.observability, stages);
      return context.json(result);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/clipboard",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient }) => await sessionClient.readClipboard(),
      );
      return context.json(result);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async () =>
          await listAuthRuns(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
            includeSettled: context.req.query("includeSettled") === "true",
          }),
      );
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      const request = await parseJsonBody(context, StartAuthRunRequest);
      const actor = interactionActorForGrant(grant);
      const startedAtMs = performance.now();
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.control",
        async ({ sessionClient, binding }) => {
          const observation = await sessionClient.observe(request.targetId);
          if (
            observation.target.targetGeneration !== request.expectedTargetGeneration ||
            observation.target.documentGeneration !== request.expectedDocumentGeneration
          ) {
            throw new InteractionResourceConflictError(
              "Auth run does not match the currently observed browser document",
            );
          }
          return await startAuthRun(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            browserSessionId,
            controllerGeneration: binding.controllerGeneration,
            originatingSessionId:
              actor.kind === "agent" && actor.sessionId ? actor.sessionId : null,
            ...request,
          });
        },
      );
      observeAuthMutation(deps.observability, startedAtMs, result);
      return context.json(result, result.replayed ? 200 : 201);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const authRunId = requireUuidParam(context, "authRunId");
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async () => {
          const run = await getAuthRun(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            authRunId,
          });
          assertAuthRunBrowser(run.browserSessionId, browserSessionId);
          return run;
        },
      );
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/report",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      const authRunId = requireUuidParam(context, "authRunId");
      const request = await parseJsonBody(context, ReportAuthRunRequest);
      const startedAtMs = performance.now();
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.control",
        async ({ binding }) => {
          const current = await getAuthRun(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            authRunId,
          });
          assertAuthRunBrowser(current.browserSessionId, browserSessionId);
          return await reportAuthRun(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            authRunId,
            controllerGeneration: binding.controllerGeneration,
            ...request,
          });
        },
      );
      observeAuthMutation(deps.observability, startedAtMs, result);
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      const authRunId = requireUuidParam(context, "authRunId");
      const request = await parseJsonBody(context, ExternalAuthRunRequest);
      const startedAtMs = performance.now();
      try {
        const replay = await getExternalAuthPreparation(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          actorSubjectId: grant.subjectId,
          authRunId,
          ...request,
        });
        if (replay?.response) {
          const record = await getBrowserSessionControlRecord(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
          });
          await authorizeSourceSession(deps, grant, record.sourceSessionId, "session.control");
          assertAuthRunBrowser(replay.run.browserSessionId, browserSessionId);
          const response = ExternalAuthRunResponse.parse(replay.response);
          observeAuthMutation(deps.observability, startedAtMs, response);
          return context.json(response);
        }
      } catch (error) {
        throw browserRouteError(error);
      }
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.control",
        async ({ sessionClient, binding, record }) => {
          const actor = interactionActorForGrant(grant);
          const scope = {
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            authRunId,
          };
          let preparation = await getExternalAuthPreparation(deps.db, {
            ...scope,
            ...request,
          });
          preparation ??= await prepareExternalAuth(deps.db, {
            ...scope,
            ...request,
          });
          assertAuthRunBrowser(preparation.run.browserSessionId, browserSessionId);
          if (preparation.run.controllerGeneration !== binding.controllerGeneration) {
            throw new InteractionResourceConflictError(
              "Auth run belongs to a stale browser controller",
            );
          }
          if (preparation.response) return preparation.response;
          if (
            preparation.operationState === "failed" ||
            preparation.operationState === "outcome_unknown"
          ) {
            throw new InteractionResourceStateError(
              `External-auth operation is ${preparation.operationState.replace("_", " ")}`,
            );
          }
          if (preparation.operationState === "prepared") {
            await dispatchExternalAuth(deps.db, {
              ...scope,
              operationId: request.operationId,
            });
          }
          const providerResult = await sessionClient.externalAuth(
            BrowserExternalAuthCommand.parse({
              browserSessionId,
              controllerGeneration: binding.controllerGeneration,
              operationId: request.operationId,
              authRunId,
              adapterId: preparation.authority.adapterId,
              connectionId: preparation.authority.connectionId,
              action: request.action,
            }),
          );
          if (providerResult.interactiveUrl !== null) {
            throw new BrowserControlProtocolError(
              "provider exposed a hosted login URL outside the human-only endpoint",
            );
          }
          let target:
            | { id: string; targetGeneration: string; documentGeneration: string | null }
            | undefined;
          if (providerResult.state === "authenticated") {
            const targets = await sessionClient.listTargets();
            const selected = targets.find((candidate) => candidate.selected) ?? targets[0];
            if (!selected) {
              throw new BrowserControlProtocolError(
                "authenticated provider browser returned no current target",
              );
            }
            const observation = await sessionClient.observe(selected.id);
            target = {
              id: observation.target.id,
              targetGeneration: observation.target.targetGeneration,
              documentGeneration: observation.target.documentGeneration,
            };
          }
          return await completeExternalAuth(deps.db, {
            ...scope,
            operationId: request.operationId,
            result: providerResult,
            ...(target ? { target } : {}),
            ...(providerResult.state === "needs_human"
              ? {
                  intervention: {
                    originatingSessionId: record.sourceSessionId,
                    originatingTurnId: actor.kind === "agent" ? (actor.turnId ?? null) : null,
                    originatingAttemptId: actor.kind === "agent" ? (actor.attemptId ?? null) : null,
                    originatingToolOperationId:
                      actor.kind === "agent" && actor.attemptId ? request.operationId : null,
                    expiresInSeconds: 1_200,
                  },
                }
              : {}),
          });
        },
      );
      const response = ExternalAuthRunResponse.parse(result);
      observeAuthMutation(deps.observability, startedAtMs, response);
      return context.json(response);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth/interactive",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      if (grant.principalKind !== "human_session") {
        throw new HTTPException(403, {
          message: "hosted login flows can only be opened by an interactive user",
        });
      }
      const authRunId = requireUuidParam(context, "authRunId");
      const request = await parseJsonBody(context, ExternalAuthInteractiveRequest);
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.control",
        async ({ sessionClient, binding }) => {
          const resolved = await getExternalAuthInteractiveContext(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            authRunId,
            ...request,
          });
          assertAuthRunBrowser(resolved.run.browserSessionId, browserSessionId);
          if (resolved.run.controllerGeneration !== binding.controllerGeneration) {
            throw new InteractionResourceConflictError(
              "Hosted login belongs to a stale browser controller",
            );
          }
          const providerResult = await sessionClient.externalAuth(
            BrowserExternalAuthCommand.parse({
              browserSessionId,
              controllerGeneration: binding.controllerGeneration,
              operationId: request.operationId,
              authRunId,
              adapterId: resolved.authority.adapterId,
              connectionId: resolved.authority.connectionId,
              action: "interactive",
            }),
          );
          if (
            providerResult.state !== "needs_human" ||
            !providerResult.externalAction ||
            !providerResult.interactiveUrl
          ) {
            throw new InteractionResourceStateError(
              "Hosted login is no longer waiting for human input",
            );
          }
          return ExternalAuthInteractiveResponse.parse({
            authRunId,
            url: providerResult.interactiveUrl,
            expiresAt: providerResult.externalAction.expiresAt,
          });
        },
      );
      return context.json(ExternalAuthInteractiveResponse.parse(result));
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/verify",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      const authRunId = requireUuidParam(context, "authRunId");
      const request = await parseJsonBody(context, VerifyAuthRunRequest);
      const startedAtMs = performance.now();
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.control",
        async ({ sessionClient, binding }) => {
          const run = await getAuthRun(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            authRunId,
          });
          assertAuthRunBrowser(run.browserSessionId, browserSessionId);
          const observation = await sessionClient.observe(run.targetId);
          return await verifyAuthRun(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            authRunId,
            controllerGeneration: binding.controllerGeneration,
            targetId: observation.target.id,
            targetGeneration: observation.target.targetGeneration,
            documentGeneration: observation.target.documentGeneration,
            url: observation.target.url,
            ...request,
          });
        },
      );
      observeAuthMutation(deps.observability, startedAtMs, result);
      return context.json(result);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/operations/:operationId",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const operationId = requireUuidParam(context, "operationId");
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient }) => await sessionClient.receipt(operationId),
      );
      return context.json(result);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/diagnostics",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const targetId = requireOpaqueParam(context, "targetId");
      const kinds = diagnosticKinds(context.req.query("kinds"));
      const afterSequence = optionalBoundedInteger(context.req.query("after"), 0, 2 ** 53 - 1);
      const limit = optionalBoundedInteger(context.req.query("limit"), 1, 1_000);
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient }) =>
          await sessionClient.diagnostics(targetId, {
            ...(kinds ? { kinds } : {}),
            ...(afterSequence === null ? {} : { afterSequence }),
            ...(limit === null ? {} : { limit }),
          }),
      );
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/attachments",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "stream:view",
      );
      const origin = requestOrigin(context, deps.settings);
      const request = await parseJsonBody(context, BrowserSessionAttachmentRequest);
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.viewer.read",
        "browser.attach",
        async ({ client, sessionClient, record, binding, placement }) => {
          if (origin) await client.addAllowedOrigins([origin]);
          const targets = await sessionClient.listTargets();
          if (!targets.some((target) => target.id === request.targetId)) {
            throw new HTTPException(404, { message: "browser target does not exist" });
          }
          const grantId = randomUUID();
          const expiresAt = new Date(Date.now() + request.expiresInSeconds * 1_000).toISOString();
          const rootSecret = browserAuthorityRoot(deps);
          const relaySecret = placement.session.openBrowserFrames
            ? resolveStreamTokenSecret(deps.settings)
            : null;
          if (placement.session.openBrowserFrames && !relaySecret) {
            throw new BrowserControlUnsupportedError(
              "browser frame relay authority is unavailable",
            );
          }
          const token = deriveBrowserViewGrantToken({
            rootSecret,
            accountId: grant.accountId,
            workspaceId,
            placement: record.session.placement,
            placementInstanceId: placement.placementInstanceId,
            browserSessionId,
            controllerGeneration: binding.controllerGeneration,
            tokenGeneration: record.tokenGeneration,
            grantId,
            expiresAt,
          });
          const reference = {
            browserSessionId,
            controllerGeneration: binding.controllerGeneration,
          };
          const viewGrant = await client.createViewGrant(reference, {
            grantId,
            token,
            expiresAt,
          });
          const relayed = await client.openRelayedFrameStream({
            reference,
            targetId: request.targetId,
            viewToken: token,
            expiresAt,
            ...(request.stream ? { stream: request.stream } : {}),
          });
          const stream = relayed
            ? await (async () => {
                // 0281: stamp the authenticated viewer subject and the live
                // session authority epoch into the relay stream token.
                const relayAuthorityEpoch = await getSessionAuthorityEpoch(deps.db, {
                  accountId: grant.accountId,
                  workspaceId,
                  sessionId: record.sourceSessionId,
                });
                if (relayAuthorityEpoch === null) {
                  throw new BrowserControlUnsupportedError(
                    "stream authority is unavailable for this session",
                  );
                }
                // The machine may be enrolled in another workspace than this
                // chat; the token is for its exact relay channel.
                const relayToken = await mintStreamToken(relaySecret!, {
                  workspaceId,
                  relayChannel: {
                    workspaceId: relayed.channel.workspaceId,
                    agentId: relayed.channel.agentId,
                    channelId: relayed.channel.channelId,
                  },
                  sessionId: record.sourceSessionId,
                  viewerId: grantId,
                  leaseEpoch: record.tokenGeneration,
                  port: relayed.channel.port,
                  ttlSeconds: request.expiresInSeconds,
                  subjectId: grant.subjectId,
                  authorityEpoch: relayAuthorityEpoch,
                });
                return {
                  kind: "relay" as const,
                  url: buildStreamUrl(relayed.endpoint),
                  token: relayToken,
                  channel: {
                    channelId: relayed.channel.channelId,
                    workspaceId: relayed.channel.workspaceId,
                    agentId: relayed.channel.agentId,
                    kind: 3 as const,
                    port: relayed.channel.port,
                  },
                };
              })()
            : await (async () => {
                const protocols = [
                  BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
                  `${BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX}${token}`,
                ] as const;
                const upstreamUrl = await client.frameStreamUrl(
                  reference,
                  request.targetId,
                  request.stream,
                );
                const attachment = placementUsesInteractionFrameProxy(placement.lease?.backend, {
                  openSandboxSignedEndpoints: deps.settings.openSandboxSignedEndpoints,
                  ...(typeof deps.settings.openSandboxInteractionFrameProxy === "boolean"
                    ? {
                        openSandboxInteractionFrameProxy:
                          deps.settings.openSandboxInteractionFrameProxy,
                      }
                    : {}),
                })
                  ? createInteractionFrameProxyAttachment({
                      requestUrl: context.req.url,
                      publicBaseUrl: deps.settings.publicBaseUrl,
                      webBaseUrl: deps.settings.webBaseUrl,
                      forwardedProto: context.req.header("x-forwarded-proto"),
                      forwardedHost:
                        context.req.header("x-forwarded-host") ?? context.req.header("host"),
                      rootSecret,
                      upstreamUrl,
                      upstreamProtocols: protocols,
                      origin,
                      expiresAt,
                    })
                  : { url: upstreamUrl, protocols };
                return {
                  kind: "direct_websocket" as const,
                  ...attachment,
                };
              })();
          return BrowserSessionAttachment.parse({
            browserSessionId,
            controllerGeneration: binding.controllerGeneration,
            targetId: request.targetId,
            stream,
            ...(viewGrant.fencedInputBatches === true ? { fencedInputBatches: true } : {}),
            ...(viewGrant.focusedInputObservations === true
              ? { focusedInputObservations: true }
              : {}),
            expiresAt,
          });
        },
      );
      return context.json(result, 201);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/heartbeat",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      await parseEmptyJsonBody(context);
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient, binding }) => {
          await sessionClient.listTargets();
          return BrowserSessionHeartbeatResponse.parse({
            browserSessionId,
            controllerGeneration: binding.controllerGeneration,
            alive: true,
          });
        },
        false,
      );
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/revisions",
    async (context) => {
      const workspaceId = context.req.param("workspaceId") ?? "";
      const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:control");
      const browserSessionId = requireUuidParam(context, "browserSessionId");
      const request = await parseJsonBody(context, PublishBrowserRevisionRequest);
      const startedAtMs = performance.now();
      try {
        const record = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        });
        await authorizeSourceSession(deps, grant, record.sourceSessionId, "session.control");
        const publicationInput = {
          accountId: grant.accountId,
          workspaceId,
          operationId: request.operationId,
          browserSessionId,
          identityId: request.identityId,
          expectedHeadGeneration: request.expectedHeadGeneration,
          advanceDefault: request.advanceDefault,
          actorSubjectId: grant.subjectId,
        };
        const prepared = await prepareBrowserRevisionPublication(deps.db, publicationInput);
        if (prepared.kind === "completed") {
          const parsed = PublishBrowserRevisionResponse.parse(prepared.response);
          observeBrowserRevisionPublication(deps.observability, startedAtMs, parsed);
          return context.json(parsed, 200);
        }
        const objectStorage = deps.objectStorage;
        if (!objectStorage) {
          throw new HTTPException(503, {
            message: "browser state storage is not configured",
          });
        }

        const response = await withActiveBrowserController(
          context,
          grant,
          workspaceId,
          browserSessionId,
          "session.control",
          "browser.control",
          async ({ client, binding, record: activeRecord }) => {
            if (
              prepared.browserSessionId !== browserSessionId ||
              prepared.controllerGeneration !== binding.controllerGeneration
            ) {
              throw new BrowserIdentityConflictError(
                "BrowserRevision publication belongs to a stale controller",
              );
            }
            const rootKey = requireBrowserStateRoot(deps);
            const objectKey = browserStateObjectKey(workspaceId, request.operationId);
            const dataKey = deriveBrowserStateDataKey(rootKey, {
              accountId: grant.accountId,
              workspaceId,
              browserSessionId,
              operationId: request.operationId,
              objectKey,
            });
            const aad = browserStateArtifactAad({
              accountId: grant.accountId,
              workspaceId,
              objectKey,
            });
            try {
              const dispatched = await dispatchBrowserRevisionPublication(deps.db, {
                ...publicationInput,
                controllerGeneration: binding.controllerGeneration,
                stateUpload: {
                  objectKey,
                  cleanupAfter: new Date(Date.now() + BROWSER_STATE_UPLOAD_CLEANUP_GRACE_MS),
                },
              });
              if (dispatched.kind === "completed") return dispatched.response;
              const signed = await objectStorage.createPutUrl({
                key: objectKey,
                contentType: BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
                audience: signedUrlAudienceForPlacement(activeRecord.session.placement),
              });

              let receipt;
              try {
                receipt = await client.captureState({
                  browserSessionId,
                  controllerGeneration: binding.controllerGeneration,
                  operationId: request.operationId,
                  objectKey,
                  afterCapture: "restart",
                  dataKey,
                  aad,
                  upload: {
                    url: signed.url,
                    requiredHeaders: signed.requiredHeaders,
                    expiresAt: signed.expiresAt.toISOString(),
                  },
                });
              } catch (error) {
                await settleBrowserRevisionCaptureFailure(
                  deps,
                  {
                    accountId: grant.accountId,
                    workspaceId,
                    operationId: request.operationId,
                    browserSessionId,
                    controllerGeneration: binding.controllerGeneration,
                  },
                  error,
                );
                throw error;
              }

              const materialization = browserRevisionMaterialization(
                receipt.manifest,
                activeRecord.session.placement,
              );
              const encryptedDataKey = wrapBrowserStateDataKey(rootKey, dataKey, {
                accountId: grant.accountId,
                workspaceId,
                objectKey,
                artifactDigest: receipt.artifactDigest,
                contentDigest: receipt.contentDigest,
              });
              return await commitBrowserRevisionPublication(deps.db, {
                ...publicationInput,
                controllerGeneration: binding.controllerGeneration,
                manifestDigest: browserStateManifestDigest(receipt.manifest),
                artifacts: [
                  {
                    kind: "chromium_profile",
                    format: receipt.format,
                    artifactDigest: receipt.artifactDigest,
                    contentDigest: receipt.contentDigest,
                    manifestDigest: browserStateManifestDigest(receipt.manifest),
                    objectKey,
                    encryptedDataKey,
                    sizeBytes: receipt.sizeBytes,
                    materialization,
                  },
                ],
              });
            } finally {
              dataKey.fill(0);
              rootKey.fill(0);
              aad.fill(0);
            }
          },
        );
        const parsed = PublishBrowserRevisionResponse.parse(response);
        observeBrowserRevisionPublication(deps.observability, startedAtMs, parsed);
        return context.json(parsed, parsed.replayed ? 200 : 201);
      } catch (error) {
        throw browserRouteError(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/suspend",
    async (context) => {
      const workspaceId = context.req.param("workspaceId");
      const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:control");
      const browserSessionId = requireUuidParam(context, "browserSessionId");
      const request = await parseJsonBody(context, BrowserSessionLifecycleRequest);
      const startedAtMs = performance.now();
      try {
        const before = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        });
        await authorizeSourceSession(deps, grant, before.sourceSessionId, "session.control");
        const parsed = await suspendBrowserSessionCheckpoint(
          context,
          grant,
          workspaceId,
          browserSessionId,
          request.operationId,
          { before, recoverController: true },
        );
        observeLifecycleResult(deps.observability, startedAtMs, parsed);
        return context.json(parsed, 200);
      } catch (error) {
        throw browserRouteError(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/resume",
    async (context) => {
      const workspaceId = context.req.param("workspaceId");
      const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:control");
      const browserSessionId = requireUuidParam(context, "browserSessionId");
      const request = await parseJsonBody(context, BrowserSessionLifecycleRequest);
      const startedAtMs = performance.now();
      const origin = requestOrigin(context, deps.settings);
      let restore: RestorePlacementBrowserStateInput | null = null;
      let preparedForDispatch = false;
      try {
        let before = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        });
        await authorizeSourceSession(deps, grant, before.sourceSessionId, "session.control");
        if (
          before.session.lifecycle === "lost" &&
          (before.session.failureCode === "controller_transition_expired" ||
            before.session.failureCode === "controller_resource_missing")
        ) {
          // A resume whose transition expired never activated; a browser whose
          // suspension found its controller restarted kept running past its
          // checkpoint. When the controller still holds that generation's
          // working copy, continue the same browser from it; nothing is
          // restored over it or discarded.
          const continued = await continueExpiredBrowserResume(
            context,
            grant,
            workspaceId,
            browserSessionId,
            request.operationId,
          );
          if ("continued" in continued) {
            const parsed = BrowserSessionMutationResponse.parse(continued.continued);
            observeLifecycleResult(deps.observability, startedAtMs, parsed);
            return context.json(parsed, 200);
          }
          // Otherwise end an expired resume's retained controller generation,
          // then resume normally from the same durable state.
          await settleExpiredBrowserResume(
            context,
            grant,
            workspaceId,
            browserSessionId,
            continued.unavailable,
          );
          before = await getBrowserSessionControlRecord(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
          });
        }
        if (before.session.lifecycle === "suspended" && before.session.controller) {
          await finishSuspendedBrowserControllerCleanup(
            context,
            grant,
            workspaceId,
            browserSessionId,
          );
          before = await getBrowserSessionControlRecord(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
          });
        }
        const authority = browserAuthorityRoot(deps);
        const prepared = await prepareBrowserSessionResume(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
          operationId: request.operationId,
          actorSubjectId: grant.subjectId,
        });
        if (isTerminalOperation(prepared.operation.state)) {
          const parsed = BrowserSessionMutationResponse.parse(prepared);
          observeLifecycleResult(deps.observability, startedAtMs, parsed);
          return context.json(parsed, 200);
        }
        // From here until controller dispatch, any failure (state restore,
        // an offline or moved placement, dispatch itself) returns the browser
        // to suspended in the catch below, so a later resume can start over.
        preparedForDispatch = true;

        const privateCheckpoint = await getBrowserPrivateCheckpointAuthority(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        });
        const revisionAuthority = privateCheckpoint
          ? null
          : await requireBrowserRevisionRestoreAuthority(deps, grant, prepared.session);
        // Signed for a short time, so a retry after making room signs anew.
        const prepareRestore = async () => {
          restore?.dataKey.fill(0);
          restore?.aad.fill(0);
          restore = privateCheckpoint
            ? await prepareBrowserPrivateCheckpointRestore(
                deps,
                grant,
                prepared.session,
                privateCheckpoint,
              )
            : await prepareBrowserStateRestore(
                deps,
                grant,
                prepared.session,
                prepared.session.placement,
                revisionAuthority,
              );
          if (!restore) {
            throw new BrowserSessionStateError("BrowserSession has no restorable durable state");
          }
        };
        await prepareRestore();

        const sourceSession = await requireSourceSession(deps, workspaceId, before.sourceSessionId);
        // A full controller saves its least recently used idle browser once,
        // as for a create, so a saved browser can come back while the machine
        // is at its limit.
        let capacitySuspendAllowed = true;
        const resumeOnPlacement = () =>
          withBrowserPlacement(
            sourceSession,
            grant,
            prepared.session.placement,
            before.deviceWorkspaceId,
            null,
            "browser.resume",
            context.req.raw.signal,
            async (placement) => {
              const networkRoute = await resolveBrowserNetworkRouteLaunch({
                deps,
                grant,
                workspaceId,
                browserSessionId,
                operationId: request.operationId,
                rootSecret: authority,
                placement: placement.placement,
              });
              const interactionHeld = await ensureInteractionHolder(
                deps,
                grant,
                sourceSession,
                browserSessionId,
                placement,
                context.req.raw.signal,
              );
              const record = await ensureDispatchedGeneration(
                deps,
                grant,
                workspaceId,
                browserSessionId,
                request.operationId,
                placement.placementInstanceId,
              ).catch(async (error: unknown) => {
                if (interactionHeld) {
                  await releaseInteractionHolder(
                    deps,
                    grant,
                    workspaceId,
                    browserSessionId,
                    placement.controllerHostSandboxGroupId,
                  ).catch(() => undefined);
                }
                throw error;
              });
              const controllerGeneration = requireOperationGeneration(record);
              const adminToken = deriveBrowserControllerAdminToken({
                rootSecret: authority,
                accountId: grant.accountId,
                workspaceId,
                placement: placement.placement,
                placementInstanceId: placement.placementInstanceId,
              });
              const tokens = deriveBrowserSessionControllerTokens({
                rootSecret: authority,
                accountId: grant.accountId,
                workspaceId,
                browserSessionId,
                placement: placement.placement,
                placementInstanceId: placement.placementInstanceId,
                controllerGeneration,
                tokenGeneration: record.tokenGeneration,
              });
              let client: BrowserControlClient | undefined;
              try {
                // The heartbeat covers everything after dispatch, including
                // provisioning the controller.
                await withInteractionHolderHeartbeat(
                  deps,
                  {
                    grant,
                    workspaceId,
                    sandboxGroupId: placement.controllerHostSandboxGroupId,
                    holderId: interactionHolderId(browserSessionId),
                    operationId: request.operationId,
                    resourceId: browserSessionId,
                    controllerGeneration,
                  },
                  async () => {
                    ({ client } = await provisionBrowserControlClient(placement.session, {
                      adminToken,
                      nativeAuthority: nativeBrowserControllerAuthority(workspaceId, placement),
                      ...(origin ? { allowedOrigins: [origin] } : {}),
                    }));
                    const linkedComputer = await ensureLinkedComputerController(
                      deps,
                      grant,
                      prepared.session,
                      placement,
                      client,
                    );
                    await ensureHeadedBrowserDisplayStack(
                      placement.session,
                      prepared.session.headless,
                      linkedComputer !== null,
                    );
                    return await client.createSession({
                      browserSessionId,
                      controllerGeneration,
                      tokenGeneration: record.tokenGeneration,
                      ...tokens,
                      headed: !prepared.session.headless,
                      transport: browserRuntimeTransport(prepared.session, placement.transport),
                      ...(linkedComputer ? { linkedComputer } : {}),
                      ...(networkRoute ? { networkRoute } : {}),
                      restore: restore!,
                    });
                  },
                );
              } catch (error) {
                // A provisioning failure propagates unchanged: no controller
                // was reached, so there is nothing to clean up.
                if (!client) throw error;
                if (capacitySuspendAllowed && browserControllerCapacityExhausted(error)) {
                  capacitySuspendAllowed = false;
                  throw new BrowserControllerFull(
                    placement.placement,
                    placement.placementInstanceId,
                    {
                      operationId: request.operationId,
                      browserSessionId,
                      sandboxGroupId: placement.controllerHostSandboxGroupId,
                      controllerGeneration,
                    },
                  );
                }
                if (!isDefiniteBrowserControllerFailure(error)) throw error;
                try {
                  await client.endSession(
                    { browserSessionId, controllerGeneration },
                    { removeState: true },
                  );
                } catch (cleanupError) {
                  if (
                    !(
                      cleanupError instanceof BrowserControlRequestError &&
                      cleanupError.status === 404
                    )
                  ) {
                    throw cleanupError;
                  }
                }
                const failed = await failBrowserSessionResume(deps.db, {
                  accountId: grant.accountId,
                  workspaceId,
                  operationId: request.operationId,
                  browserSessionId,
                  controllerGeneration,
                  error: interactionFailure(error),
                });
                if (interactionHeld) {
                  await releaseInteractionHolder(
                    deps,
                    grant,
                    workspaceId,
                    browserSessionId,
                    placement.controllerHostSandboxGroupId,
                  ).catch(() => undefined);
                }
                return failed;
              }
              return await activateBrowserSession(deps.db, {
                accountId: grant.accountId,
                workspaceId,
                operationId: request.operationId,
                browserSessionId,
                controller: {
                  controllerId: "opengeni-browserd",
                  controllerGeneration,
                  placementInstanceId: placement.placementInstanceId,
                },
                engineVersion: null,
              });
            },
          );
        let response: Awaited<ReturnType<typeof resumeOnPlacement>>;
        try {
          response = await resumeOnPlacement();
        } catch (error) {
          if (!(error instanceof BrowserControllerFull)) throw error;
          await suspendLeastRecentlyUsedBrowser(
            context,
            grant,
            workspaceId,
            sourceSession,
            error,
            browserSessionId,
          );
          await prepareRestore();
          response = await resumeOnPlacement();
        }
        const parsed = BrowserSessionMutationResponse.parse(response);
        observeLifecycleResult(deps.observability, startedAtMs, parsed);
        return context.json(parsed, 200);
      } catch (error) {
        if (preparedForDispatch) {
          // A no-op once the operation was dispatched: that path settles
          // through the controller result or the transition reaper instead.
          await failBrowserSessionResumePreparation(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            operationId: request.operationId,
            browserSessionId,
            error: interactionFailure(error),
          }).catch(() => undefined);
        }
        throw browserRouteError(error);
      } finally {
        // Assigned inside prepareRestore, which narrowing cannot follow.
        const preparedRestore = restore as RestorePlacementBrowserStateInput | null;
        preparedRestore?.dataKey.fill(0);
        preparedRestore?.aad.fill(0);
      }
    },
  );

  /** Run one working-copy request against the controller generation that owns
   * the browser's working copy, with the same session.control and placement
   * authority as any browser control: an active browser's own generation, or
   * for a lost browser the retained generation a resume would continue from.
   * The controller binds every request to the exact controller authority the
   * copy was launched under. Never replayed. */
  async function withPreservedWorkingCopy<T>(
    context: Context,
    callback: PreservedWorkingCopyCallback<T>,
  ): Promise<T> {
    const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
      context,
      "sessions:control",
    );
    const current = await getBrowserSessionControlRecord(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      browserSessionId,
    }).catch((error: unknown) => {
      throw browserRouteError(error);
    });
    if (current.session.lifecycle === "lost") {
      return await withLostBrowserWorkingCopy(
        context,
        grant,
        workspaceId,
        browserSessionId,
        callback,
      );
    }
    return await withActiveBrowserController(
      context,
      grant,
      workspaceId,
      browserSessionId,
      "session.control",
      "browser.control",
      async ({ client, record, binding, placement }) => {
        const transport = browserRuntimeTransport(record.session, placement.transport);
        if (
          transport.kind !== "managed" ||
          transport.engine !== "chromium" ||
          transport.ephemeralPartition ||
          browserSessionStorageMode(record.session) !== "private_profile"
        ) {
          throw new BrowserSessionStateError(WORKING_COPY_REFUSAL_EXPLANATIONS.unsupported_browser);
        }
        const tokens = deriveBrowserSessionControllerTokens({
          rootSecret: browserAuthorityRoot(deps),
          accountId: grant.accountId,
          workspaceId,
          placement: record.session.placement,
          placementInstanceId: placement.placementInstanceId,
          browserSessionId,
          controllerGeneration: binding.controllerGeneration,
          tokenGeneration: record.tokenGeneration,
        });
        return await callback({
          grant,
          workspaceId,
          browserSessionId,
          client,
          authority: {
            browserSessionId,
            controllerGeneration: binding.controllerGeneration,
            tokenGeneration: record.tokenGeneration,
            ...tokens,
          },
        });
      },
      // A missing controller session is the state being inspected; never
      // launch anything to "recover" it here.
      false,
    );
  }

  /** A lost browser has no active controller binding, but the controller
   * generation of its last launch still owns its working copy, exactly as
   * resume uses it. Inspecting, adopting or reverting that copy goes to the
   * same generation; nothing is launched here. */
  async function withLostBrowserWorkingCopy<T>(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    browserSessionId: string,
    callback: PreservedWorkingCopyCallback<T>,
  ): Promise<T> {
    try {
      return await reachLostBrowserWorkingCopy(
        context,
        grant,
        workspaceId,
        browserSessionId,
        callback,
      );
    } catch (error) {
      throw browserRouteError(error);
    }
  }

  async function reachLostBrowserWorkingCopy<T>(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    browserSessionId: string,
    callback: PreservedWorkingCopyCallback<T>,
  ): Promise<T> {
    const record = await getBrowserSessionControlRecord(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      browserSessionId,
    });
    await authorizeSourceSession(deps, grant, record.sourceSessionId, "session.control");
    const expired = await getExpiredBrowserSessionResume(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      browserSessionId,
    });
    if (!expired?.controllerGeneration) {
      throw new BrowserSessionStateError(
        "This browser was lost without a working copy that its controller still keeps, so there is nothing to inspect or adopt. Resume it to restore its last saved state.",
      );
    }
    const retained = record.session.controller;
    if (
      retained ? retained.controllerGeneration !== expired.controllerGeneration : expired.settleable
    ) {
      throw new BrowserSessionStateError("BrowserSession controller authority changed");
    }
    const sourceSession = await requireSourceSession(deps, workspaceId, record.sourceSessionId);
    if (
      record.session.placement.kind === "connected_machine" &&
      sourceSession.activeSandboxId !== record.session.placement.sandboxId
    ) {
      throw new BrowserSessionStateError(
        "The chat that created this browser is no longer attached to the machine the browser ran on, so its working copy cannot be reached. Attach the chat to that machine again first.",
      );
    }
    return await withBrowserPlacement(
      sourceSession,
      grant,
      record.session.placement,
      record.deviceWorkspaceId,
      retained?.placementInstanceId ?? null,
      "browser.control",
      context.req.raw.signal,
      async (placement) => {
        const transport = browserRuntimeTransport(record.session, placement.transport);
        if (
          transport.kind !== "managed" ||
          transport.engine !== "chromium" ||
          transport.ephemeralPartition ||
          browserSessionStorageMode(record.session) !== "private_profile"
        ) {
          throw new BrowserSessionStateError(WORKING_COPY_REFUSAL_EXPLANATIONS.unsupported_browser);
        }
        const client = await provisionController(
          deps,
          grant,
          record,
          placement,
          requestOrigin(context, deps.settings),
        );
        const tokens = deriveBrowserSessionControllerTokens({
          rootSecret: browserAuthorityRoot(deps),
          accountId: grant.accountId,
          workspaceId,
          placement: record.session.placement,
          placementInstanceId: placement.placementInstanceId,
          browserSessionId,
          controllerGeneration: expired.controllerGeneration!,
          tokenGeneration: record.tokenGeneration,
        });
        return await callback({
          grant,
          workspaceId,
          browserSessionId,
          client,
          authority: {
            browserSessionId,
            controllerGeneration: expired.controllerGeneration!,
            tokenGeneration: record.tokenGeneration,
            ...tokens,
          },
        });
      },
      false,
    );
  }

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/working-copy/inspection",
    async (context) => {
      await parseEmptyJsonBody(context);
      const result = await withPreservedWorkingCopy(
        context,
        async ({ grant, workspaceId, browserSessionId, client, authority }) => {
          const inspection = await client.inspectWorkingCopy(authority);
          const checkpoint = await getBrowserPrivateCheckpointAuthority(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
          }).catch(() => null);
          return BrowserWorkingCopyInspection.parse({
            browserSessionId,
            controllerGeneration: authority.controllerGeneration,
            adoptable: inspection.refusal === null && inspection.manifest !== null,
            refusal: inspection.refusal,
            explanation: workingCopyInspectionExplanation(
              inspection,
              checkpoint?.createdAt ?? null,
            ),
            manifest: inspection.manifest,
            platformSupported: inspection.platformSupported,
            profileIdentityMatches: inspection.profileIdentityMatches,
            profileInUse: inspection.profileInUse,
            receipt: inspection.receipt,
            freshness: { status: "unknown", latestCheckpointAt: checkpoint?.createdAt ?? null },
            activeAdoption: inspection.activeAdoption,
          });
        },
      );
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/working-copy/adoptions",
    async (context) => {
      const request = await parseJsonBody(context, BrowserWorkingCopyAdoptionRequest);
      const result = await withPreservedWorkingCopy(
        context,
        async ({ grant, workspaceId, browserSessionId, client, authority }) => {
          // Durable attribution before any effect: who selected which exact
          // bytes as this browser's state. Freshness stays unproven.
          await recordAuditEvent(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            subjectId: grant.subjectId,
            action: "browserSession.working_copy.adoption_requested",
            targetType: "browser_session",
            targetId: browserSessionId,
            metadata: {
              operationId: request.operationId,
              manifestDigest: request.manifestDigest,
              controllerGeneration: authority.controllerGeneration,
            },
          });
          const adoption = await client.adoptWorkingCopy({
            ...authority,
            operationId: request.operationId,
            manifestDigest: request.manifestDigest,
          });
          await recordAuditEvent(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            subjectId: grant.subjectId,
            action: "browserSession.working_copy.adoption_settled",
            targetType: "browser_session",
            targetId: browserSessionId,
            metadata: {
              operationId: adoption.operationId,
              manifestDigest: adoption.manifestDigest,
              controllerGeneration: adoption.controllerGeneration,
              phase: adoption.phase,
              failureCode: adoption.failureCode,
            },
          }).catch(() => undefined);
          return BrowserWorkingCopyAdoptionResponse.parse({
            inFlight: false,
            adoption: publicWorkingCopyAdoption(adoption),
            explanation: workingCopyAdoptionExplanation(false, adoption),
          });
        },
      );
      return context.json(result);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/working-copy/adoptions/:operationId",
    async (context) => {
      const operationId = requireUuidParam(context, "operationId");
      const result = await withPreservedWorkingCopy(context, async ({ client, authority }) => {
        const status = await client.workingCopyAdoption(authority, operationId);
        return BrowserWorkingCopyAdoptionResponse.parse({
          inFlight: status.inFlight,
          adoption: status.adoption ? publicWorkingCopyAdoption(status.adoption) : null,
          explanation: workingCopyAdoptionExplanation(status.inFlight, status.adoption),
        });
      });
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/working-copy/adoptions/:operationId/revert",
    async (context) => {
      const operationId = requireUuidParam(context, "operationId");
      const result = await withPreservedWorkingCopy(
        context,
        async ({ grant, workspaceId, browserSessionId, client, authority }) => {
          await recordAuditEvent(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            subjectId: grant.subjectId,
            action: "browserSession.working_copy.revert_requested",
            targetType: "browser_session",
            targetId: browserSessionId,
            metadata: { operationId, controllerGeneration: authority.controllerGeneration },
          });
          const status = await client.revertWorkingCopyAdoption({ ...authority, operationId });
          await recordAuditEvent(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            subjectId: grant.subjectId,
            action: "browserSession.working_copy.revert_settled",
            targetType: "browser_session",
            targetId: browserSessionId,
            metadata: {
              operationId,
              controllerGeneration: authority.controllerGeneration,
              phase: status.adoption?.phase ?? null,
              failureCode: status.adoption?.failureCode ?? null,
            },
          }).catch(() => undefined);
          return BrowserWorkingCopyAdoptionResponse.parse({
            inFlight: status.inFlight,
            adoption: status.adoption ? publicWorkingCopyAdoption(status.adoption) : null,
            explanation: workingCopyAdoptionExplanation(status.inFlight, status.adoption),
          });
        },
      );
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/end",
    async (context) => {
      const workspaceId = context.req.param("workspaceId");
      const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:control");
      const browserSessionId = requireUuidParam(context, "browserSessionId");
      const request = await parseJsonBody(context, BrowserSessionLifecycleRequest);
      const startedAtMs = performance.now();
      const origin = requestOrigin(context, deps.settings);
      let endPreparation: {
        restoreLifecycle: BrowserSessionValue["lifecycle"];
        restoreFailureCode: string | null;
        expectedControllerGeneration: string | null;
      } | null = null;
      try {
        let before = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        });
        await authorizeSourceSession(deps, grant, before.sourceSessionId, "session.control");
        // Still live on a machine its task has since moved away from: record
        // the move now, so the retirement below ends it there in this call.
        if (
          before.session.lifecycle !== "lost" &&
          before.session.controller &&
          before.session.placement?.kind === "connected_machine" &&
          (await recordSourcePlacementMove(channelServices, {
            grant,
            sourceSessionId: before.sourceSessionId,
            connectedSandboxId: before.session.placement.sandboxId,
          }))
        ) {
          before = await getBrowserSessionControlRecord(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
          });
        }
        if (
          before.session.lifecycle === "lost" &&
          before.session.failureCode === "source_placement_changed" &&
          before.session.controller &&
          before.session.placement?.kind === "connected_machine"
        ) {
          // The task moved away, so its route no longer reaches the machine
          // this browser still runs on. Stop it there first; the end below
          // then has no controller left to reach.
          const retirement = await retireFormerPlacementControllers(channelServices, {
            grant,
            sourceSessionId: before.sourceSessionId,
            connectedSandboxId: before.session.placement.sandboxId,
            browserSessionIds: [browserSessionId],
            computerSessionIds: [],
            origin,
            waitSignal: context.req.raw.signal,
          });
          if (retirement.remaining.length > 0) {
            throw new BrowserSessionStateError(
              "This browser still runs on the Connected Machine its task moved away from, and that machine could not stop it now. Try again when the machine is online.",
            );
          }
          // The machine is reachable again: end anything else this task left
          // on it too, without making this request wait.
          void retireSourceFormerPlacements(channelServices, {
            grant,
            sourceSessionId: before.sourceSessionId,
            origin: null,
          });
          before = await getBrowserSessionControlRecord(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
          });
        }
        if (before.session.controller) browserAuthorityRoot(deps);
        const prepared = await prepareBrowserSessionEnd(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
          operationId: request.operationId,
          actorSubjectId: grant.subjectId,
          expectedLifecycle: before.session.lifecycle,
          expectedFailureCode: before.session.failureCode,
          expectedControllerGeneration: before.session.controller?.controllerGeneration ?? null,
        });
        if (isTerminalOperation(prepared.operation.state)) {
          if (prepared.operation.state === "completed") {
            await releaseInteractionHolder(
              deps,
              grant,
              workspaceId,
              browserSessionId,
              before.controllerHostSandboxGroupId,
            ).catch(() => undefined);
            await releaseBrowserPasskeys(interactionSecrets, browserSessionId);
          }
          const parsed = BrowserSessionMutationResponse.parse(prepared);
          observeLifecycleResult(deps.observability, startedAtMs, parsed);
          return context.json(parsed, 200);
        }
        if (before.session.lifecycle !== "ending") {
          endPreparation = {
            restoreLifecycle: before.session.lifecycle,
            restoreFailureCode: before.session.failureCode,
            expectedControllerGeneration: before.session.controller?.controllerGeneration ?? null,
          };
        }

        const record = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
          operationId: request.operationId,
        });
        const binding = record.session.controller;
        // A browser with no controller, or whose controller can never be
        // reached again, ends here: nothing physical remains to clean up, and
        // completing under the bound generation fences that controller off.
        if (
          !binding ||
          (await browserControllerGone(
            grant,
            workspaceId,
            record.session.placement,
            record.deviceWorkspaceId,
            binding.placementInstanceId,
          ))
        ) {
          const completed = await completeBrowserSessionEnd(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            operationId: request.operationId,
            browserSessionId,
            expectedControllerGeneration: binding?.controllerGeneration ?? null,
          });
          await releaseInteractionHolder(
            deps,
            grant,
            workspaceId,
            browserSessionId,
            record.controllerHostSandboxGroupId,
          ).catch(() => undefined);
          await releaseBrowserPasskeys(interactionSecrets, browserSessionId);
          const parsed = BrowserSessionMutationResponse.parse(completed);
          observeLifecycleResult(deps.observability, startedAtMs, parsed);
          return context.json(parsed, 200);
        }
        const sourceSession = await requireSourceSession(deps, workspaceId, record.sourceSessionId);
        const response = await withBrowserPlacement(
          sourceSession,
          grant,
          record.session.placement,
          record.deviceWorkspaceId,
          binding.placementInstanceId,
          "browser.end",
          context.req.raw.signal,
          async (placement) => {
            await dispatchBrowserSessionOperation(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              operationId: request.operationId,
              browserSessionId,
              controllerGeneration: binding.controllerGeneration,
            });
            // The heartbeat covers everything after dispatch, including
            // provisioning the controller.
            await withInteractionHolderHeartbeat(
              deps,
              {
                grant,
                workspaceId,
                sandboxGroupId: placement.controllerHostSandboxGroupId,
                holderId: interactionHolderId(browserSessionId),
                operationId: request.operationId,
                resourceId: browserSessionId,
                controllerGeneration: binding.controllerGeneration,
              },
              async () => {
                const client = await provisionController(deps, grant, record, placement, origin);
                try {
                  await endBrowserDiscardingLostRuntime(client, {
                    browserSessionId,
                    controllerGeneration: binding.controllerGeneration,
                  });
                } catch (error) {
                  // Physical absence already satisfies an exact end. A stale live
                  // generation is 409 and transport uncertainty remains retryable.
                  if (!(error instanceof BrowserControlRequestError && error.status === 404)) {
                    throw error;
                  }
                }
              },
            );
            const completed = await completeBrowserSessionEnd(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              operationId: request.operationId,
              browserSessionId,
              expectedControllerGeneration: binding.controllerGeneration,
            });
            await releaseInteractionHolder(
              deps,
              grant,
              workspaceId,
              browserSessionId,
              placement.controllerHostSandboxGroupId,
            ).catch(() => undefined);
            await releaseBrowserPasskeys(interactionSecrets, browserSessionId);
            return completed;
          },
        );
        const parsed = BrowserSessionMutationResponse.parse(response);
        observeLifecycleResult(deps.observability, startedAtMs, parsed);
        return context.json(parsed, 200);
      } catch (error) {
        if (endPreparation) {
          await failPreparedBrowserSessionEnd(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
            operationId: request.operationId,
            ...endPreparation,
            error: interactionFailure(error),
          });
        }
        throw browserRouteError(error);
      }
    },
  );

  /**
   * Makes room on a full browser controller by saving and stopping its least
   * recently used idle browser, which resumes from that save on its next open.
   * Each candidate is claimed atomically: one used again, already saved by a
   * concurrent create, or with an operation in flight is skipped. A save that
   * fails after it was handed to the controller leaves its browser for the
   * normal transition reconciliation and stops the search, so one outage
   * strands at most one browser. When nothing is freed the retried create or
   * resume reports the controller's own capacity error. The waiting create or
   * resume keeps its operation and holder alive throughout.
   */
  async function suspendLeastRecentlyUsedBrowser(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    routeSourceSession: Session,
    full: BrowserControllerFull,
    creatingBrowserSessionId: string,
  ): Promise<boolean> {
    if (!deps.objectStorage) return false;
    return await withInteractionHolderHeartbeat(
      deps,
      {
        grant,
        workspaceId,
        sandboxGroupId: full.waiting.sandboxGroupId,
        holderId: interactionHolderId(full.waiting.browserSessionId),
        operationId: full.waiting.operationId,
        resourceId: full.waiting.browserSessionId,
        controllerGeneration: full.waiting.controllerGeneration,
      },
      async () =>
        await saveLeastRecentlyUsedBrowser(
          context,
          grant,
          workspaceId,
          routeSourceSession,
          full,
          creatingBrowserSessionId,
        ),
    );
  }

  async function saveLeastRecentlyUsedBrowser(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    routeSourceSession: Session,
    full: BrowserControllerFull,
    creatingBrowserSessionId: string,
  ): Promise<boolean> {
    const idleBefore = Date.now() - BROWSER_CAPACITY_SUSPEND_IDLE_MS;
    const candidates = await listBrowserCapacitySuspendCandidates(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      placement: full.placement,
      placementInstanceId: full.placementInstanceId,
      excludeBrowserSessionId: creatingBrowserSessionId,
      idleBefore: new Date(idleBefore),
      limit: BROWSER_CAPACITY_SUSPEND_CANDIDATES,
    }).catch((error: unknown) => {
      console.warn("browser.capacity_suspend_failed", {
        workspaceId,
        browserSessionId: null,
        failure: interactionFailure(error),
      });
      return [];
    });
    for (const browserSessionId of candidates) {
      try {
        const before = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        });
        if (
          before.session.lifecycle !== "active" ||
          !before.session.controller ||
          Date.parse(before.session.lastUsedAt) >= idleBefore
        ) {
          continue;
        }
        const result = await suspendBrowserSessionCheckpoint(
          context,
          grant,
          workspaceId,
          browserSessionId,
          randomUUID(),
          {
            before,
            recoverController: false,
            capacityFor: {
              routeSourceSession,
              claim: {
                idleBefore: new Date(idleBefore),
                placementInstanceId: full.placementInstanceId,
                controllerGeneration: before.session.controller.controllerGeneration,
              },
            },
          },
        );
        if (result.operation.state === "completed") {
          console.info("browser.capacity_suspended", {
            workspaceId,
            browserSessionId,
            forBrowserSessionId: creatingBrowserSessionId,
          });
          return true;
        }
        if (result.session.lifecycle !== "active") return false;
      } catch (error) {
        if (error instanceof BrowserCapacitySuspendClaimRejectedError) continue;
        console.warn("browser.capacity_suspend_failed", {
          workspaceId,
          browserSessionId,
          failure: interactionFailure(error),
        });
        // A save restored before it reached the controller leaves the browser
        // active; any other outcome is uncertain, so stop here.
        const after = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        }).catch(() => null);
        if (after?.session.lifecycle !== "active") return false;
      }
    }
    return false;
  }

  /**
   * Saves one browser's encrypted private working copy and stops its process.
   * The suspend route and capacity eviction share this. `routeSourceSession`
   * reaches the placement through another chat on the same machine, because
   * the browser's own chat may have moved elsewhere since it last used it.
   */
  async function suspendBrowserSessionCheckpoint(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    browserSessionId: string,
    operationId: string,
    checkpoint: {
      before: BrowserSessionControlRecord;
      recoverController: boolean;
      /** Set for a save the system makes to free capacity: the browser's own
       * chat may have moved, and neither the save nor the downloads it keeps
       * belong to the caller. */
      capacityFor?: { routeSourceSession: Session; claim: BrowserCapacitySuspendClaim };
    },
  ): Promise<ReturnType<typeof BrowserSessionMutationResponse.parse>> {
    const origin = requestOrigin(context, deps.settings);
    const { before } = checkpoint;
    let preparedForDispatch = false;
    try {
      if (!before.session.capabilities.privateCheckpoint) {
        throw new BrowserControlUnsupportedError(
          "this browser placement does not support private checkpoint suspension",
        );
      }
      browserAuthorityRoot(deps);
      if (!deps.objectStorage) {
        throw new HTTPException(503, {
          message: "browser state storage is not configured",
        });
      }
      if (checkpoint.recoverController) {
        await recoverRestartedBrowserControllerBeforeSuspend(context, grant, workspaceId, before);
      }
      const prepared = await prepareBrowserSessionSuspend(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        browserSessionId,
        operationId,
        actorSubjectId: checkpoint.capacityFor ? BROWSER_CAPACITY_SUSPEND_ACTOR : grant.subjectId,
        ...(checkpoint.capacityFor ? { capacityClaim: checkpoint.capacityFor.claim } : {}),
      });
      if (isTerminalOperation(prepared.operation.state)) {
        if (prepared.operation.state === "completed") {
          await finishSuspendedBrowserControllerCleanup(
            context,
            grant,
            workspaceId,
            browserSessionId,
          );
          return BrowserSessionMutationResponse.parse({
            session: (
              await getBrowserSessionControlRecord(deps.db, {
                accountId: grant.accountId,
                workspaceId,
                browserSessionId,
              })
            ).session,
            operation: prepared.operation,
          });
        }
        return BrowserSessionMutationResponse.parse(prepared);
      }

      preparedForDispatch = true;

      const record = await getBrowserSessionControlRecord(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        browserSessionId,
        operationId,
      });
      const binding = record.session.controller;
      if (!binding) {
        throw new BrowserSessionStateError("BrowserSession suspension controller is absent");
      }
      const sourceSession =
        checkpoint.capacityFor?.routeSourceSession ??
        (await requireSourceSession(deps, workspaceId, record.sourceSessionId));
      const response = await withBrowserPlacement(
        sourceSession,
        grant,
        record.session.placement,
        record.deviceWorkspaceId,
        binding.placementInstanceId,
        "browser.suspend",
        context.req.raw.signal,
        async (placement) => {
          const objectStorage = deps.objectStorage!;
          const rootKey = requireBrowserStateRoot(deps);
          const objectKey = browserStateObjectKey(workspaceId, operationId);
          const dataKey = deriveBrowserStateDataKey(rootKey, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
            operationId: operationId,
            objectKey,
          });
          const aad = browserStateArtifactAad({
            accountId: grant.accountId,
            workspaceId,
            objectKey,
          });
          try {
            // Everything that can fail before the controller is asked to
            // capture runs while the operation is still only prepared, so a
            // failure here restores the browser instead of stranding it.
            const signed = await objectStorage.createPutUrl({
              key: objectKey,
              contentType: BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
              audience: signedUrlAudienceForPlacement(record.session.placement),
            });
            const client = await provisionController(deps, grant, record, placement, origin);
            await dispatchBrowserSessionOperation(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              operationId: operationId,
              browserSessionId,
              controllerGeneration: binding.controllerGeneration,
              stateUpload: {
                objectKey,
                cleanupAfter: new Date(Date.now() + BROWSER_STATE_UPLOAD_CLEANUP_GRACE_MS),
              },
            });
            let receipt: PlacementBrowserStateCaptureReceipt;
            try {
              // The heartbeat covers everything after dispatch, including
              // keeping downloads, so slow exports never let the transition
              // expire before capture.
              receipt = await withInteractionHolderHeartbeat(
                deps,
                {
                  grant,
                  workspaceId,
                  sandboxGroupId: record.controllerHostSandboxGroupId,
                  holderId: interactionHolderId(browserSessionId),
                  operationId: operationId,
                  resourceId: browserSessionId,
                  controllerGeneration: binding.controllerGeneration,
                },
                async () => {
                  // Suspension removes the browser's working directory, and
                  // with it every download. Keep completed ones as files,
                  // private to the chat's owner when the chat is private.
                  // Best effort: never throws.
                  await retainBrowserDownloads(
                    grant,
                    workspaceId,
                    record,
                    binding,
                    placement,
                    client,
                    { subjectId: checkpoint.capacityFor ? null : grant.subjectId },
                  );
                  return await client.captureState({
                    browserSessionId,
                    controllerGeneration: binding.controllerGeneration,
                    operationId: operationId,
                    objectKey,
                    afterCapture: "stop",
                    dataKey,
                    aad,
                    upload: {
                      url: signed.url,
                      requiredHeaders: signed.requiredHeaders,
                      expiresAt: signed.expiresAt.toISOString(),
                    },
                  });
                },
              );
            } catch (error) {
              const failed = await settleBrowserSessionSuspensionCaptureFailure(
                deps,
                {
                  accountId: grant.accountId,
                  workspaceId,
                  operationId: operationId,
                  browserSessionId,
                  controllerGeneration: binding.controllerGeneration,
                },
                error,
              );
              if (failed) return failed;
              throw error;
            }
            const materialization = browserRevisionMaterialization(
              receipt.manifest,
              record.session.placement,
            );
            const manifestDigest = browserStateManifestDigest(receipt.manifest);
            const encryptedDataKey = wrapBrowserStateDataKey(rootKey, dataKey, {
              accountId: grant.accountId,
              workspaceId,
              objectKey,
              artifactDigest: receipt.artifactDigest,
              contentDigest: receipt.contentDigest,
            });
            const committed = await commitBrowserSessionSuspension(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              operationId: operationId,
              browserSessionId,
              controllerGeneration: binding.controllerGeneration,
              artifact: {
                kind: "chromium_profile",
                format: receipt.format,
                artifactDigest: receipt.artifactDigest,
                contentDigest: receipt.contentDigest,
                manifestDigest,
                objectKey,
                encryptedDataKey,
                sizeBytes: receipt.sizeBytes,
                materialization,
              },
            });
            await endCapturedBrowserController(client, browserSessionId, binding);
            await clearSuspendedBrowserSessionController(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              browserSessionId,
              expectedControllerGeneration: binding.controllerGeneration,
            });
            await releaseInteractionHolder(
              deps,
              grant,
              workspaceId,
              browserSessionId,
              record.controllerHostSandboxGroupId,
            );
            return BrowserSessionMutationResponse.parse({
              session: (
                await getBrowserSessionControlRecord(deps.db, {
                  accountId: grant.accountId,
                  workspaceId,
                  browserSessionId,
                })
              ).session,
              operation: committed.operation,
            });
          } finally {
            dataKey.fill(0);
            rootKey.fill(0);
            aad.fill(0);
          }
        },
      );
      return BrowserSessionMutationResponse.parse(response);
    } catch (error) {
      if (preparedForDispatch) {
        await failPreparedBrowserSessionSuspend(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
          operationId,
          error: interactionFailure(error),
        });
      }
      throw error;
    }
  }

  async function withBrowserPlacement<T>(
    sourceSession: Session,
    grant: AccessGrant,
    expectedPlacement: InteractionPlacement | null,
    /** An existing session's attached profile workspace, which pins the
     *  profile copy its controller check uses. */
    expectedDeviceWorkspaceId: string | null,
    expectedPlacementInstanceId: string | null,
    operation: ChannelAOperation,
    waitSignal: AbortSignal,
    callback: (placement: BrowserPlacement) => Promise<T>,
    allowOperationReplay = true,
  ): Promise<T> {
    if (expectedPlacement?.kind === "attached_device") {
      waitSignal.throwIfAborted();
      // Personal machines are controlled only for their owner, as everywhere else.
      const viewer = await attachedBrowserViewer(deps, grant, sourceSession.workspaceId);
      const device = await getAttachedBrowserDevice(deps.db, {
        ...viewer,
        deviceId: expectedPlacement.deviceId,
        deviceWorkspaceId: expectedDeviceWorkspaceId,
      });
      if (device.state !== "connected") {
        recordAttachedBrowserUnavailable(deps.observability, "disconnected");
        throw new BrowserSessionStateError("Attached browser is disconnected");
      }
      const enrollment = await getLiveEnrollmentConnection(deps.db, viewer, device.enrollmentId);
      if (!enrollment || enrollment.status !== "active" || !enrollment.connectionInstanceId) {
        recordAttachedBrowserUnavailable(deps.observability, "machine_unavailable");
        throw new BrowserSessionStateError("Attached browser machine is unavailable");
      }
      if (!enrollment.workspaceRoot) {
        recordAttachedBrowserUnavailable(deps.observability, "no_workspace_root");
        throw new BrowserSessionStateError(
          "Attached browser machine has not reported an absolute workspace root",
        );
      }
      const placementInstanceId = attachedEndPlacementInstanceId(
        operation,
        expectedPlacementInstanceId,
        device.connectionGeneration,
      );
      const built = await buildSelfhostedBackendSession({
        workspaceId: sourceSession.workspaceId,
        // Addressed where the machine is enrolled, which can be another
        // workspace its owner allowed it in.
        controlWorkspaceId: enrollment.workspaceId,
        agentId: device.enrollmentId,
        connectionInstanceId: enrollment.connectionInstanceId,
        workspaceRoot: enrollment.workspaceRoot,
        relay: relayConfigFromSettings(deps.settings),
        controlRpcFactory: () => new NatsControlRpc(async () => deps.bus.getRequestConnection()),
        // Browser-profile generation is the physical controller fence. Epoch 0
        // deliberately addresses the enrollment itself rather than borrowing an
        // unrelated session routing epoch.
        epoch: 0,
        timeoutMs: deps.settings.sandboxSelfhostedControlTimeoutMs,
        execTimeoutMs: deps.settings.sandboxSelfhostedExecTimeoutMs,
        operationResourcePolicy: enrollment.operationPolicy,
        operationResourcePolicySupported:
          enrollment.agentCapabilities.operationResourcePolicy === true,
        operationCpuQuotaSupported: enrollment.agentCapabilities.operationCpuQuota === true,
        transactionalFsWriteSupported: enrollment.agentCapabilities.transactionalFsWrite === true,
        transactionalFsWriteMachineSupported:
          enrollment.agentCapabilities.transactionalFsWriteMachine === true,
        browserControlHttpSupported: enrollment.agentCapabilities.browserControlHttp === true,
        runAsSupported: enrollment.agentCapabilities.runAs === true,
        ...(deps.settings.agentOpStreamEnabled === true &&
        enrollment.opStream === true &&
        deps.bus.getOpStreamConnection
          ? {
              opStream: {
                transport: new NatsOpStreamTransport(
                  async () => deps.bus.getOpStreamConnection?.() ?? null,
                ),
                ...(enrollment.agentCapabilities.opRelease === true
                  ? { outputReleaseSupported: true }
                  : {}),
                connectionGeneration: String(enrollment.connectionGeneration),
              },
            }
          : {}),
      });
      waitSignal.throwIfAborted();
      return await callback({
        placement: expectedPlacement,
        controllerHostSandboxGroupId: null,
        placementInstanceId,
        session: built.session as unknown as BrowserControlPlacementSession,
        lease: null,
        transport: {
          kind: "attached_chrome",
          deviceId: device.id,
          connectionGeneration: placementInstanceId,
          browserName: device.browserName,
          browserVersion: device.browserVersion,
        },
        attachedDeviceWorkspaceId: device.workspaceId,
      });
    }
    const runWithChannelA =
      operation === "browser.read" ||
      operation === "browser.action" ||
      operation === "browser.control" ||
      operation === "browser.attach"
        ? withChannelARead
        : withChannelA;
    try {
      return await runWithChannelA(
        channelServices,
        {
          accountId: grant.accountId,
          workspaceId: sourceSession.workspaceId,
          session: sourceSession,
          subjectId: grant.subjectId,
          grant,
          waitSignal,
          operation,
          retryControllerTransport: operation === "browser.read" || operation === "browser.action",
          allowOperationReplay,
          ...(expectedPlacementInstanceId &&
          (expectedPlacement?.kind === "sandbox_group" ||
            expectedPlacement?.kind === "external_provider")
            ? { retainedInstanceId: expectedPlacementInstanceId }
            : {}),
        },
        async (handle) => {
          if (expectedPlacement?.kind === "sandbox_group") {
            if (
              sourceSession.sandboxGroupId !== expectedPlacement.sandboxGroupId ||
              !handle.lease?.instanceId
            ) {
              throw new BrowserSessionStateError("BrowserSession home placement is unavailable");
            }
            assertPlacementInstance(expectedPlacementInstanceId, handle.lease.instanceId);
            return await callback({
              placement: expectedPlacement,
              controllerHostSandboxGroupId: expectedPlacement.sandboxGroupId,
              placementInstanceId: handle.lease.instanceId,
              session: handle.homeSession,
              lease: handle.lease,
              transport: { kind: "managed" },
            });
          }

          if (expectedPlacement?.kind === "external_provider") {
            if (!handle.lease?.instanceId) {
              throw new BrowserSessionStateError(
                "Remote BrowserSession controller placement is unavailable",
              );
            }
            assertPlacementInstance(expectedPlacementInstanceId, handle.lease.instanceId);
            return await callback({
              placement: expectedPlacement,
              controllerHostSandboxGroupId: sourceSession.sandboxGroupId,
              placementInstanceId: handle.lease.instanceId,
              session: handle.homeSession,
              lease: handle.lease,
              transport: externalBrowserTransport(deps, expectedPlacement),
            });
          }

          const resolved = await handle.routingSession.prime();
          if (expectedPlacement?.kind === "connected_machine") {
            if (
              resolved.kind !== "selfhosted" ||
              resolved.sandboxId !== expectedPlacement.sandboxId
            ) {
              if (operation === "browser.create") {
                throw new HTTPException(422, {
                  message: wrongInteractionPlacementMessage(expectedPlacement.sandboxId),
                });
              }
              return await throwBrowserSourcePlacementChanged(
                grant,
                sourceSession.id,
                expectedPlacement.sandboxId,
              );
            }
            const placementInstanceId = resolved.providerInstanceId ?? expectedPlacement.sandboxId;
            assertPlacementInstance(expectedPlacementInstanceId, placementInstanceId);
            return await callback({
              placement: expectedPlacement,
              controllerHostSandboxGroupId: null,
              placementInstanceId,
              session: resolved.session as unknown as BrowserControlPlacementSession,
              lease: null,
              transport: { kind: "managed" },
            });
          }
          if (resolved.sandboxId === null) {
            if (!handle.lease?.instanceId) {
              throw new BrowserSessionStateError("BrowserSession home placement is unavailable");
            }
            if (
              resolved.providerInstanceId &&
              resolved.providerInstanceId !== handle.lease.instanceId
            ) {
              throw new BrowserSessionStateError("BrowserSession home placement fence changed");
            }
            return await callback({
              placement: {
                kind: "sandbox_group",
                sandboxGroupId: sourceSession.sandboxGroupId,
              },
              controllerHostSandboxGroupId: sourceSession.sandboxGroupId,
              placementInstanceId: handle.lease.instanceId,
              session: handle.homeSession,
              lease: handle.lease,
              transport: { kind: "managed" },
            });
          }
          if (resolved.kind === "selfhosted") {
            const placement = {
              kind: "connected_machine" as const,
              sandboxId: resolved.sandboxId,
            };
            return await callback({
              placement,
              controllerHostSandboxGroupId: null,
              placementInstanceId: resolved.providerInstanceId ?? resolved.sandboxId,
              session: resolved.session as unknown as BrowserControlPlacementSession,
              lease: null,
              transport: { kind: "managed" },
            });
          }
          throw new BrowserControlUnsupportedError(
            "browser creation on a non-home provider sandbox is not supported",
          );
        },
      );
    } catch (error) {
      if (operation !== "browser.create" || expectedPlacement?.kind !== "connected_machine")
        throw error;
      throw await wrongPlacementInsteadOfOffline(
        error,
        expectedPlacement.sandboxId,
        async () =>
          (await readActiveSandbox(deps.db, sourceSession.workspaceId, sourceSession.id))
            ?.activeSandboxId ?? null,
      );
    }
  }

  async function browserRoutePreamble(
    context: Context,
    permission: "sessions:read" | "sessions:control" | "stream:view",
  ): Promise<{
    workspaceId: string;
    grant: AccessGrant;
    browserSessionId: string;
  }> {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, permission);
    return {
      workspaceId,
      grant,
      browserSessionId: requireUuidParam(context, "browserSessionId"),
    };
  }

  function controllerOnlySession(url: string): BrowserControlPlacementSession {
    const endpoint = exposedPortEndpointFromUrl(url);
    return {
      resolveExposedPort: async (port: number) => {
        if (port !== BROWSER_CONTROL_PORT) {
          throw new BrowserControlUnsupportedError(`cached controller cannot expose port ${port}`);
        }
        return endpoint;
      },
    };
  }

  async function cachedBrowserPlacement(
    record: BrowserSessionControlRecord,
  ): Promise<BrowserPlacement | null> {
    const binding = record.session.controller;
    const sandboxGroupId = record.controllerHostSandboxGroupId;
    if (!binding || !sandboxGroupId) return null;
    const lease = await readLease(deps.db, record.session.workspaceId, sandboxGroupId);
    if (
      !lease ||
      (lease.liveness !== "warm" && lease.liveness !== "draining") ||
      lease.instanceId !== binding.placementInstanceId ||
      !lease.controllerDataPlaneUrl ||
      (lease.backend === "opensandbox" && deps.settings.openSandboxSignedEndpoints) ||
      !controllerCachedUrlIsUsable(lease.controllerDataPlaneUrl)
    ) {
      return null;
    }
    return {
      placement: record.session.placement,
      controllerHostSandboxGroupId: sandboxGroupId,
      placementInstanceId: binding.placementInstanceId,
      session: controllerOnlySession(lease.controllerDataPlaneUrl),
      lease,
      transport:
        record.session.placement.kind === "external_provider"
          ? externalBrowserTransport(deps, record.session.placement)
          : { kind: "managed" },
    };
  }

  async function cacheBrowserControllerPlacement(
    grant: AccessGrant,
    workspaceId: string,
    placement: BrowserPlacement,
  ): Promise<BrowserPlacement> {
    const sandboxGroupId = placement.controllerHostSandboxGroupId;
    if (
      !sandboxGroupId ||
      !placement.lease?.instanceId ||
      !controllerHasCacheableDataPlane(placement.session)
    ) {
      return placement;
    }
    if (placement.lease.backend === "opensandbox" && deps.settings.openSandboxSignedEndpoints) {
      if (!placement.lease.controllerDataPlaneUrl) return placement;
      const lease = await recordLeaseControllerDataPlaneUrl(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        sandboxGroupId,
        expectedEpoch: placement.lease.leaseEpoch,
        expectedInstanceId: placement.lease.instanceId,
        controllerDataPlaneUrl: null,
      });
      return lease ? { ...placement, lease } : placement;
    }
    const endpoint = await placement.session.resolveExposedPort(BROWSER_CONTROL_PORT);
    const url = buildStreamUrl(endpoint);
    if (
      !shouldPersistControllerDataPlaneUrl({
        backend: placement.lease.backend,
        signedEndpoints: deps.settings.openSandboxSignedEndpoints,
        url,
      })
    ) {
      return placement;
    }
    const lease = await recordLeaseControllerDataPlaneUrl(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      sandboxGroupId,
      expectedEpoch: placement.lease.leaseEpoch,
      expectedInstanceId: placement.lease.instanceId,
      controllerDataPlaneUrl: url,
    });
    if (!lease) return placement;
    if (!controllerCacheAllowsHostFetch(url)) {
      return { ...placement, lease };
    }
    return { ...placement, session: controllerOnlySession(url), lease };
  }

  async function withBrowserCreationController<T>(
    routeDeps: ApiRouteDeps,
    grant: AccessGrant,
    workspaceId: string,
    placement: BrowserPlacement,
    adminToken: string,
    origin: string | null,
    operation: (client: BrowserControlClient) => Promise<T>,
  ): Promise<T> {
    const sandboxGroupId = placement.controllerHostSandboxGroupId;
    const cachedUrl = placement.lease?.controllerDataPlaneUrl;
    return await withCachedController({
      cachedUrl:
        sandboxGroupId &&
        cachedUrl &&
        !(
          placement.lease?.backend === "opensandbox" &&
          routeDeps.settings.openSandboxSignedEndpoints
        ) &&
        controllerCachedUrlIsUsable(cachedUrl)
          ? cachedUrl
          : null,
      createCachedClient: (url) =>
        new BrowserControlClient(controllerOnlySession(url), { adminToken }),
      prepareCachedClient: async (client) => {
        if (origin) await client.addAllowedOrigins([origin]);
      },
      invalidateCachedUrl: async () => {
        if (!sandboxGroupId || !placement.lease) return;
        await recordLeaseControllerDataPlaneUrl(routeDeps.db, {
          accountId: grant.accountId,
          workspaceId,
          sandboxGroupId,
          expectedEpoch: placement.lease.leaseEpoch,
          expectedInstanceId: placement.placementInstanceId,
          controllerDataPlaneUrl: null,
        });
      },
      provisionClient: async () => {
        const { client } = await provisionBrowserControlClient(placement.session, {
          adminToken,
          nativeAuthority: nativeBrowserControllerAuthority(workspaceId, placement),
          ...(origin ? { allowedOrigins: [origin] } : {}),
        });
        return client;
      },
      use: operation,
    });
  }

  /** Downloads kept as workspace files for this browser, and whether no
   * controller runs it now (so only kept downloads can be read). */
  async function retainedDownloadsFor(
    grant: AccessGrant,
    workspaceId: string,
    browserSessionId: string,
    downloadId?: string,
  ) {
    const record = await getBrowserSessionControlRecord(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      browserSessionId,
    });
    const notRunning = record.session.lifecycle !== "active" || !record.session.controller;
    // Kept downloads may be private to the chat's owner: authorize the chat
    // before reading them as that owner, running or not.
    await authorizeSourceSession(deps, grant, record.sourceSessionId, "session.read");
    const scope = { accountId: grant.accountId, workspaceId, browserSessionId };
    // A private chat's kept downloads are files private to its owner.
    const owner = await getBrowserDownloadPrivateOwner(deps.db, {
      ...scope,
      sourceSessionId: record.sourceSessionId,
    });
    const downloads = await withBrowserDownloadFileOwner(owner, async () =>
      downloadId
        ? [await getRetainedBrowserDownload(deps.db, { ...scope, downloadId })].filter(
            (entry) => entry !== null,
          )
        : await listRetainedBrowserDownloads(deps.db, scope),
    );
    return { notRunning, downloads };
  }

  /** Keep a running browser's completed downloads as workspace files before
   * suspension removes its working directory. Never blocks the suspension. */
  async function retainBrowserDownloads(
    grant: AccessGrant,
    workspaceId: string,
    record: BrowserSessionControlRecord,
    binding: NonNullable<BrowserSessionControlRecord["session"]["controller"]>,
    placement: BrowserPlacement,
    client: BrowserControlClient,
    attribution: { subjectId: string | null },
  ): Promise<void> {
    const objectStorage = deps.objectStorage;
    if (!objectStorage || !record.session.capabilities.downloads) return;
    const browserSessionId = record.session.id;
    try {
      const source = client.sessionClient({
        reference: { browserSessionId, controllerGeneration: binding.controllerGeneration },
        ...deriveBrowserSessionControllerTokens({
          rootSecret: browserAuthorityRoot(deps),
          accountId: grant.accountId,
          workspaceId,
          placement: record.session.placement,
          placementInstanceId: placement.placementInstanceId,
          browserSessionId,
          controllerGeneration: binding.controllerGeneration,
          tokenGeneration: record.tokenGeneration,
        }),
      });
      const result = await retainCompletedBrowserDownloads(
        { db: deps.db, settings: deps.settings, objectStorage },
        {
          accountId: grant.accountId,
          workspaceId,
          subjectId: attribution.subjectId,
          browserSessionId,
          sourceSessionId: record.sourceSessionId,
          source,
          uploadAudience: signedUrlAudienceForPlacement(record.session.placement),
        },
      );
      for (const failure of result.failed) {
        console.warn("browser.download_retention_failed", {
          workspaceId,
          browserSessionId,
          ...failure,
        });
      }
    } catch (error) {
      console.warn("browser.download_retention_failed", {
        workspaceId,
        browserSessionId,
        downloadId: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function withActiveBrowserController<T>(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    browserSessionId: string,
    authorizationOperation: SessionAuthorizationOperation,
    channelOperation: ChannelAOperation,
    callback: ActiveBrowserControllerCallback<T>,
    recoverMissing = true,
    stages?: InteractionRouteStages,
  ): Promise<T> {
    // The source-session check and the machine-route check that follows it
    // prove the same live agent attempt; they share those reads. Everything
    // from the controller call onward reads fresh.
    return await withSessionAuthorizationReadReuse((authorizationReads) =>
      withActiveBrowserControllerReads(
        context,
        grant,
        workspaceId,
        browserSessionId,
        authorizationOperation,
        channelOperation,
        callback,
        recoverMissing,
        stages,
        authorizationReads,
      ),
    );
  }

  async function withActiveBrowserControllerReads<T>(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    browserSessionId: string,
    authorizationOperation: SessionAuthorizationOperation,
    channelOperation: ChannelAOperation,
    callback: ActiveBrowserControllerCallback<T>,
    recoverMissing: boolean,
    stages: InteractionRouteStages | undefined,
    authorizationReads: { handOffToToolDispatch(): void },
  ): Promise<T> {
    try {
      const record = await getBrowserSessionControlRecord(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        browserSessionId,
      });
      stages?.mark("record");
      // A Connected Machine (or any placement without a cached controller URL)
      // always needs the source session; read it alongside authorization. A
      // denial still wins, and the session is only used once authorized.
      const sourceSessionNeeded =
        record.session.placement?.kind === "connected_machine" ||
        !record.controllerHostSandboxGroupId;
      const [authorized, sourceRead] = await Promise.allSettled([
        authorizeSourceSession(deps, grant, record.sourceSessionId, authorizationOperation),
        sourceSessionNeeded
          ? requireSourceSession(deps, workspaceId, record.sourceSessionId)
          : Promise.resolve(null),
      ]);
      if (authorized.status === "rejected") throw authorized.reason;
      if (sourceRead.status === "rejected") throw sourceRead.reason;
      const sourceAuthorization = authorized.value;
      stages?.mark("authorize");
      let sourceSession: Session | null = sourceRead.value;
      if (record.session.placement?.kind === "connected_machine") {
        if (sourceSession?.activeSandboxId !== record.session.placement.sandboxId) {
          return await throwBrowserSourcePlacementChanged(
            grant,
            record.sourceSessionId,
            record.session.placement.sandboxId,
          );
        }
      }
      stages?.mark("source_session");
      if (record.session.lifecycle !== "active" || !record.session.controller) {
        throw new BrowserSessionStateError("BrowserSession is not active");
      }
      const binding = record.session.controller;
      const admitted = await touchBrowserSessionController(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        browserSessionId,
        controllerGeneration: binding.controllerGeneration,
      });
      if (!admitted) {
        throw new BrowserSessionStateError("BrowserSession controller authority changed");
      }
      stages?.mark("control");
      const safelyReplayable =
        browserSessionStorageMode(record.session) !== "ephemeral_context" &&
        (channelOperation === "browser.read" || channelOperation === "browser.action");
      let controllerTransportFailed = false;
      const controllerRecoveryState = { attempted: false };
      const run = async (
        placement: BrowserPlacement,
        provisionedClient?: BrowserControlClient,
      ): Promise<T> => {
        authorizationReads.handOffToToolDispatch();
        // An active binding already proves browserd was provisioned. Reusing
        // it avoids restarting/checking the sidecar on every live input.
        const client = provisionedClient ?? connectController(deps, grant, record, placement);
        const tokens = deriveBrowserSessionControllerTokens({
          rootSecret: browserAuthorityRoot(deps),
          accountId: grant.accountId,
          workspaceId,
          placement: record.session.placement,
          placementInstanceId: placement.placementInstanceId,
          browserSessionId,
          controllerGeneration: binding.controllerGeneration,
          tokenGeneration: record.tokenGeneration,
        });
        const controller = {
          client,
          sessionClient: client.sessionClient({
            reference: {
              browserSessionId,
              controllerGeneration: binding.controllerGeneration,
            },
            ...tokens,
          }),
          record,
          binding,
          placement,
          sourceAuthorization,
        };
        let result: T;
        try {
          result = await callback(controller);
        } catch (error) {
          if (
            browserSessionStorageMode(record.session) === "ephemeral_context" &&
            (isMissingBrowserControllerSession(error) ||
              (error instanceof BrowserControlRequestError &&
                error.error.code === "controller_lost"))
          ) {
            const retired = await markEphemeralBrowserSessionLost(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              browserSessionId,
              controllerGeneration: binding.controllerGeneration,
            });
            if (retired)
              await releaseInteractionHolder(
                deps,
                grant,
                workspaceId,
                browserSessionId,
                record.controllerHostSandboxGroupId,
              );
            throw new BrowserSessionStateError(
              "Ephemeral browser context was lost; create a new BrowserSession. No identity or operation was replayed.",
            );
          }
          if (!recoverMissing || !isMissingBrowserControllerSession(error)) throw error;
          await recoverActiveBrowserController(
            deps,
            grant,
            record,
            binding,
            placement,
            client,
            tokens,
            authorizationOperation,
          );
          result = await callback(controller);
        }
        return result;
      };
      const cached = await cachedBrowserPlacement(record);
      stages?.mark("placement_cache");
      if (cached) {
        try {
          return await run(cached);
        } catch (error) {
          if (!safelyReplayable || !isRetryableControllerTransport(error)) {
            throw error;
          }
          controllerTransportFailed = true;
          await recordLeaseControllerDataPlaneUrl(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            sandboxGroupId: cached.controllerHostSandboxGroupId!,
            expectedEpoch: cached.lease!.leaseEpoch,
            expectedInstanceId: cached.placementInstanceId,
            controllerDataPlaneUrl: null,
          }).catch(() => null);
        }
      }

      sourceSession ??= await requireSourceSession(deps, workspaceId, record.sourceSessionId);
      return await withBrowserPlacement(
        sourceSession,
        grant,
        record.session.placement,
        record.deviceWorkspaceId,
        binding.placementInstanceId,
        channelOperation,
        context.req.raw.signal,
        async (placement) => {
          stages?.mark("placement_resolve");
          const use = async () => {
            const cachedPlacement = await cacheBrowserControllerPlacement(
              grant,
              workspaceId,
              placement,
            ).catch(() => placement);
            stages?.mark("placement_cache_write");
            return await run(cachedPlacement);
          };
          if (browserSessionStorageMode(record.session) === "ephemeral_context") return await use();
          return await withControllerTransportRecovery({
            channelOperation,
            placementKind: placement.placement.kind,
            recoveryState: controllerRecoveryState,
            transportAlreadyFailed: controllerTransportFailed,
            use,
            admitRecovery: async () => {
              if (
                !(await touchBrowserSessionController(deps.db, {
                  accountId: grant.accountId,
                  workspaceId,
                  browserSessionId,
                  controllerGeneration: binding.controllerGeneration,
                }))
              ) {
                throw new BrowserSessionStateError("BrowserSession controller authority changed");
              }
            },
            recover: async () => {
              // Provision and restore through the original exec-capable session;
              // the cached tunnel alone cannot start browserd or its display.
              const client = await provisionController(
                deps,
                grant,
                record,
                placement,
                requestOrigin(context, deps.settings),
              );
              await cacheBrowserControllerPlacement(grant, workspaceId, placement).catch(
                () => placement,
              );
              return await run(placement, client);
            },
          });
        },
        browserSessionStorageMode(record.session) !== "ephemeral_context",
      );
    } catch (error) {
      throw browserRouteError(error);
    }
  }

  async function throwBrowserSourcePlacementChanged(
    grant: AccessGrant,
    sourceSessionId: string,
    connectedSandboxId: string,
  ): Promise<never> {
    const reconciliation = await terminalizeStaleConnectedInteractionPlacement(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceSessionId,
      connectedSandboxId,
    });
    if (reconciliation.sourcePlacementChanged) {
      // End what the move left running on its former machines without making
      // this request wait for it. Earlier failed retirements of this task's
      // resources are retried too; a failure leaves the binding for later.
      void retireSourceFormerPlacements(channelServices, {
        grant,
        sourceSessionId,
        origin: null,
      });
      throw sourcePlacementChangedApiError("browser_session");
    }
    throw new BrowserSessionStateError(
      "BrowserSession source placement changed during the request; retry",
    );
  }

  /** See `interactionControllerGone`: a removed machine, or a Chrome profile
   * that is disconnected, restarted, gone or no longer reachable here; a
   * managed browser on a machine that is only offline waits. */
  async function browserControllerGone(
    grant: AccessGrant,
    workspaceId: string,
    placement: InteractionPlacement | null,
    deviceWorkspaceId: string | null,
    placementInstanceId: string | null,
  ): Promise<boolean> {
    if (placement?.kind !== "connected_machine" && placement?.kind !== "attached_device") {
      return false;
    }
    return await interactionControllerGone(
      deps.db,
      await attachedBrowserViewer(deps, grant, workspaceId),
      placement.kind === "attached_device"
        ? { ...placement, deviceWorkspaceId, placementInstanceId }
        : placement,
    );
  }

  /**
   * A controller restart (an agent update, a crash) forgets its live browsers
   * while their private profiles stay on disk. Every use relaunches such a
   * browser from that working copy, but suspension captures through the
   * controller and would otherwise record the browser as lost, discarding a
   * profile that was intact. Reach the controller the way a use does first,
   * so suspension saves what the browser actually had. A browser that cannot
   * be recovered falls through to suspension, which records the loss as
   * before.
   */
  async function recoverRestartedBrowserControllerBeforeSuspend(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    before: BrowserSessionControlRecord,
  ): Promise<void> {
    if (
      before.session.lifecycle !== "active" ||
      !before.session.controller ||
      browserSessionStorageMode(before.session) !== "private_profile"
    ) {
      return;
    }
    try {
      await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        before.session.id,
        "session.control",
        "browser.read",
        async ({ sessionClient }) => {
          await sessionClient.listTargets();
        },
      );
    } catch (error) {
      console.warn("browser.suspend_controller_recovery_failed", {
        workspaceId,
        browserSessionId: before.session.id,
        failure: interactionFailure(error),
      });
    }
  }

  async function recoverActiveBrowserController(
    routeDeps: ApiRouteDeps,
    grant: AccessGrant,
    record: BrowserSessionControlRecord,
    binding: NonNullable<BrowserSessionControlRecord["session"]["controller"]>,
    placement: BrowserPlacement,
    client: BrowserControlClient,
    tokens: ReturnType<typeof deriveBrowserSessionControllerTokens>,
    authorizationOperation: SessionAuthorizationOperation,
  ): Promise<void> {
    if (browserSessionStorageMode(record.session) === "ephemeral_context") {
      throw new BrowserSessionStateError(
        "Ephemeral browser context was lost; create a new BrowserSession. Its identity and operations cannot be restored or replayed.",
      );
    }
    const transport = browserRuntimeTransport(record.session, placement.transport);
    const recoverWorkingDirectory =
      transport.kind === "managed" &&
      transport.engine === "chromium" &&
      !transport.ephemeralPartition &&
      browserSessionStorageMode(record.session) === "private_profile";
    if (recoverWorkingDirectory) {
      // Missing controller memory cannot admit a stale source, token, placement
      // or route snapshot. Reuse the existing durable authority before recovery.
      await authorizeSourceSession(
        routeDeps,
        grant,
        record.sourceSessionId,
        authorizationOperation,
      );
      const current = await getBrowserSessionControlRecord(routeDeps.db, {
        accountId: grant.accountId,
        workspaceId: record.session.workspaceId,
        browserSessionId: record.session.id,
      });
      if (
        current.sourceSessionId !== record.sourceSessionId ||
        current.session.lifecycle !== "active" ||
        current.session.controller?.controllerGeneration !== binding.controllerGeneration ||
        current.session.controller.placementInstanceId !== placement.placementInstanceId ||
        current.session.controller.controllerId !== binding.controllerId ||
        current.tokenGeneration !== record.tokenGeneration ||
        !sameInteractionPlacement(current.session.placement, record.session.placement) ||
        current.session.driverId !== record.session.driverId ||
        current.session.engine !== record.session.engine ||
        current.session.headless !== record.session.headless ||
        current.session.linkedComputerSessionId !== record.session.linkedComputerSessionId ||
        current.session.networkRouteId !== record.session.networkRouteId ||
        JSON.stringify(current.networkRouteAuthority) !==
          JSON.stringify(record.networkRouteAuthority)
      ) {
        throw new BrowserSessionStateError("BrowserSession controller authority changed");
      }
      if (record.session.placement.kind === "connected_machine") {
        const source = await requireSourceSession(
          routeDeps,
          record.session.workspaceId,
          record.sourceSessionId,
        );
        if (source.activeSandboxId !== record.session.placement.sandboxId) {
          return await throwBrowserSourcePlacementChanged(
            grant,
            record.sourceSessionId,
            record.session.placement.sandboxId,
          );
        }
      }
    }
    const linkedComputer = await ensureLinkedComputerController(
      routeDeps,
      grant,
      record.session,
      placement,
      client,
    );
    const networkRoute = await resolveActiveBrowserNetworkRouteLaunch({
      deps: routeDeps,
      grant,
      record,
      placement: placement.placement,
    });
    try {
      await ensureHeadedBrowserDisplayStack(
        placement.session,
        record.session.headless,
        linkedComputer !== null,
      );
      if (
        recoverWorkingDirectory &&
        !(await touchBrowserSessionController(routeDeps.db, {
          accountId: grant.accountId,
          workspaceId: record.session.workspaceId,
          browserSessionId: record.session.id,
          controllerGeneration: binding.controllerGeneration,
        }))
      ) {
        throw new BrowserSessionStateError("BrowserSession controller authority changed");
      }
      await client.createSession({
        browserSessionId: record.session.id,
        controllerGeneration: binding.controllerGeneration,
        tokenGeneration: record.tokenGeneration,
        ...tokens,
        headed: !record.session.headless,
        transport,
        ...(recoverWorkingDirectory ? { recoverExistingWorkingDirectory: true } : {}),
        ...(linkedComputer ? { linkedComputer } : {}),
        ...(networkRoute ? { networkRoute } : {}),
      });
    } catch (error) {
      console.error("browser controller recovery failed", {
        browserSessionId: record.session.id,
        controllerGeneration: binding.controllerGeneration,
        failure: interactionFailure(error),
      });
      throw error;
    }
  }

  /** Continue an expired resume on its retained controller generation when the
   * controller still holds that generation's own working copy (a resident
   * browser, or its preserved profile and launch receipt after the controller
   * restarted). The controller's existing same-generation recovery adopts or
   * relaunches it from that directory, so the record, its history and the
   * possibly newer working profile all survive. When the browser cannot be
   * continued this way it returns why, leaving the record unchanged for the
   * settle-and-restore path. */
  async function continueExpiredBrowserResume(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    browserSessionId: string,
    operationId: string,
  ): Promise<ExpiredBrowserResumeContinuation> {
    const expired = await getExpiredBrowserSessionResume(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      browserSessionId,
    });
    if (!expired?.controllerGeneration) return { unavailable: null };
    const controllerGeneration = expired.controllerGeneration;
    const record = await getBrowserSessionControlRecord(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      browserSessionId,
    });
    const retained = record.session.controller;
    // A restarted controller's binding was cleared when its suspension failed;
    // the generation of that suspension still owns the working copy.
    if (retained ? retained.controllerGeneration !== controllerGeneration : expired.settleable) {
      throw new BrowserSessionStateError("BrowserSession controller authority changed");
    }
    // Only a private profile has a working copy the controller can adopt.
    if (browserSessionStorageMode(record.session) !== "private_profile") {
      return { unavailable: "It kept no private profile to continue" };
    }
    const rootSecret = browserAuthorityRoot(deps);
    const sourceSession = await requireSourceSession(deps, workspaceId, record.sourceSessionId);
    if (
      record.session.placement.kind === "connected_machine" &&
      sourceSession.activeSandboxId !== record.session.placement.sandboxId
    ) {
      return {
        unavailable:
          "The chat that created it is no longer attached to the machine the browser ran on",
      };
    }
    return await withBrowserPlacement(
      sourceSession,
      grant,
      record.session.placement,
      record.deviceWorkspaceId,
      retained?.placementInstanceId ?? null,
      "browser.resume",
      context.req.raw.signal,
      async (placement): Promise<ExpiredBrowserResumeContinuation> => {
        const binding = retained ?? {
          controllerId: "opengeni-browserd",
          controllerGeneration,
          placementInstanceId: placement.placementInstanceId,
        };
        const transport = browserRuntimeTransport(record.session, placement.transport);
        if (
          transport.kind !== "managed" ||
          transport.engine !== "chromium" ||
          transport.ephemeralPartition
        ) {
          return { unavailable: "Its browser keeps no working copy that can be continued" };
        }
        const client = await provisionController(
          deps,
          grant,
          record,
          placement,
          requestOrigin(context, deps.settings),
        );
        let linkedComputer: Awaited<ReturnType<typeof ensureLinkedComputerController>>;
        try {
          linkedComputer = await ensureLinkedComputerController(
            deps,
            grant,
            record.session,
            placement,
            client,
          );
        } catch (error) {
          // Its working copy was launched on a desktop that is gone.
          if (error instanceof BrowserSessionStateError) {
            return { unavailable: "The desktop it was launched on is gone" };
          }
          throw error;
        }
        const networkRoute = await resolveActiveBrowserNetworkRouteLaunch({
          deps,
          grant,
          record,
          placement: placement.placement,
        });
        const tokens = deriveBrowserSessionControllerTokens({
          rootSecret,
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
          placement: placement.placement,
          placementInstanceId: placement.placementInstanceId,
          controllerGeneration: binding.controllerGeneration,
          tokenGeneration: record.tokenGeneration,
        });
        const interactionHeld = await ensureInteractionHolder(
          deps,
          grant,
          sourceSession,
          browserSessionId,
          placement,
          context.req.raw.signal,
        );
        const release = async () => {
          if (!interactionHeld) return;
          await releaseInteractionHolder(
            deps,
            grant,
            workspaceId,
            browserSessionId,
            placement.controllerHostSandboxGroupId,
          ).catch(() => undefined);
        };
        try {
          await withInteractionHolderHeartbeat(
            deps,
            {
              grant,
              workspaceId,
              sandboxGroupId: placement.controllerHostSandboxGroupId,
              holderId: interactionHolderId(browserSessionId),
              operationId,
              // This operation is recorded only after the controller adopts
              // the working copy; until then the expired resume holds authority.
              continuesExpiredBrowserResume: true,
              resourceId: browserSessionId,
              controllerGeneration: binding.controllerGeneration,
            },
            async () => {
              await ensureHeadedBrowserDisplayStack(
                placement.session,
                record.session.headless,
                linkedComputer !== null,
              );
              await client.createSession({
                browserSessionId,
                controllerGeneration: binding.controllerGeneration,
                tokenGeneration: record.tokenGeneration,
                ...tokens,
                headed: !record.session.headless,
                transport,
                recoverExistingWorkingDirectory: true,
                ...(linkedComputer ? { linkedComputer } : {}),
                ...(networkRoute ? { networkRoute } : {}),
              });
            },
          );
        } catch (error) {
          // The controller proves no adoptable working copy for this generation
          // (none was completed, or its authority or profile changed): leave
          // the record for the settle-and-restore path.
          if (
            isDefiniteBrowserControllerFailure(error) &&
            error instanceof BrowserControlRequestError &&
            error.error.code === "resource_unavailable"
          ) {
            await release();
            console.warn("browser working copy could not be continued", {
              browserSessionId,
              controllerGeneration: binding.controllerGeneration,
              failure: interactionFailure(error),
            });
            return { unavailable: error.error.message };
          }
          throw error;
        }
        return {
          continued: await continueExpiredBrowserSessionResume(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
            operationId,
            actorSubjectId: grant.subjectId,
            controller: binding,
          }),
        };
      },
    );
  }

  /** End the retained controller generation of an expired resume and return
   * the browser to suspended. Other lost browsers are left unchanged so the
   * normal resume preparation refuses them. */
  async function settleExpiredBrowserResume(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    browserSessionId: string,
    unavailable: string | null,
  ): Promise<void> {
    const expired = await getExpiredBrowserSessionResume(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      browserSessionId,
    });
    if (!expired) return;
    if (!expired.settleable) {
      // It ran past its checkpoint, so returning it to that checkpoint would
      // silently discard newer state.
      throw new BrowserSessionStateError(
        unavailable
          ? `BrowserSession was lost when its controller restarted, and its working copy could not be recovered. ${unavailable}`
          : "BrowserSession was lost when its controller restarted, and its working copy could not be recovered",
      );
    }
    const record = await getBrowserSessionControlRecord(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      browserSessionId,
    });
    const binding = record.session.controller;
    if ((binding?.controllerGeneration ?? null) !== expired.controllerGeneration) {
      throw new BrowserSessionStateError("BrowserSession controller authority changed");
    }
    if (binding) {
      browserAuthorityRoot(deps);
      const sourceSession = await requireSourceSession(deps, workspaceId, record.sourceSessionId);
      await withBrowserPlacement(
        sourceSession,
        grant,
        record.session.placement,
        record.deviceWorkspaceId,
        binding.placementInstanceId,
        "browser.resume",
        context.req.raw.signal,
        async (placement) => {
          const client = await provisionController(
            deps,
            grant,
            record,
            placement,
            requestOrigin(context, deps.settings),
          );
          // A resident or provably never-completed launch is ended exactly; an
          // interrupted launch whose profile no browser runs is set aside
          // intact; a launch that completed (adoptable) or whose profile may
          // be in use stays preserved and refuses this resume.
          await endExpiredResumeSettingAsideInterruptedLaunch(client, {
            browserSessionId,
            controllerGeneration: binding.controllerGeneration,
          });
        },
      );
    }
    await settleExpiredBrowserSessionResume(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      browserSessionId,
      expectedControllerGeneration: expired.controllerGeneration,
    });
    await releaseInteractionHolder(
      deps,
      grant,
      workspaceId,
      browserSessionId,
      record.controllerHostSandboxGroupId,
    ).catch(() => undefined);
  }

  async function finishSuspendedBrowserControllerCleanup(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    browserSessionId: string,
  ): Promise<void> {
    const record = await getBrowserSessionControlRecord(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      browserSessionId,
    });
    if (record.session.lifecycle !== "suspended") {
      throw new BrowserSessionStateError("BrowserSession is not suspended");
    }
    const binding = record.session.controller;
    if (binding) {
      const sourceSession = await requireSourceSession(deps, workspaceId, record.sourceSessionId);
      await withBrowserPlacement(
        sourceSession,
        grant,
        record.session.placement,
        record.deviceWorkspaceId,
        binding.placementInstanceId,
        "browser.suspend",
        context.req.raw.signal,
        async (placement) => {
          const client = await provisionController(
            deps,
            grant,
            record,
            placement,
            requestOrigin(context, deps.settings),
          );
          await endCapturedBrowserController(client, browserSessionId, binding);
          await clearSuspendedBrowserSessionController(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            browserSessionId,
            expectedControllerGeneration: binding.controllerGeneration,
          });
        },
      );
    }
    await releaseInteractionHolder(
      deps,
      grant,
      workspaceId,
      browserSessionId,
      record.controllerHostSandboxGroupId,
    );
  }
}

function sourcePlacementChangedApiError(interactionResource: "browser_session"): ApiHttpError {
  return new ApiHttpError(409, {
    code: "conflict",
    message:
      "This browser belonged to a previous task placement and was retired. Open a new browser.",
    retryable: false,
    outcomeUnknown: false,
    details: {
      interactionResource,
      interactionFailureCode: "source_placement_changed",
      interactionLifecycle: "lost",
    },
  });
}

export function browserCreateInput(
  grant: AccessGrant,
  workspaceId: string,
  request: CreateBrowserSessionRequestValue,
  placement: InteractionPlacement,
  attachedDeviceWorkspaceId?: string,
) {
  if (request.storageMode === "ephemeral_context" && placement.kind !== "sandbox_group") {
    throw new BrowserControlUnsupportedError(
      "Ephemeral contexts require a managed sandbox placement",
    );
  }
  const attached = placement.kind === "attached_device";
  const external = placement.kind === "external_provider";
  const engine = attached ? ("chrome" as const) : external ? ("external" as const) : request.engine;
  if (
    request.engine === "lightpanda" &&
    placement.kind !== "sandbox_group" &&
    placement.kind !== "connected_machine"
  ) {
    throw new BrowserControlUnsupportedError(
      "Lightpanda requires a managed sandbox or Connected Machine browser placement",
    );
  }
  return {
    accountId: grant.accountId,
    workspaceId,
    operationId: request.operationId,
    associatedSessionId: request.sessionId,
    actorSubjectId: grant.subjectId,
    name: request.name ?? "Browser",
    initialUrl: request.initialUrl ?? null,
    placement,
    driverId:
      request.storageMode === "ephemeral_context"
        ? EPHEMERAL_CHROMIUM_DRIVER_ID
        : engine === "lightpanda"
          ? LIGHTPANDA_DRIVER_ID
          : external
            ? EXTERNAL_BROWSER_DRIVER_ID
            : BROWSER_DRIVER_ID,
    engine,
    headless: attached ? false : request.headless,
    identityId: request.identityId ?? null,
    baseRevisionId: request.baseRevisionId ?? null,
    networkRouteId: request.networkRouteId ?? null,
    linkedComputerSessionId: request.linkedComputerSessionId ?? null,
    resolveDefaultRevision:
      !attached &&
      !external &&
      request.identityId !== undefined &&
      request.baseRevisionId === undefined,
    ...(attached
      ? { capabilities: ATTACHED_BROWSER_SESSION_CAPABILITIES }
      : external
        ? { capabilities: EXTERNAL_BROWSER_SESSION_CAPABILITIES }
        : engine === "lightpanda"
          ? { capabilities: LIGHTPANDA_BROWSER_SESSION_CAPABILITIES }
          : {}),
    attachedDeviceWorkspaceId: attached ? (attachedDeviceWorkspaceId ?? null) : null,
  };
}

function browserRuntimeTransport(
  session: BrowserSessionValue,
  transport: PlacementBrowserTransport,
  placementInstanceId?: string,
  rootSecret?: string,
): PlacementBrowserTransport {
  if (browserSessionStorageMode(session) === "ephemeral_context") {
    if (transport.kind !== "managed" || !placementInstanceId || !rootSecret) {
      throw new BrowserControlUnsupportedError(
        "Ephemeral contexts cannot recover or change their placement",
      );
    }
    return {
      kind: "managed",
      engine: "chromium",
      ephemeralPartition: ephemeralBrowserPartition(session, placementInstanceId, rootSecret),
    };
  }
  if (transport.kind !== "managed") return transport;
  return {
    kind: "managed",
    engine: session.engine === "lightpanda" ? "lightpanda" : "chromium",
  };
}

function externalBrowserTransport(
  deps: ApiRouteDeps,
  placement: Extract<InteractionPlacement, { kind: "external_provider" }>,
): PlacementBrowserTransport {
  if (placement.placementId !== "default") {
    throw new BrowserControlUnsupportedError(
      "only the configured default external browser placement is available",
    );
  }
  if (placement.providerId === "browserbase") {
    if (!deps.settings.browserbaseApiKey) {
      throw new HTTPException(503, {
        message: "Browserbase browser placement is not configured",
      });
    }
    return {
      kind: "external_provider",
      providerId: "browserbase",
      placementId: placement.placementId,
      authority: { apiKey: deps.settings.browserbaseApiKey },
    };
  }
  if (placement.providerId === "kernel") {
    if (!deps.settings.kernelApiKey) {
      throw new HTTPException(503, {
        message: "Kernel browser placement is not configured",
      });
    }
    return {
      kind: "external_provider",
      providerId: "kernel",
      placementId: placement.placementId,
      authority: {
        apiKey: deps.settings.kernelApiKey,
        ...(deps.settings.kernelEndpoint ? { endpoint: deps.settings.kernelEndpoint } : {}),
      },
      timeoutSeconds: deps.settings.kernelBrowserTimeoutSeconds,
      stealth: deps.settings.kernelBrowserStealth,
    };
  }
  throw new BrowserControlUnsupportedError(
    `external browser provider ${placement.providerId} is not supported`,
  );
}

function assertCreateReplay(
  request: CreateBrowserSessionRequestValue,
  session: BrowserSessionValue,
): void {
  if (request.placement && !sameInteractionPlacement(request.placement, session.placement)) {
    throw new BrowserSessionOperationConflictError(
      "BrowserSession create operation is bound to another placement",
    );
  }
  if (request.storageMode !== browserSessionStorageMode(session)) {
    throw new BrowserSessionOperationConflictError(
      "BrowserSession create operation is bound to another storage mode",
    );
  }
  const expectedEngine =
    session.placement.kind === "attached_device"
      ? "chrome"
      : session.placement.kind === "external_provider"
        ? "external"
        : request.engine;
  if (session.engine !== expectedEngine) {
    throw new BrowserSessionOperationConflictError(
      "BrowserSession create operation is bound to another browser engine",
    );
  }
  if ((request.identityId ?? null) !== session.identityId) {
    throw new BrowserSessionOperationConflictError(
      "BrowserSession create operation is bound to another identity",
    );
  }
  if ((request.networkRouteId ?? null) !== session.networkRouteId) {
    throw new BrowserSessionOperationConflictError(
      "BrowserSession create operation is bound to another network route",
    );
  }
  if (request.baseRevisionId !== undefined && request.baseRevisionId !== session.baseRevisionId) {
    throw new BrowserSessionOperationConflictError(
      "BrowserSession create operation is bound to another revision",
    );
  }
  if ((request.linkedComputerSessionId ?? null) !== session.linkedComputerSessionId) {
    throw new BrowserSessionOperationConflictError(
      "BrowserSession create operation is bound to another ComputerSession",
    );
  }
}

async function ensureHeadedBrowserDisplayStack(
  session: BrowserControlPlacementSession,
  headless: boolean,
  linkedComputer: boolean,
): Promise<void> {
  if (
    !browserNeedsStandaloneDisplayStack({
      headless,
      linkedComputer,
      nativeBrowserControl: typeof session.ensureBrowserControl === "function",
    })
  )
    return;
  if (typeof session.exec !== "function" && typeof session.execCommand !== "function") return;
  await ensureDisplayStack(session, {
    telemetryContext: { callerKind: "viewer" },
  });
}

export function browserNeedsStandaloneDisplayStack(input: {
  headless: boolean;
  linkedComputer: boolean;
  nativeBrowserControl: boolean;
}): boolean {
  return !input.headless && !input.linkedComputer && !input.nativeBrowserControl;
}

async function ensureLinkedComputerController(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  browser: BrowserSessionValue,
  placement: BrowserPlacement,
  client: BrowserControlClient,
): Promise<{ computerSessionId: string; controllerGeneration: string } | null> {
  if (!browser.linkedComputerSessionId) return null;
  const record = await getComputerSessionControlRecord(deps.db, {
    accountId: grant.accountId,
    workspaceId: browser.workspaceId,
    computerSessionId: browser.linkedComputerSessionId,
  });
  if (
    record.session.lifecycle !== "active" ||
    !record.session.controller ||
    !sameInteractionPlacement(record.session.placement, browser.placement) ||
    record.session.controller.placementInstanceId !== placement.placementInstanceId
  ) {
    throw new BrowserSessionStateError(
      "Linked ComputerSession is not active on the browser placement",
    );
  }
  const reference = {
    computerSessionId: record.session.id,
    controllerGeneration: record.session.controller.controllerGeneration,
  };
  const tokens = deriveComputerSessionControllerTokens({
    rootSecret: browserAuthorityRoot(deps),
    accountId: grant.accountId,
    workspaceId: browser.workspaceId,
    placement: record.session.placement,
    placementInstanceId: placement.placementInstanceId,
    computerSessionId: record.session.id,
    controllerGeneration: record.session.controller.controllerGeneration,
    tokenGeneration: record.tokenGeneration,
  });
  const sessionClient = client.computerSessionClient({ reference, ...tokens });
  try {
    await sessionClient.heartbeat();
  } catch (error) {
    if (!isMissingLinkedComputerControllerSession(error)) throw error;
    await client.createComputerSession({
      ...reference,
      tokenGeneration: record.tokenGeneration,
      ...tokens,
    });
  }
  return reference;
}

function isMissingLinkedComputerControllerSession(error: unknown): boolean {
  if (!(error instanceof BrowserControlRequestError)) return false;
  if (error.status === 401 && error.error.code === "permission_denied") return true;
  return (
    error.status === 404 &&
    error.error.code === "resource_not_found" &&
    ["computer session not found", "computer session is not active"].includes(error.error.message)
  );
}

async function requireBrowserRevisionRestoreAuthority(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  session: BrowserSessionValue,
): Promise<BrowserRevisionArtifactAuthority> {
  if (!session.identityId || !session.baseRevisionId) {
    throw new BrowserSessionStateError("BrowserSession has no revision recovery authority");
  }
  return await getBrowserRevisionArtifactAuthority(deps.db, {
    accountId: grant.accountId,
    workspaceId: session.workspaceId,
    identityId: session.identityId,
    revisionId: session.baseRevisionId,
  });
}

async function prepareBrowserStateRestore(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  session: BrowserSessionValue,
  placement: InteractionPlacement,
  authority: BrowserRevisionArtifactAuthority | null,
): Promise<RestorePlacementBrowserStateInput | null> {
  if (!session.baseRevisionId) {
    if (authority) {
      throw new BrowserIdentityStateError("BrowserSession has unexpected revision authority");
    }
    return null;
  }
  if (
    !session.identityId ||
    !authority ||
    authority.revision.id !== session.baseRevisionId ||
    authority.revision.identityId !== session.identityId
  ) {
    throw new BrowserIdentityStateError("BrowserSession revision authority is inconsistent");
  }
  if (
    authority.artifacts.length !== 1 ||
    authority.revision.components.length !== 1 ||
    authority.revision.components[0]?.kind !== "chromium_profile"
  ) {
    throw new BrowserIdentityStateError(
      "BrowserRevision does not have one restorable Chromium profile",
    );
  }
  const artifact = authority.artifacts[0]!;
  if (artifact.manifestDigest !== authority.revision.manifestDigest) {
    throw new BrowserIdentityStateError("BrowserRevision manifest authority is inconsistent");
  }
  return await prepareBrowserArtifactRestore(
    deps,
    grant,
    session,
    placement,
    artifact,
    authority.revision.manifestDigest,
  );
}

async function prepareBrowserPrivateCheckpointRestore(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  session: BrowserSessionValue,
  authority: BrowserPrivateCheckpointAuthority,
): Promise<RestorePlacementBrowserStateInput> {
  if (authority.sourceBrowserSessionId !== session.id) {
    throw new BrowserSessionStateError("BrowserSession private checkpoint belongs elsewhere");
  }
  return await prepareBrowserArtifactRestore(
    deps,
    grant,
    session,
    session.placement,
    authority,
    authority.manifestDigest,
  );
}

async function prepareBrowserArtifactRestore(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  session: BrowserSessionValue,
  placement: InteractionPlacement,
  artifact: {
    objectKey: string;
    encryptedDataKey: string;
    format: string;
    artifactDigest: string;
    contentDigest: string;
    sizeBytes: number;
    materialization: BrowserRevisionMaterializationValue;
  },
  manifestDigest: string,
): Promise<RestorePlacementBrowserStateInput> {
  if (
    artifact.format !== BROWSER_PROFILE_ARTIFACT_FORMAT ||
    artifact.materialization.engine !== "chromium" ||
    artifact.materialization.driverId !== BROWSER_DRIVER_ID ||
    artifact.materialization.driverSchemaVersion !== 1
  ) {
    throw new BrowserIdentityStateError("Browser state requires another browser driver");
  }
  assertMaterializationPlacement(artifact.materialization, placement);
  const objectStorage = deps.objectStorage;
  if (!objectStorage) {
    throw new HTTPException(503, {
      message: "browser state storage is not configured",
    });
  }
  if (artifact.sizeBytes > objectStorage.maxSinglePutSizeBytes) {
    throw new BrowserIdentityStateError("Browser state artifact exceeds the supported byte limit");
  }
  const rootKey = requireBrowserStateRoot(deps);
  let dataKey: Buffer;
  try {
    dataKey = unwrapBrowserStateDataKey(rootKey, artifact.encryptedDataKey, {
      accountId: grant.accountId,
      workspaceId: session.workspaceId,
      objectKey: artifact.objectKey,
      artifactDigest: artifact.artifactDigest,
      contentDigest: artifact.contentDigest,
    });
  } catch (error) {
    throw new BrowserIdentityStateError("Browser state encryption authority is unavailable", {
      cause: error,
    });
  } finally {
    rootKey.fill(0);
  }
  const aad = browserStateArtifactAad({
    accountId: grant.accountId,
    workspaceId: session.workspaceId,
    objectKey: artifact.objectKey,
  });
  try {
    const signed = await objectStorage.createGetUrl({
      key: artifact.objectKey,
      audience: signedUrlAudienceForPlacement(placement),
    });
    return {
      objectKey: artifact.objectKey,
      format: BROWSER_PROFILE_ARTIFACT_FORMAT,
      artifactDigest: artifact.artifactDigest,
      contentDigest: artifact.contentDigest,
      manifestDigest,
      sizeBytes: artifact.sizeBytes,
      dataKey,
      aad,
      materialization: artifact.materialization,
      download: {
        url: signed.url,
        expiresAt: signed.expiresAt.toISOString(),
      },
    };
  } catch (error) {
    dataKey.fill(0);
    aad.fill(0);
    throw error;
  }
}

function assertMaterializationPlacement(
  materialization: BrowserRevisionMaterializationValue,
  placement: InteractionPlacement,
): void {
  if (
    materialization.portability === "placement_bound" &&
    (!materialization.placement || !sameInteractionPlacement(materialization.placement, placement))
  ) {
    throw new BrowserIdentityStateError("BrowserRevision is bound to another placement");
  }
  if (
    materialization.portability === "provider_bound" &&
    (placement.kind !== "external_provider" || materialization.providerId !== placement.providerId)
  ) {
    throw new BrowserIdentityStateError("BrowserRevision is bound to another browser provider");
  }
}

function sameInteractionPlacement(
  left: InteractionPlacement,
  right: InteractionPlacement,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "sandbox_group":
      return right.kind === "sandbox_group" && left.sandboxGroupId === right.sandboxGroupId;
    case "connected_machine":
      return right.kind === "connected_machine" && left.sandboxId === right.sandboxId;
    case "attached_device":
      return right.kind === "attached_device" && left.deviceId === right.deviceId;
    case "external_provider":
      return (
        right.kind === "external_provider" &&
        left.providerId === right.providerId &&
        left.placementId === right.placementId
      );
  }
}

function signedUrlAudienceForPlacement(placement: InteractionPlacement): "public" | "sandbox" {
  return placement.kind === "sandbox_group" ? "sandbox" : "public";
}

async function ensureInteractionHolder(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sourceSession: Session,
  browserSessionId: string,
  placement: BrowserPlacement,
  waitSignal: AbortSignal,
): Promise<boolean> {
  if (!placement.controllerHostSandboxGroupId) return false;
  if (!placement.lease?.instanceId) {
    throw new BrowserSessionStateError("BrowserSession lease placement is unavailable");
  }
  const sandboxRuntime = await resolveSessionSandboxRuntime(deps.db, deps.settings, sourceSession, {
    grant,
  });
  const acquired = await acquireLease(deps.db, {
    accountId: grant.accountId,
    workspaceId: sourceSession.workspaceId,
    sandboxGroupId: placement.controllerHostSandboxGroupId,
    kind: "interaction",
    holderId: interactionHolderId(browserSessionId),
    subjectId: sourceSession.id,
    backend: placement.lease.backend,
    warmBilling: {
      mode: deps.settings.sandboxWarmBillingMode,
      rateMicrosPerSecond: sandboxWarmRateMicrosPerSecond(deps.settings, placement.lease.backend),
    },
    os: placement.lease.os,
    image: sandboxRuntime.image,
    imagePolicy: "new_creates_only",
    rigVersionId: sourceSession.rigVersionId,
    leaseTtlMs: deps.settings.sandboxLeaseTtlMs,
    expectedEpoch: placement.lease.leaseEpoch,
    waitSignal,
  });
  if (acquired.role === "blocked" || acquired.role === "fenced") {
    throw new BrowserSessionStateError("BrowserSession placement is transitioning; retry");
  }
  if (
    acquired.role === "spawner" ||
    acquired.lease.leaseEpoch !== placement.lease.leaseEpoch ||
    acquired.lease.instanceId !== placement.placementInstanceId
  ) {
    await releaseInteractionHolder(
      deps,
      grant,
      sourceSession.workspaceId,
      browserSessionId,
      placement.controllerHostSandboxGroupId,
    ).catch(() => undefined);
    throw new BrowserSessionStateError("BrowserSession placement fence changed; retry");
  }
  await renewSandboxProviderExpiration({
    backend: acquired.lease.backend as ApiRouteDeps["settings"]["sandboxBackend"],
    settings: deps.settings,
    instanceId: acquired.lease.instanceId,
  }).catch(() => false);
  return true;
}

/** How long a browser must sit unused before a full controller may save it to
 * make room. Longer than an agent's ordinary pause between browser steps. */
const BROWSER_CAPACITY_SUSPEND_IDLE_MS = 5 * 60_000;
/** Candidates tried, in least-recently-used order, before giving up. */
const BROWSER_CAPACITY_SUSPEND_CANDIDATES = 3;
const BROWSER_CAPACITY_SUSPEND_ACTOR = "system:browser-capacity";

/** A create or resume reached a controller already at its browser limit.
 * `waiting` is that operation's dispatched authority, kept alive while room is
 * made so the transition reaper does not settle it in the meantime. */
class BrowserControllerFull extends Error {
  constructor(
    readonly placement: InteractionPlacement,
    readonly placementInstanceId: string,
    readonly waiting: {
      operationId: string;
      browserSessionId: string;
      sandboxGroupId: string | null;
      controllerGeneration: string;
    },
  ) {
    super("browser controller is at its browser limit");
  }
}

function browserControllerCapacityExhausted(error: unknown): boolean {
  return (
    (error instanceof BrowserControlRequestError && error.error.code === "capacity_exhausted") ||
    legacyInteractionCapacityError(error, "browser") !== null
  );
}

async function ensureDispatchedGeneration(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  browserSessionId: string,
  operationId: string,
  placementInstanceId: string,
): Promise<BrowserSessionControlRecord> {
  let record = await getBrowserSessionControlRecord(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    browserSessionId,
    operationId,
  });
  if (record.operation?.state === "prepared") {
    const controllerGeneration = randomUUID();
    try {
      await dispatchBrowserSessionOperation(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        operationId,
        browserSessionId,
        controllerGeneration,
        controller: {
          controllerId: "opengeni-browserd",
          controllerGeneration,
          placementInstanceId,
        },
      });
    } catch (error) {
      if (!(error instanceof BrowserSessionOperationConflictError)) throw error;
    }
    record = await getBrowserSessionControlRecord(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      browserSessionId,
      operationId,
    });
  }
  if (record.operation?.state !== "dispatched") {
    throw new BrowserSessionStateError("BrowserSession operation is not dispatchable");
  }
  if (
    !record.session.controller ||
    record.session.controller.controllerGeneration !== record.operation.controllerGeneration ||
    record.session.controller.placementInstanceId !== placementInstanceId
  ) {
    throw new BrowserSessionOperationConflictError(
      "BrowserSession dispatch controller binding is inconsistent",
    );
  }
  return record;
}

function requireOperationGeneration(record: BrowserSessionControlRecord): string {
  const generation = record.operation?.controllerGeneration;
  if (!generation) throw new BrowserSessionStateError("BrowserSession controller fence is absent");
  return generation;
}

/** Attach the controller's launch view to a create that activated exactly that
 * launch in this request. Replays, failures and other bindings get nothing, so
 * a caller then reads the targets and observes as before. */
export function withInitialView<
  T extends {
    session: { id: string; lifecycle: string; controller: { controllerGeneration: string } | null };
    operation: { state: string; replayed: boolean };
  },
>(
  response: T,
  launched: Awaited<ReturnType<BrowserControlClient["createSession"]>> | null,
):
  | T
  | (T & {
      initialView: { targets: BrowserTarget[]; observation: BrowserObservation; notice?: string };
    }) {
  if (
    !launched?.targets ||
    response.operation.state !== "completed" ||
    response.operation.replayed ||
    response.session.lifecycle !== "active" ||
    response.session.id !== launched.browserSessionId ||
    response.session.controller?.controllerGeneration !== launched.controllerGeneration
  ) {
    return response;
  }
  return {
    ...response,
    initialView: {
      targets: launched.targets,
      observation: launched.observation,
      ...(launched.notice ? { notice: launched.notice } : {}),
    },
  };
}

async function provisionController(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  record: BrowserSessionControlRecord,
  placement: BrowserPlacement,
  origin: string | null,
): Promise<BrowserControlClient> {
  const rootSecret = browserAuthorityRoot(deps);
  const adminToken = deriveBrowserControllerAdminToken({
    rootSecret,
    accountId: grant.accountId,
    workspaceId: record.session.workspaceId,
    placement: record.session.placement,
    placementInstanceId: placement.placementInstanceId,
  });
  return (
    await provisionBrowserControlClient(placement.session, {
      adminToken,
      nativeAuthority: nativeBrowserControllerAuthority(record.session.workspaceId, placement),
      ...(origin ? { allowedOrigins: [origin] } : {}),
    })
  ).client;
}

function connectController(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  record: BrowserSessionControlRecord,
  placement: BrowserPlacement,
): BrowserControlClient {
  return new BrowserControlClient(placement.session, {
    adminToken: deriveBrowserControllerAdminToken({
      rootSecret: browserAuthorityRoot(deps),
      accountId: grant.accountId,
      workspaceId: record.session.workspaceId,
      placement: record.session.placement,
      placementInstanceId: placement.placementInstanceId,
    }),
    nativeAuthority: nativeBrowserControllerAuthority(record.session.workspaceId, placement),
  });
}

function nativeBrowserControllerAuthority(
  workspaceId: string,
  placement: BrowserPlacement,
): { scopeId: string; scopeGeneration: string } {
  const placementId = (() => {
    switch (placement.placement.kind) {
      case "attached_device":
        return placement.placement.deviceId;
      case "connected_machine":
        return placement.placement.sandboxId;
      case "sandbox_group":
        return placement.placement.sandboxGroupId;
      case "external_provider":
        return `${placement.placement.providerId}:${placement.placement.placementId}`;
    }
  })();
  return {
    scopeId: `${workspaceId}:${placement.placement.kind}:${placementId}`,
    scopeGeneration: placement.placementInstanceId,
  };
}

async function releaseInteractionHolder(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  browserSessionId: string,
  controllerHostSandboxGroupId: string | null,
): Promise<void> {
  if (!controllerHostSandboxGroupId) return;
  await releaseLeaseHolder(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    sandboxGroupId: controllerHostSandboxGroupId,
    kind: "interaction",
    holderId: interactionHolderId(browserSessionId),
    idleGraceMs: deps.settings.sandboxIdleGraceMs,
  });
}

function interactionHolderId(browserSessionId: string): string {
  return `browser-session:${browserSessionId}`;
}

function browserAuthorityRoot(deps: ApiRouteDeps): string {
  const root = resolveFirstPartyDelegationSecret(deps.settings);
  if (!root) {
    throw new HTTPException(503, {
      message: "browser controller authority is not configured",
    });
  }
  return root;
}

function requireBrowserStateRoot(deps: ApiRouteDeps): Buffer {
  const configured = environmentsEncryptionKeyBytes(deps.settings);
  if (!configured) {
    throw new HTTPException(503, {
      message: "browser state encryption is not configured",
    });
  }
  const root = Buffer.from(configured);
  configured.fill(0);
  return root;
}

function browserRevisionMaterialization(
  manifest: PlacementBrowserStateCaptureReceipt["manifest"],
  placement: InteractionPlacement,
): BrowserRevisionMaterializationValue {
  const portable = manifest.profileCrypto !== "platform_bound";
  return {
    portability: portable ? "portable" : "placement_bound",
    reason: portable
      ? null
      : "Profile encryption depends on the source operating-system credential store.",
    platform: manifest.platform,
    architecture: manifest.architecture,
    engine: manifest.engine,
    engineVersion: manifest.engineVersion,
    driverId: manifest.driverId,
    driverSchemaVersion: manifest.driverSchemaVersion,
    profileCrypto: manifest.profileCrypto,
    providerId: null,
    placement: portable ? null : placement,
  };
}

async function endCapturedBrowserController(
  client: BrowserControlClient,
  browserSessionId: string,
  binding: NonNullable<BrowserSessionControlRecord["session"]["controller"]>,
): Promise<void> {
  try {
    await client.endSession(
      {
        browserSessionId,
        controllerGeneration: binding.controllerGeneration,
      },
      { removeState: true },
    );
  } catch (error) {
    if (!(error instanceof BrowserControlRequestError && error.status === 404)) throw error;
  }
}

/** A lost browser continued from its retained working copy, or why it could
 * not be (null when it has no such copy at all). */
type ExpiredBrowserResumeContinuation =
  | { continued: Awaited<ReturnType<typeof continueExpiredBrowserSessionResume>> }
  | { unavailable: string | null };

function isDefiniteBrowserControllerFailure(error: unknown): boolean {
  return (
    error instanceof BrowserControlRequestError &&
    !error.error.retryable &&
    error.error.code !== "outcome_unknown"
  );
}

function isMissingBrowserControllerSession(error: unknown): boolean {
  if (!(error instanceof BrowserControlRequestError)) return false;
  if (error.status === 401 && error.error.code === "permission_denied") return true;
  return (
    error.status === 404 &&
    error.error.code === "resource_not_found" &&
    ["browser session not found", "browser session is not active"].includes(error.error.message)
  );
}

async function settleBrowserSessionSuspensionCaptureFailure(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    controllerGeneration: string;
  },
  error: unknown,
) {
  if (!(error instanceof BrowserControlRequestError)) return null;
  const outcomeUnknown = error.error.code === "outcome_unknown";
  if (!outcomeUnknown && error.error.retryable) return null;
  return await failBrowserSessionSuspension(deps.db, {
    ...input,
    ...(outcomeUnknown ? { state: "outcome_unknown" as const } : {}),
    missingControllerSession: error.status === 404 && isMissingBrowserControllerSession(error),
    error: error.error,
  });
}

async function settleBrowserRevisionCaptureFailure(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    browserSessionId: string;
    controllerGeneration: string;
  },
  error: unknown,
): Promise<void> {
  if (!(error instanceof BrowserControlRequestError)) return;
  const outcomeUnknown = error.error.code === "outcome_unknown";
  if (!outcomeUnknown && error.error.retryable) return;
  await failBrowserRevisionPublication(deps.db, {
    ...input,
    state: outcomeUnknown ? "outcome_unknown" : "failed",
    error: error.error,
  });
}

type ActiveBrowserControllerCallback<T> = (input: {
  client: BrowserControlClient;
  sessionClient: ReturnType<BrowserControlClient["sessionClient"]>;
  record: BrowserSessionControlRecord;
  binding: NonNullable<BrowserSessionControlRecord["session"]["controller"]>;
  placement: BrowserPlacement;
  sourceAuthorization: ResolvedSessionAuthorization | null;
}) => Promise<T>;

async function requireSourceSession(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
): Promise<Session> {
  const session = await getSession(deps.db, workspaceId, sessionId);
  if (!session) throw new BrowserSessionNotFoundError("Associated session not found");
  return session;
}

async function authorizeSourceSession(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  operation: SessionAuthorizationOperation,
): Promise<ResolvedSessionAuthorization | null> {
  try {
    return await requireSessionAuthorization(deps, grant, {
      sessionId,
      operation,
      surface: "http",
    });
  } catch (error) {
    if (error instanceof SessionAuthorizationDeniedError) {
      throw new HTTPException(404, {
        message: "session not found",
        cause: error,
      });
    }
    if (error instanceof SessionAuthorizationUnavailableError) {
      throw new HTTPException(503, {
        message: "session authorization is unavailable",
        cause: error,
      });
    }
    throw error;
  }
}

async function parseJsonBody<T>(
  context: Context,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
): Promise<T> {
  const value = await context.req.json().catch(() => undefined);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HTTPException(400, { message: "invalid request body" });
  return parsed.data;
}

async function parseEmptyJsonBody(context: Context): Promise<void> {
  const text = await context.req.text();
  if (!text.trim()) return;
  try {
    const value = JSON.parse(text) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 0
    ) {
      throw new Error("not empty");
    }
  } catch {
    throw new HTTPException(400, { message: "invalid request body" });
  }
}

function requireUuidParam(context: Context, name: string): string {
  const value = context.req.param(name) ?? "";
  if (!isUuid(value)) throw new HTTPException(404, { message: "BrowserSession not found" });
  return value;
}

function requireOpaqueParam(context: Context, name: string): string {
  const value = context.req.param(name) ?? "";
  if (value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HTTPException(404, { message: "browser target not found" });
  }
  return value;
}

function diagnosticKinds(
  value: string | undefined,
): Array<ReturnType<typeof BrowserDiagnosticKind.parse>> | null {
  if (value === undefined || value === "") return null;
  const raw = [...new Set(value.split(","))];
  if (raw.length > 4 || raw.some((entry) => !entry)) {
    throw new HTTPException(400, { message: "invalid diagnostic kinds" });
  }
  const parsed = raw.map((entry) => BrowserDiagnosticKind.safeParse(entry));
  if (parsed.some((entry) => !entry.success)) {
    throw new HTTPException(400, { message: "invalid diagnostic kinds" });
  }
  return parsed.map((entry) => entry.data!);
}

function optionalBoundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === "") return null;
  if (!/^\d+$/u.test(value)) throw new HTTPException(400, { message: "invalid integer query" });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HTTPException(400, { message: "integer query is out of range" });
  }
  return parsed;
}

export function parseBrowserScreenshotOptions(
  query: URLSearchParams,
): BrowserControlScreenshotOptions {
  for (const key of ["fullPage", "format", "quality"]) {
    if (query.getAll(key).length > 1) {
      throw new HTTPException(400, { message: `duplicate browser screenshot ${key}` });
    }
  }
  const fullPage = query.get("fullPage");
  if (fullPage !== null && fullPage !== "true" && fullPage !== "false") {
    throw new HTTPException(400, { message: "invalid browser screenshot fullPage" });
  }
  const format = query.get("format");
  if (format !== null && format !== "jpeg" && format !== "png") {
    throw new HTTPException(400, { message: "invalid browser screenshot format" });
  }
  const quality = query.get("quality");
  const parsedQuality = quality === null ? null : optionalBoundedInteger(quality, 1, 100);
  if (quality !== null && parsedQuality === null) {
    throw new HTTPException(400, { message: "invalid browser screenshot quality" });
  }
  return {
    ...(fullPage === null ? {} : { fullPage: fullPage === "true" }),
    ...(format === null ? {} : { format }),
    ...(parsedQuality === null ? {} : { quality: parsedQuality }),
  };
}

/** Preserve the controller's definite tab diagnosis (a tab that stopped
 * answering, or one whose renderer crashed) through the public API with its
 * own code and guidance. Any other controller failure keeps the ordinary
 * envelope, which never publishes driver diagnostics. This only handles typed
 * read/pre-dispatch failures. Dispatched action uncertainty stays in the
 * action receipt, never relabeled as a safe retry. */
export function browserTabDiagnosisError(error: unknown): unknown {
  if (!(error instanceof BrowserControlRequestError)) return error;
  const code = error.error.code;
  // A controller that says a resource is gone for good (for example, the
  // person's Chrome profile reconnected and this session no longer controls
  // it) answers 503 but not retryable. As a 503 it would reach the agent as
  // "temporarily unavailable, retry", and every retry fails the same way, so
  // keep the controller's guidance and present it as the conflict it is.
  if (
    code === "resource_unavailable" &&
    error.status >= 500 &&
    !error.retryable &&
    !legacyInteractionCapacityFailure(error, "browser")
  ) {
    const failure = new ApiHttpError(409, {
      code: "conflict",
      message: error.error.message,
      retryable: false,
      outcomeUnknown: false,
    });
    failure.cause = error;
    return failure;
  }
  if (code !== "tab_not_responding" && code !== "tab_crashed") return error;
  const failure = new ApiHttpError(409, {
    code,
    message: error.error.message,
    retryable: false,
    outcomeUnknown: false,
  });
  failure.cause = error;
  return failure;
}

/** Keep a definite read timeout useful without publishing driver diagnostics. */
export function browserScreenshotError(error: unknown): unknown {
  // The controller refuses at once while a JavaScript dialog blocks the page.
  if (
    error instanceof BrowserControlRequestError &&
    error.error.code === "invalid_action" &&
    error.error.message.startsWith("A JavaScript ")
  ) {
    const failure = new ApiHttpError(409, {
      code: "conflict",
      message:
        "A JavaScript dialog is open in this tab, so it cannot be captured. Handle it first with browser_act action {type:'handle_dialog'}.",
      retryable: false,
      outcomeUnknown: false,
    });
    failure.cause = error;
    return failure;
  }
  if (error instanceof BrowserControlRequestError && error.error.code === "timeout") {
    const failure = new ApiHttpError(504, {
      code: "upstream_unavailable",
      message:
        "This tab did not produce a screenshot in time. Other browser operations may still work.",
      retryable: error.retryable,
      outcomeUnknown: false,
    });
    failure.cause = error;
    return failure;
  }
  return error;
}

export function browserScreenshotResponse(
  frame: Pick<BrowserControlFrame, "data" | "mediaType" | "metadataHeader">,
): Response {
  // Node Buffers can be views into a larger backing allocation. Copy exactly
  // the image bytes before constructing the Response.
  return new Response(Uint8Array.from(frame.data).buffer, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": frame.mediaType,
      "x-opengeni-browser-frame": frame.metadataHeader,
      ...USER_CONTENT_SECURITY_HEADERS,
    },
  });
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function requestOrigin(context: Context, settings: ApiRouteDeps["settings"]): string | null {
  return validateInteractionRequestOrigin(context.req.header("origin"), settings);
}

export function interactionActorForGrant(
  grant: AccessGrant,
): ReturnType<typeof InteractionActor.parse> {
  if (grant.principalKind !== "agent_attempt") {
    return InteractionActor.parse({
      kind: grant.principalKind === "service" ? "system" : "human",
      subjectId: grant.subjectId,
    });
  }
  return InteractionActor.parse({
    kind: "agent",
    subjectId: grant.subjectId,
    sessionId: grant.metadata?.["sessionId"],
    turnId: grant.metadata?.["turnId"],
    attemptId: grant.metadata?.["attemptId"],
    executionGeneration: grant.metadata?.["executionGeneration"],
  });
}

function assertPlacementInstance(expected: string | null, actual: string): void {
  if (expected !== null && expected !== actual) {
    throw new BrowserSessionStateError("BrowserSession placement instance changed");
  }
}

/** End keeps the original controller token fence so a later Chrome generation
 *  can still dispose the stale browserd session. */
function attachedEndPlacementInstanceId(
  operation: ChannelAOperation,
  expectedPlacementInstanceId: string | null,
  liveGeneration: string,
): string {
  if (operation === "browser.end" && expectedPlacementInstanceId) {
    return expectedPlacementInstanceId;
  }
  assertPlacementInstance(expectedPlacementInstanceId, liveGeneration);
  return liveGeneration;
}

function isTerminalOperation(state: string): boolean {
  return state === "completed" || state === "failed" || state === "outcome_unknown";
}

/** A configured browser credential (proxy or provider authority) is unusable. */
class BrowserAuthCredentialError extends Error {
  override readonly name = "BrowserAuthCredentialError";
}

async function loadExactInteractionCredential(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  reference: InteractionCredentialAuthorityRef,
) {
  const credential = await loadConnectionCredentialForBroker(deps.db, deps.settings, {
    workspaceId,
    connectionId: reference.connectionId,
    providerDomain: reference.providerDomain,
    subjectId: reference.connectionSubjectId,
    allowSubjectOwned: reference.connectionSubjectId !== null,
  });
  if (
    !credential ||
    credential.id !== reference.connectionId ||
    credential.accountId !== grant.accountId ||
    credential.workspaceId !== workspaceId ||
    credential.subjectId !== reference.connectionSubjectId ||
    credential.providerDomain !== reference.providerDomain ||
    credential.status !== "active"
  ) {
    throw new BrowserAuthCredentialError("Configured browser credential is unavailable");
  }
  return credential;
}

async function resolveBrowserNetworkRouteLaunch(input: {
  deps: ApiRouteDeps;
  grant: AccessGrant;
  workspaceId: string;
  browserSessionId: string;
  operationId: string;
  rootSecret: string;
  placement: InteractionPlacement;
}): Promise<PlacementBrowserNetworkRoute | null> {
  const record = await getBrowserSessionControlRecord(input.deps.db, {
    accountId: input.grant.accountId,
    workspaceId: input.workspaceId,
    browserSessionId: input.browserSessionId,
    operationId: input.operationId,
  });
  const route = record.networkRouteAuthority;
  if (!route) return null;
  const kind = route.configuration.kind;
  const providerRoute =
    kind === "managed"
      ? managedNetworkRouteForPlacement(route.configuration, route.consistency, input.placement)
      : undefined;
  if (kind !== "managed" && input.placement.kind === "external_provider") {
    throw new BrowserSessionStateError(
      "External browser providers require a provider-managed NetworkRoute",
    );
  }
  let proxyCredential: { username: string; password: string } | null = null;
  let credentialVersion: number | null = null;
  let proxyUrl: string | undefined;
  const dispatched = record.operation?.state === "dispatched";
  if (kind === "proxy") {
    const reference = route.configuration.credential;
    if (reference) {
      try {
        const credential = await loadExactInteractionCredential(
          input.deps,
          input.grant,
          input.workspaceId,
          reference,
        );
        credentialVersion = credential.version;
        proxyCredential = proxyCredentialFromBundle(credential.credential);
      } catch (error) {
        if (route.authorityDigest && dispatched) {
          return secretlessNetworkRouteReplay(route, kind, providerRoute);
        }
        throw error;
      }
      if (dispatched && route.credentialVersion !== credentialVersion) {
        return secretlessNetworkRouteReplay(route, kind, providerRoute);
      }
    }
    proxyUrl = browserProxyUrl(route.configuration, proxyCredential);
  }
  if (dispatched) {
    if (!route.authorityDigest) {
      throw new BrowserSessionStateError("BrowserSession route authority is not bound");
    }
    return {
      routeId: route.routeId,
      routeVersion: route.routeVersion,
      authorityDigest: route.authorityDigest,
      kind,
      consistency: route.consistency,
      ...(proxyUrl === undefined ? {} : { proxyUrl }),
      ...(providerRoute === undefined ? {} : { providerRoute }),
    };
  }
  const authorityDigest = deriveBrowserNetworkRouteAuthorityDigest({
    rootSecret: input.rootSecret,
    accountId: input.grant.accountId,
    workspaceId: input.workspaceId,
    browserSessionId: input.browserSessionId,
    routeId: route.routeId,
    routeVersion: route.routeVersion,
    credentialVersion,
    configuration: route.configuration,
    consistency: route.consistency,
    proxyCredential,
  });
  const bound = await bindBrowserSessionNetworkRouteAuthority(input.deps.db, {
    accountId: input.grant.accountId,
    workspaceId: input.workspaceId,
    browserSessionId: input.browserSessionId,
    operationId: input.operationId,
    routeVersion: route.routeVersion,
    credentialVersion,
    authorityDigest,
  });
  if (bound.authorityDigest !== authorityDigest) {
    throw new BrowserSessionOperationConflictError("BrowserSession route launch authority changed");
  }
  return {
    routeId: route.routeId,
    routeVersion: route.routeVersion,
    authorityDigest,
    kind,
    consistency: route.consistency,
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
    ...(providerRoute === undefined ? {} : { providerRoute }),
  };
}

async function resolveActiveBrowserNetworkRouteLaunch(input: {
  deps: ApiRouteDeps;
  grant: AccessGrant;
  record: BrowserSessionControlRecord;
  placement: InteractionPlacement;
}): Promise<PlacementBrowserNetworkRoute | null> {
  const route = input.record.networkRouteAuthority;
  if (!route) return null;
  if (!route.authorityDigest) {
    throw new BrowserSessionStateError("BrowserSession route authority is not bound");
  }
  const kind = route.configuration.kind;
  const providerRoute =
    kind === "managed"
      ? managedNetworkRouteForPlacement(route.configuration, route.consistency, input.placement)
      : undefined;
  if (kind !== "managed" && input.placement.kind === "external_provider") {
    throw new BrowserSessionStateError(
      "External browser providers require a provider-managed NetworkRoute",
    );
  }
  let proxyUrl: string | undefined;
  if (kind === "proxy") {
    const reference = route.configuration.credential;
    let proxyCredential: { username: string; password: string } | null = null;
    if (reference) {
      const credential = await loadExactInteractionCredential(
        input.deps,
        input.grant,
        input.record.session.workspaceId,
        reference,
      );
      if (credential.version !== route.credentialVersion) {
        throw new BrowserSessionStateError(
          "BrowserSession proxy credential changed; resume the browser to reconnect safely",
        );
      }
      proxyCredential = proxyCredentialFromBundle(credential.credential);
    }
    proxyUrl = browserProxyUrl(route.configuration, proxyCredential);
  }
  return {
    routeId: route.routeId,
    routeVersion: route.routeVersion,
    authorityDigest: route.authorityDigest,
    kind,
    consistency: route.consistency,
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
    ...(providerRoute === undefined ? {} : { providerRoute }),
  };
}

function secretlessNetworkRouteReplay(
  route: NonNullable<BrowserSessionControlRecord["networkRouteAuthority"]>,
  kind: "direct" | "proxy" | "managed" | "tunnel",
  providerRoute?: NonNullable<PlacementBrowserNetworkRoute["providerRoute"]>,
): PlacementBrowserNetworkRoute {
  if (!route.authorityDigest) {
    throw new BrowserSessionStateError("BrowserSession route authority is not bound");
  }
  return {
    routeId: route.routeId,
    routeVersion: route.routeVersion,
    authorityDigest: route.authorityDigest,
    kind,
    consistency: route.consistency,
    ...(providerRoute === undefined ? {} : { providerRoute }),
  };
}

function proxyCredentialFromBundle(credential: Readonly<Record<string, unknown>>): {
  username: string;
  password: string;
} {
  const username = credential.username;
  const password = credential.password;
  if (
    typeof username !== "string" ||
    Buffer.byteLength(username) < 1 ||
    Buffer.byteLength(username) > 4_096 ||
    username.includes("\0") ||
    typeof password !== "string" ||
    Buffer.byteLength(password) < 1 ||
    Buffer.byteLength(password) > 16_384 ||
    password.includes("\0")
  ) {
    throw new BrowserAuthCredentialError(
      "Proxy credential must contain bounded username and password fields",
    );
  }
  return { username, password };
}

function browserProxyUrl(
  configuration: Extract<
    NonNullable<BrowserSessionControlRecord["networkRouteAuthority"]>["configuration"],
    { kind: "proxy" }
  >,
  credential: { username: string; password: string } | null,
): string {
  const rawHost = configuration.host;
  if (
    /[\s/@?#]/u.test(rawHost) ||
    ((rawHost.includes("[") || rawHost.includes("]")) && !/^\[[^\]]+\]$/u.test(rawHost))
  ) {
    throw new BrowserSessionStateError("Network route proxy host is invalid");
  }
  const host = rawHost.includes(":") ? `[${rawHost.replace(/^\[|\]$/gu, "")}]` : rawHost;
  let url: URL;
  try {
    url = new URL(`${configuration.protocol}://${host}:${configuration.port}`);
  } catch {
    throw new BrowserSessionStateError("Network route proxy host is invalid");
  }
  if (!url.hostname || url.pathname !== "/") {
    throw new BrowserSessionStateError("Network route proxy host is invalid");
  }
  if (credential) {
    url.username = credential.username;
    url.password = credential.password;
  }
  return url.toString();
}

function assertAuthRunBrowser(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new InteractionResourceConflictError("Auth run belongs to another browser session");
  }
}

function browserUploadFileIds(action: BrowserActionRequestValue["action"]): string[] {
  const actions = action.type === "batch" ? action.actions : [action];
  return [
    ...new Set(actions.flatMap((entry) => (entry.type === "upload" ? entry.workspaceFileIds : []))),
  ];
}

/** Resolve Drive authority from the same immutable session authorization that
 * admitted the browser action. Agent-attempt subjects are technical worker
 * identities; their frozen initiating human is the only personal Drive
 * principal. Pure service attempts retain null and can read only ordinary
 * workspace files through the database predicate. */
export function browserFileAuthoritySubjectId(
  grant: AccessGrant,
  authorization: ResolvedSessionAuthorization | null,
): string | null {
  if (!authorization) return grant.principalKind === "agent_attempt" ? null : grant.subjectId;
  return authorization.actor.kind === "agent_attempt"
    ? authorization.actor.initiatingHumanSubjectId
    : authorization.actor.subjectId;
}

/** The batch authority query intentionally omits every unauthorized file. Any
 * omission therefore fails the whole upload before an object-storage URL is
 * minted, including mixed ordinary/Drive mappings and partially authorized
 * batches. */
export function requireAuthorizedBrowserUploadFiles(
  workspaceFileIds: readonly string[],
  authorizedFiles: readonly FileAsset[],
): FileAsset[] {
  const byId = new Map(authorizedFiles.map((file) => [file.id, file]));
  return workspaceFileIds.map((fileId) => {
    const file = byId.get(fileId);
    if (!file) throw new HTTPException(404, { message: "workspace file not found" });
    if (file.status !== "ready") {
      throw new HTTPException(409, { message: "workspace file is not ready" });
    }
    return file;
  });
}

function browserUploadFilename(value: string): string {
  const normalized = value
    .trim()
    .replace(/[/\\]/gu, "_")
    .replace(/[^A-Za-z0-9._ -]+/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  return normalized && normalized !== "." && normalized !== ".." ? normalized : "file";
}

function browserUploadSha256(value: string | null): string | null {
  return value && /^[0-9a-f]{64}$/u.test(value) ? value : null;
}

function interactionFailure(error: unknown) {
  if (error instanceof BrowserControlRequestError) {
    return legacyInteractionCapacityFailure(error, "browser") ?? error.error;
  }
  if (
    error instanceof BrowserControlUnsupportedError ||
    error instanceof BrowserControlServerUnsupportedError
  ) {
    return {
      code: "unsupported" as const,
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof BrowserControlServerError) {
    return {
      code:
        error.stage === "engine_unavailable"
          ? ("unsupported" as const)
          : ("driver_failed" as const),
      message: error.message,
      retryable: error.stage !== "engine_unavailable",
    };
  }
  return {
    code: "driver_failed" as const,
    message: error instanceof Error ? error.message : "browser controller failed",
    retryable: false,
  };
}

function assertBrowserDownloadSaveSource(
  current: BrowserDownloadValue,
  expected: BrowserDownloadValue,
): void {
  if (
    current.id !== expected.id ||
    current.browserSessionId !== expected.browserSessionId ||
    current.controllerGeneration !== expected.controllerGeneration ||
    current.status !== "completed" ||
    current.version !== expected.version ||
    current.filename !== expected.filename ||
    current.receivedBytes !== expected.receivedBytes ||
    current.totalBytes !== expected.totalBytes ||
    current.sha256 !== expected.sha256
  ) {
    throw new InteractionResourceStateError("Browser download changed before it was saved");
  }
}

async function finalizeBrowserDownloadFile(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  uploadId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getFileUpload>>>> {
  const objectStorage = deps.objectStorage;
  if (!objectStorage) throw new HTTPException(503, { message: "object storage is not configured" });
  let upload = await getFileUpload(deps.db, workspaceId, uploadId);
  if (!upload) throw new InteractionResourceStateError("Browser download file upload is absent");
  if (upload.status === "completed" && upload.file.status === "ready") {
    await recordBrowserDownloadFileUsage(deps, grant, workspaceId, upload.file);
    return upload;
  }
  if (upload.status !== "pending") {
    throw new InteractionResourceStateError(
      `Browser download file upload is ${upload.status.replace("_", " ")}`,
    );
  }
  if (upload.expiresAt.getTime() <= Date.now()) {
    throw new InteractionResourceStateError("Browser download file upload authority expired");
  }
  const pendingFile = upload.file;
  const head = await retryWhileMissing(async () => {
    if (!(await objectStorage.fileExists(pendingFile))) return null;
    return await objectStorage.headFile(pendingFile);
  });
  if (!head) {
    throw new HTTPException(503, { message: "browser download object is not available" });
  }
  if (
    Number(head.ContentLength ?? -1) !== upload.file.sizeBytes ||
    (head.ContentType !== undefined && head.ContentType !== upload.file.contentType) ||
    (upload.file.sha256 !== null && head.Metadata?.sha256 !== upload.file.sha256)
  ) {
    throw new HTTPException(502, { message: "browser download object failed verification" });
  }
  let file: FileAsset;
  try {
    file = await completeFileUpload(deps.db, workspaceId, upload.id);
  } catch (error) {
    const current = await getFileUpload(deps.db, workspaceId, upload.id);
    if (current?.status !== "completed" || current.file.status !== "ready") throw error;
    upload = current;
    file = current.file;
  }
  await recordBrowserDownloadFileUsage(deps, grant, workspaceId, file);
  return { ...upload, status: "completed", file };
}

async function recordBrowserDownloadFileUsage(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  file: FileAsset,
): Promise<void> {
  await recordWorkspaceUsage(deps, {
    accountId: grant.accountId,
    workspaceId,
    subjectId: grant.subjectId,
    eventType: "file.uploaded",
    quantity: file.sizeBytes,
    unit: "byte",
    sourceResourceType: "file",
    sourceResourceId: file.id,
    idempotencyKey: `file.uploaded:${workspaceId}:${file.id}`,
  });
}

/** A user's own attached browser could not be reached for an operation. */
function recordAttachedBrowserUnavailable(
  observability: ApiRouteDeps["observability"],
  reason: "disconnected" | "machine_unavailable" | "no_workspace_root",
): void {
  try {
    observability?.incrementCounter({
      name: "opengeni_attached_browser_unavailable_total",
      help: "Browser operations refused because the user's attached browser (or its machine) was unreachable, by closed reason.",
      labels: { reason },
    });
  } catch {
    // Telemetry never changes the refusal.
  }
}

const WORKING_COPY_REFUSAL_EXPLANATIONS: Record<BrowserWorkingCopyRefusalValue, string> = {
  unsupported_platform:
    "Adopting a working copy is supported only for browsers on Linux machines, where the controller can prove no process uses the copy. Nothing was changed.",
  unsupported_browser:
    "Only a managed Chromium browser with a private profile keeps a working copy that can be adopted. Nothing was changed.",
  browser_running:
    "The browser is running, starting or being ended on its controller, so there is no stopped working copy to adopt now. If it is running, use it normally; otherwise inspect again once it has stopped.",
  working_copy_invalid:
    "The browser's working directory on its machine is missing, incomplete or not a plain directory, so it cannot be adopted. Nothing was changed.",
  receipt_not_adoptable:
    "The working copy has no completed record of a browser launch, so it cannot be adopted. Its record and recovery state are preserved.",
  authority_changed:
    "The working copy was launched under a different controller authority than this browser now has, so it cannot be adopted for it. Nothing was changed.",
  process_state_unknown:
    "It cannot be proven that no process uses the copy's browser profile. Close any browser using it, then inspect again. Nothing was changed.",
  adoption_not_needed:
    "The working copy is the same directory the browser was launched in, so it needs no adoption; the browser continues from it when it is next used.",
  adoption_unresolved:
    "An earlier adoption for this browser has not finished. Check it with getBrowserSessionWorkingCopyAdoption and its operation id (see activeAdoption). Inspecting and checking never change it; retrying that same adoption with the same operationId and manifestDigest settles it. Do not start another.",
};

function workingCopyInspectionExplanation(
  inspection: PlacementBrowserWorkingCopyInspection,
  latestCheckpointAt: string | null,
): string {
  if (inspection.refusal) return WORKING_COPY_REFUSAL_EXPLANATIONS[inspection.refusal];
  const manifest = inspection.manifest!;
  return [
    `This working copy can be adopted: ${manifest.entries} entries, ${manifest.bytes} bytes, manifest digest ${manifest.digest}.`,
    manifest.excluded.length > 0
      ? `Left out because the controller rebuilds them: ${manifest.excluded.join(", ")}. Everything else is in the digest.`
      : "Every entry is in the digest.",
    "It is not the directory the browser was launched in (it was moved, copied or restored), so the browser refuses to continue from it until it is adopted.",
    latestCheckpointAt
      ? `How recent its contents are is not proven; the browser's latest saved checkpoint is from ${latestCheckpointAt}.`
      : "How recent its contents are is not proven.",
    "Adopting selects exactly these bytes as the browser's state and is never replaced by an older checkpoint afterwards; the directory it replaces is kept.",
    "To adopt, call adoptBrowserSessionWorkingCopy with this manifestDigest and a new operationId. If the bytes change first, the adoption is refused.",
  ].join(" ");
}

function publicWorkingCopyAdoption(
  adoption: PlacementBrowserWorkingCopyAdoption,
): BrowserWorkingCopyAdoptionValue {
  return {
    operationId: adoption.operationId,
    browserSessionId: adoption.browserSessionId,
    controllerGeneration: adoption.controllerGeneration,
    manifestDigest: adoption.manifestDigest,
    phase: adoption.phase,
    failureCode: adoption.failureCode,
    retainedDirectories: adoption.retainedDirectories,
    createdAt: adoption.createdAt,
    updatedAt: adoption.updatedAt,
  };
}

function workingCopyAdoptionExplanation(
  inFlight: boolean,
  adoption: PlacementBrowserWorkingCopyAdoption | null,
): string {
  const kept = adoption?.retainedDirectories.length
    ? ` Kept on the machine for separate cleanup: ${adoption.retainedDirectories.join(", ")}.`
    : "";
  if (inFlight)
    return "The adoption is still running on the controller. Check again with getBrowserSessionWorkingCopyAdoption; do not start another.";
  if (!adoption)
    return "The controller has no record of this adoption, which proves it changed nothing there.";
  switch (adoption.phase) {
    case "adopted":
      return `Adopted. The browser continues from the copy with manifest digest ${adoption.manifestDigest} the next time it is used, and is never replaced by an older checkpoint.${kept}`;
    case "interrupted":
    case "failed":
      return `The adoption stopped before the copy took the browser's place${adoption.failureCode ? ` (${adoption.failureCode})` : ""}; the browser's own directory is unchanged.${kept}`;
    case "collision":
      return `The adoption found the browser's directories in an unexpected state (${adoption.failureCode ?? "unknown"}) and stopped without moving or removing anything more. The browser stays unavailable until this adoption is reverted with revertBrowserSessionWorkingCopyAdoption, which puts the browser's own directory back and keeps the staged copy. If the revert refuses, the directories need a person on that machine.${kept}`;
    case "reverting":
      return "A revert of this adoption stopped part way and is not running. Retry revertBrowserSessionWorkingCopyAdoption with the same operationId to finish it; a retry repeats nothing already done.";
    case "reverted":
      return `Reverted. The browser's own directory is back in place and the staged copy was not used.${kept}`;
    default:
      return "The adoption stopped part way and is not running. Checking it never changes it. To finish it, retry the same adoption with the same operationId and manifestDigest under the authority that approved it; a retry repeats nothing already done. To undo it instead, revert it with revertBrowserSessionWorkingCopyAdoption. Do not start another.";
  }
}

type PreservedWorkingCopyCallback<T> = (input: {
  grant: AccessGrant;
  workspaceId: string;
  browserSessionId: string;
  client: BrowserControlClient;
  authority: PlacementBrowserWorkingCopyAuthority;
}) => Promise<T>;

function browserRouteError(error: unknown): HTTPException {
  const tabDiagnosis = browserTabDiagnosisError(error);
  if (tabDiagnosis instanceof ApiHttpError) return tabDiagnosis;
  const connectedMachineError = interactionControlApiError(error, "browser");
  if (connectedMachineError) return connectedMachineError;
  if (error instanceof HTTPException) return error;
  if (error instanceof SandboxPaidComputeAdmissionError)
    return new HTTPException(402, { message: error.message, cause: error });
  if (error instanceof BrowserSessionNotFoundError) {
    return new HTTPException(404, { message: error.message, cause: error });
  }
  if (error instanceof AttachedBrowserDeviceNotFoundError) {
    return new HTTPException(404, { message: error.message, cause: error });
  }
  if (error instanceof BrowserIdentityNotFoundError) {
    return new HTTPException(404, { message: error.message, cause: error });
  }
  if (error instanceof InteractionResourceNotFoundError) {
    return new HTTPException(404, { message: error.message, cause: error });
  }
  if (
    error instanceof BrowserSessionOperationConflictError ||
    error instanceof BrowserSessionStateError ||
    error instanceof BrowserIdentityConflictError ||
    error instanceof BrowserIdentityStateError ||
    error instanceof BrowserStateUploadStateError ||
    error instanceof InteractionResourceConflictError ||
    error instanceof InteractionResourceStateError ||
    error instanceof BrowserAuthCredentialError
  ) {
    return new HTTPException(409, { message: error.message, cause: error });
  }
  const legacyCapacity = legacyInteractionCapacityError(error, "browser");
  if (legacyCapacity) return legacyCapacity;
  if (error instanceof BrowserControlRequestError) {
    return new HTTPException(error.status as ContentfulStatusCode, {
      message: error.error.message,
      cause: error,
    });
  }
  if (error instanceof BrowserControlTransportError) {
    return new HTTPException(503, {
      message: "browser controller is unavailable",
      cause: error,
    });
  }
  if (error instanceof BrowserControlProtocolError) {
    return new HTTPException(502, {
      message: "browser controller response is invalid",
      cause: error,
    });
  }
  if (
    error instanceof BrowserControlUnsupportedError ||
    error instanceof BrowserControlServerUnsupportedError
  ) {
    return new HTTPException(409, { message: error.message, cause: error });
  }
  if (error instanceof BrowserControlServerError) {
    return new HTTPException(error.stage === "engine_unavailable" ? 409 : 503, {
      message:
        error.stage === "engine_unavailable"
          ? "browser engine is unavailable on this placement"
          : "browser controller could not start",
      cause: error,
    });
  }
  return new HTTPException(500, {
    message: "BrowserSession request failed",
    cause: error,
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Where a saved recording goes when the agent names no path. */
function defaultBrowserRecordingPath(startedAt: string): string {
  return `recordings/browser-${startedAt.replace(/\.\d+Z$/u, "Z").replace(/[:]/gu, "-")}.mp4`;
}

/** One stable operation id per file a recording save imports, so a retried
 * save replays each import instead of writing it twice. */
function derivedOperationId(operationId: string, name: string): string {
  const bytes = createHash("sha256")
    .update(`opengeni-browser-recording-import-v1\0${operationId}\0${name}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
