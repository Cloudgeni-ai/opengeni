// Workbench v2 — capture READ serving.
//
// The two GET capture routes in `sessions.ts` are thin: grant-first (files:read),
// load the row (DB, RLS-scoped), then delegate the response SHAPING to the two
// pure functions here. Keeping the shaping decoupled from Hono + the DB lets the
// hermetic route tests exercise every branch ({available:false}, inline-vs-signed
// manifest, file resolve/marker/404) with in-memory fakes — no live stack.
//
// These functions NEVER touch a live sandbox box: a capture is served entirely
// from the durable `workspace_captures` row + its object-storage blobs. That is
// the whole point — the <200ms cold paint must not depend on a warm machine.

import {
  GetWorkspaceCaptureFileResponse,
  GetWorkspaceCaptureResponse,
  WORKSPACE_CAPTURE_MANIFEST_MAX_BYTES,
  WorkspaceCaptureDegradedReason,
  WorkspaceCaptureManifest,
  WorkspaceCaptureStats,
} from "@opengeni/contracts";
import type { WorkspaceCaptureRow } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

// Serve the manifest inline below this size (the overwhelmingly common case —
// the one API round-trip requirement); above it, a signed GET URL to the blob.
export const CAPTURE_INLINE_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
// Serve a single after-image inline below this size; above it, a signed GET URL.
export const CAPTURE_INLINE_FILE_MAX_BYTES = 256 * 1024;
// Short-lived — the client fetches immediately after the metadata response.
export const CAPTURE_SIGNED_URL_TTL_SECONDS = 300;

// The slice of ObjectStorage the serving path needs. Structural so the tests can
// inject an in-memory map without standing up S3/minio.
export type CaptureStoragePort = {
  getObjectBytes: (key: string) => Promise<{ bytes: Uint8Array } | null>;
  createGetUrl: (args: {
    key: string;
    expiresInSeconds?: number;
  }) => Promise<{ url: string; expiresAt: Date }>;
  // Size probe without downloading. Optional because ObjectStorage declares it
  // optional; every shipped provider implements it.
  headObject?: (key: string) => Promise<{ ContentLength?: number } | null>;
};

type LoadedManifest = {
  manifest: WorkspaceCaptureManifest;
  byteLength: number;
  stats: WorkspaceCaptureStats;
};

type ManifestCacheEntry = LoadedManifest & {
  identity: string;
  inlineResponse?: Extract<GetWorkspaceCaptureResponse, { available: true }>;
};

/**
 * Process-local cache for immutable capture manifests. Capture rows point at a
 * revision-specific object key, so a successfully validated blob is safe to
 * reuse as long as the row identity still matches. Both entry count and bytes
 * are bounded; large signed-manifest responses bypass the cache.
 */
export class WorkspaceCaptureManifestCache {
  readonly #entries = new Map<string, ManifestCacheEntry>();
  #retainedBytes = 0;

