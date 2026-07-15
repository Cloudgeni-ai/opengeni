// Workbench v2 — capture READ serving (dossier §10.3).
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
};

function signedUrl(signed: { url: string; expiresAt: Date }): { url: string; expiresAt: string } {
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}

// Fetch + validate the manifest blob for a row. Returns null when the row has no
// manifest key, the blob is gone (GC'd), or the bytes fail to parse/validate — a
// malformed capture is treated as "no capture available" (the list route degrades
// to {available:false}, the file route to 404). Capture reads must NEVER be worse
// than the status-quo live/wake fallback (dossier §10.10), so a poison row can
// never 500 the workbench; it degrades and logs.
async function loadManifest(
  row: WorkspaceCaptureRow,
  storage: CaptureStoragePort,
): Promise<{ manifest: WorkspaceCaptureManifest; byteLength: number } | null> {
  if (!row.manifestKey) return null;
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
  return { manifest: parsed.data, byteLength: blob.bytes.byteLength };
}

/**
 * Shape the GET …/workspace/capture response from a loaded row. `{available:false}`
 * when there is no capture yet, the row is not in the `available` state, or its
 * manifest blob has been GC'd (all graceful cold-fallback states — never errors).
 * Inline manifest for ≤2MB, signed URL above.
 */
export async function serveWorkspaceCapture(
  row: WorkspaceCaptureRow | null,
  storage: CaptureStoragePort,
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
  const stats = WorkspaceCaptureStats.safeParse(row.stats);
  if (!stats.success) {
    // A row with malformed stats (or a synthetic/partial row) degrades to the
    // cold-fallback state rather than 500.
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
  const blob = await storage.getObjectBytes(row.manifestKey);
  if (!blob) {
    // Manifest raced GC between the row read and the blob fetch — degrade to the
    // cold-fallback state rather than 500.
    return { available: false };
  }
  if (blob.bytes.byteLength <= CAPTURE_INLINE_MANIFEST_MAX_BYTES) {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(blob.bytes));
    } catch {
      console.warn(
        `workspace capture read — manifest blob is not valid JSON (session=${row.sessionId} rev=${row.revision})`,
      );
      return { available: false };
    }
    const manifest = WorkspaceCaptureManifest.safeParse(json);
    if (!manifest.success) {
      console.warn(
        `workspace capture read — manifest failed schema validation (session=${row.sessionId} rev=${row.revision})`,
      );
      return { available: false };
    }
    return GetWorkspaceCaptureResponse.parse({
      ...meta,
      manifest: manifest.data,
      manifestUrl: null,
    });
  }
  const signed = await storage.createGetUrl({
    key: row.manifestKey,
    expiresInSeconds: CAPTURE_SIGNED_URL_TTL_SECONDS,
  });
  return GetWorkspaceCaptureResponse.parse({
    ...meta,
    manifest: null,
    manifestUrl: signedUrl(signed),
  });
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
): Promise<GetWorkspaceCaptureFileResponse> {
  const loaded = row ? await loadManifest(row, storage) : null;
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
  return GetWorkspaceCaptureFileResponse.parse({
    ...base,
    encoding: null,
    content: null,
    contentUrl: signedUrl(signed),
  });
}
