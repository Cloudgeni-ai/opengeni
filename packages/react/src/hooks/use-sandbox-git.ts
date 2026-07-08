import type {
  GitFileDiff,
  SessionEvent,
  WorkspaceCaptureManifest,
  WorkspaceCaptureRepo,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

export type UseSandboxGitOptions = ClientOverride & {
  /** Live event log (usually `useSessionEvents().events`) — drives auto-refresh
   *  on `git.changed`. */
  events?: SessionEvent[] | undefined;
  /** Repo root within the workspace (multi-repo). Default: workspace root. */
  repoPath?: string | undefined;
  /** Diff the staged index vs HEAD (`--cached`) instead of the working tree. */
  staged?: boolean | undefined;
  /** Hold off the initial fetch. Default true. */
  enabled?: boolean | undefined;
  /** Lease liveness ("warm" | "draining" | "cold"). When NOT warm, the diff is
   *  served from the capture (cold/offline) instead of a live `gitDiff` RPC. */
  liveness?: string | undefined;
  /** The latest turn-end capture (from `useWorkspaceCapture`). Supplies the cold
   *  diff for this repo. A warm box always wins (live `gitDiff` unchanged). */
  capture?: WorkspaceCaptureManifest | null | undefined;
};

export type UseSandboxGitResult = {
  /** Working-tree (or staged) diff vs HEAD — the structured hunks the Pierre
   *  diff view renders. */
  diff: GitFileDiff[];
  branch: string | null;
  /** Whether a repo is actually mounted (drives "no repository" vs "no changes"). */
  isRepo: boolean;
  ahead: number;
  behind: number;
  refresh: () => Promise<void>;
  /** Which source the diff is served from: the live box or the turn-end capture. */
  source: "live" | "capture" | null;
  /** When the served capture was taken (ISO), when `source === "capture"`. */
  capturedAt: string | null;
  loading: boolean;
  error: Error | null;
};

/** Normalize a repo root for matching ("" and "." both mean the workspace root). */
function normalizeRoot(root: string): string {
  return root === "." ? "" : root;
}

/** Find the capture repo matching `repoPath` (default workspace root). */
function repoForPath(
  manifest: WorkspaceCaptureManifest,
  repoPath: string,
): WorkspaceCaptureRepo | null {
  const want = normalizeRoot(repoPath);
  const exact = manifest.repos.find((r) => normalizeRoot(r.root) === want);
  if (exact) return exact;
  // Root-scoped hook against a single-repo capture whose root isn't literally "":
  // fall back to the sole repo so the common single-repo case just works.
  if (want === "" && manifest.repos.length === 1) return manifest.repos[0] ?? null;
  return null;
}

/** Merge a freshly-served diff over the current one, preserving the identity of
 *  unchanged per-file entries (same path/status/counts/hunk-count) so a cold→warm
 *  reconcile does NOT remount unchanged file sections — no-flicker (§12-D1). */
function mergeDiffs(current: GitFileDiff[], next: GitFileDiff[]): GitFileDiff[] {
  if (current.length === 0) return next;
  const byPath = new Map(current.map((d) => [d.path, d] as const));
  let changed = current.length !== next.length;
  const merged = next.map((file, index) => {
    const existing = byPath.get(file.path);
    if (
      existing &&
      existing.status === file.status &&
      existing.additions === file.additions &&
      existing.deletions === file.deletions &&
      existing.isBinary === file.isBinary &&
      existing.truncated === file.truncated &&
      existing.hunks.length === file.hunks.length
    ) {
      if (current[index] !== existing) changed = true;
      return existing;
    }
    changed = true;
    return file;
  });
  return changed ? merged : current;
}

/**
 * Project the Git service into the Pierre diff data contract: structured
 * `GitFileDiff[]` (per-file hunks with per-line old/new numbers, rename
 * detection, binary flag, add/del counts) plus branch + ahead/behind. When the
 * box is warm the `git diff` runs in-box (API-direct); when it is cold/offline the
 * diff is served from the turn-end capture instead (dossier §10.4). Refreshes on
 * `git.changed`; reconciles live in place on the cold→warm transition.
 */
export function useSandboxGit(
  sessionId: string | null | undefined,
  options: UseSandboxGitOptions = {},
): UseSandboxGitResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const repoPath = options.repoPath ?? "";
  const staged = options.staged ?? false;
  const capture = options.capture ?? null;
  const isLive = options.liveness === "warm" || options.liveness === "draining";

  const [diff, setDiff] = useState<GitFileDiff[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [isRepo, setIsRepo] = useState(false);
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [source, setSource] = useState<"live" | "capture" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const status = await client.gitStatus(workspaceId, sessionId, { path: repoPath });
      setIsRepo(status.isRepo);
      setBranch(status.head);
      setAhead(status.ahead);
      setBehind(status.behind);
      if (!status.isRepo) {
        setDiff([]);
        setSource("live");
        return;
      }
      const result = await client.gitDiff(workspaceId, sessionId, { path: repoPath, staged });
      // Merge in place so the cold→warm swap keeps unchanged file sections mounted.
      setDiff((prev) => mergeDiffs(prev, result.files));
      setSource("live");
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId, sessionId, repoPath, staged]);

  // Serve the diff from a capture (the cold/offline source). `staged` has no
  // meaning here: the capture records the combined turn-end change surface vs HEAD.
  const seedFromCapture = useCallback(
    (manifest: WorkspaceCaptureManifest) => {
      const repo = repoForPath(manifest, repoPath);
      if (!repo) {
        setIsRepo(false);
        setBranch(null);
        setAhead(0);
        setBehind(0);
        setDiff((prev) => (prev.length === 0 ? prev : []));
        setSource("capture");
        return;
      }
      setIsRepo(true);
      setBranch(repo.head);
      setAhead(repo.ahead);
      setBehind(repo.behind);
      setDiff((prev) => mergeDiffs(prev, repo.diff));
      setSource("capture");
      setError(null);
    },
    [repoPath],
  );

  // Source selection on mount / liveness / capture-revision change. Key on the
  // capture REVISION (a primitive), not the manifest object, so a fresh object per
  // render can't spin the effect; the latest manifest is read from a ref.
  const captureRef = useRef<WorkspaceCaptureManifest | null>(capture);
  captureRef.current = capture;
  const captureRevision = capture?.revision ?? null;
  useEffect(() => {
    if (!enabled) {
      setDiff([]);
      setIsRepo(false);
      setBranch(null);
      setSource(null);
      return;
    }
    if (isLive) {
      void refresh();
      return;
    }
    if (captureRevision !== null && captureRef.current) {
      seedFromCapture(captureRef.current);
      return;
    }
    void refresh();
  }, [enabled, isLive, captureRevision, refresh, seedFromCapture]);

  // git.changed → re-fetch the LIVE diff. A git.changed only originates from a
  // live box, so this both keeps warm sessions fresh and folds a cold box that
  // just came up (unchanged from the pre-capture behavior).
  const events = options.events;
  const lastChangeRef = useRef(0);
  useEffect(() => {
    if (!enabled || !events) return;
    let latest = lastChangeRef.current;
    for (const event of events) {
      if (event.type === "git.changed" && event.sequence > latest) {
        latest = event.sequence;
      }
    }
    if (latest > lastChangeRef.current) {
      lastChangeRef.current = latest;
      void refresh();
    }
  }, [enabled, events, refresh]);

  return {
    diff,
    branch,
    isRepo,
    ahead,
    behind,
    refresh,
    source,
    capturedAt: source === "capture" ? (capture?.capturedAt ?? null) : null,
    loading,
    error,
  };
}
