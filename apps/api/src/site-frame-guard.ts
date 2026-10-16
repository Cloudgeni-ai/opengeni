import {
  SITE_NO_ORIGIN_ID,
  siteFrameBodyRefusal,
  siteFrameFromHeaders,
  siteFrameOperation,
} from "@opengeni/contracts/site-session-http";
import {
  requireAccessGrant,
  siteOriginsMatch,
  siteSessionOriginFromMetadata,
  withSiteSessionOrigin,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getSession, getSessionAuthorityProjection } from "@opengeni/db";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "./http/api-error";
import { resolveSiteRequestOrigin } from "./site-session-origin";

/** The agent's own Codemode SDK proxy checks the proxied path itself. */
const CODEMODE_SDK_PROXY = /^\/v1\/workspaces\/[^/]+\/codemode\/sdk(?:\/|$)/u;
/** Site Data and files under a published Site: `/published-artifacts/<id>/data|files`. */
const SITE_DATA = /^\/v1\/workspaces\/[^/]+\/published-artifacts\/([^/]+)\/(?:data|files)(?:\/|$)/u;

/**
 * Server-side boundary for requests a host forwarded from a Site frame (the
 * console bridge, a Codemode preview). Hosts already hold Site code to the
 * `SITE_OPERATIONS` allowlist; the API enforces it again for any request that
 * carries the host's frame headers:
 *
 * - only allowlisted operations reach a handler;
 * - Site Data only for the frame's own published Site (403, as the Site Data
 *   service's own frame clamp answers);
 * - a session list names only the frame's own Site;
 * - a per-session operation reaches only a session the same Site (or, for a
 *   frame without a published Site, the same mounted frame) started; anything
 *   else is the same 404 as a missing session;
 * - a message, draft, queue or control body carries only the fields Site
 *   code may set (`siteFrameBodyRefusal`): text and how the model answers it.
 *   Approval decisions, answers to questions, resources, personal resource
 *   attachments, MCP credential updates, connection accounts and model
 *   context are refused with 403 `site_frame_field_forbidden`; the person
 *   gives those in the console. Session creates get the same treatment in
 *   the create route, which also applies the minimal Site profile;
 * - a session operation runs inside its validated Site origin, so every
 *   session or turn it starts records which Site it came from.
 *
 * Ordinary handlers still authorize every allowed operation with the
 * viewer's own authority.
 */
export function siteFrameGuard(deps: ApiRouteDeps) {
  return async (c: Context, next: Next) => {
    const frame = siteFrameFromHeaders((name) => c.req.header(name));
    const pathname = new URL(c.req.url).pathname;
    if (!frame || c.req.method === "OPTIONS" || CODEMODE_SDK_PROXY.test(pathname)) {
      await next();
      return;
    }
    const data = SITE_DATA.exec(pathname);
    if (data && !frame.siteId)
      throw new HTTPException(403, { message: "This Site host does not provide Site Data" });
    if (data && data[1] !== frame.siteId)
      throw new HTTPException(403, { message: "A Site can only use its own data" });
    const workspaceId = c.req.param("workspaceId") ?? "";
    const match = siteFrameOperation(c.req.method, pathname, workspaceId, frame.siteId);
    if (!match) throw new HTTPException(404, { message: "Unsupported Site session API path" });
    // Workspace, model and config reads and Site Data (whose service clamps
    // frames itself) start or reach no session.
    if (!match.operation.id.startsWith("sessions.")) {
      await next();
      return;
    }
    const grant = await requireAccessGrant(c, deps, workspaceId);
    const origin = await resolveSiteRequestOrigin(deps.db, grant, frame);
    if (match.operation.id === "sessions.list") {
      const origins = new URL(c.req.url).searchParams.getAll("originSiteId");
      if (origins.length !== 1 || origins[0] !== (origin.siteId ?? SITE_NO_ORIGIN_ID))
        throw new HTTPException(404, { message: "Unsupported Site session API path" });
    }
    if (match.sessionId !== null) {
      const authority = await getSessionAuthorityProjection(deps.db, grant.workspaceId, match.sessionId);
      const session = await getSession(deps.db, grant.workspaceId, match.sessionId).catch(
        () => null,
      );
      if (!authority?.siteAccessRootId || !session || !siteOriginsMatch(origin, siteSessionOriginFromMetadata(session.metadata)))
        throw new HTTPException(404, { message: "session not found" });
    }
    if (c.req.method !== "GET" && match.operation.id !== "sessions.create") {
      // Hono caches the parsed body, so the route reads the same JSON.
      const body: unknown = await c.req.json().catch(() => undefined);
      const refused = siteFrameBodyRefusal(match.operation.id, match.suffix, body);
      if (refused) throw siteFrameFieldForbidden(refused);
    }
    await withSiteSessionOrigin(origin, () => next());
  };
}

/** 403 for a body field Site code may not send; names the field, never its value. */
export function siteFrameFieldForbidden(field: string): ApiHttpError {
  return new ApiHttpError(403, {
    code: "forbidden",
    message:
      "A Site page can send message text only. Approvals, answers, resources, credentials and connection choices happen in the console.",
    retryable: false,
    outcomeUnknown: false,
    details: { code: "site_frame_field_forbidden", field },
  });
}
