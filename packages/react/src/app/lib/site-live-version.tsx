import type {
  SessionEvent,
  WorkspaceArtifact,
  WorkspaceArtifactCurrentResponse,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactLiveTicketResponse,
} from "@opengeni/sdk";
import type { OpenGeniSiteDataChange } from "@opengeni/sdk/site";
import { useCallback, useEffect, useRef, useState } from "react";

/** How soon an open Site view first checks for versions published elsewhere. */
export const SITE_VERSION_POLL_MS = 5_000;
/** Unchanged checks back off up to this. */
export const SITE_VERSION_POLL_MAX_MS = 60_000;
/** While the live connection is up, checks are only a fallback. */
export const SITE_VERSION_LIVE_POLL_MS = 300_000;

type SiteDetailClient = {
  getWorkspaceArtifact: (
    workspaceId: string,
    artifactId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<WorkspaceArtifactDetailResponse>;
  /** The cheap check; without it (or on a server without it) each check reads the history. */
  getWorkspaceArtifactCurrent?: (
    workspaceId: string,
    artifactId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<WorkspaceArtifactCurrentResponse>;
  /** Live hints (new versions, data changes); without it (or a 404) checks stay timed. */
  createWorkspaceArtifactLiveTicket?: (
    workspaceId: string,
    artifactId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<WorkspaceArtifactLiveTicketResponse>;
};

export type SiteLiveVersion = {
  /** The Site as last read; null until the first read succeeds. */
  detail: WorkspaceArtifactDetailResponse | null;
  /** The first read failed; nothing is known about the Site yet. */
  failed: boolean;
  /** Whether checks for new versions are working (`reconnecting` after one failed). */
  watch: "live" | "reconnecting";
  /** Check now, for example after a publish or a restore. Overlapping asks share one read. */
  check: () => void;
  /** Read again from the start after the first read failed. */
  retry: () => void;
  /**
   * Follow the Site's data change hints (for its frame). Stable across
   * renders; returns an unsubscribe.
   */
  subscribeDataChanges: (listener: (change: OpenGeniSiteDataChange) => void) => () => void;
};

/** What a check compares: a change means the history is read again. */
function headSignature(artifact: WorkspaceArtifact): string {
  return JSON.stringify([
    artifact.title,
    artifact.status,
    artifact.currentVersion?.id ?? null,
    artifact.updatedAt,
  ]);
}

/** What a re-read can change on screen; an identical read re-renders nothing. */
function signature(detail: WorkspaceArtifactDetailResponse): string {
  const { artifact } = detail;
  return JSON.stringify([
    artifact.title,
    artifact.status,
    artifact.currentVersion?.id ?? null,
    detail.versions.map((version) => version.id),
    detail.events.map((event) => event.id),
  ]);
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * The Site's current version, kept current while its Site view is open:
 * checked when asked (a publish or restore from beside it), when the live
 * connection says a new version is live, on a timer while the page is
 * visible (every few seconds at first, backing off while nothing changes,
 * and only every few minutes while the live connection is up), and when the
 * page comes back into view or the network returns. Hidden pages make no
 * timed checks. A check reads
 * only the Site and its current version; the history is read again only when
 * that changed. A Site that is gone (deleted, or no longer shared) stops the
 * timed checks; coming back to the page checks once more.
 */
export function useSiteLiveVersion(
  client: SiteDetailClient,
  workspaceId: string,
  siteId: string,
): SiteLiveVersion {
  const [detail, setDetail] = useState<WorkspaceArtifactDetailResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [watch, setWatch] = useState<"live" | "reconnecting">("live");
  const [attempt, setAttempt] = useState(0);
  const read = useRef<() => void>(() => {});
  const dataListeners = useRef(new Set<(change: OpenGeniSiteDataChange) => void>());
  useEffect(() => {
    const abort = new AbortController();
    let inFlight = false;
    let again = false;
    let shown: string | null = null;
    let head: string | null = null;
    // An older server without the cheap check answers it 404 or 405.
    let cheap = typeof client.getWorkspaceArtifactCurrent === "function";
    let gone = false;
    setDetail(null);
    setFailed(false);
    setWatch("live");
    const readDetail = async () => {
      const next = await client.getWorkspaceArtifact(workspaceId, siteId, {
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      head = headSignature(next.artifact);
      const nextSignature = signature(next);
      if (nextSignature !== shown) {
        shown = nextSignature;
        setDetail(next);
      }
    };
    const changed = async (): Promise<boolean> => {
      if (!cheap || head === null || !client.getWorkspaceArtifactCurrent) return true;
      try {
        const current = await client.getWorkspaceArtifactCurrent(workspaceId, siteId, {
          signal: abort.signal,
        });
        return headSignature(current.artifact) !== head;
      } catch (error) {
        const status = errorStatus(error);
        if (status !== 404 && status !== 405) throw error;
        // Unsupported, or the Site is gone: the full read tells which.
        cheap = false;
        return true;
      }
    };
    const run = async () => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        do {
          again = false;
          try {
            if (await changed()) await readDetail();
            if (abort.signal.aborted) return;
            gone = false;
            setFailed(false);
            setWatch("live");
          } catch (error) {
            if (abort.signal.aborted) return;
            const status = errorStatus(error);
            gone = status === 403 || status === 404;
            if (shown === null) setFailed(true);
            else setWatch("reconnecting");
          }
        } while (again && !abort.signal.aborted);
      } finally {
        inFlight = false;
      }
    };
    const visible = () => document.visibilityState !== "hidden";
    let delay = SITE_VERSION_POLL_MS;
    let timer: number | null = null;
    let liveUp = false;
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (abort.signal.aborted || gone || !visible()) return;
      timer = window.setTimeout(
        () => {
          timer = null;
          void check(true);
        },
        liveUp ? SITE_VERSION_LIVE_POLL_MS : delay,
      );
    };
    const check = async (timed: boolean) => {
      const before = head;
      await run();
      if (abort.signal.aborted) return;
      // Unchanged timed checks back off; any change starts over.
      delay =
        timed && head === before
          ? Math.min(SITE_VERSION_POLL_MAX_MS, delay * 2)
          : SITE_VERSION_POLL_MS;
      schedule();
    };
    read.current = () => void check(false);
    void check(false);
    const onVisible = () => {
      if (!visible()) {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        return;
      }
      delay = SITE_VERSION_POLL_MS;
      void check(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    window.addEventListener("focus", onVisible);
    const stopLive = followSiteLive(client, workspaceId, siteId, abort.signal, {
      up: (value) => {
        liveUp = value;
        schedule();
      },
      version: () => read.current(),
      data: (change) => {
        for (const listener of dataListeners.current) {
          try {
            listener(change);
          } catch {
            // One listener failing does not stop the others.
          }
        }
      },
    });
    return () => {
      abort.abort();
      stopLive();
      read.current = () => {};
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [attempt, client, siteId, workspaceId]);
  const check = useCallback(() => read.current(), []);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const subscribeDataChanges = useCallback((listener: (change: OpenGeniSiteDataChange) => void) => {
    dataListeners.current.add(listener);
    return () => {
      dataListeners.current.delete(listener);
    };
  }, []);
  return { detail, failed, watch, check, retry, subscribeDataChanges };
}

type SiteLiveHandlers = {
  up: (live: boolean) => void;
  version: () => void;
  data: (change: OpenGeniSiteDataChange) => void;
};

/**
 * The console's live connection for one Site: a short-lived ticket, then a
 * WebSocket with hints only. Reconnects with backoff, and before its
 * admission ends; a deployment without live hints (404) is not asked again.
 * After a reconnect that missed data changes, the frame hears "anything may
 * have changed".
 */
function followSiteLive(
  client: SiteDetailClient,
  workspaceId: string,
  siteId: string,
  signal: AbortSignal,
  handlers: SiteLiveHandlers,
): () => void {
  const createTicket = client.createWorkspaceArtifactLiveTicket;
  if (!createTicket || typeof WebSocket !== "function") return () => {};
  let socket: WebSocket | null = null;
  let timer: number | null = null;
  let failures = 0;
  let lastSeq: number | null = null;
  const later = (ms: number) => {
    if (signal.aborted) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(
      () => {
        timer = null;
        void open();
      },
      ms * (0.75 + Math.random() * 0.5),
    );
  };
  const retryLater = () => {
    failures += 1;
    later(Math.min(600_000, 5_000 * 2 ** Math.min(failures, 7)));
  };
  const visible = () => document.visibilityState !== "hidden";
  let opening = false;
  let unsupported = false;
  let socketFailures = 0;
  const open = async () => {
    if (signal.aborted || opening || socket || !visible()) return;
    opening = true;
    let ticket: WorkspaceArtifactLiveTicketResponse;
    try {
      ticket = await createTicket.call(client, workspaceId, siteId, { signal });
    } catch (error) {
      // No live hints here (or the Site is gone): timed checks carry on.
      const status = errorStatus(error);
      if (signal.aborted) return;
      if (status === 404 || status === 403 || status === 405) {
        unsupported = true;
        return;
      }
      retryLater();
      return;
    } finally {
      opening = false;
    }
    if (signal.aborted || !visible()) return;
    let current: WebSocket;
    try {
      current = new WebSocket(ticket.url);
    } catch {
      retryLater();
      return;
    }
    socket = current;
    let admitted = false;
    let planned = false;
    let refresh: number | null = null;
    current.addEventListener("message", (event) => {
      let hint: { type?: unknown; seq?: unknown; collections?: unknown; ttlSeconds?: unknown };
      try {
        hint = JSON.parse(String(event.data)) as typeof hint;
      } catch {
        return;
      }
      const seq = typeof hint.seq === "number" ? hint.seq : null;
      if (hint.type === "hello") {
        admitted = true;
        failures = 0;
        socketFailures = 0;
        handlers.up(true);
        if (lastSeq !== null && seq !== null && seq > lastSeq) {
          handlers.data({ collections: null, seq });
          // A version may also have gone live while disconnected.
          handlers.version();
        }
        if (seq !== null) lastSeq = Math.max(lastSeq ?? 0, seq);
        const ttl = typeof hint.ttlSeconds === "number" ? hint.ttlSeconds : 900;
        if (refresh !== null) window.clearTimeout(refresh);
        refresh = window.setTimeout(
          () => {
            planned = true;
            current.close(1000);
          },
          Math.max(30, ttl - 30) * 1000,
        );
      } else if (hint.type === "data") {
        // Notices can arrive out of order: always pass them on.
        if (seq !== null) lastSeq = Math.max(lastSeq ?? 0, seq);
        const collections = Array.isArray(hint.collections)
          ? hint.collections.filter((name): name is string => typeof name === "string")
          : null;
        handlers.data({ collections, seq });
      } else if (hint.type === "version") {
        handlers.version();
      }
    });
    current.addEventListener("close", () => {
      if (refresh !== null) window.clearTimeout(refresh);
      if (socket === current) socket = null;
      if (signal.aborted) return;
      handlers.up(false);
      if (!visible()) return;
      // A planned refresh comes back at once; a dropped connection (a gateway
      // deploy drops them all) spreads its return over 30 seconds.
      if (planned) later(1_000);
      else if (admitted) later(1_000 + Math.random() * 29_000);
      else if (++socketFailures >= 5) {
        // The live route refuses every connection here (for example a
        // gateway without live hints): stop asking for tickets.
        unsupported = true;
      } else retryLater();
    });
  };
  // A page left in the background lets the connection go; coming back
  // reconnects (and its hello says whether anything was missed).
  let hiding: number | null = null;
  const onVisibility = () => {
    if (visible()) {
      if (hiding !== null) window.clearTimeout(hiding);
      hiding = null;
      if (!socket && timer === null && !opening && !unsupported) void open();
      return;
    }
    hiding ??= window.setTimeout(() => {
      hiding = null;
      const current = socket;
      socket = null;
      current?.close(1000);
    }, 30_000);
  };
  document.addEventListener("visibilitychange", onVisibility);
  void open();
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    if (hiding !== null) window.clearTimeout(hiding);
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    const current = socket;
    socket = null;
    try {
      current?.close(1000);
    } catch {
      // Already closed.
    }
  };
}

/**
 * Whether an event in the Site's conversation may have changed the Site: a
 * tool call returning (publishing, restoring, or a shell command that did
 * either) or the turn ending. Cheaper to check than to parse tool output.
 */
export function siteMayHaveChanged(event: Pick<SessionEvent, "type">): boolean {
  return (
    event.type === "agent.toolCall.output" ||
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled"
  );
}
