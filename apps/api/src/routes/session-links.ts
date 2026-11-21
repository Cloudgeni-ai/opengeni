import { AddSessionLinkRequest } from "@opengeni/contracts";
import {
  addSessionLink,
  removeSessionLink,
  requireAccessGrant,
  requireSessionAuthorization,
  SessionLinkLimitError,
  SessionLinkUrlError,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getSessionLinks } from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  withSessionLinkStatuses,
  workspaceSessionLinkStatusReader,
  type SessionLinkStatusReader,
} from "../integrations/session-link-status";

/**
 * A chat's Linked panel: list its links with live status, and add or remove
 * one as a person. Each route calls the session authorization seam itself,
 * with the operation the session middleware classifies.
 */
export function registerSessionLinkRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  reader: SessionLinkStatusReader = workspaceSessionLinkStatusReader(deps),
): void {
  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/links", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    await requireSessionAuthorization(deps, grant, {
      sessionId,
      operation: "session.read",
      surface: "http",
    });
    const links = await getSessionLinks(deps.db, workspaceId, sessionId);
    if (!links) throw new HTTPException(404, { message: "Session not found" });
    const fresh = c.req.query("fresh") === "true";
    return c.json({ links: await withSessionLinkStatuses(workspaceId, links, reader, { fresh }) });
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/links", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    await requireSessionAuthorization(deps, grant, {
      sessionId,
      operation: "session.control",
      surface: "http",
    });
    const parsed = AddSessionLinkRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(422, {
        message: "Give an http or https url, and optionally a title.",
      });
    }
    try {
      const result = await addSessionLink(deps, {
        workspaceId,
        sessionId,
        url: parsed.data.url,
        title: parsed.data.title,
        kind: parsed.data.kind,
        addedBy: "person",
      });
      if (!result) throw new HTTPException(404, { message: "Session not found" });
      return c.json(result.link, result.added ? 201 : 200);
    } catch (error) {
      if (error instanceof SessionLinkLimitError || error instanceof SessionLinkUrlError) {
        throw new HTTPException(422, { message: error.message });
      }
      throw error;
    }
  });

  app.delete("/v1/workspaces/:workspaceId/sessions/:sessionId/links/:linkId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    await requireSessionAuthorization(deps, grant, {
      sessionId,
      operation: "session.control",
      surface: "http",
    });
    const removed = await removeSessionLink(deps, {
      workspaceId,
      sessionId,
      id: c.req.param("linkId"),
    });
    if (removed === null) throw new HTTPException(404, { message: "Session not found" });
    return c.json({ removed });
  });
}
