/**
 * Credential profile REST routes, under `/v1/workspaces/:workspaceId`.
 *
 * A credential profile maps environment variable names to secret references
 * that Opengeni adds to every command an agent runs (docs/secrets.md). The
 * routes read and store references only, never values. Reading needs
 * `secrets:list`; changing needs `secrets:write` plus the settings permission
 * of the level: `workspace:admin` for the workspace, `sessions:control` and
 * tool-policy access to the chat for a session.
 */
import { CredentialProfileInput } from "@opengeni/contracts";
import {
  getSessionCredentialProfile,
  getWorkspaceCredentialProfile,
  isCredentialProfileError,
  requireAccessGrantAuthorization,
  requirePermission,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  setCredentialProfile,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { AccessGrant } from "@opengeni/contracts";
import type { Context, Hono } from "hono";
import { ApiHttpError } from "../http/api-error";
import { parseRequestJson } from "../http/request-body";

const PREFIX = "/v1/workspaces/:workspaceId";

async function profileRoute(c: Context, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (isCredentialProfileError(error)) {
      return c.json(
        {
          error: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        error.status,
      );
    }
    throw error;
  }
}

async function authorizeSession(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  operation: "session.read" | "session.tool_policy.write",
): Promise<void> {
  try {
    await requireSessionAuthorization(deps, grant, { sessionId, operation, surface: "http" });
  } catch (error) {
    if (error instanceof SessionAuthorizationDeniedError) {
      throw new ApiHttpError(404, { code: "not_found", message: "Session not found." });
    }
    if (error instanceof SessionAuthorizationUnavailableError) {
      throw new ApiHttpError(503, {
        code: "upstream_unavailable",
        message: "Session authorization is temporarily unavailable.",
        retryable: true,
      });
    }
    throw error;
  }
}

export function registerCredentialProfileRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get(`${PREFIX}/credential-profile`, (c) =>
    profileRoute(c, async () => {
      const workspaceId = c.req.param("workspaceId")!;
      await requireAccessGrantAuthorization(c, deps, workspaceId, "secrets:list");
      return c.json(await getWorkspaceCredentialProfile(deps.db, { workspaceId }));
    }),
  );

  app.put(`${PREFIX}/credential-profile`, (c) =>
    profileRoute(c, async () => {
      const workspaceId = c.req.param("workspaceId")!;
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "workspace:admin",
      );
      requirePermission(authorization.grant, "secrets:write");
      const payload = await parseRequestJson(c, CredentialProfileInput);
      const profile = await setCredentialProfile(deps.db, {
        accountId: authorization.grant.accountId,
        workspaceId,
        sessionId: null,
        subjectId: authorization.grant.subjectId,
        profile: payload,
      });
      return c.json({ profile });
    }),
  );

  app.get(`${PREFIX}/sessions/:sessionId/credential-profile`, (c) =>
    profileRoute(c, async () => {
      const workspaceId = c.req.param("workspaceId")!;
      const sessionId = c.req.param("sessionId")!;
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "sessions:read",
      );
      requirePermission(authorization.grant, "secrets:list");
      await authorizeSession(deps, authorization.grant, sessionId, "session.read");
      return c.json(await getSessionCredentialProfile(deps.db, { workspaceId, sessionId }));
    }),
  );

  app.put(`${PREFIX}/sessions/:sessionId/credential-profile`, (c) =>
    profileRoute(c, async () => {
      const workspaceId = c.req.param("workspaceId")!;
      const sessionId = c.req.param("sessionId")!;
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "sessions:control",
      );
      await authorizeSession(deps, authorization.grant, sessionId, "session.tool_policy.write");
      requirePermission(authorization.grant, "secrets:write");
      const payload = await parseRequestJson(c, CredentialProfileInput);
      await setCredentialProfile(deps.db, {
        accountId: authorization.grant.accountId,
        workspaceId,
        sessionId,
        subjectId: authorization.grant.subjectId,
        profile: payload,
      });
      return c.json(await getSessionCredentialProfile(deps.db, { workspaceId, sessionId }));
    }),
  );
}
