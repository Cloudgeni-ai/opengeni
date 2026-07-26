import type {
  GetWorkspaceCaptureResponse,
  SessionEvent,
  WorkspaceCaptureDegradedReason,
  WorkspaceCaptureManifest,
  WorkspaceRevisionCapturedPayload,
  WorkspaceRevisionDegradedPayload,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

/** The announce event M1 emits at turn end (metadata only, never content). */
const REVISION_CAPTURED = "workspace.revision.captured";
const REVISION_DEGRADED = "workspace.revision.degraded";
const MANIFEST_FETCH_TIMEOUT_MS = 15_000;

type AvailableCaptureResponse = Extract<GetWorkspaceCaptureResponse, { available: true }>;

const CAPTURE_STATS_NUMBER_FIELDS = [
  "repoCount",
  "fileCount",
  "additions",
  "deletions",
  "totalBytes",
  "tooLargeCount",
  "binaryCount",
  "treeEntryCount",
  "durationMs",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Signed manifests bypass the authenticated JSON client's wire decoder. Treat
 * the blob as untrusted until its outer schema and exact revision identity match
 * the metadata response that minted the URL. The API performs the full contract
 * parse; this client-side boundary prevents a corrupt/mis-keyed response from
 * being presented as a different authoritative capture.
 */
function captureManifestForResponse(
  value: unknown,
  response: AvailableCaptureResponse,
): WorkspaceCaptureManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.capturedAt !== "string" ||
    !(value.turnId === null || typeof value.turnId === "string") ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    !isRecord(value.treeIndex) ||
    typeof value.treeTruncated !== "boolean" ||
    !Array.isArray(value.repos) ||
    !Array.isArray(value.files) ||
    !isRecord(value.stats)
  ) {
    throw new Error("Workspace capture manifest failed validation.");
  }

  if (
    value.revision !== response.revision ||
    value.capturedAt !== response.capturedAt ||
    value.turnId !== response.turnId ||
    value.leaseEpoch !== response.leaseEpoch
  ) {
    throw new Error("Workspace capture manifest identity did not match its response.");
  }

  for (const field of CAPTURE_STATS_NUMBER_FIELDS) {
    if (!Number.isSafeInteger(value.stats[field]) || value.stats[field] !== response.stats[field]) {
      throw new Error("Workspace capture manifest statistics did not match its response.");
    }
  }
  if (
    typeof value.stats.treeTruncated !== "boolean" ||
    value.stats.treeTruncated !== response.stats.treeTruncated ||
    (value.stats.fingerprint ?? null) !== (response.stats.fingerprint ?? null) ||
    value.repos.length !== response.stats.repoCount ||
    value.files.length !== response.stats.fileCount ||
    value.treeTruncated !== response.stats.treeTruncated
  ) {
    throw new Error("Workspace capture manifest statistics did not match its response.");
  }

  return value as WorkspaceCaptureManifest;
}

export type UseWorkspaceCaptureOptions = ClientOverride & {
  /** Live event log (usually `useSessionEvents().events`) — a
   *  `workspace.revision.captured` for a NEWER revision refreshes the manifest. */
  events?: SessionEvent[] | undefined;
  /** Hold off the mount fetch (e.g. the workbench panel is collapsed). Default true. */
  enabled?: boolean | undefined;
};

export type UseWorkspaceCaptureResult = {
  /** The resolved manifest (tree index + per-repo diffs + file refs), or null when
   *  no capture exists (falls back to the live/wake path — status quo). */
  capture: WorkspaceCaptureManifest | null;
  /** The loaded capture's monotonic revision, or null when unavailable. */
  revision: number | null;
  /** When the loaded capture was taken (ISO), for the "as of <time>" source badge. */
  capturedAt: string | null;
  /** Whether a capture is available at all (the `{available:false}` discriminator). */
  available: boolean;
  /** Why the newest durable revision is unavailable. null means no capture has
   *  been attempted yet; a value means capture explicitly failed closed and
   *  consumers must use the live box rather than trust an incomplete snapshot. */
  degradedReason: WorkspaceCaptureDegradedReason | null;
  /** The changed-file count from the capture's stats, resolved on the FIRST GET
   *  (from the response's top-level `stats`, before any manifest-URL hop). null
   *  until that first resolve; 0 when no capture exists. This is the pre-paint
   *  "changes exist?" signal the dock uses to pick its default tab with no
   *  embedder events-at-mount contract. */
  fileCount: number | null;
  /** A newer revision has been ANNOUNCED than the one currently loaded (a refresh
   *  is in flight or pending). M5's source badge can show a subtle "updating…". */
  isStale: boolean;
  loading: boolean;
  error: Error | null;
  /** Force a re-fetch of the latest capture. */
  refresh: () => Promise<void>;
};

