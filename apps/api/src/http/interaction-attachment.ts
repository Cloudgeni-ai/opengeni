import { interactionViewerOriginEntries } from "@opengeni/config";
import {
  externalAttributionForAuthorization,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { validateInteractionRequestOrigin } from "./cors";

/** The viewer origin selects a transport origin, never a grant or a CORS policy. */
export async function requireInteractionAttachmentAccess(context: Context, deps: ApiRouteDeps) {
  const workspaceId = context.req.param("workspaceId") ?? "";
  const requestOrigin = context.req.header("origin");
  const viewerOrigin = context.req.header("x-opengeni-interaction-viewer-origin");
  if (viewerOrigin === undefined) {
    const grant = await requireAccessGrant(context, deps, workspaceId, "stream:view");
    return {
      workspaceId,
      grant,
      origin: validateInteractionRequestOrigin(requestOrigin, deps.settings),
    };
  }

  // Only a server-to-server request authenticated as a product's external
  // actor may assert a different viewer origin. Cookie auth and direct
  // browser requests remain on the console path above.
  const access = await requireAccessGrantAuthorization(context, deps, workspaceId, "stream:view");
  if (
    requestOrigin !== undefined ||
    !externalAttributionForAuthorization(access, access.grant) ||
    !interactionViewerOriginEntries(deps.settings.interactionViewerOrigins).includes(viewerOrigin)
  ) {
    throw new HTTPException(403, { message: "interaction viewer origin is not allowed" });
  }
  return { workspaceId, grant: access.grant, origin: viewerOrigin };
}
