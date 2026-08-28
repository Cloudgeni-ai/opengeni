import {
  ApplyInternalApplicationDeploymentRequest,
  ApproveInternalApplicationDeploymentRequest,
  CreateInternalApplicationAiSessionRequest,
  CreateInternalApplicationBuildSessionRequest,
  CreateInternalApplicationRequest,
  InternalApplicationAiSessionReceipt,
  InternalApplicationBuildSessionReceipt,
  InternalApplicationBundlesResponse,
  InternalApplicationDataSourcesResponse,
  InternalApplicationDeploymentActionResponse,
  InternalApplicationDeploymentOperationsResponse,
  InternalApplicationDeploymentsResponse,
  InternalApplicationDeploymentTargetsResponse,
  InternalApplicationDetail,
  InternalApplicationDeploymentOperation,
  InternalApplicationEventsResponse,
  InternalApplicationsListResponse,
  ObserveInternalApplicationDeploymentRequest,
  PlanInternalApplicationDeploymentRequest,
  ReconcileInternalApplicationDeploymentOperationRequest,
  RegisterInternalApplicationBundleRequest,
  RetireInternalApplicationDeploymentRequest,
  RollbackInternalApplicationDeploymentRequest,
  UpdateInternalApplicationRequest,
  UpsertInternalApplicationDataSourceRequest,
  UpsertInternalApplicationDeploymentTargetRequest,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  InternalApplicationIdempotencyError,
  InternalApplicationInvariantError,
  InternalApplicationNotFoundError,
  InternalApplicationVersionConflictError,
  createInternalApplication,
  getInternalApplication,
  getInternalApplicationDeploymentOperation,
  listInternalApplicationBundles,
  listInternalApplicationDataSources,
  listInternalApplicationDeploymentTargets,
  listInternalApplicationDeployments,
  listInternalApplicationDeploymentOperations,
  listInternalApplicationEvents,
  listInternalApplications,
  loadConnectionCredentialForBroker,
  recordInternalApplicationBuildSessionStarted,
  registerInternalApplicationBundle,
  updateInternalApplication,
  upsertInternalApplicationDataSource,
  upsertInternalApplicationDeploymentTarget,
} from "@opengeni/db";
import {
  KubernetesInternalApplicationProvider,
  InternalApplicationProviderError,
  applyInternalApplicationDeployment,
  approveInternalApplicationDeploymentPlan,
  observeInternalApplicationDeployment,
  planInternalApplicationDeployment,
  reconcileInternalApplicationDeploymentOperation,
  requireAccessGrant,
  resolveInternalApplicationBuildSessionPolicy,
  resolveInternalApplicationAiSessionPolicy,
  retireInternalApplicationDeployment,
  rollbackInternalApplicationDeployment,
  createSessionForRequest,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { ZodType } from "zod";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

async function parseJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  const value = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new HTTPException(400, {
      message: "invalid internal application request",
    });
  return parsed.data;
}

export function internalApplicationsHttpError(error: unknown): HTTPException {
  if (error instanceof HTTPException) return error;
  if (error instanceof InternalApplicationNotFoundError)
    return new HTTPException(404, { message: error.message });
  if (
    error instanceof InternalApplicationVersionConflictError ||
    error instanceof InternalApplicationIdempotencyError
  )
    return new HTTPException(409, { message: error.message });
  if (error instanceof InternalApplicationInvariantError)
    return new HTTPException(422, { message: error.message });
  if (error instanceof InternalApplicationProviderError && !error.outcomeUnknown)
    return new HTTPException(422, { message: error.message });
  return new HTTPException(500, {
    message: "internal application operation failed",
  });
}

export function assertInternalApplicationsEnabled(settings: {
  advancedDeploymentsEnabled?: boolean;
}): void {
  if (!settings.advancedDeploymentsEnabled) {
    throw new HTTPException(404, {
      message: "advanced deployments are not enabled for this deployment",
    });
  }
}

