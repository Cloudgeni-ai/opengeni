import { randomUUID } from "node:crypto";
import { resolveFirstPartyDelegationSecret, resolveStreamTokenSecret } from "@opengeni/config";
import {
  BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX,
  BROWSER_CONTROL_PORT,
  COMPUTER_CONTROL_WEBSOCKET_PROTOCOL,
  COMPUTER_RFB_WEBSOCKET_PROTOCOL,
  ComputerActionCommand,
  ComputerActionRequest,
  ComputerSessionAttachment,
  ComputerSessionAttachmentRequest,
  ComputerSessionHeartbeatResponse,
  ComputerSessionLifecycleRequest,
  ComputerSessionListResponse,
  ComputerSessionMutationResponse,
  ComputerTargetListResponse,
  CreateComputerSessionRequest,
  InteractionActor,
  INTERACTION_PROTOCOL_VERSION,
  type AccessGrant,
  type ComputerSession as ComputerSessionValue,
  type CreateComputerSessionRequest as CreateComputerSessionRequestValue,
  type InteractionPlacement,
  type Session,
  type SessionAuthorizationOperation,
} from "@opengeni/contracts";
import {
  getSessionAuthorityEpoch,
  acquireLease,
  activateComputerSession,
  completeComputerSessionEnd,
  ComputerSessionNotFoundError,
  ComputerSessionOperationConflictError,
  ComputerSessionStateError,
  dispatchComputerSessionOperation,
  failComputerSessionOperation,
  findComputerSessionControlRecordByOperation,
  getAttachedBrowserDevice,
  getComputerSessionControlRecord,
  getLiveEnrollmentConnection,
  getSandbox,
  getSession,
  listComputerSessions,
  prepareComputerSessionCreate,
  prepareComputerSessionEnd,
  releaseLeaseHolder,
  readLease,
  recordLeaseControllerDataPlaneUrl,
  touchComputerSessionController,
  type ComputerSessionControlRecord,
  type LeaseSnapshot,
} from "@opengeni/db";
import {
  requireAccessGrant,
  requireSessionAuthorization,
  relayConfigFromSettings,
  resolveSessionSandboxRuntime,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  BrowserControlClient,
  BrowserControlProtocolError,
  BrowserControlRequestError,
  BrowserControlServerError,
  BrowserControlServerUnsupportedError,
  BrowserControlTransportError,
  BrowserControlUnsupportedError,
  buildSelfhostedBackendSession,
  buildStreamUrl,
  exposedPortEndpointFromUrl,
  mintStreamToken,
  NatsControlRpc,
  NatsOpStreamTransport,
  provisionBrowserControlClient,
  renewSandboxProviderExpiration,
  type BrowserControlPlacementSession,
} from "@opengeni/runtime/sandbox";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  deriveBrowserControllerAdminToken,
  deriveComputerSessionControllerTokens,
  deriveComputerViewGrantToken,
} from "../browser-controller-authority";
import { connectedMachineComputerAccessError } from "../connected-machine-computer-access";
import { controllerCacheAllowsHostFetch, withCachedController } from "../controller-data-plane";
import { withInteractionHolderHeartbeat } from "../interaction-holder-heartbeat";
import { validateInteractionRequestOrigin } from "../http/cors";
import { interactionControlApiError } from "../http/interaction-control-error";
import { createInteractionFrameProxyAttachment, placementUsesInteractionFrameProxy } from "../interaction-frame-proxy";
import { observeComputerActionResult, observeLifecycleResult } from "../interaction-metrics";
import { withChannelA, withChannelARead, type ChannelAOperation } from "../sandbox/channel-a";

type ComputerPlacement = {
  placement: InteractionPlacement;
  placementInstanceId: string;
  session: BrowserControlPlacementSession;
  lease: LeaseSnapshot | null;
};

/** Public ComputerSession resource surface. Physical app/window authority stays
 * in the same placement controller used by BrowserSession; this route owns only
 * durable authorization, placement fencing, lifecycle receipts, and routing. */
