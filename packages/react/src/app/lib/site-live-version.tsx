import type {
  SessionEvent,
  WorkspaceArtifact,
  WorkspaceArtifactCurrentResponse,
  WorkspaceArtifactDetailResponse,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

/** How often an open Site view checks for versions published elsewhere. */
export const SITE_VERSION_POLL_MS = 5_000;

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
 * checked when asked (a publish or restore from beside it), every few seconds
 * while the page is visible (versions published from anywhere else), and
 * when the page comes back into view or the network returns. A check reads
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
    read.current = () => void run();
    void run();
    const visible = () => document.visibilityState !== "hidden";
    const timer = window.setInterval(() => {
      if (visible() && !gone) void run();
    }, SITE_VERSION_POLL_MS);
    const onVisible = () => {
      if (visible()) void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      abort.abort();
      read.current = () => {};
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [attempt, client, siteId, workspaceId]);
  const check = useCallback(() => read.current(), []);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { detail, failed, watch, check, retry };
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