export function registerInternalApplicationRoutes(app: Hono, deps: ApiRouteDeps): void {
  function assertEnabled() {
    assertInternalApplicationsEnabled(deps.settings);
  }

  async function grant(c: Context, write = false): Promise<AccessGrant> {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) throw new HTTPException(404, { message: "workspace not found" });
    const result = await requireAccessGrant(
      c,
      deps,
      workspaceId,
      write ? "workspace:admin" : "workspace:read",
    );
    assertEnabled();
    return result;
  }

  const provider = new KubernetesInternalApplicationProvider(
    async ({ workspaceId, connectionId, apiServer }) => {
      if (!connectionId)
        throw new InternalApplicationInvariantError(
          "Kubernetes target requires a workspace credential connection",
        );
      const credential = await loadConnectionCredentialForBroker(deps.db, deps.settings, {
        workspaceId,
        connectionId,
        providerDomain: new URL(apiServer).hostname,
        allowSubjectOwned: false,
      });
      if (!credential || credential.status !== "active")
        throw new InternalApplicationInvariantError(
          "Kubernetes credential connection is unavailable",
        );
      const candidate =
        credential.credential.bearerToken ??
        credential.credential.token ??
        credential.credential.access_token;
      if (typeof candidate !== "string" || candidate.length === 0)
        throw new InternalApplicationInvariantError(
          "Kubernetes credential connection has no bearer token",
        );
      const certificateAuthority =
        credential.credential.caCertificate ??
        credential.credential.certificateAuthority ??
        credential.credential.ca;
      if (
        certificateAuthority !== undefined &&
        (typeof certificateAuthority !== "string" ||
          certificateAuthority.length < 1 ||
          certificateAuthority.length > 1_048_576)
      )
        throw new InternalApplicationInvariantError(
          "Kubernetes credential connection has an invalid certificate authority",
        );
      return {
        bearerToken: candidate,
        ...(typeof certificateAuthority === "string" ? { certificateAuthority } : {}),
      };
    },
    fetch,
    async ({ workspaceId, connectionId, endpoint }) => {
      const credential = await loadConnectionCredentialForBroker(deps.db, deps.settings, {
        workspaceId,
        connectionId,
        providerDomain: new URL(endpoint).hostname,
        allowSubjectOwned: false,
      });
      if (!credential || credential.status !== "active")
        throw new InternalApplicationInvariantError(
          "Data lifecycle broker credential connection is unavailable",
        );
      const candidate =
        credential.credential.bearerToken ??
        credential.credential.token ??
        credential.credential.access_token;
      if (typeof candidate !== "string" || candidate.length === 0)
        throw new InternalApplicationInvariantError(
          "Data lifecycle broker credential connection has no bearer token",
        );
      return { bearerToken: candidate };
    },
  );

  app.get("/v1/workspaces/:workspaceId/internal-applications", async (c) => {
    await grant(c);
    try {
      return c.json(
        InternalApplicationsListResponse.parse({
          applications: await listInternalApplications(deps.db, c.req.param("workspaceId")),
        }),
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/internal-applications", async (c) => {
    const access = await grant(c, true);
    const request = await parseJson(c, CreateInternalApplicationRequest);
    try {
      return c.json(
        InternalApplicationDetail.parse(
          await createInternalApplication(deps.db, {
            workspaceId: c.req.param("workspaceId"),
            actorSubjectId: access.subjectId,
            request,
          }),
        ),
        201,
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/internal-applications/:applicationId", async (c) => {
    await grant(c);
    try {
      return c.json(
        InternalApplicationDetail.parse(
          await getInternalApplication(
            deps.db,
            c.req.param("workspaceId"),
            c.req.param("applicationId"),
          ),
        ),
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.post(
    "/v1/workspaces/:workspaceId/internal-applications/:applicationId/build/sessions",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const applicationId = c.req.param("applicationId");
      const access = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
      assertEnabled();
      const request = await parseJson(c, CreateInternalApplicationBuildSessionRequest);
      try {
        const [detail, dataSources, targets] = await Promise.all([
          getInternalApplication(deps.db, workspaceId, applicationId),
          listInternalApplicationDataSources(deps.db, workspaceId),
          listInternalApplicationDeploymentTargets(deps.db, workspaceId),
        ]);
        const resolved = resolveInternalApplicationBuildSessionPolicy(
          detail,
          dataSources,
          targets,
          request,
        );
        const session = await createSessionForRequest(deps, access, workspaceId, {
          initialMessage: resolved.initialMessage,
          instructions: resolved.instructions,
          ...(request.model ? { model: request.model } : {}),
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
          idempotencyKey: `internal-app-build:${applicationId}:${request.operationId}`,
          metadata: {
            internalApplicationId: applicationId,
            internalApplicationRevision: detail.application.headRevision,
            internalApplicationBuildOperationId: request.operationId,
            ...(request.targetId ? { internalApplicationTargetId: request.targetId } : {}),
          },
        });
        await recordInternalApplicationBuildSessionStarted(deps.db, {
          workspaceId,
          applicationId,
          operationId: request.operationId,
          expectedApplicationRevision: request.expectedApplicationRevision,
          sessionId: session.id,
          targetId: request.targetId,
          actorSubjectId: access.subjectId,
        });
        return c.json(
          InternalApplicationBuildSessionReceipt.parse({
            schemaVersion: 1,
            applicationId,
            applicationRevision: detail.application.headRevision,
            sessionId: session.id,
            initialTurnId: session.initialTurnId,
            model: session.model,
            eventsPath: `/v1/workspaces/${workspaceId}/sessions/${session.id}/events/stream`,
          }),
          202,
        );
      } catch (error) {
        throw internalApplicationsHttpError(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/internal-applications/:applicationId/ai/sessions",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const applicationId = c.req.param("applicationId");
      const access = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
      assertEnabled();
      const request = await parseJson(c, CreateInternalApplicationAiSessionRequest);
      try {
        const detail = await getInternalApplication(deps.db, workspaceId, applicationId);
        const deployments = await listInternalApplicationDeployments(
          deps.db,
          workspaceId,
          applicationId,
        );
        const bundles = await listInternalApplicationBundles(deps.db, workspaceId, applicationId);
        const resolved = resolveInternalApplicationAiSessionPolicy(
          detail,
          deployments,
          bundles,
          request,
        );
        const session = await createSessionForRequest(deps, access, workspaceId, {
          initialMessage: request.initialMessage,
          ...(request.modelContext ? { modelContext: request.modelContext } : {}),
          instructions: resolved.instructions,
          model: resolved.model,
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
          idempotencyKey: `internal-app:${applicationId}:${request.operationId}`,
          metadata: {
            ...request.metadata,
            internalApplicationId: applicationId,
            internalApplicationRevision: detail.application.headRevision,
            internalApplicationDeploymentId: resolved.deployment.id,
          },
          firstPartyMcpPermissions: [],
          firstPartyMcpTools: [],
        });
        return c.json(
          InternalApplicationAiSessionReceipt.parse({
            schemaVersion: 1,
            applicationId,
            applicationRevision: detail.application.headRevision,
            sessionId: session.id,
            initialTurnId: session.initialTurnId,
            model: resolved.model,
            eventsPath: `/v1/workspaces/${workspaceId}/sessions/${session.id}/events/stream`,
          }),
          202,
        );
      } catch (error) {
        throw internalApplicationsHttpError(error);
      }
    },
  );

  app.patch("/v1/workspaces/:workspaceId/internal-applications/:applicationId", async (c) => {
    const access = await grant(c, true);
    const request = await parseJson(c, UpdateInternalApplicationRequest);
    try {
      return c.json(
        InternalApplicationDetail.parse(
          await updateInternalApplication(deps.db, {
            workspaceId: c.req.param("workspaceId"),
            applicationId: c.req.param("applicationId"),
            actorSubjectId: access.subjectId,
            request,
          }),
        ),
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/internal-application-data-sources", async (c) => {
    await grant(c);
    try {
      return c.json(
        InternalApplicationDataSourcesResponse.parse({
          dataSources: await listInternalApplicationDataSources(
            deps.db,
            c.req.param("workspaceId"),
          ),
        }),
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.put(
    "/v1/workspaces/:workspaceId/internal-application-data-sources/:dataSourceId",
    async (c) => {
      const access = await grant(c, true);
      const request = await parseJson(c, UpsertInternalApplicationDataSourceRequest);
      try {
        return c.json(
          await upsertInternalApplicationDataSource(deps.db, {
            workspaceId: c.req.param("workspaceId"),
            dataSourceId: c.req.param("dataSourceId"),
            actorSubjectId: access.subjectId,
            request,
          }),
          request.expectedRevision === 0 ? 201 : 200,
        );
      } catch (error) {
        throw internalApplicationsHttpError(error);
      }
    },
  );

  app.get("/v1/workspaces/:workspaceId/internal-application-targets", async (c) => {
    await grant(c);
    try {
      return c.json(
        InternalApplicationDeploymentTargetsResponse.parse({
          targets: await listInternalApplicationDeploymentTargets(
            deps.db,
            c.req.param("workspaceId"),
          ),
        }),
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.put("/v1/workspaces/:workspaceId/internal-application-targets/:targetId", async (c) => {
    const access = await grant(c, true);
    const request = await parseJson(c, UpsertInternalApplicationDeploymentTargetRequest);
    try {
      return c.json(
        await upsertInternalApplicationDeploymentTarget(deps.db, {
          workspaceId: c.req.param("workspaceId"),
          targetId: c.req.param("targetId"),
          actorSubjectId: access.subjectId,
          request,
        }),
        request.expectedRevision === 0 ? 201 : 200,
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/internal-applications/:applicationId/bundles", async (c) => {
    await grant(c);
    try {
      return c.json(
        InternalApplicationBundlesResponse.parse({
          bundles: await listInternalApplicationBundles(
            deps.db,
            c.req.param("workspaceId"),
            c.req.param("applicationId"),
          ),
        }),
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.post(
    "/v1/workspaces/:workspaceId/internal-applications/:applicationId/bundles",
    async (c) => {
      const access = await grant(c, true);
      const request = await parseJson(c, RegisterInternalApplicationBundleRequest);
      try {
        return c.json(
          await registerInternalApplicationBundle(deps.db, {
            workspaceId: c.req.param("workspaceId"),
            applicationId: c.req.param("applicationId"),
            actorSubjectId: access.subjectId,
            request,
          }),
          201,
        );
      } catch (error) {
        throw internalApplicationsHttpError(error);
      }
    },
  );

  app.get("/v1/workspaces/:workspaceId/internal-application-deployments", async (c) => {
    await grant(c);
    try {
      return c.json(
        InternalApplicationDeploymentsResponse.parse({
          deployments: await listInternalApplicationDeployments(
            deps.db,
            c.req.param("workspaceId"),
            c.req.query("applicationId"),
          ),
        }),
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/internal-application-deployments/plan", async (c) => {
    const access = await grant(c, true);
    const request = await parseJson(c, PlanInternalApplicationDeploymentRequest);
    try {
      return c.json(
        InternalApplicationDeploymentActionResponse.parse(
          await planInternalApplicationDeployment(deps.db, {
            workspaceId: c.req.param("workspaceId"),
            actorSubjectId: access.subjectId,
            request,
          }),
        ),
        201,
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.post(
    "/v1/workspaces/:workspaceId/internal-application-operations/:operationId/approve",
    async (c) => {
      const access = await grant(c, true);
      const request = await parseJson(c, ApproveInternalApplicationDeploymentRequest);
      try {
        return c.json(
          InternalApplicationDeploymentOperation.parse(
            await approveInternalApplicationDeploymentPlan(deps.db, {
              workspaceId: c.req.param("workspaceId"),
              operationId: c.req.param("operationId"),
              actorSubjectId: access.subjectId,
              request,
            }),
          ),
        );
      } catch (error) {
        throw internalApplicationsHttpError(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/internal-application-operations/:operationId/reconcile",
    async (c) => {
      const access = await grant(c, true);
      const request = await parseJson(c, ReconcileInternalApplicationDeploymentOperationRequest);
      try {
        return c.json(
          InternalApplicationDeploymentActionResponse.parse(
            await reconcileInternalApplicationDeploymentOperation(deps.db, provider, {
              workspaceId: c.req.param("workspaceId"),
              operationId: c.req.param("operationId"),
              actorSubjectId: access.subjectId,
              request,
            }),
          ),
        );
      } catch (error) {
        throw internalApplicationsHttpError(error);
      }
    },
  );

  app.post("/v1/workspaces/:workspaceId/internal-application-deployments/apply", async (c) => {
    const access = await grant(c, true);
    const request = await parseJson(c, ApplyInternalApplicationDeploymentRequest);
    try {
      return c.json(
        InternalApplicationDeploymentActionResponse.parse(
          await applyInternalApplicationDeployment(deps.db, provider, {
            workspaceId: c.req.param("workspaceId"),
            actorSubjectId: access.subjectId,
            request,
          }),
        ),
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.post(
    "/v1/workspaces/:workspaceId/internal-application-deployments/:deploymentId/observe",
    async (c) => {
      const access = await grant(c, true);
      const request = await parseJson(c, ObserveInternalApplicationDeploymentRequest);
      try {
        return c.json(
          InternalApplicationDeploymentActionResponse.parse(
            await observeInternalApplicationDeployment(deps.db, provider, {
              workspaceId: c.req.param("workspaceId"),
              deploymentId: c.req.param("deploymentId"),
              operationId: request.operationId,
              actorSubjectId: access.subjectId,
            }),
          ),
        );
      } catch (error) {
        throw internalApplicationsHttpError(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/internal-application-deployments/:deploymentId/rollback",
    async (c) => {
      const access = await grant(c, true);
      const request = await parseJson(c, RollbackInternalApplicationDeploymentRequest);
      try {
        return c.json(
          InternalApplicationDeploymentActionResponse.parse(
            await rollbackInternalApplicationDeployment(deps.db, provider, {
              workspaceId: c.req.param("workspaceId"),
              deploymentId: c.req.param("deploymentId"),
              actorSubjectId: access.subjectId,
              request,
            }),
          ),
        );
      } catch (error) {
        throw internalApplicationsHttpError(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/internal-application-deployments/:deploymentId/retire",
    async (c) => {
      const access = await grant(c, true);
      const request = await parseJson(c, RetireInternalApplicationDeploymentRequest);
      try {
        return c.json(
          InternalApplicationDeploymentActionResponse.parse(
            await retireInternalApplicationDeployment(deps.db, provider, {
              workspaceId: c.req.param("workspaceId"),
              deploymentId: c.req.param("deploymentId"),
              actorSubjectId: access.subjectId,
              request,
            }),
          ),
        );
      } catch (error) {
        throw internalApplicationsHttpError(error);
      }
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/internal-application-deployments/:deploymentId/operations",
    async (c) => {
      await grant(c);
      try {
        return c.json(
          InternalApplicationDeploymentOperationsResponse.parse({
            operations: await listInternalApplicationDeploymentOperations(
              deps.db,
              c.req.param("workspaceId"),
              c.req.param("deploymentId"),
            ),
          }),
        );
      } catch (error) {
        throw internalApplicationsHttpError(error);
      }
    },
  );

  app.get("/v1/workspaces/:workspaceId/internal-applications/:applicationId/events", async (c) => {
    await grant(c);
    try {
      return c.json(
        InternalApplicationEventsResponse.parse({
          events: await listInternalApplicationEvents(
            deps.db,
            c.req.param("workspaceId"),
            c.req.param("applicationId"),
          ),
        }),
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/internal-application-operations/:operationId", async (c) => {
    await grant(c);
    try {
      return c.json(
        InternalApplicationDeploymentOperation.parse(
          await getInternalApplicationDeploymentOperation(
            deps.db,
            c.req.param("workspaceId"),
            c.req.param("operationId"),
          ),
        ),
      );
    } catch (error) {
      throw internalApplicationsHttpError(error);
    }
  });
}
