import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { SITE_ASSET_API_PREFIX, parseSiteAssetAddress } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { getSiteVersionAssetManifest } from "@opengeni/db";
import { siteAssetFile, siteAssetResponse } from "../site-assets";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Asset files of multi-file app versions for the console's app frame:
 * `GET /v1/app-assets/<workspaceId>/<versionId>/<token>/<path>`.
 *
 * The frame is opaque-origin and sends no credentials, so this route is
 * public: the version's unguessable token, which only the version's
 * access-checked content response names, is the capability. It serves only
 * files listed in that version's manifest, with long-term immutable caching.
 * It needs no Sites domain, so self-hosted deployments use it too.
 */
export function registerAppAssetRoutes(app: Hono, deps: ApiRouteDeps): void {
  const handler = async (context: {
    req: { url: string; method: string; header: (name: string) => string | undefined };
  }) => {
    const notFound = () => new HTTPException(404, { message: "File not found" });
    const storage = deps.objectStorage;
    if (!storage) throw notFound();
    const rest = new URL(context.req.url).pathname.slice(SITE_ASSET_API_PREFIX.length + 1);
    const slash = rest.indexOf("/");
    const workspaceId = slash < 0 ? "" : rest.slice(0, slash);
    const address = slash < 0 ? null : parseSiteAssetAddress(rest.slice(slash + 1));
    if (!UUID.test(workspaceId) || !address) throw notFound();
    const manifest = await getSiteVersionAssetManifest(deps.db, workspaceId, address.versionId);
    const file = siteAssetFile(manifest, address.token, address.path);
    if (!file) throw notFound();
    return await siteAssetResponse(storage, workspaceId, file, {
      method: context.req.method.toUpperCase(),
      ifNoneMatch: context.req.header("if-none-match") ?? null,
    });
  };
  app.get(`${SITE_ASSET_API_PREFIX}/*`, handler);
}
