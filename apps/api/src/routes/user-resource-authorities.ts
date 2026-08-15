import {
  IssueUserResourceGrantRequest,
  ListUserResourceAuthoritiesQuery,
  ListUserResourceAuthoritiesResponse,
  RevokeUserResourceGrantQuery,
  UserResourceGrantMutationResponse,
} from "@opengeni/contracts";
import {
  requireAccessGrantAuthorization,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  issueSelfUserResourceGrant,
  listSelfUserResourceAuthorities,
  nestedPostgresSqlState,
  revokeSelfUserResourceGrant,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

function requireAuthenticatedHuman(access: AccessGrantAuthorization): string {
  if (
    !access.contextIntegrity ||
    access.authenticatedSubjectId !== access.grant.subjectId ||
    access.grant.principalKind !== "human_session" ||
    access.grant.serviceInitiator ||
    access.grant.serviceInitiatorContext ||
    access.grant.subjectId.startsWith("api_key:")
  ) {
    throw new HTTPException(403, { message: "authenticated human session required" });
  }
  return access.grant.subjectId;
}

async function body<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(422, { message: "invalid user-resource request" });
  return parsed.data;
}

function lifecycleError(error: unknown): never {
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
    const query = ListUserResourceAuthoritiesQuery.safeParse({ scope: context.req.query("scope") });
    if (!query.success) throw new HTTPException(422, { message: "explicit scope=user required" });
    const workspaceId = context.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "workspace:read",
    );
    const subjectId = requireAuthenticatedHuman(access);
    try {
      return context.json(
        ListUserResourceAuthoritiesResponse.parse({
          scope: "user",
          authorities: await listSelfUserResourceAuthorities(deps.db, {
            accountId: access.grant.accountId,
            workspaceId,
            subjectId,
          }),
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
    const subjectId = requireAuthenticatedHuman(access);
    try {
      return context.json(
        UserResourceGrantMutationResponse.parse({
          scope: "user",
          grant: await issueSelfUserResourceGrant(deps.db, {
            accountId: access.grant.accountId,
            workspaceId,
            subjectId,
            authorityId: authorityId.data,
            action: request.action,
            mode: request.mode,
            context: request.context,
            sessionId: request.sessionId ?? null,
            workspaceSharedAcknowledged: request.workspaceSharedAcknowledged,
          }),
        }),
      );
    } catch (error) {
      return lifecycleError(error);
    }
  });

  app.delete(`${base}/grants/:grantId`, async (context) => {
    const query = RevokeUserResourceGrantQuery.safeParse({ scope: context.req.query("scope") });
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
    const subjectId = requireAuthenticatedHuman(access);
    try {
      return context.json({
        scope: "user",
        grant: await revokeSelfUserResourceGrant(deps.db, {
          accountId: access.grant.accountId,
          workspaceId,
          subjectId,
          grantId: grantId.data,
        }),
      });
    } catch (error) {
      return lifecycleError(error);
    }
  });
}
