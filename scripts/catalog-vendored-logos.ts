import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vendoredManifestDocument from "../data/catalog/logos/manifest.json";

/**
 * Vendored connector logos.
 *
 * A default deployment imports the committed catalog with `--skip-logos`, so
 * it never fetches from third-party logo hosts at deploy time. To still ship
 * logos for the curated connector set, the reviewed assets are committed under
 * `data/catalog/logos/` with a provenance manifest and copied into object
 * storage by the importer under the same `catalog-assets/...` key scheme a
 * fetched logo would use. The vendored path adds no third-party dependency, so
 * `--skip-logos` keeps it enabled while still skipping the network fetch for
 * the uncurated long tail.
 *
 * `bun run catalog:vendor-logos` regenerates the directory from the current
 * snapshot plus curated overlay. This module has no dependency on the importer,
 * which imports it.
 */

/** Same ceiling the importer applies to a fetched logo. */
export const MAX_LOGO_BYTES = 512 * 1024;

export const VENDORED_LOGO_MANIFEST_PATH = "data/catalog/logos/manifest.json";

/** Directory that holds the vendored asset files next to the manifest. */
export const VENDORED_LOGO_DIRECTORY = fileURLToPath(
  new URL("../data/catalog/logos/", import.meta.url),
);

export type VendoredLogoEntry = {
  /** Registry capability id the importer derives from `(domain, mcpUrl)`. */
  readonly capabilityId: string;
  readonly domain: string;
  /** Exact canonical MCP URL of the row the asset was vendored for. */
  readonly mcpUrl: string;
  /** Asset file name relative to the manifest directory. */
  readonly file: string;
  /** The row's effective logo source at vendoring time; a mismatch means stale. */
  readonly sourceUrl: string;
  readonly sha256: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly fetchedAt: string;
};

export type VendoredLogoManifest = {
  readonly version: number;
  readonly entries: readonly VendoredLogoEntry[];
};

export class VendoredLogoManifestError extends Error {
  constructor(message: string) {
    super(`${VENDORED_LOGO_MANIFEST_PATH}: ${message}`);
    this.name = "VendoredLogoManifestError";
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_FILE_NAME = /^[a-z0-9][a-z0-9.-]*\.(?:svg|jpg|jpeg|png|gif|webp|ico)$/;

/**
 * The exact content types the catalog-asset route can serve back. Anything
 * outside this map would be stored under an extension the route does not map,
 * so the asset would exist in object storage and still 404. Accepting only
 * these keeps stored bytes and served bytes the same set.
 *
 * Declared here rather than beside `extensionForContentType` because the
 * committed manifest is parsed at module load, before that point in the file.
 */
const LOGO_EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/vnd.microsoft.icon": "ico",
  "image/webp": "webp",
  "image/x-icon": "ico",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new VendoredLogoManifestError(`${where}: ${key} must be a non-empty string`);
  }
  return value;
}

function parseEntry(value: unknown, index: number): VendoredLogoEntry {
  const record = asRecord(value);
  if (!record) throw new VendoredLogoManifestError(`entries[${index}] must be an object`);
  const capabilityId = requiredString(record, "capabilityId", `entries[${index}]`);
  const where = capabilityId;
  const known = new Set([
    "capabilityId",
    "domain",
    "mcpUrl",
    "file",
    "sourceUrl",
    "sha256",
    "contentType",
    "sizeBytes",
    "fetchedAt",
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new VendoredLogoManifestError(`${where}: unknown key "${key}"`);
  }
  const file = requiredString(record, "file", where);
  if (!SAFE_FILE_NAME.test(file)) {
    throw new VendoredLogoManifestError(`${where}: file "${file}" is not a safe asset file name`);
  }
  const sha256 = requiredString(record, "sha256", where);
  if (!SHA256_HEX.test(sha256)) {
    throw new VendoredLogoManifestError(`${where}: sha256 must be 64 lowercase hex characters`);
  }
  const contentType = requiredString(record, "contentType", where);
  const contentTypeCheck = validateLogoContentType(contentType);
  if (!contentTypeCheck.ok) {
    throw new VendoredLogoManifestError(`${where}: ${contentTypeCheck.reason}`);
  }
  const sizeBytes = record.sizeBytes;
  if (
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_LOGO_BYTES
  ) {
    throw new VendoredLogoManifestError(
      `${where}: sizeBytes must be an integer between 1 and ${MAX_LOGO_BYTES}`,
    );
  }
  const sourceUrl = requiredString(record, "sourceUrl", where);
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "https:") throw new Error("not https");
  } catch {
    throw new VendoredLogoManifestError(`${where}: sourceUrl must be an https URL`);
  }
  return {
    capabilityId,
    domain: requiredString(record, "domain", where),
    mcpUrl: requiredString(record, "mcpUrl", where),
    file,
    sourceUrl,
    sha256,
    contentType: contentTypeCheck.contentType,
    sizeBytes,
    fetchedAt: requiredString(record, "fetchedAt", where),
  };
}

