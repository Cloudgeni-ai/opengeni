import {
  requireAccessGrantAuthorization,
  requireSessionAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getSessionLinks } from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  cachedSessionPullRequestDetail,
  personalSessionPullRequestReader,
  type SessionPullRequestReader,
  workspaceSessionPullRequestReader,
} from "../integrations/session-link-pull-request";
import { viewerToolGrant } from "./session-links";

/**
 * A linked pull request's details for the chat's PR panel. Reading it is a
 * session read, like the Linked list; the pull request must be one of the
 * chat's links. It reads through the workspace's GitHub App, then the
 * viewer's own GitHub; `pullRequest` is null when neither can read it, and a
 * failed GitHub read answers 502.
 */
export function registerSessionLinkPullRequestRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  reader: SessionPullRequestReader = workspaceSessionPullRequestReader(deps),
  personalReader: typeof personalSessionPullRequestReader = personalSessionPullRequestReader,
): void {
  app.get(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/links/:linkId/pull-request",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const sessionId = c.req.param("sessionId");
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "sessions:read",
      );
      const grant = authorization.grant;
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
      const viewerGrant = viewerToolGrant(authorization);
      try {
        const pullRequest = await cachedSessionPullRequestDetail(workspaceId, link, reader, {
          fresh: c.req.query("fresh") === "true",
          viewer: viewerGrant
            ? {
                subjectId: viewerGrant.subjectId,
                read: personalReader(deps, {
                  accountId: viewerGrant.accountId,
                  workspaceId,
                  subjectId: viewerGrant.subjectId,
                }),
              }
            : null,
        });
        return c.json({ pullRequest });
      } catch {
        throw new HTTPException(502, { message: "Could not read the pull request from GitHub" });
      }
    },
  );
}