export function registerComputerSessionRoutes(app: Hono, deps: ApiRouteDeps): void {
  const channelServices = {
    db: deps.db,
    settings: deps.settings,
    bus: deps.bus,
    observability: deps.observability,
  };

  app.get("/v1/workspaces/:workspaceId/computer-sessions", async (context) => {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:read");
    return context.json(
      ComputerSessionListResponse.parse(
        await listComputerSessions(deps.db, {
          accountId: grant.accountId,
          workspaceId,
        }),
      ),
    );
  });

  app.get("/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId", async (context) => {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:read");
    const computerSessionId = requireUuidParam(context, "computerSessionId");
    try {
      const record = await getComputerSessionControlRecord(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        computerSessionId,
      });
      await authorizeSourceSession(deps, grant, record.sourceSessionId, "session.read");
      return context.json(record.session);
    } catch (error) {
      throw computerRouteError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/computer-sessions", async (context) => {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:control");
    const request = await parseJsonBody(context, CreateComputerSessionRequest);
    const startedAtMs = performance.now();
    await authorizeSourceSession(deps, grant, request.sessionId, "session.control");
    const origin = requestOrigin(context, deps.settings);
    const authority = controllerAuthorityRoot(deps);

    try {
      const existing = await findComputerSessionControlRecordByOperation(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        operationId: request.operationId,
      });
      if (existing && existing.sourceSessionId !== request.sessionId) {
        throw new ComputerSessionOperationConflictError(
          "ComputerSession create operation belongs to another source session",
        );
      }
      if (existing) assertCreateReplay(request, existing.session);
      let prepared = existing
        ? await prepareComputerSessionCreate(
            deps.db,
            computerCreateInput(grant, workspaceId, request, existing.session.placement),
          )
        : null;
      if (prepared && isTerminalOperation(prepared.operation.state)) {
        const parsed = ComputerSessionMutationResponse.parse(prepared);
        observeLifecycleResult(deps.observability, startedAtMs, parsed);
        return context.json(parsed, 200);
      }

      const sourceSession = await requireSourceSession(deps, workspaceId, request.sessionId);
      const response = await withComputerPlacement(
        sourceSession,
        grant,
        existing?.session.placement ?? request.placement ?? null,
        existing?.session.controller?.placementInstanceId ?? null,
        "computer.create",
        context.req.raw.signal,
        async (placement) => {
          if (!prepared) {
            prepared = await prepareComputerSessionCreate(
              deps.db,
              computerCreateInput(grant, workspaceId, request, placement.placement),
            );
          }
          if (isTerminalOperation(prepared.operation.state)) return prepared;

          const interactionHeld = await ensureInteractionHolder(
            grant,
            sourceSession,
            prepared.session.id,
            placement,
            context.req.raw.signal,
          );
          const record = await ensureDispatchedGeneration(
            grant,
            workspaceId,
            prepared.session.id,
            request.operationId,
            placement.placementInstanceId,
          ).catch(async (error: unknown) => {
            if (interactionHeld) {
              await releaseInteractionHolder(
                grant,
                workspaceId,
                prepared!.session.id,
                placement.placement,
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
          const tokens = deriveComputerSessionControllerTokens({
            rootSecret: authority,
            accountId: grant.accountId,
            workspaceId,
            computerSessionId: prepared.session.id,
            placement: placement.placement,
            placementInstanceId: placement.placementInstanceId,
            controllerGeneration,
            tokenGeneration: record.tokenGeneration,
          });
          let physical;
          try {
            physical = await withComputerCreationController(
              grant,
              workspaceId,
              placement,
              adminToken,
              origin,
              async (client) =>
                await withInteractionHolderHeartbeat(
                  deps,
                  {
                    grant,
                    workspaceId,
                    sandboxGroupId:
                      placement.placement.kind === "sandbox_group"
                        ? placement.placement.sandboxGroupId
                        : null,
                    holderId: interactionHolderId(preparedSession.id),
                    operationId: request.operationId,
                    resourceId: preparedSession.id,
                    controllerGeneration,
                  },
                  async () =>
                    await client.createComputerSession({
                      computerSessionId: preparedSession.id,
                      controllerGeneration,
                      tokenGeneration: record.tokenGeneration,
                      ...tokens,
                    }),
                ),
            );
            await cacheComputerControllerPlacement(grant, workspaceId, placement).catch(
              () => placement,
            );
          } catch (error) {
            const retryableRequestFailure =
              error instanceof BrowserControlRequestError &&
              error.retryable &&
              error.error.code !== "machine_locked";
            const outcomeUnknown =
              error instanceof BrowserControlProtocolError ||
              error instanceof BrowserControlTransportError ||
              isAbort(error);
            const rethrowAfterFailure =
              error instanceof BrowserControlTransportError ||
              retryableRequestFailure ||
              isAbort(error);
            const failed = await failComputerSessionOperation(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              operationId: request.operationId,
              computerSessionId: preparedSession.id,
              ...(outcomeUnknown ? { state: "outcome_unknown" as const } : {}),
              error: interactionFailure(error),
            });
            if (interactionHeld && !outcomeUnknown) {
              await releaseInteractionHolder(
                grant,
                workspaceId,
                prepared.session.id,
                placement.placement,
              ).catch(() => undefined);
            }
            if (rethrowAfterFailure) throw error;
            return failed;
          }
          // These facts come from the physical adapter after its native helper
          // and seat are live. The API never guesses a platform or display.
          return await activateComputerSession(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            operationId: request.operationId,
            computerSessionId: preparedSession.id,
            controller: {
              controllerId: "opengeni-browserd",
              controllerGeneration,
              placementInstanceId: placement.placementInstanceId,
            },
            platform: physical.platform,
            adapter: physical.adapter,
            seatId: physical.seatId,
            displayId: physical.displayId,
            capabilities: physical.capabilities,
          });
        },
      );
      const parsed = ComputerSessionMutationResponse.parse(response);
      observeLifecycleResult(deps.observability, startedAtMs, parsed);
      return context.json(
        parsed,
        parsed.operation.state === "completed" && !parsed.operation.replayed ? 201 : 200,
      );
    } catch (error) {
      throw computerRouteError(error);
    }
  });

  app.get(
    "/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/targets",
    async (context) => {
      const { workspaceId, grant, computerSessionId } = await routePreamble(
        context,
        "sessions:read",
      );
      const result = await withActiveComputerController(
        context,
        grant,
        workspaceId,
        computerSessionId,
        "session.read",
        "computer.read",
        async ({ sessionClient, binding }) =>
          ComputerTargetListResponse.parse({
            computerSessionId,
            controllerGeneration: binding.controllerGeneration,
            targets: await sessionClient.listTargets(),
          }),
      );
      return context.json(result);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/targets/:targetId/observation",
    async (context) => {
      const { workspaceId, grant, computerSessionId } = await routePreamble(
        context,
        "sessions:read",
      );
      const targetId = requireOpaqueParam(context, "targetId");
      const result = await withActiveComputerController(
        context,
        grant,
        workspaceId,
        computerSessionId,
        "session.read",
        "computer.read",
        async ({ sessionClient }) => await sessionClient.observe(targetId),
      );
      return context.json(result);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/clipboard",
    async (context) => {
      const { workspaceId, grant, computerSessionId } = await routePreamble(
        context,
        "sessions:read",
      );
      const result = await withActiveComputerController(
        context,
        grant,
        workspaceId,
        computerSessionId,
        "session.read",
        "computer.read",
        async ({ sessionClient }) => await sessionClient.readClipboard(),
      );
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/actions",
    async (context) => {
      const { workspaceId, grant, computerSessionId } = await routePreamble(
        context,
        "sessions:control",
      );
      const request = await parseJsonBody(context, ComputerActionRequest);
      const startedAtMs = performance.now();
      const result = await withActiveComputerController(
        context,
        grant,
        workspaceId,
        computerSessionId,
        "session.control",
        "computer.action",
        async ({ sessionClient, binding }) =>
          await sessionClient.action(
            ComputerActionCommand.parse({
              protocolVersion: INTERACTION_PROTOCOL_VERSION,
              operationId: request.operationId,
              computerSessionId,
              controllerGeneration: binding.controllerGeneration,
              targetId: request.targetId,
              expectedTargetGeneration: request.expectedTargetGeneration,
              expectedObservationId: request.expectedObservationId,
              expectedFrameId: request.expectedFrameId,
              actor: interactionActorForGrant(grant),
              action: request.action,
            }),
          ),
      );
      observeComputerActionResult(deps.observability, startedAtMs, request, result);
      return context.json(result);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/operations/:operationId",
    async (context) => {
      const { workspaceId, grant, computerSessionId } = await routePreamble(
        context,
        "sessions:read",
      );
      const operationId = requireUuidParam(context, "operationId");
      const result = await withActiveComputerController(
        context,
        grant,
        workspaceId,
        computerSessionId,
        "session.read",
        "computer.read",
        async ({ sessionClient }) => await sessionClient.receipt(operationId),
      );
      return context.json(result);
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/attachments",
    async (context) => {
      const { workspaceId, grant, computerSessionId } = await routePreamble(context, "stream:view");
      const origin = requestOrigin(context, deps.settings);
      const request = await parseJsonBody(context, ComputerSessionAttachmentRequest);
      const result = await withActiveComputerController(
        context,
        grant,
        workspaceId,
        computerSessionId,
        "session.viewer.read",
        "computer.attach",
        async ({ client, sessionClient, record, binding, placement }) => {
          if (origin) await client.addAllowedOrigins([origin]);
          const reference = {
            computerSessionId,
            controllerGeneration: binding.controllerGeneration,
          };
          const target = (await sessionClient.listTargets()).find(
            (candidate) => candidate.id === request.targetId,
          );
          if (!target) {
            throw new BrowserControlRequestError(404, {
              code: "target_not_found",
              message: "computer target does not exist",
              retryable: false,
            });
          }
          if (target.kind === "app") {
            throw new BrowserControlRequestError(409, {
              code: "unsupported",
              message:
                "application targets support semantic control but do not provide a visual stream; select a window or screen",
              retryable: false,
            });
          }
          const grantId = randomUUID();
          const expiresAt = new Date(Date.now() + request.expiresInSeconds * 1_000).toISOString();
          const token = deriveComputerViewGrantToken({
            rootSecret: controllerAuthorityRoot(deps),
            accountId: grant.accountId,
            workspaceId,
            placement: record.session.placement,
            placementInstanceId: placement.placementInstanceId,
            computerSessionId,
            controllerGeneration: binding.controllerGeneration,
            tokenGeneration: record.tokenGeneration,
            grantId,
            expiresAt,
          });
          await client.createComputerViewGrant(reference, {
            grantId,
            token,
            expiresAt,
          });
          const relaySecret = placement.session.openComputerFrames
            ? resolveStreamTokenSecret(deps.settings)
            : null;
          if (placement.session.openComputerFrames && !relaySecret) {
            throw new BrowserControlUnsupportedError(
              "computer frame relay authority is unavailable",
            );
          }
          let relayed = null;
          try {
            relayed = await client.openRelayedComputerFrameStream({
              reference,
              targetId: request.targetId,
              viewToken: token,
              expiresAt,
              ...(request.stream ? { stream: request.stream } : {}),
            });
          } catch (error) {
            const publicFailure = interactionControlApiError(error, "computer");
            console.error("computer frame relay open failed", {
              computerSessionId,
              targetId: request.targetId,
              failureCode: publicFailure?.details?.controlFailureCode ?? "unclassified",
              retryable: publicFailure?.retryable ?? false,
              outcomeUnknown: publicFailure?.outcomeUnknown ?? false,
              controlRequestId: publicFailure?.details?.controlRequestId ?? null,
            });
            throw error;
          }
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
                    kind: 4 as const,
                    port: relayed.channel.port,
                  },
                };
              })()
            : await (async () => {
                const rfb =
                  record.session.placement.kind === "sandbox_group" &&
                  record.session.platform === "linux" &&
                  target.kind === "screen";
                const protocols = rfb
                  ? [
                      "binary",
                      COMPUTER_RFB_WEBSOCKET_PROTOCOL,
                      `${BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX}${token}`,
                    ]
                  : [
                      COMPUTER_CONTROL_WEBSOCKET_PROTOCOL,
                      `${BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX}${token}`,
                    ];
                const upstreamUrl = rfb
                  ? await client.computerRfbStreamUrl(reference, request.targetId)
                  : await client.computerFrameStreamUrl(
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
                      rootSecret: controllerAuthorityRoot(deps),
                      upstreamUrl,
                      upstreamProtocols: protocols,
                      origin,
                      expiresAt,
                    })
                  : { url: upstreamUrl, protocols };
                return rfb
                  ? { kind: "direct_rfb" as const, ...attachment }
                  : { kind: "direct_websocket" as const, ...attachment };
              })();
          return ComputerSessionAttachment.parse({
            computerSessionId,
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
    "/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/heartbeat",
    async (context) => {
      const { workspaceId, grant, computerSessionId } = await routePreamble(
        context,
        "sessions:read",
      );
      await parseEmptyJsonBody(context);
      const result = await withActiveComputerController(
        context,
        grant,
        workspaceId,
        computerSessionId,
        "session.read",
        "computer.read",
        async ({ sessionClient, binding }) => {
          await sessionClient.heartbeat();
          return ComputerSessionHeartbeatResponse.parse({
            computerSessionId,
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
    "/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/end",
    async (context) => {
      const workspaceId = context.req.param("workspaceId") ?? "";
      const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:control");
      const computerSessionId = requireUuidParam(context, "computerSessionId");
      const request = await parseJsonBody(context, ComputerSessionLifecycleRequest);
      const startedAtMs = performance.now();
      const origin = requestOrigin(context, deps.settings);
      try {
        const before = await getComputerSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          computerSessionId,
        });
        await authorizeSourceSession(deps, grant, before.sourceSessionId, "session.control");
        if (before.session.controller) controllerAuthorityRoot(deps);
        const prepared = await prepareComputerSessionEnd(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          computerSessionId,
          operationId: request.operationId,
          actorSubjectId: grant.subjectId,
        });
        if (isTerminalOperation(prepared.operation.state)) {
          if (prepared.operation.state === "completed") {
            await releaseInteractionHolder(
              grant,
              workspaceId,
              computerSessionId,
              before.session.placement,
            ).catch(() => undefined);
          }
          const parsed = ComputerSessionMutationResponse.parse(prepared);
          observeLifecycleResult(deps.observability, startedAtMs, parsed);
          return context.json(parsed, 200);
        }

        const record = await getComputerSessionControlRecord(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          computerSessionId,
          operationId: request.operationId,
        });
        const binding = record.session.controller;
        if (!binding) {
          const completed = await completeComputerSessionEnd(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            operationId: request.operationId,
            computerSessionId,
            expectedControllerGeneration: null,
          });
          await releaseInteractionHolder(
            grant,
            workspaceId,
            computerSessionId,
            record.session.placement,
          ).catch(() => undefined);
          const parsed = ComputerSessionMutationResponse.parse(completed);
          observeLifecycleResult(deps.observability, startedAtMs, parsed);
          return context.json(parsed, 200);
        }

        const sourceSession = await requireSourceSession(deps, workspaceId, record.sourceSessionId);
        const response = await withComputerPlacement(
          sourceSession,
          grant,
          record.session.placement,
          binding.placementInstanceId,
          "computer.end",
          context.req.raw.signal,
          async (placement) => {
            await dispatchComputerSessionOperation(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              operationId: request.operationId,
              computerSessionId,
              controllerGeneration: binding.controllerGeneration,
            });
            const client = await provisionController(grant, record, placement, origin);
            try {
              await withInteractionHolderHeartbeat(
                deps,
                {
                  grant,
                  workspaceId,
                  sandboxGroupId:
                    placement.placement.kind === "sandbox_group"
                      ? placement.placement.sandboxGroupId
                      : null,
                  holderId: interactionHolderId(computerSessionId),
                  operationId: request.operationId,
                  resourceId: computerSessionId,
                  controllerGeneration: binding.controllerGeneration,
                },
                async () =>
                  await client.endComputerSession(
                    {
                      computerSessionId,
                      controllerGeneration: binding.controllerGeneration,
                    },
                    { removeState: true },
                  ),
              );
            } catch (error) {
              if (!(error instanceof BrowserControlRequestError && error.status === 404)) {
                throw error;
              }
            }
            const completed = await completeComputerSessionEnd(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              operationId: request.operationId,
              computerSessionId,
              expectedControllerGeneration: binding.controllerGeneration,
            });
            await releaseInteractionHolder(
              grant,
              workspaceId,
              computerSessionId,
              record.session.placement,
            ).catch(() => undefined);
            return completed;
          },
        );
        const parsed = ComputerSessionMutationResponse.parse(response);
        observeLifecycleResult(deps.observability, startedAtMs, parsed);
        return context.json(parsed, 200);
      } catch (error) {
        throw computerRouteError(error);
      }
    },
  );

  async function withComputerPlacement<T>(
    sourceSession: Session,
    grant: AccessGrant,
    expectedPlacement: InteractionPlacement | null,
    expectedPlacementInstanceId: string | null,
    operation: ChannelAOperation,
    waitSignal: AbortSignal,
    callback: (placement: ComputerPlacement) => Promise<T>,
  ): Promise<T> {
    if (expectedPlacement?.kind === "external_provider") {
      throw new BrowserControlUnsupportedError(
        `computer placement ${expectedPlacement.kind} is not executable`,
      );
    }
    if (expectedPlacement?.kind === "attached_device") {
      waitSignal.throwIfAborted();
      const device = await getAttachedBrowserDevice(deps.db, {
        accountId: grant.accountId,
        workspaceId: sourceSession.workspaceId,
        deviceId: expectedPlacement.deviceId,
      });
      if (device.state !== "connected") {
        throw new ComputerSessionStateError("Attached browser machine is disconnected");
      }
      const enrollment = await getLiveEnrollmentConnection(
        deps.db,
        sourceSession.workspaceId,
        device.enrollmentId,
      );
      if (!enrollment || enrollment.status !== "active" || !enrollment.connectionInstanceId) {
        throw new ComputerSessionStateError("Attached browser machine is unavailable");
      }
      if (operation !== "computer.end") {
        assertConnectedMachineComputerAccess(enrollment, operation);
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
        placementInstanceId,
        session: built.session as unknown as BrowserControlPlacementSession,
        lease: null,
      });
    }
    const runWithChannelA =
      operation === "computer.read" ||
      operation === "computer.action" ||
      operation === "computer.control" ||
      operation === "computer.attach"
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
        retryControllerTransport: operation === "computer.read" || operation === "computer.action",
      },
      async (handle) => {
        if (expectedPlacement?.kind === "sandbox_group") {
          if (
            sourceSession.sandboxGroupId !== expectedPlacement.sandboxGroupId ||
            !handle.lease?.instanceId
          ) {
            throw new ComputerSessionStateError("ComputerSession home placement is unavailable");
          }
          assertPlacementInstance(expectedPlacementInstanceId, handle.lease.instanceId);
          return await callback({
            placement: expectedPlacement,
            placementInstanceId: handle.lease.instanceId,
            session: handle.homeSession,
            lease: handle.lease,
          });
        }

        const resolved = await handle.routingSession.prime();
        if (operation !== "computer.end" && resolved.kind === "selfhosted" && resolved.sandboxId) {
          const sandbox = await getSandbox(deps.db, grant, resolved.sandboxId);
          if (sandbox?.kind !== "selfhosted" || !sandbox.enrollmentId) {
            throw new ComputerSessionStateError("Connected Machine placement is unavailable");
          }
          const enrollment = await getLiveEnrollmentConnection(
            deps.db,
            grant,
            sandbox.enrollmentId,
          );
          if (!enrollment?.connectionInstanceId) {
            throw new ComputerSessionStateError("Connected Machine is unavailable");
          }
          assertConnectedMachineComputerAccess(enrollment, operation);
        }
        if (expectedPlacement?.kind === "connected_machine") {
          if (
            resolved.kind !== "selfhosted" ||
            resolved.sandboxId !== expectedPlacement.sandboxId
          ) {
            throw new ComputerSessionStateError(
              "ComputerSession Connected Machine is not the active placement",
            );
          }
          const placementInstanceId = resolved.providerInstanceId ?? expectedPlacement.sandboxId;
          assertPlacementInstance(expectedPlacementInstanceId, placementInstanceId);
          return await callback({
            placement: expectedPlacement,
            placementInstanceId,
            session: resolved.session as unknown as BrowserControlPlacementSession,
            lease: null,
          });
        }
        if (resolved.sandboxId === null) {
          if (!handle.lease?.instanceId) {
            throw new ComputerSessionStateError("ComputerSession home placement is unavailable");
          }
          if (
            resolved.providerInstanceId &&
            resolved.providerInstanceId !== handle.lease.instanceId
          ) {
            throw new ComputerSessionStateError("ComputerSession home placement fence changed");
          }
          return await callback({
            placement: {
              kind: "sandbox_group",
              sandboxGroupId: sourceSession.sandboxGroupId,
            },
            placementInstanceId: handle.lease.instanceId,
            session: handle.homeSession,
            lease: handle.lease,
          });
        }
        if (resolved.kind === "selfhosted") {
          return await callback({
            placement: {
              kind: "connected_machine",
              sandboxId: resolved.sandboxId,
            },
            placementInstanceId: resolved.providerInstanceId ?? resolved.sandboxId,
            session: resolved.session as unknown as BrowserControlPlacementSession,
            lease: null,
          });
        }
        throw new BrowserControlUnsupportedError(
          "computer creation on a non-home provider sandbox is not supported",
        );
      },
    );
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

  async function cachedComputerPlacement(
    record: ComputerSessionControlRecord,
  ): Promise<ComputerPlacement | null> {
    const binding = record.session.controller;
    if (!binding || record.session.placement.kind !== "sandbox_group") return null;
    const sandboxGroupId = record.session.placement.sandboxGroupId;
    const lease = await readLease(deps.db, record.session.workspaceId, sandboxGroupId);
    if (
      !lease ||
      (lease.liveness !== "warm" && lease.liveness !== "draining") ||
      lease.instanceId !== binding.placementInstanceId ||
      !lease.controllerDataPlaneUrl ||
      !controllerCacheAllowsHostFetch(lease.controllerDataPlaneUrl)
    ) {
      return null;
    }
    return {
      placement: record.session.placement,
      placementInstanceId: binding.placementInstanceId,
      session: controllerOnlySession(lease.controllerDataPlaneUrl),
      lease,
    };
  }

  async function cacheComputerControllerPlacement(
    grant: AccessGrant,
    workspaceId: string,
    placement: ComputerPlacement,
  ): Promise<ComputerPlacement> {
    if (
      placement.placement.kind !== "sandbox_group" ||
      !placement.lease?.instanceId ||
      !placement.session.resolveExposedPort
    ) {
      return placement;
    }
    const endpoint = await placement.session.resolveExposedPort(BROWSER_CONTROL_PORT);
    const url = buildStreamUrl(endpoint);
    const lease = await recordLeaseControllerDataPlaneUrl(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      sandboxGroupId: placement.placement.sandboxGroupId,
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

  async function withComputerCreationController<T>(
    grant: AccessGrant,
    workspaceId: string,
    placement: ComputerPlacement,
    adminToken: string,
    origin: string | null,
    operation: (client: BrowserControlClient) => Promise<T>,
  ): Promise<T> {
    const cachedUrl = placement.lease?.controllerDataPlaneUrl;
    const sandboxGroupId =
      placement.placement.kind === "sandbox_group" ? placement.placement.sandboxGroupId : null;
    return await withCachedController({
      cachedUrl:
        sandboxGroupId && cachedUrl && controllerCacheAllowsHostFetch(cachedUrl)
          ? cachedUrl
          : null,
      createCachedClient: (url) =>
        new BrowserControlClient(controllerOnlySession(url), { adminToken }),
      prepareCachedClient: async (client) => {
        if (origin) await client.addAllowedOrigins([origin]);
      },
      invalidateCachedUrl: async () => {
        if (!sandboxGroupId || !placement.lease) return;
        await recordLeaseControllerDataPlaneUrl(deps.db, {
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
          nativeAuthority: nativeControllerAuthority(workspaceId, placement),
          ...(origin ? { allowedOrigins: [origin] } : {}),
        });
        return client;
      },
      use: operation,
    });
  }

  async function withActiveComputerController<T>(
    context: Context,
    grant: AccessGrant,
    workspaceId: string,
    computerSessionId: string,
    authorizationOperation: SessionAuthorizationOperation,
    channelOperation: ChannelAOperation,
    callback: (input: {
      client: BrowserControlClient;
      sessionClient: ReturnType<BrowserControlClient["computerSessionClient"]>;
      record: ComputerSessionControlRecord;
      binding: NonNullable<ComputerSessionControlRecord["session"]["controller"]>;
      placement: ComputerPlacement;
    }) => Promise<T>,
    recoverMissing = true,
  ): Promise<T> {
    try {
      const record = await getComputerSessionControlRecord(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        computerSessionId,
      });
      await authorizeSourceSession(deps, grant, record.sourceSessionId, authorizationOperation);
      if (record.session.lifecycle !== "active" || !record.session.controller) {
        throw new ComputerSessionStateError("ComputerSession is not active");
      }
      const binding = record.session.controller;
      const admitted = await touchComputerSessionController(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        computerSessionId,
        controllerGeneration: binding.controllerGeneration,
      });
      if (!admitted) {
        throw new ComputerSessionStateError("ComputerSession controller authority changed");
      }
      const run = async (placement: ComputerPlacement): Promise<T> => {
        // The active controller binding is the provisioning fence. Live
        // input connects to it directly instead of re-ensuring the sidecar.
        const client = connectController(grant, record, placement);
        const tokens = deriveComputerSessionControllerTokens({
          rootSecret: controllerAuthorityRoot(deps),
          accountId: grant.accountId,
          workspaceId,
          placement: record.session.placement,
          placementInstanceId: placement.placementInstanceId,
          computerSessionId,
          controllerGeneration: binding.controllerGeneration,
          tokenGeneration: record.tokenGeneration,
        });
        const controller = {
          client,
          sessionClient: client.computerSessionClient({
            reference: {
              computerSessionId,
              controllerGeneration: binding.controllerGeneration,
            },
            ...tokens,
          }),
          record,
          binding,
          placement,
        };
        let result: T;
        try {
          result = await callback(controller);
        } catch (error) {
          if (!recoverMissing || !isMissingComputerControllerSession(error)) throw error;
          await client.createComputerSession({
            computerSessionId,
            controllerGeneration: binding.controllerGeneration,
            tokenGeneration: record.tokenGeneration,
            ...tokens,
          });
          result = await callback(controller);
        }
        return result;
      };
      const cached = await cachedComputerPlacement(record);
      if (cached) {
        try {
          return await run(cached);
        } catch (error) {
          const safelyReplayable =
            channelOperation === "computer.read" || channelOperation === "computer.action";
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
            sandboxGroupId: cached.lease!.sandboxGroupId,
            expectedEpoch: cached.lease!.leaseEpoch,
            expectedInstanceId: cached.placementInstanceId,
            controllerDataPlaneUrl: null,
          }).catch(() => null);
        }
      }

      const sourceSession = await requireSourceSession(deps, workspaceId, record.sourceSessionId);
      return await withComputerPlacement(
        sourceSession,
        grant,
        record.session.placement,
        binding.placementInstanceId,
        channelOperation,
        context.req.raw.signal,
        async (placement) =>
          await run(
            await cacheComputerControllerPlacement(grant, workspaceId, placement).catch(
              () => placement,
            ),
          ),
      );
    } catch (error) {
      throw computerRouteError(error);
    }
  }

  async function ensureInteractionHolder(
    grant: AccessGrant,
    sourceSession: Session,
    computerSessionId: string,
    placement: ComputerPlacement,
    waitSignal: AbortSignal,
  ): Promise<boolean> {
    if (placement.placement.kind !== "sandbox_group") return false;
    if (!placement.lease?.instanceId) {
      throw new ComputerSessionStateError("ComputerSession lease placement is unavailable");
    }
    const sandboxRuntime = await resolveSessionSandboxRuntime(
      deps.db,
      deps.settings,
      sourceSession,
    );
    const acquired = await acquireLease(deps.db, {
      accountId: grant.accountId,
      workspaceId: sourceSession.workspaceId,
      sandboxGroupId: placement.placement.sandboxGroupId,
      kind: "interaction",
      holderId: interactionHolderId(computerSessionId),
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
      throw new ComputerSessionStateError("ComputerSession placement is transitioning; retry");
    }
    if (
      acquired.role === "spawner" ||
      acquired.lease.leaseEpoch !== placement.lease.leaseEpoch ||
      acquired.lease.instanceId !== placement.placementInstanceId
    ) {
      await releaseInteractionHolder(
        grant,
        sourceSession.workspaceId,
        computerSessionId,
        placement.placement,
      ).catch(() => undefined);
      throw new ComputerSessionStateError("ComputerSession placement fence changed; retry");
    }
    await renewSandboxProviderExpiration({
      backend: acquired.lease.backend as ApiRouteDeps["settings"]["sandboxBackend"],
      settings: deps.settings,
      instanceId: acquired.lease.instanceId,
    }).catch(() => false);
    return true;
  }

  async function ensureDispatchedGeneration(
    grant: AccessGrant,
    workspaceId: string,
    computerSessionId: string,
    operationId: string,
    placementInstanceId: string,
  ): Promise<ComputerSessionControlRecord> {
    let record = await getComputerSessionControlRecord(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      computerSessionId,
      operationId,
    });
    if (record.operation?.state === "prepared") {
      const controllerGeneration = randomUUID();
      try {
        await dispatchComputerSessionOperation(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          operationId,
          computerSessionId,
          controllerGeneration,
          controller: {
            controllerId: "opengeni-browserd",
            controllerGeneration,
            placementInstanceId,
          },
        });
      } catch (error) {
        if (!(error instanceof ComputerSessionOperationConflictError)) throw error;
      }
      record = await getComputerSessionControlRecord(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        computerSessionId,
        operationId,
      });
    }
    if (record.operation?.state !== "dispatched") {
      throw new ComputerSessionStateError("ComputerSession create operation is not dispatchable");
    }
    if (
      !record.session.controller ||
      record.session.controller.controllerGeneration !== record.operation.controllerGeneration ||
      record.session.controller.placementInstanceId !== placementInstanceId
    ) {
      throw new ComputerSessionOperationConflictError(
        "ComputerSession dispatch controller binding is inconsistent",
      );
    }
    return record;
  }

  async function provisionController(
    grant: AccessGrant,
    record: ComputerSessionControlRecord,
    placement: ComputerPlacement,
    origin: string | null,
  ): Promise<BrowserControlClient> {
    const adminToken = deriveBrowserControllerAdminToken({
      rootSecret: controllerAuthorityRoot(deps),
      accountId: grant.accountId,
      workspaceId: record.session.workspaceId,
      placement: record.session.placement,
      placementInstanceId: placement.placementInstanceId,
    });
    return (
      await provisionBrowserControlClient(placement.session, {
        adminToken,
        nativeAuthority: nativeControllerAuthority(record.session.workspaceId, placement),
        ...(origin ? { allowedOrigins: [origin] } : {}),
      })
    ).client;
  }

  function connectController(
    grant: AccessGrant,
    record: ComputerSessionControlRecord,
    placement: ComputerPlacement,
  ): BrowserControlClient {
    return new BrowserControlClient(placement.session, {
      adminToken: deriveBrowserControllerAdminToken({
        rootSecret: controllerAuthorityRoot(deps),
        accountId: grant.accountId,
        workspaceId: record.session.workspaceId,
        placement: record.session.placement,
        placementInstanceId: placement.placementInstanceId,
      }),
      nativeAuthority: nativeControllerAuthority(record.session.workspaceId, placement),
    });
  }

  async function releaseInteractionHolder(
    grant: AccessGrant,
    workspaceId: string,
    computerSessionId: string,
    placement: InteractionPlacement,
  ): Promise<void> {
    if (placement.kind !== "sandbox_group") return;
    await releaseLeaseHolder(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      sandboxGroupId: placement.sandboxGroupId,
      kind: "interaction",
      holderId: interactionHolderId(computerSessionId),
      idleGraceMs: deps.settings.sandboxIdleGraceMs,
    });
  }

  async function routePreamble(
    context: Context,
    permission: "sessions:read" | "sessions:control" | "stream:view",
  ): Promise<{
    workspaceId: string;
    grant: AccessGrant;
    computerSessionId: string;
  }> {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, permission);
    return {
      workspaceId,
      grant,
      computerSessionId: requireUuidParam(context, "computerSessionId"),
    };
  }
}

