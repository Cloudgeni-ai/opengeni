import {
  BrowserIdentity,
  BrowserIdentityListResponse,
  BrowserIdentityMutationResponse,
  BrowserRevisionListResponse,
  CreateBrowserIdentityRequest,
  UpdateBrowserIdentityRequest,
} from "@opengeni/contracts";
import {
  BrowserIdentityConflictError,
  BrowserIdentityNotFoundError,
  BrowserIdentityStateError,
  createBrowserIdentity,
  getBrowserIdentity,
  listBrowserIdentities,
  listBrowserRevisions,
  updateBrowserIdentity,
} from "@opengeni/db";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerBrowserIdentityRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/browser-identities", async (context) => {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:read");
    try {
      return context.json(
        BrowserIdentityListResponse.parse(
          await listBrowserIdentities(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            includeArchived: context.req.query("includeArchived") === "true",
          }),
        ),
      );
    } catch (error) {
      throw browserIdentityRouteError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/browser-identities", async (context) => {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:control");
    const request = await parseJsonBody(context, CreateBrowserIdentityRequest);
    try {
      const response = await createBrowserIdentity(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        operationId: request.operationId,
        name: request.name,
        actorSubjectId: grant.subjectId,
      });
      return context.json(
        BrowserIdentityMutationResponse.parse(response),
        response.replayed ? 200 : 201,
      );
    } catch (error) {
      throw browserIdentityRouteError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/browser-identities/:identityId", async (context) => {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:read");
    try {
      return context.json(
        BrowserIdentity.parse(
          await getBrowserIdentity(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            identityId: uuidParam(context, "identityId"),
          }),
        ),
      );
    } catch (error) {
      throw browserIdentityRouteError(error);
    }
  });

  app.patch("/v1/workspaces/:workspaceId/browser-identities/:identityId", async (context) => {
    const workspaceId = context.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:control");
    const identityId = uuidParam(context, "identityId");
    const request = await parseJsonBody(context, UpdateBrowserIdentityRequest);
    try {
      return context.json(
        BrowserIdentityMutationResponse.parse(
          await updateBrowserIdentity(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            identityId,
            actorSubjectId: grant.subjectId,
            ...request,
          }),
        ),
      );
    } catch (error) {
      throw browserIdentityRouteError(error);
    }
  });

  app.get(
    "/v1/workspaces/:workspaceId/browser-identities/:identityId/revisions",
    async (context) => {
      const workspaceId = context.req.param("workspaceId") ?? "";
      const grant = await requireAccessGrant(context, deps, workspaceId, "sessions:read");
      try {
        return context.json(
          BrowserRevisionListResponse.parse(
            await listBrowserRevisions(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              identityId: uuidParam(context, "identityId"),
            }),
          ),
        );
      } catch (error) {
        throw browserIdentityRouteError(error);
      }
    },
  );
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

function uuidParam(context: Context, name: string): string {
  const value = context.req.param(name);
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new HTTPException(400, { message: `${name} must be a UUID` });
  }
  return value;
}

export function browserIdentityRouteError(error: unknown): HTTPException {
  if (error instanceof HTTPException) return error;
  if (error instanceof BrowserIdentityNotFoundError) {
    return new HTTPException(404, { message: error.message, cause: error });
  }
  if (error instanceof BrowserIdentityConflictError || error instanceof BrowserIdentityStateError) {
    return new HTTPException(409, { message: error.message, cause: error });
  }
  return new HTTPException(500, {
    message: "BrowserIdentity request failed",
    cause: error,
  });
}
