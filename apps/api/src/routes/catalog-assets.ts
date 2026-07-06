import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "@opengeni/core";

const CATALOG_ASSET_PREFIX = "catalog-assets/";
const MAX_KEY_LENGTH = 512;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
};

export function registerCatalogAssetRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings, objectStorage } = deps;

  app.get("/v1/catalog-assets/*", async (c) => {
    if (!settings.integrationsEnabled) {
      throw new HTTPException(404, { message: "integrations are not enabled for this deployment" });
    }
    if (!objectStorage) {
      throw new HTTPException(404, { message: "asset not found" });
    }
    const key = catalogAssetKeyFromPath(new URL(c.req.url).pathname);
    if (!key) {
      throw new HTTPException(404, { message: "asset not found" });
    }
    const contentType = contentTypeForKey(key);
    if (!contentType) {
      throw new HTTPException(404, { message: "asset not found" });
    }
    const object = await objectStorage.getObjectBytes(key);
    if (!object) {
      throw new HTTPException(404, { message: "asset not found" });
    }
    const etag = etagForKey(key);
    const headers = {
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    };
    if (ifNoneMatchSatisfied(c.req.header("if-none-match"), etag)) {
      return c.body(null, 304, headers);
    }
    // Copy narrows the AWS/GCS/Azure SDKs' ArrayBufferLike-backed Uint8Array to the
    // ArrayBuffer-backed one Hono's body() type expects.
    return c.body(new Uint8Array(object.bytes), 200, { ...headers, "Content-Type": contentType });
  });
}

/** Decoded, validated storage key from a `/v1/catalog-assets/...` request path, or null if malformed/unsafe. */
export function catalogAssetKeyFromPath(pathname: string): string | null {
  const prefix = "/v1/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  if (
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    !key.startsWith(CATALOG_ASSET_PREFIX) ||
    key.includes("..") ||
    key.includes("\\") ||
    key.includes("//") ||
    !PRINTABLE_ASCII.test(key)
  ) {
    return null;
  }
  return key;
}

function contentTypeForKey(key: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(key);
  const ext = match?.[1]?.toLowerCase();
  return ext ? CONTENT_TYPE_BY_EXTENSION[ext] ?? null : null;
}

/** Digest-keyed filenames (`{domain}/{digest24}.{ext}`) make the basename itself a stable ETag. */
function etagForKey(key: string): string {
  const filename = key.slice(key.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  const digest = dot === -1 ? filename : filename.slice(0, dot);
  return `"${digest}"`;
}

function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (!header) {
    return false;
  }
  if (header.trim() === "*") {
    return true;
  }
  return header.split(",").map((value) => value.trim()).includes(etag);
}
