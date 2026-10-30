import {
  IssueUserResourceGrantRequest,
  ListUserResourceAuthoritiesQuery,
  ListUserResourceAuthoritiesResponse,
  OwnResourceReachQuery,
  OwnResourceReachResponse,
  type OwnResourceReachWorkspace,
  RevokeUserResourceGrantQuery,
  SetOwnResourceReachRequest,
  SetOwnResourceReachResponse,
  UserResourceGrantMutationResponse,
  UserResourceGrantRevocationResponse,
} from "@opengeni/contracts";
import {
  getOwnResourceHere,
  issueManagedHumanUserResourceGrant,
  listManagedHumanUserResourceAuthorities,
  OwnResourceAlwaysOnError,
  OwnResourceNotFoundError,
  requireAccessContext,
  requireAccessGrantAuthorization,
  revokeManagedHumanUserResourceGrant,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  SessionTenancyManagedHumanRequiredError,
  setOwnResourceHere,
  type ApiRouteDeps,
  type OwnResourceHere,
} from "@opengeni/core";
import {
  getWorkspace,
  nestedPostgresSqlState,
  SessionTenancyNotActivatedError,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { parseRequestBody, parseRequestQuery } from "../http/request-body";

async function body<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = parseRequestBody(schema, await context.req.json().catch(() => null), {
    status: 422,
    message: "invalid user-resource request",
  });
  return parsed;
}

function lifecycleError(error: unknown): never {
  if (error instanceof OwnResourceNotFoundError) {
    throw new HTTPException(404, { message: error.message });
  }
  if (error instanceof OwnResourceAlwaysOnError) {
    throw new HTTPException(422, { message: error.message });
  }
  if (
    error instanceof SessionAuthorizationDeniedError ||
    error instanceof SessionTenancyManagedHumanRequiredError ||
    error instanceof SessionTenancyNotActivatedError
  ) {
    throw new HTTPException(403, { message: "user-resource authority denied" });
  }
  if (error instanceof SessionAuthorizationUnavailableError) {
    throw new HTTPException(503, { message: "session authorization unavailable" });
  }
  if (nestedPostgresSqlState(error) === "42501") {
    throw new HTTPException(403, { message: "user-resource authority denied" });
  }
  if (nestedPostgresSqlState(error) === "22023") {
    throw new HTTPException(422, { message: "invalid user-resource request" });
  }
  throw error;
}

function reachEntry(
  workspace: { id: string; name: string },
  here: OwnResourceHere,
  currentWorkspaceId: string,
): OwnResourceReachWorkspace {
  return {
    workspaceId: workspace.id,
    name: workspace.name,
    personal: here.personal,
    current: workspace.id === currentWorkspaceId,
    on: here.on,
    alwaysOn: here.alwaysOn,
    canChange: here.canChange,
  };
}

/**
 * "Where it works" for your own login, plan or machine: each workspace you
 * belong to in the organization, and whether it works there for your own
 * messages. A workspace where you can't see it is left out.
 */
function registerOwnResourceReachRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/workspaces/:workspaceId/own-resources/reach";
  app.get(path, async (context) => {
    const query = parseRequestQuery(
      OwnResourceReachQuery,
      {
        resourceKind: context.req.query("resourceKind"),
        resourceId: context.req.query("resourceId"),
      },
      { status: 422, message: "resourceKind and resourceId are required" },
    );
    const workspaceId = context.req.param("workspaceId");
    const here = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    const access = await requireAccessContext(context, deps);
    const candidates = new Set([
      workspaceId,
      ...access.workspaceGrants
        .filter((grant) => grant.accountId === here.grant.accountId)
        .map((grant) => grant.workspaceId),
    ]);
    const workspaces: OwnResourceReachWorkspace[] = [];
    for (const candidate of candidates) {
      let entry: OwnResourceHere | null;
      try {
        const authorization =
          candidate === workspaceId
            ? here
            : await requireAccessGrantAuthorization(context, deps, candidate, "workspace:read");
        entry = await getOwnResourceHere(deps, authorization, candidate, query);
      } catch (error) {
        // The workspace this was asked from must answer; others are left out.
        if (candidate === workspaceId) return lifecycleError(error);
        if (error instanceof HTTPException && [403, 404].includes(error.status)) continue;
        if (
          error instanceof SessionAuthorizationDeniedError ||
          error instanceof SessionTenancyManagedHumanRequiredError ||
          nestedPostgresSqlState(error) === "42501"
        )
          continue;
        throw error;
      }
      if (!entry) {
        if (candidate === workspaceId) return lifecycleError(new OwnResourceNotFoundError());
        continue;
      }
      const workspace = await getWorkspace(deps.db, candidate);
      if (workspace) workspaces.push(reachEntry(workspace, entry, workspaceId));
    }
    workspaces.sort(
      (left, right) =>
        Number(right.personal) - Number(left.personal) || left.name.localeCompare(right.name),
    );
    return context.json(OwnResourceReachResponse.parse({ ...query, workspaces }));
  });

  app.put(path, async (context) => {
    const request = await body(context, SetOwnResourceReachRequest);
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    try {
      const here = await setOwnResourceHere(deps, access, workspaceId, request);
      const workspace = await getWorkspace(deps.db, workspaceId);
      if (!workspace) throw new HTTPException(404, { message: "workspace not found" });
      return context.json(
        SetOwnResourceReachResponse.parse({ workspace: reachEntry(workspace, here, workspaceId) }),
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return lifecycleError(error);
    }
  });
}

export function registerUserResourceAuthorityRoutes(app: Hono, deps: ApiRouteDeps): void {
  registerOwnResourceReachRoutes(app, deps);
  const base = "/v1/workspaces/:workspaceId/user-resource-authorities";
  app.get(base, async (context) => {
    const query = parseRequestQuery(
      ListUserResourceAuthoritiesQuery,
      {
        scope: context.req.query("scope"),
        resourceKind: context.req.query("resourceKind"),
        cursor: context.req.query("cursor"),
        limit: context.req.query("limit"),
      },
      { status: 422, message: "explicit scope=user required" },
    );
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    try {
      const page = await listManagedHumanUserResourceAuthorities(deps, access, workspaceId, query);
      return context.json(
        ListUserResourceAuthoritiesResponse.parse({
          scope: "user",
          ...page,
        }),
      );
    } catch (error) {
      return lifecycleError(error);
    }
  });

  app.post(`${base}/:authorityId/grants`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const authorityId = z.string().uuid().safeParse(context.req.param("authorityId"));
    if (!authorityId.success) throw new HTTPException(422, { message: "invalid authority id" });
    const request = await body(context, IssueUserResourceGrantRequest);
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    try {
      return context.json(
        UserResourceGrantMutationResponse.parse({
          scope: "user",
          grant: await issueManagedHumanUserResourceGrant(
            deps,
            access,
            workspaceId,
            authorityId.data,
            request,
            "http",
          ),
        }),
      );
    } catch (error) {
      return lifecycleError(error);
    }
  });

  app.delete(`${base}/grants/:grantId`, async (context) => {
    parseRequestQuery(
      RevokeUserResourceGrantQuery,
      { scope: context.req.query("scope") },
      { status: 422, message: "explicit scope=user required" },
    );
    const grantId = z.string().uuid().safeParse(context.req.param("grantId"));
    if (!grantId.success) throw new HTTPException(422, { message: "invalid grant id" });
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    try {
      return context.json(
        UserResourceGrantRevocationResponse.parse({
          scope: "user",
          grant: await revokeManagedHumanUserResourceGrant(deps, access, workspaceId, grantId.data),
        }),
      );
    } catch (error) {
      return lifecycleError(error);
    }
  });
}
