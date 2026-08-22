import { randomUUID } from "node:crypto";
import {
  environmentsEncryptionKeyBytes,
  resolveFirstPartyDelegationSecret,
  resolveStreamTokenSecret,
} from "@opengeni/config";
import {
  BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX,
  BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
  BROWSER_CONTROL_PORT,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_PROFILE_ARTIFACT_FORMAT,
  BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
  AttachedBrowserDevice,
  AttachedBrowserDeviceListResponse,
  BrowserActionCommand,
  BrowserActionRequest,
  BrowserDiagnosticKind,
  BrowserDownload,
  BrowserDownloadSaveRequest,
  BrowserDownloadSaveResponse,
  BrowserDownloadListResponse,
  BrowserExternalAuthCommand,
  BrowserOpenTargetRequest,
  BrowserObservation,
  BrowserProtectedAuthFillCommand,
  BrowserSessionAttachment,
  BrowserSessionAttachmentRequest,
  BrowserSessionHeartbeatResponse,
  BrowserSessionLifecycleRequest,
  BrowserSessionListResponse,
  BrowserSessionMutationResponse,
  BrowserTargetListResponse,
  CreateBrowserSessionRequest,
  ExternalAuthInteractiveRequest,
  ExternalAuthInteractiveResponse,
  ExternalAuthRunRequest,
  ExternalAuthRunResponse,
  InteractionActor,
  ProtectedAuthFillRequest,
  ProtectedAuthFillResponse,
  ReportAuthRunRequest,
  StartAuthRunRequest,
  VerifyAuthRunRequest,
  PublishBrowserRevisionRequest,
  PublishBrowserRevisionResponse,
  type AccessGrant,
  type BrowserProtectedAuthFillReceipt as BrowserProtectedAuthFillReceiptValue,
  type BrowserActionRequest as BrowserActionRequestValue,
  type BrowserDownload as BrowserDownloadValue,
  type BrowserSession as BrowserSessionValue,
  type FileAsset,
  type CreateBrowserSessionRequest as CreateBrowserSessionRequestValue,
  type InteractionPlacement,
  type InteractionCredentialAuthorityRef,
  type BrowserRevisionMaterialization as BrowserRevisionMaterializationValue,
  type Session,
  type SessionAuthorizationOperation,
  type SiteAuthAuthority,
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
  completeBrowserSessionEnd,
  completeExternalAuth,
  completeBrowserDownloadSave,
  completeFileUpload,
  completeProtectedAuthFill,
  commitBrowserSessionSuspension,
  commitBrowserRevisionPublication,
  dispatchBrowserRevisionPublication,
  dispatchBrowserDownloadSave,
  dispatchBrowserSessionOperation,
  dispatchExternalAuth,
  dispatchProtectedAuthFill,
  failBrowserSessionOperation,
  failBrowserSessionResume,
  failBrowserSessionResumePreparation,
  failBrowserSessionSuspension,
  failBrowserRevisionPublication,
  findBrowserSessionControlRecordByOperation,
  findBrowserDownloadSave,
  getBrowserSessionControlRecord,
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
  getProtectedAuthFillPreparation,
  getSiteAuthConnection,
  getSession,
  InteractionResourceConflictError,
  InteractionResourceNotFoundError,
  InteractionResourceStateError,
  listAuthRuns,
  listBrowserSessions,
  listAttachedBrowserDevices,
  prepareBrowserSessionCreate,
  prepareExternalAuth,
  prepareBrowserDownloadSave,
  prepareBrowserSessionEnd,
  prepareBrowserSessionResume,
  prepareBrowserSessionSuspend,
  prepareBrowserRevisionPublication,
  prepareProtectedAuthFill,
  reportAuthRun,
  releaseLeaseHolder,
  readLease,
  recordLeaseControllerDataPlaneUrl,
  loadConnectionCredentialForBroker,
  markProtectedAuthFillOutcomeUnknown,
  startAuthRun,
  touchBrowserSessionController,
  verifyAuthRun,
  settleBrowserDownloadSaveFailure,
  type BrowserSessionControlRecord,
  type BrowserPrivateCheckpointAuthority,
  type BrowserRevisionArtifactAuthority,
  type LeaseSnapshot,
} from "@opengeni/db";
import {
  requireAccessGrant,
  requireSessionAuthorization,
  recordWorkspaceUsage,
  requireLimit,
  relayConfigFromSettings,
  resolveSessionSandboxRuntime,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  type ApiRouteDeps,
  type ResolvedSessionAuthorization,
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
  type PlacementBrowserStateCaptureReceipt,
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
  shouldPersistControllerDataPlaneUrl,
  withCachedController,
} from "../controller-data-plane";
import { withInteractionHolderHeartbeat } from "../interaction-holder-heartbeat";
import {
  browserStateArtifactAad,
  browserStateManifestDigest,
  browserStateObjectKey,
  deriveBrowserStateDataKey,
  unwrapBrowserStateDataKey,
  wrapBrowserStateDataKey,
} from "../browser-state-authority";
import {
  BrowserAuthCredentialError,
  resolveProtectedAuthFieldValues,
} from "../browser-auth-broker";
import { managedNetworkRouteForPlacement } from "../browser-network-route";
import { validateInteractionRequestOrigin } from "../http/cors";
import { interactionControlApiError } from "../http/interaction-control-error";
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
import { sanitizeFilename } from "./files";

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
};

