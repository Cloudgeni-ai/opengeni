import {
  ConnectionUseGrantMutationResponse,
  ConnectionUseGrantRevocationResponse,
  IssueConnectionUseGrantRequest,
  ListConnectionAuthoritiesQuery,
  RevokeConnectionUseGrantQuery,
} from "@opengeni/contracts/connection-authority";
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
import {
  connectionUseGrantLifecycleInput,
  projectSelfConnectionAuthorities,
} from "../connection-authority-owner";

async function body<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(422, { message: "invalid connection authority" });
  return parsed.data;
}

function lifecycleError(error: unknown): never {
  if (
    error instanceof SessionAuthorizationDeniedError ||
    error instanceof SessionTenancyManagedHumanRequiredError ||
    error instanceof SessionTenancyNotActivatedError
  ) {
    throw new HTTPException(403, { message: "connection authority denied" });
  }
  if (error instanceof SessionAuthorizationUnavailableError) {
    throw new HTTPException(503, { message: "session authorization unavailable" });
  }
  if (nestedPostgresSqlState(error) === "42501") {
    throw new HTTPException(403, { message: "connection authority denied" });
  }
  if (nestedPostgresSqlState(error) === "22023") {
    throw new HTTPException(422, { message: "invalid connection authority" });
  }
  throw error;
}

export function registerConnectionAuthorityRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/connection-authorities";

  app.get(base, async (context) => {
    const query = ListConnectionAuthoritiesQuery.safeParse({
      scope: context.req.query("scope"),
      cursor: context.req.query("cursor"),
      limit: context.req.query("limit"),
    });
    if (!query.success) throw new HTTPException(422, { message: "explicit scope=user required" });
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "connections:read",
    );
    try {
      return context.json(
        projectSelfConnectionAuthorities(
          await listManagedHumanUserResourceAuthorities(deps, access, workspaceId, {
            resourceKind: "connection",
            cursor: query.data.cursor,
            limit: query.data.limit,
          }),
        ),
      );
    } catch (error) {
      return lifecycleError(error);
    }
  });

  app.post(`${base}/:authorityId/grants`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const authorityId = z.string().uuid().safeParse(context.req.param("authorityId"));
    if (!authorityId.success) throw new HTTPException(422, { message: "invalid authority id" });
    const request = await body(context, IssueConnectionUseGrantRequest);
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "connections:read",
    );
    try {
      const normalized = connectionUseGrantLifecycleInput(request);
      return context.json(
        ConnectionUseGrantMutationResponse.parse({
          scope: "user",
          grant: await issueManagedHumanUserResourceGrant(
            deps,
            access,
            workspaceId,
            authorityId.data,
            { scope: "user", resourceKind: "connection", ...normalized },
            "http",
          ),
        }),
      );
    } catch (error) {
      return lifecycleError(error);
    }
  });

  app.delete(`${base}/grants/:grantId`, async (context) => {
    const query = RevokeConnectionUseGrantQuery.safeParse({ scope: context.req.query("scope") });
    if (!query.success) throw new HTTPException(422, { message: "explicit scope=user required" });
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
        ConnectionUseGrantRevocationResponse.parse({
          scope: "user",
          grant: await revokeManagedHumanUserResourceGrant(deps, access, workspaceId, grantId.data),
        }),
      );
    } catch (error) {
      return lifecycleError(error);
    }
  });
}
