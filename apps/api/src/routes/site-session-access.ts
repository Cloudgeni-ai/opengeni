import {
  requireAccessGrant,
  requireSessionAuthorization,
  siteViewerForGrant,
  currentSiteSessionOrigin,
  type ApiRouteDeps,
} from "@opengeni/core";
import { listSiteSessionAccess, setSiteSessionAccess } from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sessionAuthorizationHttpError } from "./sessions";

export function registerSiteSessionAccessRoutes(app: Hono, deps: ApiRouteDeps) {
  const path = "/v1/workspaces/:workspaceId/published-artifacts/:siteId/session-access";
  const actor = async (c: Context) => {
    const workspaceId = c.req.param("workspaceId")!;
    const siteId = c.req.param("siteId")!;
    if (!z.string().uuid().safeParse(siteId).success) throw new HTTPException(404);
    const grant = await requireAccessGrant(
      c,
      deps,
      workspaceId,
      c.req.method === "GET" ? "sessions:read" : "sessions:control",
    );
    if (currentSiteSessionOrigin())
      throw new HTTPException(403, { message: "A Site page cannot manage chat access" });
    const { subjectId } = await siteViewerForGrant(deps.db, grant);
    if (!subjectId) throw new HTTPException(403, { message: "Chat owner authority required" });
    return { workspaceId, siteId, subjectId, grant };
  };
  app.get(path, async (c) =>
    c.json({ sessionIds: await listSiteSessionAccess(deps.db, await actor(c)) }),
  );
  for (const method of ["put", "delete"] as const) {
    app[method](`${path}/:sessionId`, async (c) => {
      const input = await actor(c);
      const sessionId = c.req.param("sessionId");
      if (!z.string().uuid().safeParse(sessionId).success) throw new HTTPException(404);
      try {
        await requireSessionAuthorization(deps, input.grant, {
          sessionId,
          operation: "session.control",
          surface: "http",
        });
      } catch (error) {
        throw sessionAuthorizationHttpError(error);
      }
      if (
        !(await setSiteSessionAccess(deps.db, { ...input, sessionId, allowed: method === "put" }))
      )
        throw new HTTPException(404, { message: "Owned chat and private Site not found" });
      return c.json({ sessionId, siteId: input.siteId, allowed: method === "put" });
    });
  }
}
