import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

/**
 * The wake-on-edit state machine (dossier §3 #5 / §10.4 / §12-C). M3 OWNS this
 * logic; M5 renders it. States are explicit and exhaustive:
 *
 *   viewing-cold      — cold snapshot open, no local edits (editable, cloud).
 *   buffering         — local edits buffered; the box is not warm and no warm is
 *                       yet in flight (the host has not attached).
 *   warming           — edits buffered; the box is actively coming up (the host
 *                       attached a viewer in response to `wantsWarm`).
 *   flushing          — the box is warm; the guarded write is in flight.
 *   flushed           — the buffer was written to the live box.
 *   conflict          — the live file diverged from the captured base between
 *                       capture and flush; NO write was issued (C2).
 *   readonly-offline  — a self-hosted machine that is offline; read-only, no wake.
 */
export type WorkspaceEditState =
  | "viewing-cold"
  | "buffering"
  | "warming"
  | "flushing"
  | "flushed"
  | "conflict"
  | "readonly-offline";

export type WorkspaceEditConflict = {
  path: string;
  /** The capture-served content the edit was based on. */
  base: string;
  /** The live content found on the box at flush time (what would be overwritten). */
  live: string;
};

export type UseWorkspaceEditOptions = ClientOverride & {
  /** The file being edited (workspace-relative). null disables the machine. */
  path?: string | null | undefined;
  /** The capture-served content loaded into the editor — the flush base (C2). */
  baseContent?: string | null | undefined;
  /** `capabilities.liveness` — "warm" | "draining" | "cold". Drives the flush. */
  liveness?: string | undefined;
  /** True while the host is actively warming the box (attach in flight, not warm
   *  yet) — lifts `buffering` → `warming`. The host sets this after acting on
   *  `wantsWarm` (e.g. flipping `attachFiles` on `useSessionCapabilities`). */
  warming?: boolean | undefined;
  /** A self-hosted machine that is OFFLINE: read-only, no remote wake possible. */
  offline?: boolean | undefined;
  /** Called once when the first cold edit needs the box warmed — the host wires
   *  this to its liveness primitive (flip `attachFiles`/`attachViewer`). */
  onWarmRequested?: (() => void) | undefined;
};

export type UseWorkspaceEditResult = {
  state: WorkspaceEditState;
  /** The editor should be read-only (self-hosted offline). */
  readOnly: boolean;
  /** The current buffered content (null = no local edit yet). */
  buffer: string | null;
  /** The host should warm the box (flip its attach primitive). Latches true from
   *  the first cold edit until the buffer flushes or is discarded. */
  wantsWarm: boolean;
  /** Record an edit from the editor (idempotent per identical content). */
  edit: (content: string) => void;
  /** The conflict detail when `state === "conflict"`. */
  conflict: WorkspaceEditConflict | null;
  /** Flush the buffer regardless of the base guard (the user chose "overwrite"
   *  from the conflict bar). Writes last-writer-wins. */
  overwrite: () => Promise<void>;
  /** Drop the local buffer and return to viewing the snapshot. */
  discard: () => void;
  error: Error | null;
};

function isLive(liveness: string | undefined): boolean {
  return liveness === "warm" || liveness === "draining";
}

/**
 * Cold-editing without a spinner: the editor opens instantly from the capture,
 * the first keystroke buffers locally AND signals the host to warm the box, and on
 * warm the buffer flushes IF the live file still matches the captured base — else a
 * non-blocking conflict is surfaced and nothing is overwritten (dossier §12-C2).
 *
 * The base guard compares the live content at flush time against `baseContent`
 * (the exact bytes the editor loaded). This is equivalent to the sha256 compare
 * the dossier describes — M1 leaves `baseHash` null, so the loaded content IS the
 * authoritative base — and avoids async Web Crypto in the render path.
 */