/**
 * Parses and validates the vendored logo manifest. Throws rather than dropping
 * a malformed entry so a bad edit fails the import loudly instead of silently
 * shipping monograms for curated connectors.
 */
export function parseVendoredLogoManifest(document: unknown): VendoredLogoManifest {
  const root = asRecord(document);
  if (!root) throw new VendoredLogoManifestError("document must be an object");
  if (root.version !== 1) {
    throw new VendoredLogoManifestError(`unsupported version ${String(root.version)}; expected 1`);
  }
  if (!Array.isArray(root.entries)) {
    throw new VendoredLogoManifestError("entries must be an array");
  }
  const entries = root.entries.map(parseEntry);
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.capabilityId)) {
      throw new VendoredLogoManifestError(`duplicate entry for ${entry.capabilityId}`);
    }
    if (seenFiles.has(entry.file)) {
      throw new VendoredLogoManifestError(`duplicate asset file ${entry.file}`);
    }
    seenIds.add(entry.capabilityId);
    seenFiles.add(entry.file);
  }
  return { version: root.version, entries };
}

export function vendoredLogosByCapabilityId(
  manifest: VendoredLogoManifest,
): ReadonlyMap<string, VendoredLogoEntry> {
  return new Map(manifest.entries.map((entry) => [entry.capabilityId, entry]));
}

/** The committed manifest, validated at module load so a bad edit fails loudly. */
export const VENDORED_LOGO_MANIFEST: VendoredLogoManifest =
  parseVendoredLogoManifest(vendoredManifestDocument);

export const vendoredLogoEntriesByCapabilityId: ReadonlyMap<string, VendoredLogoEntry> =
  vendoredLogosByCapabilityId(VENDORED_LOGO_MANIFEST);

/**
 * Canonical serialization used by the import fingerprint. Whitespace and key
 * order in the manifest are irrelevant; adding, removing, or replacing a
 * vendored asset (its sha256 changes) is not.
 */
export function vendoredLogoManifestFingerprintInput(manifest: VendoredLogoManifest): string {
  const sorted = [...manifest.entries]
    .map((entry) => ({
      capabilityId: entry.capabilityId,
      contentType: entry.contentType,
      domain: entry.domain,
      file: entry.file,
      mcpUrl: entry.mcpUrl,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      sourceUrl: entry.sourceUrl,
    }))
    .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  return JSON.stringify({ version: manifest.version, entries: sorted });
}

/** Serializes a manifest with sorted entries so regeneration yields a stable diff. */
export function serializeVendoredLogoManifest(manifest: VendoredLogoManifest): string {
  const entries = [...manifest.entries].sort((a, b) =>
    a.capabilityId.localeCompare(b.capabilityId),
  );
  return `${JSON.stringify({ version: manifest.version, entries }, null, 2)}\n`;
}

export function normalizedContentType(value: string | null): string | null {
  return value?.split(";")[0]?.trim().toLowerCase() || null;
}

export function extensionForContentType(contentType: string): string | null {
  return LOGO_EXTENSION_BY_CONTENT_TYPE[contentType] ?? null;
}

export function safePathSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

/** Object key a logo is served from; identical for fetched and vendored assets. */
export function catalogLogoObjectKey(domain: string, sha256: string, contentType: string): string {
  const extension = extensionForContentType(contentType);
  if (!extension) {
    // Unreachable through the validated paths: `validateLogoContentType`
    // already rejects every content type without a served extension.
    throw new Error(`unsupported logo content type: ${contentType}`);
  }
  return `catalog-assets/integrations-sh/logos/${safePathSegment(domain)}/${sha256.slice(0, 24)}.${extension}`;
}

export type LogoAssetValidation =
  | { ok: true; contentType: string; sha256: string; bytes: Uint8Array }
  | { ok: false; reason: string };

export function validateLogoContentType(
  rawContentType: string | null,
): { ok: true; contentType: string } | { ok: false; reason: string } {
  const contentType = normalizedContentType(rawContentType);
  if (!contentType?.startsWith("image/")) {
    return { ok: false, reason: `invalid_content_type:${contentType ?? "missing"}` };
  }
  if (!extensionForContentType(contentType)) {
    return { ok: false, reason: `unservable_content_type:${contentType}` };
  }
  return { ok: true, contentType };
}

