import {
  createSessionShareLink,
  getSessionShareLinkState,
  listSessionShareLinks,
  readSharedSession,
  requireAccessGrant,
  revokeSessionShareLink,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { trustedRequestSourceRateLimitKey } from "../http/request-source";
import { PublicSetupRateLimiter } from "./managed-onboarding";

/**
 * Read-only chat share links. The person who started a chat creates, refreshes
 * and stops its link (the session routes, classified and authorized like every
 * other session route); anyone holding a link reads its snapshot without
 * signing in, rate limited per client and never cached, so a stopped link
 * stops at once.
 */
export function registerSessionShareLinkRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings } = deps;
  const webBaseUrl = (c: Context): string =>
    settings.webBaseUrl ?? settings.publicBaseUrl ?? new URL(c.req.url).origin;
  const publicReads = new PublicSetupRateLimiter({
    globalCapacity: 600,
    globalRefillPerSecond: 100,
    clientCapacity: 60,
    clientRefillPerSecond: 1,
    maxClientKeys: 8_192,
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/share-link", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    return c.json(
      await getSessionShareLinkState(deps, grant, {
        workspaceId,
        sessionId: c.req.param("sessionId"),
        webBaseUrl: webBaseUrl(c),
      }),
    );
  });

  app.put("/v1/workspaces/:workspaceId/sessions/:sessionId/share-link", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const result = await createSessionShareLink(deps, grant, {
      workspaceId,
      sessionId: c.req.param("sessionId"),
      webBaseUrl: webBaseUrl(c),
    });
    return c.json(result.link, result.created ? 201 : 200);
  });

  app.delete("/v1/workspaces/:workspaceId/sessions/:sessionId/share-link", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    return c.json(
      await revokeSessionShareLink(deps, grant, {
        workspaceId,
        sessionId: c.req.param("sessionId"),
      }),
    );
  });

  app.get("/v1/workspaces/:workspaceId/share-links", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    return c.json(
      await listSessionShareLinks(deps, grant, { workspaceId, webBaseUrl: webBaseUrl(c) }),
    );
  });

  app.get("/v1/shared-sessions/:shareId", async (c) => {
    let allowed = false;
    try {
      allowed = publicReads.take(trustedRequestSourceRateLimitKey(c, settings));
    } catch {
      // A public read fails closed when its abuse gate can't decide.
    }
    if (!allowed) {
      throw new HTTPException(429, { message: "too many requests; slow down" });
    }
    // Never cached anywhere, so a stopped link stops at once; never indexed.
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Referrer-Policy", "no-referrer");
    const shared = await readSharedSession(deps, c.req.param("shareId"));
    if (!shared) throw new HTTPException(404, { message: "This link doesn't open anymore." });
    return c.json(shared);
  });
}