export function registerBrowserSessionRoutes(app: Hono, deps: ApiRouteDeps): void {
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
          accountId: grant.accountId,
          workspaceId,
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
            accountId: grant.accountId,
            workspaceId,
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
    return context.json(
      BrowserSessionListResponse.parse(
        await listBrowserSessions(deps.db, {
          accountId: grant.accountId,
          workspaceId,
        }),
      ),
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
    await authorizeSourceSession(deps, grant, request.sessionId, "session.control");
    const origin = requestOrigin(context, deps.settings);
    const authority = browserAuthorityRoot(deps);

    try {
      const existing = await findBrowserSessionControlRecordByOperation(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        operationId: request.operationId,
      });
      if (existing && existing.sourceSessionId !== request.sessionId) {
        throw new BrowserSessionOperationConflictError(
          "BrowserSession create operation belongs to another source session",
        );
      }
      if (existing) assertCreateReplay(request, existing.session);
      let prepared = existing
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

      const sourceSession = await requireSourceSession(deps, workspaceId, request.sessionId);
      const response = await withBrowserPlacement(
        sourceSession,
        grant,
        existing?.session.placement ?? request.placement ?? null,
        existing?.session.controller?.placementInstanceId ?? null,
        "browser.create",
        context.req.raw.signal,
        async (placement) => {
          let revisionAuthority: BrowserRevisionArtifactAuthority | null = null;
          if (!prepared) {
            prepared = await prepareBrowserSessionCreate(
              deps.db,
              browserCreateInput(grant, workspaceId, request, placement.placement),
            );
          }
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
            const interactionHeld = await ensureInteractionHolder(
              deps,
              grant,
              sourceSession,
              prepared.session.id,
              placement,
              context.req.raw.signal,
            );
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
                  return await withInteractionHolderHeartbeat(
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
                    async () => {
                      await ensureHeadedBrowserDisplayStack(
                        placement.session,
                        preparedSession.headless,
                      );
                      return await client.createSession({
                        browserSessionId: preparedSession.id,
                        controllerGeneration,
                        tokenGeneration: record.tokenGeneration,
                        ...tokens,
                        headed: !preparedSession.headless,
                        transport: browserRuntimeTransport(preparedSession, placement.transport),
                        ...(linkedComputer ? { linkedComputer } : {}),
                        ...(networkRoute ? { networkRoute } : {}),
                        ...(request.initialUrl ? { initialUrl: request.initialUrl } : {}),
                        ...(restore ? { restore } : {}),
                      });
                    },
                  );
                },
              );
              await cacheBrowserControllerPlacement(grant, workspaceId, placement).catch(
                () => placement,
              );
            } catch (error) {
              if (
                error instanceof BrowserControlTransportError ||
                (error instanceof BrowserControlRequestError && error.retryable) ||
                isAbort(error)
              )
                throw error;
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
            return await activateBrowserSession(deps.db, {
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
          } finally {
            restore?.dataKey.fill(0);
            restore?.aad.fill(0);
          }
        },
      );
      const parsed = BrowserSessionMutationResponse.parse(response);
      observeLifecycleResult(deps.observability, startedAtMs, parsed);
      return context.json(
        parsed,
        parsed.operation.state === "completed" && !parsed.operation.replayed ? 201 : 200,
      );
    } catch (error) {
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
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient }) => await sessionClient.listDownloads(),
      );
      return context.json(BrowserDownloadListResponse.parse(result));
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
        if (!upload || upload.file.id !== save.fileId || upload.file.objectKey !== save.objectKey) {
          throw new InteractionResourceStateError("Browser download file authority is unavailable");
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
        const get = await objectStorage.createGetUrl({
          key: upload.file.objectKey,
          expiresInSeconds: BROWSER_WORKSPACE_FILE_AUTHORITY_TTL_SECONDS,
          audience: signedUrlAudienceForPlacement(controllerRecord.session.placement),
        });
        const sourceSession = await requireSourceSession(deps, workspaceId, save.sourceSessionId);
        await authorizeSourceSession(deps, grant, save.sourceSessionId, "session.control");
        const dispatched = await dispatchBrowserDownloadSave(deps.db, identity);
        const imported = await withChannelA(
          channelServices,
          {
            accountId: grant.accountId,
            workspaceId,
            session: sourceSession,
            subjectId: grant.subjectId,
            waitSignal: context.req.raw.signal,
            operation: "browser.download.save",
          },
          async ({ service }) =>
            await service.importWorkspaceFile({
              operationId: request.operationId,
              destinationPath: save.destinationPath,
              overwrite: save.overwrite,
              mayReplaceExisting: save.overwrite && dispatched.dispatchedNow,
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
      } catch (error) {
        throw browserRouteError(error);
      }
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/observation",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:read",
      );
      const targetId = requireOpaqueParam(context, "targetId");
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.read",
        "browser.read",
        async ({ sessionClient }) => await sessionClient.observe(targetId),
      );
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/actions",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      const request = await parseJsonBody(context, BrowserActionRequest);
      const workspaceFileIds = browserUploadFileIds(request.action);
      if (workspaceFileIds.length > 0) {
        await requireAccessGrant(context, deps, workspaceId, "files:read");
      }
      const startedAtMs = performance.now();
      const result = await withActiveBrowserController(
        context,
        grant,
        workspaceId,
        browserSessionId,
        "session.control",
        "browser.action",
        async ({ sessionClient, binding, record, sourceAuthorization }) => {
          const command = BrowserActionCommand.parse({
            protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
            operationId: request.operationId,
            browserSessionId,
            controllerGeneration: binding.controllerGeneration,
            targetId: request.targetId,
            expectedTargetGeneration: request.expectedTargetGeneration,
            expectedDocumentGeneration: request.expectedDocumentGeneration,
            expectedFrameId: request.expectedFrameId,
            actor: interactionActorForGrant(grant),
            observationMode: request.observationMode,
            action: request.action,
          });
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
          return await sessionClient.action(command);
        },
      );
      observeBrowserActionResult(deps.observability, startedAtMs, request, result);
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
    "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/protected-fill",
    async (context) => {
      const { workspaceId, grant, browserSessionId } = await browserRoutePreamble(
        context,
        "sessions:control",
      );
      const authRunId = requireUuidParam(context, "authRunId");
      const request = await parseJsonBody(context, ProtectedAuthFillRequest);
      const startedAtMs = performance.now();
      try {
        const replay = await getProtectedAuthFillPreparation(deps.db, {
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
          const response = ProtectedAuthFillResponse.parse(replay.response);
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
          let preparation = await getProtectedAuthFillPreparation(deps.db, {
            ...scope,
            ...request,
          });
          let credential: Awaited<ReturnType<typeof loadConnectionCredentialForBroker>> = null;
          if (!preparation) {
            const run = await getAuthRun(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              authRunId,
            });
            assertAuthRunBrowser(run.browserSessionId, browserSessionId);
            const connection = await getSiteAuthConnection(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              siteAuthConnectionId: run.siteAuthConnectionId,
            });
            const authority = connection.authorities.find(
              (candidate) => candidate.id === request.authorityId,
            );
            if (!authority) {
              throw new InteractionResourceStateError("Auth authority is not configured");
            }
            if (authority.kind === "external_provider") {
              throw new InteractionResourceStateError(
                "External auth providers cannot use protected field fill",
              );
            }
            if (authority.kind === "connection_fields") {
              credential = await loadBoundBrowserCredential(deps, grant, workspaceId, authority);
            }
            preparation = await prepareProtectedAuthFill(deps.db, {
              ...scope,
              ...request,
              credentialVersion: credential?.version ?? null,
            });
          }
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
              `Protected-fill operation is ${preparation.operationState.replace("_", " ")}`,
            );
          }
          if (preparation.authority.kind === "human") {
            if (preparation.operationState !== "prepared") {
              throw new InteractionResourceStateError(
                "Human protected-fill operation entered an invalid dispatch state",
              );
            }
            return await completeProtectedAuthFill(deps.db, {
              ...scope,
              operationId: request.operationId,
              status: "needs_human",
              intervention: {
                originatingSessionId: record.sourceSessionId,
                originatingTurnId: actor.kind === "agent" ? (actor.turnId ?? null) : null,
                originatingAttemptId: actor.kind === "agent" ? (actor.attemptId ?? null) : null,
                originatingToolOperationId:
                  actor.kind === "agent" && actor.attemptId ? request.operationId : null,
                kind: preparation.authority.fields.some((field) => field.purpose === "totp")
                  ? "mfa"
                  : "manual_login",
                reason: "Sign in or complete authentication in this browser tab.",
                expiresInSeconds: 900,
              },
            });
          }
          if (preparation.authority.kind === "external_provider") {
            throw new InteractionResourceStateError(
              "External auth providers cannot use protected field fill",
            );
          }

          if (preparation.operationState === "dispatched") {
            try {
              const receipt = await sessionClient.protectedAuthReceipt(request.operationId);
              return await settleProtectedAuthReceipt({
                deps,
                scope,
                receipt,
              });
            } catch (error) {
              if (
                error instanceof BrowserControlRequestError &&
                error.error.code === "resource_not_found"
              ) {
                await markProtectedAuthFillOutcomeUnknown(deps.db, {
                  ...scope,
                  operationId: request.operationId,
                  errorCode: "controller_receipt_missing",
                });
                throw new InteractionResourceStateError(
                  "Protected-fill outcome is unknown after controller recovery",
                );
              }
              throw error;
            }
          }

          credential ??= await loadBoundBrowserCredential(
            deps,
            grant,
            workspaceId,
            preparation.authority,
          );
          if (credential.version !== preparation.credentialVersion) {
            throw new InteractionResourceConflictError(
              "Credential changed after protected fill was prepared; use a new operation id",
            );
          }
          const fields = resolveProtectedAuthFieldValues({
            authority: preparation.authority,
            requestedFields: request.fields,
            credential: credential.credential,
          });
          await dispatchProtectedAuthFill(deps.db, {
            ...scope,
            operationId: request.operationId,
          });
          const receipt = await sessionClient.protectedAuthFill(
            BrowserProtectedAuthFillCommand.parse({
              protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
              operationId: request.operationId,
              browserSessionId,
              controllerGeneration: binding.controllerGeneration,
              targetId: preparation.run.targetId,
              expectedTargetGeneration: request.expectedTargetGeneration,
              expectedDocumentGeneration: request.expectedDocumentGeneration,
              expectedFrameId: request.expectedFrameId,
              actor,
              authorityId: preparation.authority.id,
              credentialVersion: preparation.credentialVersion,
              allowedOrigins: preparation.origins,
              fields,
              submit: request.submit,
            }),
          );
          return await settleProtectedAuthReceipt({ deps, scope, receipt });
        },
      );
      const response = ProtectedAuthFillResponse.parse(result);
      observeAuthMutation(deps.observability, startedAtMs, response);
      return context.json(response);
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
          await client.createViewGrant(reference, {
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
                const relayToken = await mintStreamToken(relaySecret!, {
                  workspaceId,
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
      const origin = requestOrigin(context, deps.settings);
      try {
        const before = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        });
        await authorizeSourceSession(deps, grant, before.sourceSessionId, "session.control");
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
        const prepared = await prepareBrowserSessionSuspend(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
          operationId: request.operationId,
          actorSubjectId: grant.subjectId,
        });
        if (isTerminalOperation(prepared.operation.state)) {
          if (prepared.operation.state === "completed") {
            await finishSuspendedBrowserControllerCleanup(
              context,
              grant,
              workspaceId,
              browserSessionId,
            );
            const parsed = BrowserSessionMutationResponse.parse({
              session: (
                await getBrowserSessionControlRecord(deps.db, {
                  accountId: grant.accountId,
                  workspaceId,
                  browserSessionId,
                })
              ).session,
              operation: prepared.operation,
            });
            observeLifecycleResult(deps.observability, startedAtMs, parsed);
            return context.json(parsed, 200);
          }
          const parsed = BrowserSessionMutationResponse.parse(prepared);
          observeLifecycleResult(deps.observability, startedAtMs, parsed);
          return context.json(parsed, 200);
        }

        const record = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
          operationId: request.operationId,
        });
        const binding = record.session.controller;
        if (!binding) {
          throw new BrowserSessionStateError("BrowserSession suspension controller is absent");
        }
        const sourceSession = await requireSourceSession(deps, workspaceId, record.sourceSessionId);
        const response = await withBrowserPlacement(
          sourceSession,
          grant,
          record.session.placement,
          binding.placementInstanceId,
          "browser.suspend",
          context.req.raw.signal,
          async (placement) => {
            const objectStorage = deps.objectStorage!;
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
              await dispatchBrowserSessionOperation(deps.db, {
                accountId: grant.accountId,
                workspaceId,
                operationId: request.operationId,
                browserSessionId,
                controllerGeneration: binding.controllerGeneration,
                stateUpload: {
                  objectKey,
                  cleanupAfter: new Date(Date.now() + BROWSER_STATE_UPLOAD_CLEANUP_GRACE_MS),
                },
              });
              const signed = await objectStorage.createPutUrl({
                key: objectKey,
                contentType: BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
                audience: signedUrlAudienceForPlacement(record.session.placement),
              });
              const client = await provisionController(deps, grant, record, placement, origin);
              let receipt: PlacementBrowserStateCaptureReceipt;
              try {
                receipt = await withInteractionHolderHeartbeat(
                  deps,
                  {
                    grant,
                    workspaceId,
                    sandboxGroupId: record.controllerHostSandboxGroupId,
                    holderId: interactionHolderId(browserSessionId),
                    operationId: request.operationId,
                    resourceId: browserSessionId,
                    controllerGeneration: binding.controllerGeneration,
                  },
                  async () =>
                    await client.captureState({
                      browserSessionId,
                      controllerGeneration: binding.controllerGeneration,
                      operationId: request.operationId,
                      objectKey,
                      afterCapture: "stop",
                      dataKey,
                      aad,
                      upload: {
                        url: signed.url,
                        requiredHeaders: signed.requiredHeaders,
                        expiresAt: signed.expiresAt.toISOString(),
                      },
                    }),
                );
              } catch (error) {
                const failed = await settleBrowserSessionSuspensionCaptureFailure(
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
                operationId: request.operationId,
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
        const parsed = BrowserSessionMutationResponse.parse(response);
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
      try {
        let before = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        });
        await authorizeSourceSession(deps, grant, before.sourceSessionId, "session.control");
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

        const privateCheckpoint = await getBrowserPrivateCheckpointAuthority(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        });
        const revisionAuthority = privateCheckpoint
          ? null
          : await requireBrowserRevisionRestoreAuthority(deps, grant, prepared.session);
        try {
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
        } catch (error) {
          await failBrowserSessionResumePreparation(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            operationId: request.operationId,
            browserSessionId,
            error: interactionFailure(error),
          });
          throw error;
        }
        if (!restore) {
          throw new BrowserSessionStateError("BrowserSession has no restorable durable state");
        }

        const sourceSession = await requireSourceSession(deps, workspaceId, before.sourceSessionId);
        const response = await withBrowserPlacement(
          sourceSession,
          grant,
          prepared.session.placement,
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
            const { client } = await provisionBrowserControlClient(placement.session, {
              adminToken,
              nativeAuthority: nativeBrowserControllerAuthority(workspaceId, placement),
              ...(origin ? { allowedOrigins: [origin] } : {}),
            });
            try {
              const linkedComputer = await ensureLinkedComputerController(
                deps,
                grant,
                prepared.session,
                placement,
                client,
              );
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
                  await ensureHeadedBrowserDisplayStack(
                    placement.session,
                    prepared.session.headless,
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
        const parsed = BrowserSessionMutationResponse.parse(response);
        observeLifecycleResult(deps.observability, startedAtMs, parsed);
        return context.json(parsed, 200);
      } catch (error) {
        throw browserRouteError(error);
      } finally {
        restore?.dataKey.fill(0);
        restore?.aad.fill(0);
      }
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
      try {
        const before = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
        });
        await authorizeSourceSession(deps, grant, before.sourceSessionId, "session.control");
        if (before.session.controller) browserAuthorityRoot(deps);
        const prepared = await prepareBrowserSessionEnd(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
          operationId: request.operationId,
          actorSubjectId: grant.subjectId,
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
          }
          const parsed = BrowserSessionMutationResponse.parse(prepared);
          observeLifecycleResult(deps.observability, startedAtMs, parsed);
          return context.json(parsed, 200);
        }

        const record = await getBrowserSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          browserSessionId,
          operationId: request.operationId,
        });
        const binding = record.session.controller;
        if (!binding) {
          const completed = await completeBrowserSessionEnd(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            operationId: request.operationId,
            browserSessionId,
            expectedControllerGeneration: null,
          });
          await releaseInteractionHolder(
            deps,
            grant,
            workspaceId,
            browserSessionId,
            record.controllerHostSandboxGroupId,
          ).catch(() => undefined);
          const parsed = BrowserSessionMutationResponse.parse(completed);
          observeLifecycleResult(deps.observability, startedAtMs, parsed);
          return context.json(parsed, 200);
        }
        const sourceSession = await requireSourceSession(deps, workspaceId, record.sourceSessionId);
        const response = await withBrowserPlacement(
          sourceSession,
          grant,
          record.session.placement,
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
            const client = await provisionController(deps, grant, record, placement, origin);
            try {
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
                async () =>
                  await client.endSession(
                    {
                      browserSessionId,
                      controllerGeneration: binding.controllerGeneration,
                    },
                    { removeState: true },
                  ),
              );
            } catch (error) {
              // Physical absence already satisfies an exact end. A stale live
              // generation is 409 and transport uncertainty remains retryable.
              if (!(error instanceof BrowserControlRequestError && error.status === 404)) {
                throw error;
              }
            }
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
            return completed;
          },
        );
        const parsed = BrowserSessionMutationResponse.parse(response);
        observeLifecycleResult(deps.observability, startedAtMs, parsed);
        return context.json(parsed, 200);
      } catch (error) {
        throw browserRouteError(error);
      }
    },
  );

  async function withBrowserPlacement<T>(
    sourceSession: Session,
    grant: AccessGrant,
    expectedPlacement: InteractionPlacement | null,
    expectedPlacementInstanceId: string | null,
    operation: ChannelAOperation,
    waitSignal: AbortSignal,
    callback: (placement: BrowserPlacement) => Promise<T>,
  ): Promise<T> {
    if (expectedPlacement?.kind === "attached_device") {
      waitSignal.throwIfAborted();
      const device = await getAttachedBrowserDevice(deps.db, {
        accountId: grant.accountId,
        workspaceId: sourceSession.workspaceId,
        deviceId: expectedPlacement.deviceId,
      });
      if (device.state !== "connected") {
        throw new BrowserSessionStateError("Attached browser is disconnected");
      }
      const enrollment = await getLiveEnrollmentConnection(
        deps.db,
        sourceSession.workspaceId,
        device.enrollmentId,
      );
      if (!enrollment || enrollment.status !== "active" || !enrollment.connectionInstanceId) {
        throw new BrowserSessionStateError("Attached browser machine is unavailable");
      }
      const placementInstanceId = attachedEndPlacementInstanceId(
        operation,
        expectedPlacementInstanceId,
        device.connectionGeneration,
      );
      const built = await buildSelfhostedBackendSession({
        workspaceId: sourceSession.workspaceId,
        agentId: device.enrollmentId,
        connectionInstanceId: enrollment.connectionInstanceId,
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
        ...(deps.settings.agentOpStreamEnabled === true &&
        enrollment.opStream === true &&
        deps.bus.getOpStreamConnection
          ? {
              opStream: {
                transport: new NatsOpStreamTransport(
                  async () => deps.bus.getOpStreamConnection?.() ?? null,
                ),
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
      });
    }
    const runWithChannelA =
      operation === "browser.read" ||
      operation === "browser.action" ||
      operation === "browser.control" ||
      operation === "browser.attach"
        ? withChannelARead
        : withChannelA;
    return await runWithChannelA(
      channelServices,
      {
        accountId: grant.accountId,
        workspaceId: sourceSession.workspaceId,
        session: sourceSession,
        subjectId: grant.subjectId,
        waitSignal,
        operation,
        retryControllerTransport: operation === "browser.read" || operation === "browser.action",
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
            throw new BrowserSessionStateError(
              "BrowserSession Connected Machine is not the active placement",
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
    if (!sandboxGroupId || !placement.lease?.instanceId || !placement.session.resolveExposedPort) {
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

  async function withActiveBrowserController<T>(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    browserSessionId: string,
    authorizationOperation: SessionAuthorizationOperation,
    channelOperation: ChannelAOperation,
    callback: (input: {
      client: BrowserControlClient;
      sessionClient: ReturnType<BrowserControlClient["sessionClient"]>;
      record: BrowserSessionControlRecord;
      binding: NonNullable<BrowserSessionControlRecord["session"]["controller"]>;
      placement: BrowserPlacement;
      sourceAuthorization: ResolvedSessionAuthorization | null;
    }) => Promise<T>,
    recoverMissing = true,
  ): Promise<T> {
    try {
      const record = await getBrowserSessionControlRecord(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        browserSessionId,
      });
      const sourceAuthorization = await authorizeSourceSession(
        deps,
        grant,
        record.sourceSessionId,
        authorizationOperation,
      );
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
      const run = async (placement: BrowserPlacement): Promise<T> => {
        // An active binding already proves browserd was provisioned. Reusing
        // it avoids restarting/checking the sidecar on every live input.
        const client = connectController(deps, grant, record, placement);
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
          if (!recoverMissing || !isMissingBrowserControllerSession(error)) throw error;
          await recoverActiveBrowserController(
            deps,
            grant,
            record,
            binding,
            placement,
            client,
            tokens,
          );
          result = await callback(controller);
        }
        return result;
      };
      const cached = await cachedBrowserPlacement(record);
      if (cached) {
        try {
          return await run(cached);
        } catch (error) {
          const safelyReplayable =
            channelOperation === "browser.read" || channelOperation === "browser.action";
          if (
            !safelyReplayable ||
            (!(error instanceof BrowserControlTransportError) &&
              !(error instanceof BrowserControlRequestError && error.retryable))
          ) {
            throw error;
          }
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

      const sourceSession = await requireSourceSession(deps, workspaceId, record.sourceSessionId);
      return await withBrowserPlacement(
        sourceSession,
        grant,
        record.session.placement,
        binding.placementInstanceId,
        channelOperation,
        context.req.raw.signal,
        async (placement) =>
          await run(
            await cacheBrowserControllerPlacement(grant, workspaceId, placement).catch(
              () => placement,
            ),
          ),
      );
    } catch (error) {
      throw browserRouteError(error);
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
  ): Promise<void> {
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
      await ensureHeadedBrowserDisplayStack(placement.session, record.session.headless);
      await client.createSession({
        browserSessionId: record.session.id,
        controllerGeneration: binding.controllerGeneration,
        tokenGeneration: record.tokenGeneration,
        ...tokens,
        headed: !record.session.headless,
        transport: browserRuntimeTransport(record.session, placement.transport),
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

function browserCreateInput(
  grant: AccessGrant,
  workspaceId: string,
  request: CreateBrowserSessionRequestValue,
  placement: InteractionPlacement,
) {
  const attached = placement.kind === "attached_device";
  const external = placement.kind === "external_provider";
  const engine = attached ? ("chrome" as const) : external ? ("external" as const) : request.engine;
  if (engine === "lightpanda" && placement.kind !== "sandbox_group") {
    throw new BrowserControlUnsupportedError(
      "Lightpanda is currently available only in managed agent sandboxes",
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
      engine === "lightpanda"
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
  };
}

function browserRuntimeTransport(
  session: BrowserSessionValue,
  transport: PlacementBrowserTransport,
): PlacementBrowserTransport {
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
): Promise<void> {
  if (headless) return;
  if (typeof session.exec !== "function" && typeof session.execCommand !== "function") return;
  await ensureDisplayStack(session, {
    telemetryContext: { callerKind: "viewer" },
  });
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
  const sandboxRuntime = await resolveSessionSandboxRuntime(deps.db, deps.settings, sourceSession);
  const acquired = await acquireLease(deps.db, {
    accountId: grant.accountId,
    workspaceId: sourceSession.workspaceId,
    sandboxGroupId: placement.controllerHostSandboxGroupId,
    kind: "interaction",
    holderId: interactionHolderId(browserSessionId),
    subjectId: sourceSession.id,
    backend: placement.lease.backend,
    os: placement.lease.os,
    image: sandboxRuntime.image,
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

async function loadBoundBrowserCredential(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  authority: Extract<SiteAuthAuthority, { kind: "connection_fields" }>,
) {
  return await loadExactInteractionCredential(deps, grant, workspaceId, authority.credential);
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

async function settleProtectedAuthReceipt(input: {
  deps: ApiRouteDeps;
  scope: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    authRunId: string;
  };
  receipt: BrowserProtectedAuthFillReceiptValue;
}) {
  const { deps, scope, receipt } = input;
  if (receipt.state === "completed") {
    if (!receipt.observation) {
      throw new BrowserControlProtocolError("protected-fill receipt omitted its observation");
    }
    return await completeProtectedAuthFill(deps.db, {
      ...scope,
      operationId: receipt.operationId,
      status: receipt.observation.status,
      targetGeneration: receipt.observation.target.targetGeneration,
      documentGeneration: receipt.observation.target.documentGeneration,
    });
  }
  if (receipt.state === "failed") {
    if (!receipt.error) {
      throw new BrowserControlProtocolError("protected-fill failure omitted its error");
    }
    const staleCodes = new Set([
      "controller_stale",
      "target_not_found",
      "target_stale",
      "observation_stale",
      "document_stale",
      "frame_stale",
      "locator_not_found",
      "locator_ambiguous",
    ]);
    return await completeProtectedAuthFill(deps.db, {
      ...scope,
      operationId: receipt.operationId,
      status: staleCodes.has(receipt.error.code) ? "stale" : "failed",
      failureCode: receipt.error.code,
    });
  }
  if (receipt.state === "outcome_unknown") {
    await markProtectedAuthFillOutcomeUnknown(deps.db, {
      ...scope,
      operationId: receipt.operationId,
      errorCode: receipt.error?.code ?? "outcome_unknown",
    });
    throw new InteractionResourceStateError("Protected-fill outcome is unknown");
  }
  throw new InteractionResourceStateError(`Protected-fill operation is still ${receipt.state}`);
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
  if (error instanceof BrowserControlRequestError) return error.error;
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

function browserRouteError(error: unknown): HTTPException {
  const connectedMachineError = interactionControlApiError(error, "browser");
  if (connectedMachineError) return connectedMachineError;
  if (error instanceof HTTPException) return error;
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
