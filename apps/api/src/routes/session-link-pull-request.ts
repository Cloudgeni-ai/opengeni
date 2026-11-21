import {
  requireAccessGrant,
  requireSessionAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getSessionLinks } from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  cachedSessionPullRequestDetail,
  type SessionPullRequestReader,
  workspaceSessionPullRequestReader,
} from "../integrations/session-link-pull-request";

/**
 * A linked pull request's details for the chat's PR panel. Reading it is a
 * session read, like the Linked list; the pull request must be one of the
 * chat's links. `pullRequest` is null when the workspace cannot read it.
 */
export function registerSessionLinkPullRequestRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  reader: SessionPullRequestReader = workspaceSessionPullRequestReader(deps),
): void {
  app.get(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/links/:linkId/pull-request",
    async (c) => {
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
      const link = links.find((each) => each.id === c.req.param("linkId"));
      if (!link || link.kind !== "pull_request") {
        throw new HTTPException(404, { message: "Linked pull request not found" });
      }
      const pullRequest = await cachedSessionPullRequestDetail(workspaceId, link, reader, {
        fresh: c.req.query("fresh") === "true",
      });
      return c.json({ pullRequest });
    },
  );
}