  constructor(
    readonly maxEntries = 64,
    readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  get(row: WorkspaceCaptureRow): LoadedManifest | null {
    const key = row.manifestKey;
    if (!key) return null;
    const entry = this.#entries.get(key);
    if (!entry || entry.identity !== manifestIdentity(row)) return null;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  getInlineResponse(
    row: WorkspaceCaptureRow,
  ): Extract<GetWorkspaceCaptureResponse, { available: true }> | null {
    const key = row.manifestKey;
    if (!key) return null;
    const entry = this.#entries.get(key);
    if (!entry || entry.identity !== manifestIdentity(row) || !entry.inlineResponse) return null;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.inlineResponse;
  }

  setInlineResponse(
    row: WorkspaceCaptureRow,
    response: Extract<GetWorkspaceCaptureResponse, { available: true }>,
  ): void {
    const key = row.manifestKey;
    if (!key) return;
    const entry = this.#entries.get(key);
    if (!entry || entry.identity !== manifestIdentity(row)) return;
    entry.inlineResponse = response;
  }

  set(row: WorkspaceCaptureRow, loaded: LoadedManifest): void {
    const key = row.manifestKey;
    if (
      !key ||
      this.maxEntries <= 0 ||
      this.maxBytes <= 0 ||
      loaded.byteLength > CAPTURE_INLINE_MANIFEST_MAX_BYTES ||
      loaded.byteLength > this.maxBytes
    ) {
      return;
    }
    const previous = this.#entries.get(key);
    if (previous) {
      this.#retainedBytes -= previous.byteLength;
      this.#entries.delete(key);
    }
    this.#entries.set(key, { ...loaded, identity: manifestIdentity(row) });
    this.#retainedBytes += loaded.byteLength;
    while (this.#entries.size > this.maxEntries || this.#retainedBytes > this.maxBytes) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      if (oldest) this.#retainedBytes -= oldest.byteLength;
    }
  }
}

function manifestIdentity(row: WorkspaceCaptureRow): string {
  return `${row.sessionId}\0${row.turnId}\0${row.revision}\0${row.leaseEpoch}\0${row.capturedAt}`;
}

function signedUrl(signed: { url: string; expiresAt: Date }): { url: string; expiresAt: string } {
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}

type ManifestSize = { kind: "missing" } | { kind: "known"; bytes: number } | { kind: "unknown" };

// Learn how large a row's manifest blob is WITHOUT downloading it. Parsing is
// synchronous: a large manifest blocks the API's event loop for as long as the
// parse takes, so the decision to parse must come before the bytes do. The
// row's size_bytes counts the manifest plus tree and after-images, so it is an
// upper bound that settles the common small case with no storage round trip.
async function manifestSize(
  row: WorkspaceCaptureRow & { manifestKey: string },
  storage: CaptureStoragePort,
): Promise<ManifestSize> {
  if (row.sizeBytes !== null && row.sizeBytes <= CAPTURE_INLINE_MANIFEST_MAX_BYTES) {
    return { kind: "known", bytes: row.sizeBytes };
  }
  if (!storage.headObject) return { kind: "unknown" };
  const head = await storage.headObject(row.manifestKey);
  if (!head) return { kind: "missing" };
  return typeof head.ContentLength === "number"
    ? { kind: "known", bytes: head.ContentLength }
    : { kind: "unknown" };
}

// Fetch + validate the manifest blob for a row. Returns null when the row has no
// manifest key, the blob is gone (GC'd), or the bytes fail to parse/validate — a
// malformed capture is treated as "no capture available" (the list route degrades
// to {available:false}, the file route to 404). Capture reads must NEVER be worse
// than the status-quo live/wake fallback, so a poison row can
// never 500 the workbench; it degrades and logs.
async function loadManifest(
  row: WorkspaceCaptureRow,
  storage: CaptureStoragePort,
  cache?: WorkspaceCaptureManifestCache,
): Promise<LoadedManifest | null> {
  if (!row.manifestKey) return null;
  const cached = cache?.get(row);
  if (cached) return cached;
  const stats = WorkspaceCaptureStats.safeParse(row.stats);
  if (!stats.success) {
    console.warn(
      `workspace capture read — row stats failed schema validation (session=${row.sessionId} rev=${row.revision})`,
    );
    return null;
  }
  const blob = await storage.getObjectBytes(row.manifestKey);
  if (!blob) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(blob.bytes));
  } catch {
    console.warn(
      `workspace capture read — manifest blob is not valid JSON (session=${row.sessionId} rev=${row.revision})`,
    );
    return null;
  }
  const parsed = WorkspaceCaptureManifest.safeParse(json);
  if (!parsed.success) {
    console.warn(
      `workspace capture read — manifest failed schema validation (session=${row.sessionId} rev=${row.revision})`,
    );
    return null;
  }
  const manifest = parsed.data;
  const servedStats = stats.data;
  const statsMatch =
    manifest.stats.repoCount === servedStats.repoCount &&
    manifest.stats.fileCount === servedStats.fileCount &&
    manifest.stats.additions === servedStats.additions &&
    manifest.stats.deletions === servedStats.deletions &&
    manifest.stats.totalBytes === servedStats.totalBytes &&
    manifest.stats.tooLargeCount === servedStats.tooLargeCount &&
    manifest.stats.binaryCount === servedStats.binaryCount &&
    manifest.stats.treeEntryCount === servedStats.treeEntryCount &&
    manifest.stats.treeTruncated === servedStats.treeTruncated &&
    manifest.stats.durationMs === servedStats.durationMs &&
    (manifest.stats.fingerprint ?? null) === (servedStats.fingerprint ?? null);
  if (
    manifest.revision !== row.revision ||
    manifest.capturedAt !== row.capturedAt ||
    manifest.turnId !== row.turnId ||
    manifest.leaseEpoch !== row.leaseEpoch ||
    !statsMatch ||
    manifest.repos.length !== manifest.stats.repoCount ||
    manifest.files.length !== manifest.stats.fileCount ||
    manifest.treeTruncated !== manifest.stats.treeTruncated
  ) {
    // A valid blob under the wrong row/key is still poison: row metadata drives
    // cache identity and revision pinning in the client. Never combine two
    // different captures into one apparently authoritative response.
    console.warn(
      `workspace capture read — manifest identity did not match row (session=${row.sessionId} rev=${row.revision})`,
    );
    return null;
  }
  const loaded = { manifest, byteLength: blob.bytes.byteLength, stats: servedStats };
  cache?.set(row, loaded);
  return loaded;
}

