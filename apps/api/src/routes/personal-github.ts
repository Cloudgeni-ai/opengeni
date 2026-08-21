import {
  PersonalGitHubConnectionStatusResponse,
  PersonalGitHubOAuthStartRequest,
} from "@opengeni/contracts/personal-github";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Hono } from "hono";
import { assertPersonalConnectionOwnerPrincipal } from "../connection-ownership";
import {
  completePersonalGitHubOAuthCallback,
  listPersonalGitHubConnections,
  personalGitHubReviewUrl,
  startPersonalGitHubOAuth,
} from "../integrations/personal-github";

export function registerPersonalGitHubRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/connections/github", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:read");
    const connections = await listPersonalGitHubConnections(deps, {
      workspaceId,
      subjectId: grant.subjectId,
    });
    return c.json(
      PersonalGitHubConnectionStatusResponse.parse({
        enabled: deps.settings.githubPersonalOauthEnabled,
        connection: canonicalPersonalGitHubConnection(connections),
        reviewUrl: personalGitHubReviewUrl(deps.settings),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/connections/github/oauth/start", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    assertPersonalConnectionOwnerPrincipal(access, "My GitHub account");
    const payload = PersonalGitHubOAuthStartRequest.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await startPersonalGitHubOAuth(deps, {
        access,
        workspaceId,
        ...(payload.connectionId ? { connectionId: payload.connectionId } : {}),
        ...(payload.returnPath ? { returnPath: payload.returnPath } : {}),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/connections/:connectionId/github/reconnect", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    assertPersonalConnectionOwnerPrincipal(access, "My GitHub account");
    const payload = PersonalGitHubOAuthStartRequest.omit({ connectionId: true }).parse(
      await c.req.json().catch(() => ({})),
    );
    return c.json(
      await startPersonalGitHubOAuth(deps, {
        access,
        workspaceId,
        connectionId: c.req.param("connectionId"),
        ...(payload.returnPath ? { returnPath: payload.returnPath } : {}),
      }),
    );
  });

  app.get("/v1/integrations/github-personal/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    const result = await completePersonalGitHubOAuthCallback(deps, {
      requestUrl: c.req.url,
      ...(code ? { code } : {}),
      ...(state ? { state } : {}),
      ...(error ? { error } : {}),
    });
    return c.redirect(result.redirectTo, 302);
  });
}

function canonicalPersonalGitHubConnection<
  T extends { status: string; updatedAt: string; id: string },
>(connections: T[]): T | null {
  const statusRank: Record<string, number> = {
    active: 0,
    needs_reauth: 1,
    error: 2,
    revoked: 3,
  };
  return (
    [...connections].sort((left, right) => {
      const rank = (statusRank[left.status] ?? 4) - (statusRank[right.status] ?? 4);
      if (rank !== 0) return rank;
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      return updated !== 0 ? updated : right.id.localeCompare(left.id);
    })[0] ?? null
  );
}
