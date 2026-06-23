import type { FsReadResponse, FsTreeNode, FsWriteResponse, GitFileStatusCode, SessionEvent } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

/** The git-status overlay a file row may carry (tints modified files in the tree). */
export type FileTreeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

/** A node in the Pierre file tree. `children === undefined` ⇒ an unexpanded dir
 *  (lazy treeMode); `children: []` ⇒ an expanded-but-empty dir. */
export type FileTreeNode = {
  path: string; // workspace-relative POSIX
  name: string;
  kind: "file" | "dir";
  children?: FileTreeNode[] | undefined;
  size?: number | null | undefined;
  status?: FileTreeStatus | undefined;
};

export type UseSandboxFilesOptions = ClientOverride & {
  /** Live event log (usually `useSessionEvents().events`) — drives auto-refresh
   *  on `fs.changed` / `git.changed`. */
  events?: SessionEvent[] | undefined;
  /** Initial path to list (workspace root by default). */
  rootPath?: string | undefined;
  /** Hold off the initial list (e.g. panel collapsed). Default true. */
  enabled?: boolean | undefined;
  /** The lease liveness ("cold" | "warm" | "draining"). The structured FileSystem
   *  capability is advertised even on a COLD box, so the mount-time list can race
   *  the box: it lists before the box is warm, gets an empty/errored result, and
   *  (with no `fs.changed` event) never re-lists. Passing liveness re-lists when
   *  the box first becomes warm, so the tree populates as soon as the box is up. */
  liveness?: string | undefined;
};

export type UseSandboxFilesResult = {
  /** The tree roots (the listed root's children). */
  tree: FileTreeNode[];
  /** Lazy-expand a directory node in place (lists its immediate children). */
  expand: (path: string) => Promise<void>;
  /** Paths whose lazy `fs.list` is currently in flight — the FileBrowser shows a
   *  spinner on these nodes so a 2-3s Channel-A list never looks frozen. */
  expandingPaths: Set<string>;
  /** Read a file for the preview pane (text or base64-for-binary, size-capped). */
  readFile: (path: string) => Promise<FsReadResponse>;
  /** Write a file (overwrite, last-writer-wins) — the editor save path. Re-lists
   *  the parent on return so a brand-new file appears even before fs.changed. */
  writeFile: (path: string, content: string) => Promise<FsWriteResponse>;
  /** Create a new empty file (refuses to clobber an existing path: overwrite=false). */
  createFile: (path: string) => Promise<void>;
  /** Create a directory (recursive by default). */
  createDir: (path: string) => Promise<void>;
  /** Delete a path (pass recursive=true for a non-empty directory). */
  deleteEntry: (path: string, recursive?: boolean) => Promise<void>;
  /** Move / rename a path (rename == move). Refuses to clobber unless overwrite=true. */
  moveEntry: (path: string, newPath: string, opts?: { overwrite?: boolean }) => Promise<void>;
  /** Re-list the whole tree from the root. */
  refresh: () => Promise<void>;
  loading: boolean;
  error: Error | null;
};

/** The workspace-relative parent directory of a POSIX path ("" for a root entry). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

function fsNodeToTree(node: FsTreeNode): FileTreeNode {
  const kind = node.type === "dir" ? "dir" : "file";
  // Lazy-tree contract: a depth-bounded `fsList` returns each directory at the
  // depth boundary with `children: []` (the dir is listed, but its grandchildren
  // are NOT). An empty array therefore means "not yet expanded", NOT "empty
  // directory" — so we must map it to `undefined` (the unexpanded marker the
  // FileBrowser keys lazy-expand on). If we kept `[]`, `toggle()`'s
  // `node.children === undefined` guard would never fire and clicking a folder
  // would do nothing (the reported bug). A directory we actually expand has its
  // children spliced in by `replaceChildren` (bypassing this mapper), so a
  // genuinely-empty dir correctly ends up as `[]` AFTER expansion.
  const mappedChildren =
    node.children && node.children.length > 0 ? node.children.map(fsNodeToTree) : undefined;
  return {
    path: node.path,
    name: node.name,
    kind,
    size: node.sizeBytes,
    ...(kind === "dir" ? { children: mappedChildren } : {}),
  };
}

const GIT_STATUS_TO_TREE: Partial<Record<GitFileStatusCode, FileTreeStatus>> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  copied: "added",
  untracked: "untracked",
  typechange: "modified",
};

/** Replace the children of `targetPath` within the tree (immutably). */
function replaceChildren(nodes: FileTreeNode[], targetPath: string, children: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children };
    }
    if (node.kind === "dir" && node.children && targetPath.startsWith(`${node.path}/`)) {
      return { ...node, children: replaceChildren(node.children, targetPath, children) };
    }
    return node;
  });
}