/**
 * Shape the GET …/workspace/capture response from a loaded row. `{available:false}`
 * when there is no capture yet, the row is not in the `available` state, or its
 * manifest blob has been GC'd (all graceful cold-fallback states — never errors).
 * Inline manifest for ≤2MB, signed URL above.
 */
/** Awaited before a signed capture URL is returned to the caller: the route
 *  records the metadata-only issuance audit fact. A throwing recorder fails
 *  the serve closed - no recorded fact, no bearer capability. */
export type CaptureSignedUrlIssuanceRecorder = (fact: {
  kind: "capture_manifest" | "capture_file";
  revision: number;
  expiresAt: string;
}) => Promise<void>;

export async function serveWorkspaceCapture(
  row: WorkspaceCaptureRow | null,
  storage: CaptureStoragePort,
  cache?: WorkspaceCaptureManifestCache,
  onSignedUrlIssued?: CaptureSignedUrlIssuanceRecorder,
): Promise<GetWorkspaceCaptureResponse> {
  if (!row) {
    return { available: false };
  }
  if (row.state === "failed") {
    const reason = WorkspaceCaptureDegradedReason.safeParse(row.stats.degradedReason);
    if (!reason.success) {
      // `failed` was reserved before repository-discovery markers existed. Do
      // not invent a cause for an older or malformed row; plain unavailable is
      // the only truthful backwards-compatible response.
      return { available: false };
    }
    return GetWorkspaceCaptureResponse.parse({
      available: false,
      degradedReason: reason.data,
      revision: row.revision,
      capturedAt: row.capturedAt,
      turnId: row.turnId,
      leaseEpoch: row.leaseEpoch,
    });
  }
  if (row.state !== "available" || !row.manifestKey) return { available: false };
  const cachedResponse = cache?.getInlineResponse(row);
  if (cachedResponse) return cachedResponse;
  const stats = WorkspaceCaptureStats.safeParse(row.stats);
  if (!stats.success) {
    console.warn(
      `workspace capture read — row stats failed schema validation (session=${row.sessionId} rev=${row.revision})`,
    );
    return { available: false };
  }
  const meta = {
    available: true as const,
    revision: row.revision,
    capturedAt: row.capturedAt,
    turnId: row.turnId,
    leaseEpoch: row.leaseEpoch,
    sizeBytes: row.sizeBytes ?? 0,
    stats: stats.data,
  };
  const size = await manifestSize({ ...row, manifestKey: row.manifestKey }, storage);
  if (size.kind === "missing") return { available: false };
  if (size.kind === "unknown" || size.bytes > CAPTURE_INLINE_MANIFEST_MAX_BYTES) {
    // Large manifests are handed to the client by signed URL and never
    // downloaded or parsed here: the client validates schema, revision
    // identity and stats against this metadata before using it.
    const signed = await storage.createGetUrl({
      key: row.manifestKey,
      expiresInSeconds: CAPTURE_SIGNED_URL_TTL_SECONDS,
    });
    await onSignedUrlIssued?.({
      kind: "capture_manifest",
      revision: row.revision,
      expiresAt: signed.expiresAt.toISOString(),
    });
    return GetWorkspaceCaptureResponse.parse({
      ...meta,
      manifest: null,
      manifestUrl: signedUrl(signed),
    });
  }
  // Inline manifests are validated against the row before they are served.
  const loaded = await loadManifest(row, storage, cache);
  if (!loaded) return { available: false };
  if (loaded.byteLength > CAPTURE_INLINE_MANIFEST_MAX_BYTES) {
    // The blob changed size after the probe; never inline it.
    return { available: false };
  }
  const response = GetWorkspaceCaptureResponse.parse({
    ...meta,
    stats: loaded.stats,
    manifest: loaded.manifest,
    manifestUrl: null,
  });
  if (!response.available) {
    throw new Error("validated inline capture response lost its available discriminator");
  }
  cache?.setInlineResponse(row, response);
  return response;
}

