import type {
  GitFileDiff,
  SessionEvent,
  WorkspaceCaptureManifest,
  WorkspaceCaptureRepo,
} from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

export type UseSandboxGitOptions = ClientOverride & {
  /** Live event log (usually `useSessionEvents().events`) — drives auto-refresh
   *  on `git.changed`. */
  events?: SessionEvent[] | undefined;
  /** Repo root within the workspace (multi-repo). Default: workspace root. */
  repoPath?: string | undefined;
  /** All repository roots in the workspace. When supplied, status and diff are
   *  aggregated into one workspace-wide result and paths are workspace-relative. */
  repoPaths?: readonly string[] | undefined;
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

/** A Git diff qualified into workspace scope. `repoRoot` is present for the
 *  workspace-wide path and lets review UI group real repositories without
 *  guessing from the first path segment. */
export type SandboxGitFileDiff = GitFileDiff & { repoRoot?: string | undefined };

export type UseSandboxGitResult = {
  /** Working-tree (or staged) diff vs HEAD — the structured hunks the Pierre
   *  diff view renders. */
  diff: SandboxGitFileDiff[];
  branch: string | null;
  /** Whether a repo is actually mounted (drives "no repository" vs "no changes"). */
  isRepo: boolean;
  ahead: number;
  behind: number;
  /** Number and workspace-relative roots of repositories represented here. */
  repoCount: number;
  repoRoots: string[];
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
  const normalized = root
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

function qualifyPath(repoRoot: string, path: string): string {
  const root = normalizeRoot(repoRoot);
  return root ? `${root}/${path}` : path;
}

function qualifyDiff(repoRoot: string, file: GitFileDiff): SandboxGitFileDiff {
  const root = normalizeRoot(repoRoot);
  return {
    ...file,
    path: qualifyPath(root, file.path),
    oldPath: file.oldPath === null ? null : qualifyPath(root, file.oldPath),
    repoRoot: root,
  };
}

function uniqueRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map(normalizeRoot))].sort((a, b) => a.localeCompare(b));
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

/** Full diff equality for identity preservation. Hunk count/count summaries are
 *  not sufficient: an edit can replace text without changing either shape. */
function sameFileDiff(a: SandboxGitFileDiff, b: SandboxGitFileDiff): boolean {
  if (
    a.path !== b.path ||
    a.oldPath !== b.oldPath ||
    a.repoRoot !== b.repoRoot ||
    a.status !== b.status ||
    a.isBinary !== b.isBinary ||
    a.isImage !== b.isImage ||
    a.additions !== b.additions ||
    a.deletions !== b.deletions ||
    a.truncated !== b.truncated ||
    a.hunks.length !== b.hunks.length
  )
    return false;

  return a.hunks.every((hunk, hunkIndex) => {
    const other = b.hunks[hunkIndex];
    if (
      !other ||
      hunk.oldStart !== other.oldStart ||
      hunk.oldLines !== other.oldLines ||
      hunk.newStart !== other.newStart ||
      hunk.newLines !== other.newLines ||
      hunk.header !== other.header ||
      hunk.lines.length !== other.lines.length
    )
      return false;
    return hunk.lines.every((line, lineIndex) => {
      const otherLine = other.lines[lineIndex];
      return (
        otherLine !== undefined &&
        line.type === otherLine.type &&
        line.oldNo === otherLine.oldNo &&
        line.newNo === otherLine.newNo &&
        line.text === otherLine.text
      );
    });
  });
}

/** Merge a freshly-served diff over the current one, preserving the identity of
 *  genuinely unchanged per-file entries so a cold→warm reconcile does NOT
 *  remount unchanged file sections — no-flicker (§12-D1). */