/**
 * The cold-paint data source: fetch the latest turn-end workspace capture with a
 * SINGLE api round-trip on mount (no machine, no Channel-A — this is the <200ms
 * first paint). The manifest is served inline in the common
 * case; a rare >2MB manifest comes back as a short-TTL signed URL we follow.
 *
 * Subscribes to the live event log: a `workspace.revision.captured` for a revision
 * newer than the one loaded triggers a background refresh (stale-while-revalidate).
 * `{available:false}` is a value, never a crash — consumers fall back to the
 * live/wake path exactly as before the capture feature existed.
 */
export function useWorkspaceCapture(
  sessionId: string | null | undefined,
  options: UseWorkspaceCaptureOptions = {},
): UseWorkspaceCaptureResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const identityKey = `${workspaceId}\u0000${sessionId ?? ""}`;

  const [capture, setCapture] = useState<WorkspaceCaptureManifest | null>(null);
  const [available, setAvailable] = useState(false);
  const [degradedReason, setDegradedReason] = useState<WorkspaceCaptureDegradedReason | null>(null);
  // Resolved from the FIRST GET's top-level stats (before any manifest-URL hop),
  // so the dock can pick its default tab as early as possible. null until then.
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // The highest revision ANNOUNCED on the event log — compared against the loaded
  // manifest's revision to compute `isStale` and to gate refreshes.
  const [announcedRevision, setAnnouncedRevision] = useState<number | null>(null);
  // State updates are asynchronous, so the previous session's capture still
  // exists during the first render after an identity switch. Tag it and hide it
  // synchronously until the new identity's request owns the state.
  const [stateIdentity, setStateIdentity] = useState(identityKey);

  // A generation counter fences a slow in-flight fetch against a newer one (or an
  // identity change) so a stale response can never overwrite fresher state.
  const generationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  // Event sequence numbers are scoped to a session. Keeping this cursor across an
  // identity switch would discard the new session's low-numbered announcements.
  const lastSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    requestAbortRef.current?.abort();
    const requestAbort = new AbortController();
    requestAbortRef.current = requestAbort;
    const generation = (generationRef.current += 1);
    setStateIdentity(identityKey);
    setLoading(true);
    setError(null);
    try {
      // A signed URL can expire between mint and GET. Re-enter the authenticated
      // endpoint once to mint a fresh URL; never replay or log the old credential.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res: GetWorkspaceCaptureResponse = await client.getWorkspaceCapture(
          workspaceId,
          sessionId,
          { signal: requestAbort.signal },
        );
        if (generationRef.current !== generation) return;
        if (!res.available) {
          setCapture(null);
          setAvailable(false);
          setFileCount(0);
          setDegradedReason(res.degradedReason ?? null);
          return;
        }
        setDegradedReason(null);
        // Resolve the changed-file count immediately from the response's stats — the
        // default-tab signal must not wait on a >2MB manifest-URL hop.
        setFileCount(res.stats.fileCount);
        // Exactly one of manifest / manifestUrl is non-null (M2 contract). The inline
        // manifest is the <200ms common case; a >2MB manifest is a signed URL hop.
        let manifestValue: unknown = res.manifest;
        if (!manifestValue && res.manifestUrl) {
          const response = await fetch(res.manifestUrl.url, {
            signal: AbortSignal.any([
              requestAbort.signal,
              AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
            ]),
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
          }).catch(() => null);
          if (generationRef.current !== generation) return;
          if (!response?.ok) {
            if (
              attempt === 0 &&
              (response === null || response.status === 401 || response.status === 403)
            ) {
              continue;
            }
            throw new Error(
              `Workspace capture manifest download failed${response ? ` (${response.status})` : ""}.`,
            );
          }
          try {
            manifestValue = await response.json();
          } catch {
            throw new Error("Workspace capture manifest was not valid JSON.");
          }
          if (generationRef.current !== generation) return;
        }
        if (!manifestValue) {
          throw new Error("Workspace capture response did not include a manifest.");
        }
        const manifest = captureManifestForResponse(manifestValue, res);
        setCapture(manifest);
        setAvailable(true);
        // Fold the served revision into the announced high-water mark so a capture we
        // JUST loaded is never reported stale against an older announce.
        setAnnouncedRevision((prev) =>
          prev === null || manifest.revision > prev ? manifest.revision : prev,
        );
        return;
      }
      throw new Error("Workspace capture manifest download failed after refreshing its URL.");
    } catch (cause) {
      if (generationRef.current !== generation) return;
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (generationRef.current === generation) setLoading(false);
      if (requestAbortRef.current === requestAbort) requestAbortRef.current = null;
    }
  }, [client, workspaceId, sessionId, identityKey]);

  // Mount fetch + reset on identity change.
  useEffect(() => {
    // Invalidate a request started for the previous identity before clearing its
    // state. The cleanup also fences a response that arrives after unmount.
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    generationRef.current += 1;
    lastSeqRef.current = 0;
    setCapture(null);
    setAvailable(false);
    setDegradedReason(null);
    setFileCount(null);
    setAnnouncedRevision(null);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refresh();
    return () => {
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      generationRef.current += 1;
    };
  }, [enabled, refresh]);

  // Fold `workspace.revision.captured` announcements. A revision NEWER than the one
  // loaded bumps the announced high-water mark (→ isStale) and refreshes in the
  // background. The event is announce-only (metadata) — we still re-fetch the
  // manifest, since the payload carries no content.
  const events = options.events;
  useEffect(() => {
    if (!enabled || !events) return;
    let newest: number | null = null;
    for (const event of events) {
      if (event.sequence <= lastSeqRef.current) continue;
      if (event.type === REVISION_CAPTURED) {
        const payload = event.payload as WorkspaceRevisionCapturedPayload | null;
        if (payload && typeof payload === "object" && typeof payload.revision === "number") {
          newest = newest === null ? payload.revision : Math.max(newest, payload.revision);
        }
      } else if (event.type === REVISION_DEGRADED) {
        const payload = event.payload as WorkspaceRevisionDegradedPayload | null;
        if (payload && typeof payload === "object" && typeof payload.revision === "number") {
          newest = newest === null ? payload.revision : Math.max(newest, payload.revision);
        }
      }
    }
    for (const event of events)
      if (event.sequence > lastSeqRef.current) lastSeqRef.current = event.sequence;
    if (newest === null) return;
    setAnnouncedRevision((prev) => (prev === null || newest > prev ? newest : prev));
  }, [enabled, events]);

  // A newer announced revision than the loaded manifest → refresh in the background.
  const identityMatches = enabled && stateIdentity === identityKey;
  const visibleCapture = identityMatches ? capture : null;
  const visibleAnnouncedRevision = identityMatches ? announcedRevision : null;
  const loadedRevision = visibleCapture?.revision ?? null;
  useEffect(() => {
    if (!enabled) return;
    if (visibleAnnouncedRevision === null) return;
    if (loadedRevision !== null && visibleAnnouncedRevision <= loadedRevision) return;
    // A newer capture exists than the one we hold (or we hold none) — pull it.
    void refresh();
  }, [enabled, visibleAnnouncedRevision, loadedRevision, refresh]);

  const isStale =
    loadedRevision !== null &&
    visibleAnnouncedRevision !== null &&
    visibleAnnouncedRevision > loadedRevision;

  return {
    capture: visibleCapture,
    revision: loadedRevision,
    capturedAt: visibleCapture?.capturedAt ?? null,
    available: identityMatches && available,
    degradedReason: identityMatches ? degradedReason : null,
    fileCount: identityMatches ? fileCount : null,
    isStale,
    loading: identityMatches && loading,
    error: identityMatches ? error : null,
    refresh,
  };
}
