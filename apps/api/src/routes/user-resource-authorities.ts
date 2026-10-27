import {
  IssueUserResourceGrantRequest,
  ListUserResourceAuthoritiesQuery,
  ListUserResourceAuthoritiesResponse,
  RevokeUserResourceGrantQuery,
  UserResourceGrantMutationResponse,
  UserResourceGrantRevocationResponse,
} from "@opengeni/contracts";
import {
  issueManagedHumanUserResourceGrant,
  listManagedHumanUserResourceAuthorities,
  requireAccessGrantAuthorization,
  revokeManagedHumanUserResourceGrant,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  SessionTenancyManagedHumanRequiredError,
  type ApiRouteDeps,
} from "@opengeni/core";
import { nestedPostgresSqlState, SessionTenancyNotActivatedError } from "@opengeni/db";
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

export function registerUserResourceAuthorityRoutes(app: Hono, deps: ApiRouteDeps): void {
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