/**
 * Project the FileSystem service into a lazy-loaded Pierre tree. The initial
 * list pulls one level (depth 1); `expand(path)` lists a directory's immediate
 * children on demand (the fast lazy-tree UX). A git-status overlay tints
 * modified files. Auto-refreshes when an `fs.changed` / `git.changed` event
 * arrives on the live log.
 */
export function useSandboxFiles(
  sessionId: string | null | undefined,
  options: UseSandboxFilesOptions = {},
): UseSandboxFilesResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const rootPath = options.rootPath ?? "";

  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandingPaths, setExpandingPaths] = useState<Set<string>>(new Set());
  const [error, setError] = useState<Error | null>(null);
  const statusRef = useRef<Map<string, FileTreeStatus>>(new Map());

  const applyStatus = useCallback((nodes: FileTreeNode[]): FileTreeNode[] => {
    const overlay = statusRef.current;
    if (overlay.size === 0) return nodes;
    const walk = (list: FileTreeNode[]): FileTreeNode[] =>
      list.map((node) => {
        const status = overlay.get(node.path);
        const next = node.children ? { ...node, children: walk(node.children) } : { ...node };
        if (status && node.kind === "file") next.status = status;
        else delete next.status;
        return next;
      });
    return walk(nodes);
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      // Pull the git-status overlay first (best-effort — a non-repo box just
      // returns isRepo:false), then the tree, so the first paint is tinted.
      try {
        const status = await client.gitStatus(workspaceId, sessionId, { path: rootPath });
        const overlay = new Map<string, FileTreeStatus>();
        for (const file of status.files) {
          const code = file.worktree ?? file.index;
          const mapped = code ? GIT_STATUS_TO_TREE[code] : undefined;
          if (mapped) overlay.set(file.path, mapped);
        }
        statusRef.current = overlay;
      } catch {
        statusRef.current = new Map();
      }
      const listed = await client.fsList(workspaceId, sessionId, { path: rootPath, depth: 1 });
      const children = (listed.root.children ?? []).map(fsNodeToTree);
      setTree(applyStatus(children));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId, sessionId, rootPath, applyStatus]);

  const expand = useCallback(
    async (path: string) => {
      if (!sessionId) return;
      // Mark this node as expanding so the FileBrowser can render a spinner while
      // the (often 2-3s) Channel-A fs/list is in flight — the tree never looks
      // frozen on a click.
      setExpandingPaths((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      try {
        const listed = await client.fsList(workspaceId, sessionId, { path, depth: 1 });
        const children = (listed.root.children ?? []).map(fsNodeToTree);
        setTree((prev) => applyStatus(replaceChildren(prev, path, children)));
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        setExpandingPaths((prev) => {
          if (!prev.has(path)) return prev;
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    },
    [client, workspaceId, sessionId, applyStatus],
  );

  const readFile = useCallback(
    async (path: string) => {
      if (!sessionId) throw new Error("no session");
      return await client.fsRead(workspaceId, sessionId, { path });
    },
    [client, workspaceId, sessionId],
  );

  // Targeted re-list of a single directory after a mutation. The root ("") goes
  // through a full refresh (which also refreshes the git overlay); a nested dir
  // re-lists in place via the same depth-1 splice `expand` uses. This makes a
  // mutation reflect immediately even on no-event environments where the
  // fs.changed auto-refresh never fires (and is harmless where it does).
  const relistPath = useCallback(
    async (path: string) => {
      if (!sessionId) return;
      if (path === "" || path === rootPath) {
        await refresh();
        return;
      }
      try {
        const listed = await client.fsList(workspaceId, sessionId, { path, depth: 1 });
        const children = (listed.root.children ?? []).map(fsNodeToTree);
        setTree((prev) => applyStatus(replaceChildren(prev, path, children)));
      } catch {
        // The parent may not be mounted in the tree yet (collapsed) — fall back to
        // a root refresh rather than surfacing an error on an otherwise-OK mutation.
        await refresh();
      }
    },
    [client, workspaceId, sessionId, rootPath, applyStatus, refresh],
  );

  const writeFile = useCallback(
    async (path: string, content: string): Promise<FsWriteResponse> => {
      if (!sessionId) throw new Error("no session");
      try {
        const res = await client.fsWrite(workspaceId, sessionId, { path, content, overwrite: true });
        await relistPath(parentOf(path));
        return res;
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause));
        setError(err);
        throw err;
      }
    },
    [client, workspaceId, sessionId, relistPath],
  );

  const createFile = useCallback(
    async (path: string): Promise<void> => {
      if (!sessionId) throw new Error("no session");
      try {
        await client.fsWrite(workspaceId, sessionId, { path, content: "", overwrite: false });
        await relistPath(parentOf(path));
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause));
        setError(err);
        throw err;
      }
    },
    [client, workspaceId, sessionId, relistPath],
  );

  const createDir = useCallback(
    async (path: string): Promise<void> => {
      if (!sessionId) throw new Error("no session");
      try {
        await client.fsMkdir(workspaceId, sessionId, { path, recursive: true });
        await relistPath(parentOf(path));
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause));
        setError(err);
        throw err;
      }
    },
    [client, workspaceId, sessionId, relistPath],
  );

  const deleteEntry = useCallback(
    async (path: string, recursive = false): Promise<void> => {
      if (!sessionId) throw new Error("no session");
      try {
        await client.fsDelete(workspaceId, sessionId, { path, recursive });
        await relistPath(parentOf(path));
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause));
        setError(err);
        throw err;
      }
    },
    [client, workspaceId, sessionId, relistPath],
  );

  const moveEntry = useCallback(
    async (path: string, newPath: string, opts?: { overwrite?: boolean }): Promise<void> => {
      if (!sessionId) throw new Error("no session");
      try {
        await client.fsMove(workspaceId, sessionId, {
          path,
          newPath,
          overwrite: opts?.overwrite ?? false,
        });
        // A move touches two parents (source + destination); re-list both.
        const from = parentOf(path);
        const to = parentOf(newPath);
        await relistPath(from);
        if (to !== from) await relistPath(to);
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause));
        setError(err);
        throw err;
      }
    },
    [client, workspaceId, sessionId, relistPath],
  );

  // Initial load + reset on identity change.
  useEffect(() => {
    if (!enabled) {
      setTree([]);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  // Auto-refresh on fs/git change notifications.
  const events = options.events;
  const lastChangeRef = useRef(0);
  useEffect(() => {
    if (!enabled || !events) return;
    let latest = lastChangeRef.current;
    for (const event of events) {
      if ((event.type === "fs.changed" || event.type === "git.changed") && event.sequence > latest) {
        latest = event.sequence;
      }
    }
    if (latest > lastChangeRef.current) {
      lastChangeRef.current = latest;
      void refresh();
    }
  }, [enabled, events, refresh]);

  // Re-list when the box first becomes warm. The FileSystem capability is
  // advertised on a cold box too, so the mount-time `refresh()` can run before
  // the box is up (empty/errored result); without an `fs.changed` event the tree
  // would stay empty forever. A cold->warm transition re-lists once the box is
  // actually serving — the real fix for the "No files" the deployed app showed.
  const wasLiveRef = useRef(false);
  const liveness = options.liveness;
  useEffect(() => {
    const live = liveness === "warm" || liveness === "draining";
    if (enabled && live && !wasLiveRef.current) {
      wasLiveRef.current = true;
      void refresh();
    } else if (!live) {
      wasLiveRef.current = false;
    }
  }, [enabled, liveness, refresh]);

  return {
    tree,
    expand,
    expandingPaths,
    readFile,
    writeFile,
    createFile,
    createDir,
    deleteEntry,
    moveEntry,
    refresh,
    loading,
    error,
  };
}
