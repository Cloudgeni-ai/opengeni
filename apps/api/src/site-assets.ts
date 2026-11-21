/**
 * Multi-file app versions: freeze an uploaded asset bundle into
 * content-addressed objects plus a manifest, and serve one asset file of a
 * version. See `@opengeni/contracts/app-assets` for the model and
 * docs/published-sites.md ("Multi-file apps").
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  SITE_ASSET_BUNDLE_MAX_BYTES,
  SITE_ASSET_CACHE_CONTROL,
  SITE_ASSET_CONTENT_TYPES,
  SITE_ASSET_MAX_FILE_BYTES,
  SITE_ASSET_MAX_FILES,
  SITE_ASSET_MAX_TOTAL_BYTES,
  SiteAssetBundle,
  SiteAssetManifest,
  isSiteAssetPath,
  siteAssetContentType,
  siteAssetObjectKey,
  type SiteAssetFile,
} from "@opengeni/contracts";
import type { ObjectStorageDependency } from "@opengeni/core";
import { WorkspaceArtifactOperationError } from "@opengeni/db";
import { retryWhileMissing } from "@opengeni/storage";
import { USER_CONTENT_SECURITY_POLICY } from "./http/user-content";

type Storage = NonNullable<ObjectStorageDependency>;

const MB = 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const ALLOWED = Object.keys(SITE_ASSET_CONTENT_TYPES)
  .map((extension) => `.${extension}`)
  .join(", ");

function refuse(message: string): never {
  throw new WorkspaceArtifactOperationError(message);
}

function decodeBase64(path: string, value: string): Buffer {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length % 4 !== 0 || !BASE64.test(compact))
    refuse(`App asset ${path} is not valid base64. Encode each file's bytes with base64.`);
  return Buffer.from(compact, "base64");
}

/**
 * Validate an uploaded bundle and store its files. Every file is stored once
 * per workspace under its SHA-256 (versions and apps share unchanged files);
 * the manifest lists them sorted by path with a fresh 128-bit token.
 */
export async function storeSiteAssetBundle(
  storage: Storage,
  workspaceId: string,
  bytes: Uint8Array,
): Promise<SiteAssetManifest> {
  let bundle: SiteAssetBundle;
  try {
    const parsed = SiteAssetBundle.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (!parsed.success) throw parsed.error;
    bundle = parsed.data;
  } catch {
    refuse(
      `App assets must be JSON {files: [{path, base64}]} with 1 to ${SITE_ASSET_MAX_FILES} files. Correct it and prepare a new upload.`,
    );
  }
  return await storeSiteAssetFiles(storage, workspaceId, bundle);
}

/**
 * Validate a parsed bundle and store its files (an upload, or the asset
 * files an app package carries). The manifest gets a fresh token.
 */