export function useWorkspaceEdit(
  sessionId: string | null | undefined,
  options: UseWorkspaceEditOptions = {},
): UseWorkspaceEditResult {
  const { client, workspaceId } = useOpenGeni(options);
  const path = options.path ?? null;
  const baseContent = options.baseContent ?? null;
  const live = isLive(options.liveness);
  const offline = options.offline === true;
  const identityKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${path ?? ""}`;

  const [buffer, setBuffer] = useState<string | null>(null);
  const [wantsWarm, setWantsWarm] = useState(false);
  const [flush, setFlush] = useState<"idle" | "flushing" | "flushed" | "conflict">("idle");
  const [conflict, setConflict] = useState<WorkspaceEditConflict | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [stateIdentity, setStateIdentity] = useState(identityKey);

  const onWarmRequested = options.onWarmRequested;
  const bufferRef = useRef<string | null>(null);
  bufferRef.current = buffer;
  // Guards a single in-flight flush against re-entry (liveness can re-render).
  const flushingRef = useRef(false);
  const identityGenerationRef = useRef(0);
  const flushAttemptRef = useRef(0);
  const readAbortRef = useRef<AbortController | null>(null);

  // Reset the machine when the edited file (or session) changes.
  useEffect(() => {
    identityGenerationRef.current += 1;
    flushAttemptRef.current += 1;
    readAbortRef.current?.abort();
    readAbortRef.current = null;
    setStateIdentity(identityKey);
    setBuffer(null);
    setWantsWarm(false);
    setFlush("idle");
    setConflict(null);
    setError(null);
    flushingRef.current = false;
    return () => {
      identityGenerationRef.current += 1;
      flushAttemptRef.current += 1;
      readAbortRef.current?.abort();
      readAbortRef.current = null;
    };
  }, [identityKey]);

  const edit = useCallback(
    (content: string) => {
      if (stateIdentity !== identityKey) return;
      if (offline) return; // read-only — no buffering, no wake.
      setBuffer((prev) => (prev === content ? prev : content));
      // Any new edit invalidates a prior flushed/conflict resolution.
      setFlush((prev) => (prev === "flushing" ? prev : "idle"));
      setConflict(null);
      if (!live) {
        // First cold edit signals the host to warm the box (once).
        setWantsWarm((prev) => {
          if (!prev) onWarmRequested?.();
          return true;
        });
      }
    },
    [offline, live, onWarmRequested, stateIdentity, identityKey],
  );

  const doFlush = useCallback(
    async (force: boolean) => {
      if (stateIdentity !== identityKey) return;
      if (!sessionId || !path) return;
      const content = bufferRef.current;
      if (content === null) return;
      if (flushingRef.current) return;
      const identityGeneration = identityGenerationRef.current;
      const flushAttempt = (flushAttemptRef.current += 1);
      flushingRef.current = true;
      setFlush("flushing");
      setError(null);
      try {
        if (!force) {
          // Base guard: re-read the live file and compare to the captured base. A
          // divergence means the box changed under us — surface a conflict, write
          // NOTHING (C2).
          const readAbort = new AbortController();
          readAbortRef.current?.abort();
          readAbortRef.current = readAbort;
          const liveRead = await client.fsRead(
            workspaceId,
            sessionId,
            { path },
            { signal: readAbort.signal },
          );
          if (readAbortRef.current === readAbort) readAbortRef.current = null;
          if (identityGenerationRef.current !== identityGeneration) return;
          const liveContent = liveRead.content;
          if (baseContent !== null && liveContent !== baseContent) {
            setConflict({ path, base: baseContent, live: liveContent });
            setFlush("conflict");
            return;
          }
        }
        await client.fsWrite(workspaceId, sessionId, { path, content, overwrite: true });
        if (identityGenerationRef.current !== identityGeneration) return;
        setConflict(null);
        setFlush("flushed");
        setWantsWarm(false);
      } catch (cause) {
        if (identityGenerationRef.current !== identityGeneration) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        // Leave the buffer intact so the user can retry; fall back to buffering.
        setFlush("idle");
      } finally {
        if (flushAttemptRef.current === flushAttempt) {
          flushingRef.current = false;
          readAbortRef.current = null;
        }
      }
    },
    [client, workspaceId, sessionId, path, baseContent, stateIdentity, identityKey],
  );

  // Auto-flush once the box is warm and a buffer is pending (the wake completed).
  useEffect(() => {
    if (offline) return;
    if (!live) return;
    if (buffer === null) return;
    if (flush === "flushed" || flush === "conflict" || flush === "flushing") return;
    void doFlush(false);
  }, [offline, live, buffer, flush, doFlush]);

  const overwrite = useCallback(async () => {
    await doFlush(true);
  }, [doFlush]);

  const discard = useCallback(() => {
    setBuffer(null);
    setWantsWarm(false);
    setFlush("idle");
    setConflict(null);
    setError(null);
  }, []);

  // Derive the exhaustive public state.
  let state: WorkspaceEditState;
  if (offline) {
    state = "readonly-offline";
  } else if (flush === "flushing") {
    state = "flushing";
  } else if (flush === "flushed") {
    state = "flushed";
  } else if (flush === "conflict") {
    state = "conflict";
  } else if (buffer === null) {
    state = "viewing-cold";
  } else if (live) {
    // Warm with a pending buffer that hasn't entered flush yet — a transient tick
    // before the auto-flush effect runs.
    state = "flushing";
  } else if (options.warming === true) {
    state = "warming";
  } else {
    state = "buffering";
  }

  const identityMatches = stateIdentity === identityKey;
  return {
    state: identityMatches ? state : offline ? "readonly-offline" : "viewing-cold",
    readOnly: offline,
    buffer: identityMatches ? buffer : null,
    wantsWarm: identityMatches && wantsWarm,
    edit,
    conflict: identityMatches ? conflict : null,
    overwrite,
    discard,
    error: identityMatches ? error : null,
  };
}
