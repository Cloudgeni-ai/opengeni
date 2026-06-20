import type { FsReadResponse, FsTreeNode, GitFileStatusCode, SessionEvent } from "@opengeni/sdk";
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
};

export type UseSandboxFilesResult = {
  /** The tree roots (the listed root's children). */
  tree: FileTreeNode[];
  /** Lazy-expand a directory node in place (lists its immediate children). */
  expand: (path: string) => Promise<void>;
  /** Read a file for the preview pane (text or base64-for-binary, size-capped). */
  readFile: (path: string) => Promise<FsReadResponse>;
  /** Re-list the whole tree from the root. */
  refresh: () => Promise<void>;
  loading: boolean;
  error: Error | null;
};

function fsNodeToTree(node: FsTreeNode): FileTreeNode {
  const kind = node.type === "dir" ? "dir" : "file";
  return {
    path: node.path,
    name: node.name,
    kind,
    size: node.sizeBytes,
    ...(kind === "dir"
      ? { children: node.children ? node.children.map(fsNodeToTree) : undefined }
      : {}),
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
      try {
        const listed = await client.fsList(workspaceId, sessionId, { path, depth: 1 });
        const children = (listed.root.children ?? []).map(fsNodeToTree);
        setTree((prev) => applyStatus(replaceChildren(prev, path, children)));
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
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

  return { tree, expand, readFile, refresh, loading, error };
}
