import {
  AuthRun,
  AuthRunListResponse,
  CreateInteractionInterventionRequest,
  CreateNetworkRouteRequest,
  CreateSiteAuthConnectionRequest,
  InteractionIntervention,
  InteractionInterventionListResponse,
  InteractionInterventionMutationResponse,
  NetworkRoute,
  NetworkRouteListResponse,
  NetworkRouteMutationResponse,
  ResolveInteractionInterventionRequest,
  SiteAuthConnection,
  SiteAuthConnectionListResponse,
  SiteAuthConnectionMutationResponse,
  UpdateNetworkRouteRequest,
  UpdateSiteAuthConnectionRequest,
  type AccessGrant,
  type SessionAuthorizationOperation,
} from "@opengeni/contracts";
import {
  BrowserSessionNotFoundError,
  ComputerSessionNotFoundError,
  InteractionResourceConflictError,
  InteractionResourceNotFoundError,
  InteractionResourceStateError,
  createInteractionIntervention,
  createNetworkRoute,
  createSiteAuthConnection,
  getAuthRun,
  getBrowserSessionControlRecord,
  getComputerSessionControlRecord,
  getInteractionIntervention,
  getNetworkRoute,
  getSiteAuthConnection,
  listAuthRuns,
  listInteractionInterventions,
  listNetworkRoutes,
  listSiteAuthConnections,
  resolveInteractionIntervention,
  updateNetworkRoute,
  updateSiteAuthConnection,
} from "@opengeni/db";
import {
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  requireAccessGrant,
  requireSessionAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerInteractionResourceRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/network-routes", async (context) => {
    const { workspaceId, grant } = await preamble(context, deps, "sessions:read");
    try {
      return context.json(
        NetworkRouteListResponse.parse(
          await listNetworkRoutes(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            includeArchived: context.req.query("includeArchived") === "true",
          }),
        ),
      );
    } catch (error) {
      throw interactionResourceRouteError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/network-routes", async (context) => {
    const { workspaceId, grant } = await preamble(context, deps, "sessions:control");
    const request = await parseJsonBody(context, CreateNetworkRouteRequest);
    try {
      const response = await createNetworkRoute(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        actorSubjectId: grant.subjectId,
        ...request,
      });
      return context.json(
        NetworkRouteMutationResponse.parse(response),
        response.replayed ? 200 : 201,
      );
    } catch (error) {
      throw interactionResourceRouteError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/network-routes/:networkRouteId", async (context) => {
    const { workspaceId, grant } = await preamble(context, deps, "sessions:read");
    try {
      return context.json(
        NetworkRoute.parse(
          await getNetworkRoute(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            routeId: uuidParam(context, "networkRouteId"),
          }),
        ),
      );
    } catch (error) {
      throw interactionResourceRouteError(error);
    }
  });

  app.patch("/v1/workspaces/:workspaceId/network-routes/:networkRouteId", async (context) => {
    const { workspaceId, grant } = await preamble(context, deps, "sessions:control");
    const routeId = uuidParam(context, "networkRouteId");
    const request = await parseJsonBody(context, UpdateNetworkRouteRequest);
    try {
      return context.json(
        NetworkRouteMutationResponse.parse(
          await updateNetworkRoute(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            actorSubjectId: grant.subjectId,
            routeId,
            ...request,
          }),
        ),
      );
    } catch (error) {
      throw interactionResourceRouteError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/site-auth-connections", async (context) => {
    const { workspaceId, grant } = await preamble(context, deps, "sessions:read");
    try {
      return context.json(
        SiteAuthConnectionListResponse.parse(
          await listSiteAuthConnections(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            includeArchived: context.req.query("includeArchived") === "true",
          }),
        ),
      );
    } catch (error) {
      throw interactionResourceRouteError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/site-auth-connections", async (context) => {
    const { workspaceId, grant } = await preamble(context, deps, "sessions:control");
    const request = await parseJsonBody(context, CreateSiteAuthConnectionRequest);
    try {
      const response = await createSiteAuthConnection(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        actorSubjectId: grant.subjectId,
        ...request,
      });
      return context.json(
        SiteAuthConnectionMutationResponse.parse(response),
        response.replayed ? 200 : 201,
      );
    } catch (error) {
      throw interactionResourceRouteError(error);
    }
  });

  app.get(
    "/v1/workspaces/:workspaceId/site-auth-connections/:siteAuthConnectionId",
    async (context) => {
      const { workspaceId, grant } = await preamble(context, deps, "sessions:read");
      try {
        return context.json(
          SiteAuthConnection.parse(
            await getSiteAuthConnection(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              siteAuthConnectionId: uuidParam(context, "siteAuthConnectionId"),
            }),
          ),
        );
      } catch (error) {
        throw interactionResourceRouteError(error);
      }
    },
  );

  app.patch(
    "/v1/workspaces/:workspaceId/site-auth-connections/:siteAuthConnectionId",
    async (context) => {
      const { workspaceId, grant } = await preamble(context, deps, "sessions:control");
      const siteAuthConnectionId = uuidParam(context, "siteAuthConnectionId");
      const request = await parseJsonBody(context, UpdateSiteAuthConnectionRequest);
      try {
        return context.json(
          SiteAuthConnectionMutationResponse.parse(
            await updateSiteAuthConnection(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              actorSubjectId: grant.subjectId,
              siteAuthConnectionId,
              ...request,
            }),
          ),
        );
      } catch (error) {
        throw interactionResourceRouteError(error);
      }
    },
  );

  app.get("/v1/workspaces/:workspaceId/auth-runs", async (context) => {
    const { workspaceId, grant } = await preamble(context, deps, "sessions:read");
    const browserSessionId = optionalUuidQuery(context, "browserSessionId");
    const siteAuthConnectionId = optionalUuidQuery(context, "siteAuthConnectionId");
    try {
      return context.json(
        AuthRunListResponse.parse(
          await listAuthRuns(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            ...(browserSessionId ? { browserSessionId } : {}),
            ...(siteAuthConnectionId ? { siteAuthConnectionId } : {}),
            includeSettled: context.req.query("includeSettled") === "true",
          }),
        ),
      );
    } catch (error) {
      throw interactionResourceRouteError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/auth-runs/:authRunId", async (context) => {
    const { workspaceId, grant } = await preamble(context, deps, "sessions:read");
    try {
      return context.json(
        AuthRun.parse(
          await getAuthRun(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            authRunId: uuidParam(context, "authRunId"),
          }),
        ),
      );
    } catch (error) {
      throw interactionResourceRouteError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/interaction-interventions", async (context) => {
    const { workspaceId, grant } = await preamble(context, deps, "sessions:read");
    const resourceKind = optionalResourceKind(context);
    const resourceId = optionalUuidQuery(context, "resourceId");
    try {
      return context.json(
        InteractionInterventionListResponse.parse(
          await listInteractionInterventions(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            ...(resourceKind ? { resourceKind } : {}),
            ...(resourceId ? { resourceId } : {}),
            includeSettled: context.req.query("includeSettled") === "true",
          }),
        ),
      );
    } catch (error) {
      throw interactionResourceRouteError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/interaction-interventions", async (context) => {
    const { workspaceId, grant } = await preamble(context, deps, "sessions:control");
    const request = await parseJsonBody(context, CreateInteractionInterventionRequest);
    try {
      const resourceSessionId = await resourceSourceSessionId(deps, grant, workspaceId, request);
      await authorizeSession(deps, grant, resourceSessionId, "session.control");
      const actor = interactionProvenance(grant);
      const actorSessionId = actor.sessionId ?? resourceSessionId;
      if (actorSessionId !== resourceSessionId) {
        await authorizeSession(deps, grant, actorSessionId, "session.control");
      }
      const response = await createInteractionIntervention(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        actorSubjectId: grant.subjectId,
        ...request,
        originatingSessionId: actorSessionId,
        originatingTurnId: actor.turnId,
        originatingAttemptId: actor.attemptId,
        originatingToolOperationId: actor.attemptId ? request.operationId : null,
      });
      return context.json(
        InteractionInterventionMutationResponse.parse(response),
        response.replayed ? 200 : 201,
      );
    } catch (error) {
      throw interactionResourceRouteError(error);
    }
  });

  app.get(
    "/v1/workspaces/:workspaceId/interaction-interventions/:interventionId",
    async (context) => {
      const { workspaceId, grant } = await preamble(context, deps, "sessions:read");
      try {
        return context.json(
          InteractionIntervention.parse(
            await getInteractionIntervention(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              interventionId: uuidParam(context, "interventionId"),
            }),
          ),
        );
      } catch (error) {
        throw interactionResourceRouteError(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/interaction-interventions/:interventionId/resolve",
    async (context) => {
      const { workspaceId, grant } = await preamble(context, deps, "sessions:control");
      const interventionId = uuidParam(context, "interventionId");
      const request = await parseJsonBody(context, ResolveInteractionInterventionRequest);
      try {
        return context.json(
          InteractionInterventionMutationResponse.parse(
            await resolveInteractionIntervention(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              actorSubjectId: grant.subjectId,
              interventionId,
              ...request,
            }),
          ),
        );
      } catch (error) {
        throw interactionResourceRouteError(error);
      }
    },
  );
}