function mergeDiffs(
  current: SandboxGitFileDiff[],
  next: SandboxGitFileDiff[],
): SandboxGitFileDiff[] {
  if (current.length === 0) return next;
  const byPath = new Map(current.map((d) => [d.path, d] as const));
  let changed = current.length !== next.length;
  const merged = next.map((file, index) => {
    const existing = byPath.get(file.path);
    if (existing && sameFileDiff(existing, file)) {
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
  const workspaceWide = options.repoPaths !== undefined;
  // Serialize the caller's array so inline values do not retrigger effects. An
  // explicitly empty advertised list falls back to the legacy repoPath probe.
  const repoPathsKey = uniqueRoots(
    options.repoPaths && options.repoPaths.length > 0 ? options.repoPaths : [repoPath],
  ).join("\u0000");
  const repoPaths = useMemo(() => repoPathsKey.split("\u0000"), [repoPathsKey]);
  const staged = options.staged ?? false;
  const capture = options.capture ?? null;
  const isLive = options.liveness === "warm" || options.liveness === "draining";
  const identityKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${repoPathsKey}\u0000${workspaceWide}\u0000${staged}`;

  const [diff, setDiff] = useState<SandboxGitFileDiff[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [isRepo, setIsRepo] = useState(false);
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [repoRoots, setRepoRoots] = useState<string[]>([]);
  const [source, setSource] = useState<"live" | "capture" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [stateIdentity, setStateIdentity] = useState(identityKey);
  // Live requests and event cursors are identity-scoped. The refs deliberately
  // survive renders, so they must be fenced/reset when that identity changes.
  const refreshGenerationRef = useRef(0);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const lastChangeRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    refreshAbortRef.current?.abort();
    const refreshAbort = new AbortController();
    refreshAbortRef.current = refreshAbort;
    const generation = (refreshGenerationRef.current += 1);
    setLoading(true);
    setError(null);
    try {
      const statuses = await Promise.all(
        repoPaths.map(async (root) => ({
          root,
          status: await client.gitStatus(
            workspaceId,
            sessionId,
            { path: root },
            { signal: refreshAbort.signal },
          ),
        })),
      );
      if (refreshGenerationRef.current !== generation) return;
      const repositories = statuses.filter(({ status }) => status.isRepo);
      const roots = repositories.map(({ root }) => root);
      setRepoRoots(roots);
      setIsRepo(repositories.length > 0);
      setBranch(repositories.length === 1 ? (repositories[0]?.status.head ?? null) : null);
      setAhead(repositories.reduce((sum, { status }) => sum + status.ahead, 0));
      setBehind(repositories.reduce((sum, { status }) => sum + status.behind, 0));
      if (repositories.length === 0) {
        setDiff([]);
        setSource("live");
        return;
      }
      const results = await Promise.all(
        repositories.map(async ({ root }) => ({
          root,
          result: await client.gitDiff(
            workspaceId,
            sessionId,
            {
              path: root,
              staged,
              includeUntracked: !staged,
            },
            { signal: refreshAbort.signal },
          ),
        })),
      );
      if (refreshGenerationRef.current !== generation) return;
      // Merge in place so the cold→warm swap keeps unchanged file sections mounted.
      setDiff((prev) =>
        mergeDiffs(
          prev,
          results.flatMap(({ root, result }) =>
            workspaceWide ? result.files.map((file) => qualifyDiff(root, file)) : result.files,
          ),
        ),
      );
      setSource("live");
    } catch (cause) {
      if (refreshGenerationRef.current !== generation) return;
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (refreshGenerationRef.current === generation) setLoading(false);
      if (refreshAbortRef.current === refreshAbort) refreshAbortRef.current = null;
    }
  }, [client, workspaceId, sessionId, repoPaths, staged, workspaceWide]);

  // Serve the diff from a capture (the cold/offline source). `staged` has no
  // meaning here: the capture records the combined turn-end change surface vs HEAD.
  const seedFromCapture = useCallback(
    (manifest: WorkspaceCaptureManifest) => {
      const repositories = workspaceWide
        ? manifest.repos
        : ([repoForPath(manifest, repoPath)].filter(Boolean) as WorkspaceCaptureRepo[]);
      if (repositories.length === 0) {
        setIsRepo(false);
        setBranch(null);
        setAhead(0);
        setBehind(0);
        setRepoRoots([]);
        setDiff((prev) => (prev.length === 0 ? prev : []));
        setSource("capture");
        return;
      }
      setIsRepo(true);
      setBranch(repositories.length === 1 ? (repositories[0]?.head ?? null) : null);
      setAhead(repositories.reduce((sum, repo) => sum + repo.ahead, 0));
      setBehind(repositories.reduce((sum, repo) => sum + repo.behind, 0));
      setRepoRoots(repositories.map((repo) => normalizeRoot(repo.root)));
      setDiff((prev) =>
        mergeDiffs(
          prev,
          repositories.flatMap((repo) =>
            workspaceWide ? repo.diff.map((file) => qualifyDiff(repo.root, file)) : repo.diff,
          ),
        ),
      );
      setSource("capture");
      setError(null);
    },
    [repoPath, workspaceWide],
  );

  // Source selection on mount / liveness / capture-revision change. Key on the
  // capture REVISION (a primitive), not the manifest object, so a fresh object per
  // render can't spin the effect; the latest manifest is read from a ref.
  const captureRef = useRef<WorkspaceCaptureManifest | null>(capture);
  captureRef.current = capture;
  const captureRevision = capture?.revision ?? null;
  const previousIdentityRef = useRef(identityKey);
  useEffect(() => {
    // A liveness/capture source change supersedes any older live request. Only a
    // true data-identity change clears rendered state and the event high-water mark.
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = null;
    refreshGenerationRef.current += 1;
    const identityChanged = previousIdentityRef.current !== identityKey;
    previousIdentityRef.current = identityKey;
    if (identityChanged || !enabled) {
      lastChangeRef.current = 0;
      setDiff([]);
      setStateIdentity(identityKey);
      setIsRepo(false);
      setBranch(null);
      setAhead(0);
      setBehind(0);
      setRepoRoots([]);
      setSource(null);
      setLoading(false);
      setError(null);
    }
    if (!enabled) {
      return;
    }
    if (isLive) {
      void refresh();
    } else if (captureRevision !== null && captureRef.current) {
      seedFromCapture(captureRef.current);
    } else {
      void refresh();
    }
    return () => {
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
      refreshGenerationRef.current += 1;
    };
  }, [enabled, isLive, captureRevision, identityKey, refresh, seedFromCapture]);

  // git.changed → re-fetch the LIVE diff. A git.changed only originates from a
  // live box, so this both keeps warm sessions fresh and folds a cold box that
  // just came up (unchanged from the pre-capture behavior).
  const events = options.events;
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

  const identityMatches = enabled && stateIdentity === identityKey;
  const visibleRepoRoots = identityMatches ? repoRoots : [];
  return {
    diff: identityMatches ? diff : [],
    branch: identityMatches ? branch : null,
    isRepo: identityMatches && isRepo,
    ahead: identityMatches ? ahead : 0,
    behind: identityMatches ? behind : 0,
    repoCount: visibleRepoRoots.length,
    repoRoots: visibleRepoRoots,
    refresh,
    source: identityMatches ? source : null,
    capturedAt: identityMatches && source === "capture" ? (capture?.capturedAt ?? null) : null,
    loading: identityMatches && loading,
    error: identityMatches ? error : null,
  };
}
