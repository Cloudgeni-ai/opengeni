import type { GitFileDiff, SessionEvent } from "@opengeni/sdk";
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
  loading: boolean;
  error: Error | null;
};

/**
 * Project the Git service into the Pierre diff data contract: structured
 * `GitFileDiff[]` (per-file hunks with per-line old/new numbers, rename
 * detection, binary flag, add/del counts) plus branch + ahead/behind. The
 * `git diff` runs in-box (API-direct) and the hunks come back inline. Refreshes
 * on `git.changed`.
 */
export function useSandboxGit(
  sessionId: string | null | undefined,
  options: UseSandboxGitOptions = {},
): UseSandboxGitResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const repoPath = options.repoPath ?? "";
  const staged = options.staged ?? false;

  const [diff, setDiff] = useState<GitFileDiff[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [isRepo, setIsRepo] = useState(false);
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
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
        return;
      }
      const result = await client.gitDiff(workspaceId, sessionId, { path: repoPath, staged });
      setDiff(result.files);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId, sessionId, repoPath, staged]);

  useEffect(() => {
    if (!enabled) {
      setDiff([]);
      setIsRepo(false);
      setBranch(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

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

  return { diff, branch, isRepo, ahead, behind, refresh, loading, error };
}
