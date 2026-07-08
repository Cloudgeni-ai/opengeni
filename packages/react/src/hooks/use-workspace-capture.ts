import type {
  GetWorkspaceCaptureResponse,
  SessionEvent,
  WorkspaceCaptureManifest,
  WorkspaceRevisionCapturedPayload,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

/** The announce event M1 emits at turn end (metadata only, never content). */
const REVISION_CAPTURED = "workspace.revision.captured";

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
 * first paint, dossier §10.4/§12-A1). The manifest is served inline in the common
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

  const [capture, setCapture] = useState<WorkspaceCaptureManifest | null>(null);
  const [available, setAvailable] = useState(false);
  // Resolved from the FIRST GET's top-level stats (before any manifest-URL hop),
  // so the dock can pick its default tab as early as possible. null until then.
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // The highest revision ANNOUNCED on the event log — compared against the loaded
  // manifest's revision to compute `isStale` and to gate refreshes.
  const [announcedRevision, setAnnouncedRevision] = useState<number | null>(null);

  // A generation counter fences a slow in-flight fetch against a newer one (or an
  // identity change) so a stale response can never overwrite fresher state.
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const generation = (generationRef.current += 1);
    setLoading(true);
    setError(null);
    try {
      const res: GetWorkspaceCaptureResponse = await client.getWorkspaceCapture(workspaceId, sessionId);
      if (generationRef.current !== generation) return;
      if (!res.available) {
        setCapture(null);
        setAvailable(false);
        setFileCount(0);
        return;
      }
      // Resolve the changed-file count immediately from the response's stats — the
      // default-tab signal must not wait on a >2MB manifest-URL hop.
      setFileCount(res.stats.fileCount);
      // Exactly one of manifest / manifestUrl is non-null (M2 contract). The inline
      // manifest is the <200ms common case; a >2MB manifest is a signed URL hop.
      let manifest = res.manifest;
      if (!manifest && res.manifestUrl) {
        const response = await fetch(res.manifestUrl.url);
        if (generationRef.current !== generation) return;
        if (!response.ok) throw new Error(`workspace capture manifest fetch failed: ${response.status}`);
        manifest = (await response.json()) as WorkspaceCaptureManifest;
        if (generationRef.current !== generation) return;
      }
      if (!manifest) {
        // available:true but neither manifest nor a working URL — degrade, never crash.
        setCapture(null);
        setAvailable(false);
        return;
      }
      setCapture(manifest);
      setAvailable(true);
      // Fold the served revision into the announced high-water mark so a capture we
      // JUST loaded is never reported stale against an older announce.
      setAnnouncedRevision((prev) => (prev === null || manifest.revision > prev ? manifest.revision : prev));
    } catch (cause) {
      if (generationRef.current !== generation) return;
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
  }, [client, workspaceId, sessionId]);

  // Mount fetch + reset on identity change.
  useEffect(() => {
    if (!enabled) {
      setCapture(null);
      setAvailable(false);
      setFileCount(null);
      setAnnouncedRevision(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  // Fold `workspace.revision.captured` announcements. A revision NEWER than the one
  // loaded bumps the announced high-water mark (→ isStale) and refreshes in the
  // background. The event is announce-only (metadata) — we still re-fetch the
  // manifest, since the payload carries no content.
  const events = options.events;
  const lastSeqRef = useRef(0);
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
      }
    }
    for (const event of events) if (event.sequence > lastSeqRef.current) lastSeqRef.current = event.sequence;
    if (newest === null) return;
    setAnnouncedRevision((prev) => (prev === null || newest > prev ? newest : prev));
  }, [enabled, events]);

  // A newer announced revision than the loaded manifest → refresh in the background.
  const loadedRevision = capture?.revision ?? null;
  useEffect(() => {
    if (!enabled) return;
    if (announcedRevision === null) return;
    if (loadedRevision !== null && announcedRevision <= loadedRevision) return;
    // A newer capture exists than the one we hold (or we hold none) — pull it.
    void refresh();
  }, [enabled, announcedRevision, loadedRevision, refresh]);

  const isStale = loadedRevision !== null && announcedRevision !== null && announcedRevision > loadedRevision;

  return {
    capture,
    revision: loadedRevision,
    capturedAt: capture?.capturedAt ?? null,
    available,
    fileCount,
    isStale,
    loading,
    error,
    refresh,
  };
}