async function preamble(
  context: Context,
  deps: ApiRouteDeps,
  permission: "sessions:read" | "sessions:control",
): Promise<{ workspaceId: string; grant: AccessGrant }> {
  const workspaceId = context.req.param("workspaceId") ?? "";
  return {
    workspaceId,
    grant: await requireAccessGrant(context, deps, workspaceId, permission),
  };
}

async function resourceSourceSessionId(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  request: { resourceKind: "browser_session" | "computer_session"; resourceId: string },
): Promise<string> {
  if (request.resourceKind === "browser_session") {
    return (
      await getBrowserSessionControlRecord(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        browserSessionId: request.resourceId,
      })
    ).sourceSessionId;
  }
  return (
    await getComputerSessionControlRecord(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      computerSessionId: request.resourceId,
    })
  ).sourceSessionId;
}

async function authorizeSession(
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
      throw new HTTPException(404, { message: "session not found", cause: error });
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

function interactionProvenance(grant: AccessGrant): {
  sessionId: string | null;
  turnId: string | null;
  attemptId: string | null;
} {
  if (grant.principalKind !== "agent_attempt") {
    return { sessionId: null, turnId: null, attemptId: null };
  }
  const sessionId = uuidValue(grant.metadata?.["sessionId"]);
  const turnId = uuidValue(grant.metadata?.["turnId"]);
  const attemptId = uuidValue(grant.metadata?.["attemptId"]);
  if (!sessionId || !turnId || !attemptId) {
    throw new HTTPException(403, { message: "agent attempt provenance is invalid" });
  }
  return {
    sessionId,
    turnId,
    attemptId,
  };
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

function optionalResourceKind(context: Context): "browser_session" | "computer_session" | null {
  const value = context.req.query("resourceKind");
  if (value === undefined) return null;
  if (value !== "browser_session" && value !== "computer_session") {
    throw new HTTPException(400, { message: "resourceKind is invalid" });
  }
  return value;
}

function optionalUuidQuery(context: Context, name: string): string | null {
  const value = context.req.query(name);
  if (value === undefined) return null;
  const parsed = uuidValue(value);
  if (!parsed) throw new HTTPException(400, { message: `${name} must be a UUID` });
  return parsed;
}

function uuidParam(context: Context, name: string): string {
  const value = uuidValue(context.req.param(name));
  if (!value) throw new HTTPException(400, { message: `${name} must be a UUID` });
  return value;
}

function uuidValue(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : null;
}

export function interactionResourceRouteError(error: unknown): HTTPException {
  if (error instanceof HTTPException) return error;
  if (
    error instanceof InteractionResourceNotFoundError ||
    error instanceof BrowserSessionNotFoundError ||
    error instanceof ComputerSessionNotFoundError
  ) {
    return new HTTPException(404, { message: error.message, cause: error });
  }
  if (
    error instanceof InteractionResourceConflictError ||
    error instanceof InteractionResourceStateError
  ) {
    return new HTTPException(409, { message: error.message, cause: error });
  }
  return new HTTPException(500, {
    message: "Interaction resource request failed",
    cause: error,
  });
}