/**
 * Textual SVG constructs that make an asset active content rather than a mark.
 *
 * Defense in depth only: the serving route already sends
 * `X-Content-Type-Options: nosniff` plus `default-src 'none'; sandbox`, and the
 * UI renders logos through `<img>`, so an SVG cannot execute against an
 * OpenGeni origin today. Rejecting at vendoring and import time keeps a
 * scripted mark out of the repository and out of object storage regardless of
 * how the bytes are consumed later.
 */
const SVG_ACTIVE_CONTENT_PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: "script_element", re: /<\s*script\b/i },
  { name: "foreign_object", re: /<\s*foreignObject\b/i },
  { name: "event_handler_attribute", re: /\son[a-z]+\s*=/i },
  { name: "javascript_url", re: /javascript\s*:/i },
];

/**
 * `href`/`xlink:href` on the two elements that can pull in another document.
 * The value is extracted rather than matched in place so an optional quote
 * cannot let an external target slip past a lookahead.
 */
const SVG_REFERENCE_HREF =
  /<\s*(use|image)\b[^>]*?\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** A reference an SVG mark may legitimately resolve: same document, or inline bytes. */
function isSelfContainedSvgReference(value: string): boolean {
  const target = value.trim();
  return target.startsWith("#") || /^data:image\//i.test(target);
}

/** Rejects SVG bytes that carry active content; non-SVG bytes always pass. */
export function svgActiveContentReason(contentType: string, bytes: Uint8Array): string | null {
  if (contentType !== "image/svg+xml") {
    return null;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  for (const pattern of SVG_ACTIVE_CONTENT_PATTERNS) {
    if (pattern.re.test(text)) {
      return `svg_active_content:${pattern.name}`;
    }
  }
  SVG_REFERENCE_HREF.lastIndex = 0;
  for (const match of text.matchAll(SVG_REFERENCE_HREF)) {
    const element = match[1]?.toLowerCase() === "use" ? "use" : "image";
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!isSelfContainedSvgReference(value)) {
      return `svg_active_content:external_${element}_href`;
    }
  }
  return null;
}

/**
 * The one logo acceptance rule: a servable image content type, at most
 * `MAX_LOGO_BYTES`, and no active content inside an SVG. The importer applies
 * it to fetched responses and the vendoring script applies it before writing an
 * asset to the repository.
 */
export function validateLogoAsset(input: {
  contentType: string | null;
  bytes: Uint8Array;
}): LogoAssetValidation {
  const contentType = validateLogoContentType(input.contentType);
  if (!contentType.ok) return contentType;
  if (input.bytes.byteLength === 0) {
    return { ok: false, reason: "image_empty" };
  }
  if (input.bytes.byteLength > MAX_LOGO_BYTES) {
    return { ok: false, reason: "image_too_large" };
  }
  const activeContent = svgActiveContentReason(contentType.contentType, input.bytes);
  if (activeContent) {
    return { ok: false, reason: activeContent };
  }
  return {
    ok: true,
    contentType: contentType.contentType,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    bytes: input.bytes,
  };
}

export type LogoFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Fetches and validates a logo without storing it. */
export async function fetchLogoAsset(
  sourceUrl: string,
  fetchImpl: LogoFetch,
): Promise<LogoAssetValidation> {
  let response: Response;
  try {
    response = await fetchImpl(sourceUrl);
  } catch (error) {
    return {
      ok: false,
      reason: `fetch_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    return { ok: false, reason: `http_status:${response.status}` };
  }
  const contentType = validateLogoContentType(response.headers.get("content-type"));
  if (!contentType.ok) return contentType;
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_LOGO_BYTES) {
    return { ok: false, reason: "image_too_large" };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return validateLogoAsset({ contentType: contentType.contentType, bytes });
}

/**
 * Reads a vendored asset and proves it is byte-identical to its manifest entry.
 * A mismatch is a corrupted or hand-edited checkout and fails closed.
 */
export async function readVendoredLogoAsset(
  entry: VendoredLogoEntry,
  directory: string = VENDORED_LOGO_DIRECTORY,
): Promise<LogoAssetValidation> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(directory, entry.file)));
  } catch (error) {
    return {
      ok: false,
      reason: `vendored_logo_unreadable:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const validated = validateLogoAsset({ contentType: entry.contentType, bytes });
  if (!validated.ok) return validated;
  if (validated.sha256 !== entry.sha256 || bytes.byteLength !== entry.sizeBytes) {
    return { ok: false, reason: "vendored_logo_digest_mismatch" };
  }
  return validated;
}