function computerCreateInput(
  grant: AccessGrant,
  workspaceId: string,
  request: CreateComputerSessionRequestValue,
  placement: InteractionPlacement,
) {
  return {
    accountId: grant.accountId,
    workspaceId,
    operationId: request.operationId,
    associatedSessionId: request.sessionId,
    actorSubjectId: grant.subjectId,
    name: request.name ?? "Computer",
    placement,
  };
}

function assertCreateReplay(
  request: CreateComputerSessionRequestValue,
  session: ComputerSessionValue,
): void {
  if (request.placement && !sameInteractionPlacement(request.placement, session.placement)) {
    throw new ComputerSessionOperationConflictError(
      "ComputerSession create operation is bound to another placement",
    );
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

function requireOperationGeneration(record: ComputerSessionControlRecord): string {
  const generation = record.operation?.controllerGeneration;
  if (!generation) {
    throw new ComputerSessionStateError("ComputerSession controller fence is absent");
  }
  return generation;
}

function nativeControllerAuthority(
  workspaceId: string,
  placement: ComputerPlacement,
): { scopeId: string; scopeGeneration: string } {
  const placementId =
    placement.placement.kind === "connected_machine"
      ? placement.placement.sandboxId
      : placement.placement.kind === "attached_device"
        ? placement.placement.deviceId
        : placement.placement.kind === "sandbox_group"
          ? placement.placement.sandboxGroupId
          : null;
  if (!placementId) {
    throw new BrowserControlUnsupportedError("computer controller placement is unsupported");
  }
  return {
    scopeId: `${workspaceId}:${placement.placement.kind}:${placementId}`,
    scopeGeneration: placement.placementInstanceId,
  };
}

function interactionHolderId(computerSessionId: string): string {
  return `computer-session:${computerSessionId}`;
}

function controllerAuthorityRoot(deps: ApiRouteDeps): string {
  const root = resolveFirstPartyDelegationSecret(deps.settings);
  if (!root) {
    throw new HTTPException(503, {
      message: "interaction controller authority is not configured",
    });
  }
  return root;
}

async function requireSourceSession(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
): Promise<Session> {
  const session = await getSession(deps.db, workspaceId, sessionId);
  if (!session) throw new ComputerSessionNotFoundError("Associated session not found");
  return session;
}

async function authorizeSourceSession(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  operation: SessionAuthorizationOperation,
): Promise<void> {
  try {
    await requireSessionAuthorization(deps, grant, {
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
  if (!isUuid(value)) throw new HTTPException(404, { message: "ComputerSession not found" });
  return value;
}

function requireOpaqueParam(context: Context, name: string): string {
  const value = context.req.param(name) ?? "";
  if (value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HTTPException(404, { message: "computer target not found" });
  }
  return value;
}

function requestOrigin(context: Context, settings: ApiRouteDeps["settings"]): string | null {
  return validateInteractionRequestOrigin(context.req.header("origin"), settings);
}

function interactionActorForGrant(grant: AccessGrant): ReturnType<typeof InteractionActor.parse> {
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
    throw new ComputerSessionStateError("ComputerSession placement instance changed");
  }
}

/** End must still reach the live agent with the session's original token
 *  fence. A later Chrome generation must not block ScreenCaptureKit teardown. */
function attachedEndPlacementInstanceId(
  operation: ChannelAOperation,
  expectedPlacementInstanceId: string | null,
  liveGeneration: string,
): string {
  if (operation === "computer.end" && expectedPlacementInstanceId) {
    return expectedPlacementInstanceId;
  }
  assertPlacementInstance(expectedPlacementInstanceId, liveGeneration);
  return liveGeneration;
}

function assertConnectedMachineComputerAccess(
  enrollment: {
    hasDisplay: boolean;
    desktopUnavailableReason: string | null;
    allowScreenControl: boolean;
  },
  operation: ChannelAOperation,
): void {
  const error = connectedMachineComputerAccessError(
    enrollment,
    operation === "computer.action" || operation === "computer.control",
  );
  if (!error) return;
  if (error.status === 403) {
    throw new HTTPException(403, { message: error.message });
  }
  throw new ComputerSessionStateError(error.message);
}

function isTerminalOperation(state: string): boolean {
  return state === "completed" || state === "failed" || state === "outcome_unknown";
}

function isMissingComputerControllerSession(error: unknown): boolean {
  if (!(error instanceof BrowserControlRequestError)) return false;
  if (error.status === 401 && error.error.code === "permission_denied") return true;
  return (
    error.status === 404 &&
    error.error.code === "resource_not_found" &&
    ["computer session not found", "computer session is not active"].includes(error.error.message)
  );
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
    message: error instanceof Error ? error.message : "computer controller failed",
    retryable: false,
  };
}

function computerRouteError(error: unknown): HTTPException {
  const connectedMachineError = interactionControlApiError(error, "computer");
  if (connectedMachineError) return connectedMachineError;
  if (error instanceof HTTPException) return error;
  if (error instanceof ComputerSessionNotFoundError) {
    return new HTTPException(404, { message: error.message, cause: error });
  }
  if (
    error instanceof ComputerSessionOperationConflictError ||
    error instanceof ComputerSessionStateError
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
      message: "computer controller is unavailable",
      cause: error,
    });
  }
  if (error instanceof BrowserControlProtocolError) {
    return new HTTPException(502, {
      message: "computer controller response is invalid",
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
          ? "computer adapter is unavailable on this placement"
          : "computer controller could not start",
      cause: error,
    });
  }
  return new HTTPException(500, {
    message: "ComputerSession request failed",
    cause: error,
  });
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