/**
 * Shape the GET …/workspace/capture/file response from a loaded row (the row
 * already resolved to the requested revision, or the latest). Throws
 * HTTPException(404) when there is no capture, the path is not in the manifest,
 * or the file was deleted. Returns a metadata-only marker for a tooLarge file (or
 * a captured file whose after-image blob is missing). Inline content for ≤256KB,
 * signed URL above.
 */
export async function serveWorkspaceCaptureFile(
  row: WorkspaceCaptureRow | null,
  path: string,
  storage: CaptureStoragePort,
  onSignedUrlIssued?: CaptureSignedUrlIssuanceRecorder,
): Promise<GetWorkspaceCaptureFileResponse> {
  // Resolving one file needs the manifest's file index. Captures never publish
  // a manifest above WORKSPACE_CAPTURE_MANIFEST_MAX_BYTES; an older, larger one
  // is not parsed here (the client opens the file live instead).
  const size = row?.manifestKey
    ? await manifestSize({ ...row, manifestKey: row.manifestKey }, storage)
    : null;
  const loaded =
    row &&
    size?.kind !== "missing" &&
    !(size?.kind === "known" && size.bytes > WORKSPACE_CAPTURE_MANIFEST_MAX_BYTES)
      ? await loadManifest(row, storage)
      : null;
  if (!loaded) {
    throw new HTTPException(404, { message: "capture not found" });
  }
  const { manifest } = loaded;
  const file = manifest.files.find((f) => f.path === path);
  if (!file) {
    throw new HTTPException(404, { message: "path not in capture" });
  }
  if (file.deleted) {
    // Parity with fs/read on a deleted path.
    throw new HTTPException(404, { message: "file was deleted" });
  }
  const base = {
    path: file.path,
    revision: manifest.revision,
    status: file.status,
    hash: file.hash,
    baseHash: file.baseHash,
    sizeBytes: file.sizeBytes,
    isBinary: file.isBinary,
    tooLarge: file.tooLarge,
  };
  if (file.tooLarge || !file.contentRef) {
    // Marker: content was not captured (guard tripped) or the blob is unavailable.
    return GetWorkspaceCaptureFileResponse.parse({
      ...base,
      encoding: null,
      content: null,
      contentUrl: null,
    });
  }
  if (file.sizeBytes <= CAPTURE_INLINE_FILE_MAX_BYTES) {
    const blob = await storage.getObjectBytes(file.contentRef);
    if (!blob) {
      // After-image GC'd out from under us → return the marker (client opens live).
      return GetWorkspaceCaptureFileResponse.parse({
        ...base,
        encoding: null,
        content: null,
        contentUrl: null,
      });
    }
    const encoding = file.isBinary ? "base64" : "utf8";
    const content = file.isBinary
      ? Buffer.from(blob.bytes).toString("base64")
      : new TextDecoder().decode(blob.bytes);
    return GetWorkspaceCaptureFileResponse.parse({ ...base, encoding, content, contentUrl: null });
  }
  const signed = await storage.createGetUrl({
    key: file.contentRef,
    expiresInSeconds: CAPTURE_SIGNED_URL_TTL_SECONDS,
  });
  await onSignedUrlIssued?.({
    kind: "capture_file",
    revision: row!.revision,
    expiresAt: signed.expiresAt.toISOString(),
  });
  return GetWorkspaceCaptureFileResponse.parse({
    ...base,
    encoding: null,
    content: null,
    contentUrl: signedUrl(signed),
  });
}
