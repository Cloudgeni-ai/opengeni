import type { Hono } from "hono";
import { compress } from "hono/compress";
import { HTTPException } from "hono/http-exception";
import {
  SITE_ASSET_API_PREFIX,
  parseSiteAssetAddress,
  type SiteAssetManifest,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { getSiteVersionAssetManifest } from "@opengeni/db";
import { siteAssetFile, siteAssetResponse } from "../site-assets";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Manifests of recently loaded versions. A version row never changes, so a
 * page's chunks need one database read, not one per file. Unknown versions
 * are not kept.
 */
const MANIFEST_CACHE_MAX = 512;
const manifests = new Map<string, SiteAssetManifest>();

async function versionManifest(
  deps: ApiRouteDeps,
  workspaceId: string,
  versionId: string,
): Promise<SiteAssetManifest | null> {
  const key = `${workspaceId}/${versionId}`;
  const cached = manifests.get(key);
  if (cached) {
    manifests.delete(key);
    manifests.set(key, cached);
    return cached;
  }
  const manifest = await getSiteVersionAssetManifest(deps.db, workspaceId, versionId);
  if (!manifest) return null;
  manifests.set(key, manifest);
  if (manifests.size > MANIFEST_CACHE_MAX) manifests.delete(manifests.keys().next().value!);
  return manifest;
}

/** Scripts, styles and other text compress well; images and fonts are already compressed. */
const compressText = compress({
  contentTypeFilter:
    /^(?:text\/|application\/(?:json|manifest\+json|wasm)|image\/(?:svg\+xml|x-icon|bmp))(?:;|$)/iu,
});

/**
 * Asset files of multi-file app versions for the console's app frame:
 * `GET /v1/app-assets/<workspaceId>/<versionId>/<token>/<path>`.
 *
 * The frame is opaque-origin and sends no credentials, so this route is
 * public (browsers' same-origin and same-site loads and navigations are
 * refused): the version's unguessable token, which only the version's
 * access-checked content response names, is the capability. It serves only
 * files listed in that version's manifest, with long-term immutable caching.
 * It needs no Sites domain, so self-hosted deployments use it too.
 */
export function registerAppAssetRoutes(app: Hono, deps: ApiRouteDeps): void {
  const handler = async (context: {
    req: { url: string; method: string; header: (name: string) => string | undefined };
  }) => {
    const notFound = () => new HTTPException(404, { message: "File not found" });
    // Only app frames load these files, and their opaque origin is always
    // cross-site. The API may share the console's origin, whose policy trusts
    // its own scripts: refusing same-origin and same-site loads keeps an
    // uploaded file from ever running as the console's own code, and
    // refusing navigations keeps the route from hosting pages or downloads.
    const site = context.req.header("sec-fetch-site");
    if (site === "same-origin" || site === "same-site") throw notFound();
    if (context.req.header("sec-fetch-mode") === "navigate") throw notFound();
    const storage = deps.objectStorage;
    if (!storage) throw notFound();
    const rest = new URL(context.req.url).pathname.slice(SITE_ASSET_API_PREFIX.length + 1);
    const slash = rest.indexOf("/");
    const workspaceId = slash < 0 ? "" : rest.slice(0, slash);
    const address = slash < 0 ? null : parseSiteAssetAddress(rest.slice(slash + 1));
    if (!UUID.test(workspaceId) || !address) throw notFound();
    const manifest = await versionManifest(deps, workspaceId, address.versionId);
    const file = siteAssetFile(manifest, address.token, address.path);
    if (!file) throw notFound();
    return await siteAssetResponse(storage, workspaceId, file, {
      method: context.req.method.toUpperCase(),
      ifNoneMatch: context.req.header("if-none-match") ?? null,
    });
  };
  app.use(`${SITE_ASSET_API_PREFIX}/*`, compressText);
  app.get(`${SITE_ASSET_API_PREFIX}/*`, handler);
}