export async function storeSiteAssetFiles(
  storage: Storage,
  workspaceId: string,
  bundle: SiteAssetBundle,
): Promise<SiteAssetManifest> {
  const seen = new Set<string>();
  const decoded: Array<{ path: string; bytes: Buffer; sha256: string }> = [];
  let total = 0;
  for (const file of bundle.files) {
    if (/\.html?$/iu.test(file.path))
      refuse(
        `App assets can't include ${file.path}: upload the entry HTML as the app's HTML and leave HTML out of the assets (apps are single-page).`,
      );
    if (!isSiteAssetPath(file.path))
      refuse(
        `App asset path ${file.path} isn't allowed. Use paths relative to the HTML (like assets/index-4f2a.js) made of letters, digits and ._~@+- with one of: ${ALLOWED}.`,
      );
    if (seen.has(file.path)) refuse(`App asset ${file.path} appears twice.`);
    seen.add(file.path);
    const content = decodeBase64(file.path, file.base64);
    if (content.byteLength > SITE_ASSET_MAX_FILE_BYTES)
      refuse(
        `App asset ${file.path} is over ${SITE_ASSET_MAX_FILE_BYTES / MB} MB. Link large media from app files or where it is hosted.`,
      );
    total += content.byteLength;
    if (total > SITE_ASSET_MAX_TOTAL_BYTES)
      refuse(
        `App assets are over ${SITE_ASSET_MAX_TOTAL_BYTES / MB} MB together. Link large media from app files or where it is hosted.`,
      );
    decoded.push({
      path: file.path,
      bytes: content,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  // Store each distinct content once; a file already there is the same bytes.
  const unique = new Map(decoded.map((file) => [file.sha256, file]));
  const pending = [...unique.values()];
  const workers = Array.from({ length: Math.min(8, pending.length) }, async () => {
    for (let file = pending.shift(); file; file = pending.shift()) {
      const key = siteAssetObjectKey(workspaceId, file.sha256);
      if (storage.headObject && (await storage.headObject(key))) continue;
      await storage.putObject({
        key,
        contentType: "application/octet-stream",
        body: file.bytes,
        sha256: file.sha256,
      });
    }
  });
  await Promise.all(workers);
  return SiteAssetManifest.parse({
    token: randomBytes(16).toString("base64url"),
    files: decoded
      .map(
        (file): SiteAssetFile => ({
          path: file.path,
          sha256: file.sha256,
          sizeBytes: file.bytes.byteLength,
        }),
      )
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
}

/** A version's asset files as a bundle again (for an app package), sorted by path. */
export async function readSiteAssetBundle(
  storage: Storage,
  workspaceId: string,
  manifest: SiteAssetManifest,
): Promise<SiteAssetBundle> {
  const files: SiteAssetBundle["files"] = new Array(manifest.files.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(8, manifest.files.length) }, async () => {
    for (let index = next++; index < manifest.files.length; index = next++) {
      const file = manifest.files[index]!;
      const object = await retryWhileMissing(() =>
        storage.getObjectBytes(siteAssetObjectKey(workspaceId, file.sha256)),
      );
      if (!object) throw new Error(`App asset ${file.path} is unavailable`);
      files[index] = { path: file.path, base64: Buffer.from(object.bytes).toString("base64") };
    }
  });
  await Promise.all(workers);
  return { files };
}

/**
 * The manifest for one upload: frozen at its first publish (so a retry or a
 * second publish of the same upload gets the same files and token), built
 * from the uploaded bundle otherwise. Null when the upload has no assets, or
 * was already published without them (assets uploaded later never change
 * what that upload publishes).
 */
export async function freezeSiteAssets(
  storage: Storage,
  workspaceId: string,
  keys: { upload: string; frozen: string; published?: boolean },
): Promise<SiteAssetManifest | null> {
  const readFrozen = async () => {
    const frozen = await storage.getObjectBytes(keys.frozen);
    return frozen
      ? SiteAssetManifest.parse(JSON.parse(new TextDecoder().decode(frozen.bytes)))
      : null;
  };
  const existing = await readFrozen();
  if (existing) return existing;
  if (keys.published) return null;
  if (!storage.headObject || !storage.putObjectStreamIfAbsent)
    throw new Error("Object storage cannot freeze app assets");
  const head = await storage.headObject(keys.upload);
  if (!head) return null;
  const tooLarge = () =>
    refuse(
      `The app assets upload is over ${SITE_ASSET_BUNDLE_MAX_BYTES / MB} MB. Link large media from app files or where it is hosted.`,
    );
  if ((head.ContentLength ?? 0) > SITE_ASSET_BUNDLE_MAX_BYTES) tooLarge();
  const object = await retryWhileMissing(() => storage.getObjectBytes(keys.upload));
  if (!object) refuse("App assets are not available yet. Retry publication with the same upload.");
  if (object.bytes.byteLength > SITE_ASSET_BUNDLE_MAX_BYTES) tooLarge();
  const manifest = await storeSiteAssetBundle(storage, workspaceId, object.bytes);
  const body = new TextEncoder().encode(JSON.stringify(manifest));
  const created = await storage.putObjectStreamIfAbsent({
    key: keys.frozen,
    contentType: "application/json",
    byteSize: body.byteLength,
    chunks: (async function* () {
      yield body;
    })(),
  });
  if (created) return manifest;
  // A concurrent publish of the same upload froze first: use its manifest.
  const winner = await retryWhileMissing(readFrozen);
  if (!winner) refuse("App assets are not available yet. Retry publication with the same upload.");
  return winner;
}

function sameToken(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The listed file for a token and path, or null (an unknown token is the same as no file). */
export function siteAssetFile(
  manifest: SiteAssetManifest | null,
  token: string,
  path: string,
): SiteAssetFile | null {
  if (!manifest || !sameToken(manifest.token, token)) return null;
  return manifest.files.find((file) => file.path === path) ?? null;
}

/**
 * Headers of an asset response. App frames are opaque-origin, so the file is
 * readable cross-origin without credentials (module scripts and fonts use
 * CORS). Opened directly it is a sandboxed, script-free document of an
 * allowed type, never sniffed into another.
 */
export function siteAssetHeaders(file: SiteAssetFile): Record<string, string> {
  return {
    "Content-Type": siteAssetContentType(file.path) ?? "application/octet-stream",
    "Cache-Control": SITE_ASSET_CACHE_CONTROL,
    ETag: `"${file.sha256}"`,
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Security-Policy": USER_CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

/** One asset file as a response (304 when the browser already has it). */
export async function siteAssetResponse(
  storage: Storage,
  workspaceId: string,
  file: SiteAssetFile,
  request: { method: string; ifNoneMatch: string | null },
): Promise<Response> {
  const headers = siteAssetHeaders(file);
  const matches = (request.ifNoneMatch ?? "")
    .split(",")
    .map((value) => value.trim().replace(/^W\//u, ""))
    .some((value) => value === headers.ETag || value === "*");
  if (matches) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD")
    return new Response(null, {
      status: 200,
      headers: { ...headers, "Content-Length": String(file.sizeBytes) },
    });
  const object = await retryWhileMissing(() =>
    storage.getObjectBytes(siteAssetObjectKey(workspaceId, file.sha256)),
  );
  if (!object) throw new Error("App asset is unavailable");
  return new Response(object.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers });
}
