import type {
  FsChangedPayload,
  FsReadResponse,
  FsTreeNode,
  FsWriteResponse,
  GitChangedPayload,
  GitFileStatusCode,
  OpenGeniRequestOptions,
  SessionEvent,
  WorkspaceCaptureManifest,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

/** The git-status overlay a file row may carry (tints modified files in the tree). */
export type FileTreeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export type CapturedFileUnavailableReason = "not-captured" | "too-large" | "content-missing";

/** A cold capture can index a path without retaining its contents. Components
 *  use this typed result to offer an explicit wake action instead of silently
 *  turning passive review into a live sandbox read. */
export class CapturedFileUnavailableError extends Error {
  readonly code = "captured_file_unavailable";

  constructor(
    readonly path: string,
    readonly reason: CapturedFileUnavailableReason,
  ) {
    super(
      reason === "too-large"
        ? `${path} exceeds the captured preview limit.`
        : reason === "content-missing"
          ? `${path} is no longer available in this capture.`
          : `${path} was not changed in this captured turn.`,
    );
    this.name = "CapturedFileUnavailableError";
  }
}

export class FileWriteConflictError extends Error {
  readonly code = "file_write_conflict";

  constructor(
    readonly path: string,
    readonly expectedContent: string,
    readonly liveContent: string,
  ) {
    super(`${path} changed on the machine. Reload it or explicitly overwrite the live version.`);
    this.name = "FileWriteConflictError";
  }
}

export type SandboxWriteFileOptions = {
  /** Exact text loaded into the editor. The live file is re-read before write;
   *  divergence fails closed with FileWriteConflictError. */
  expectedContent?: string | undefined;
  /** Deliberately bypass the expected-content guard after a visible conflict. */
  force?: boolean | undefined;
};

/** A node in the Pierre file tree. `children === undefined` ⇒ an unexpanded dir
 *  (lazy treeMode); `children: []` ⇒ an expanded-but-empty dir. */
export type FileTreeNode = {
  path: string; // workspace-relative POSIX
  name: string;
  kind: "file" | "dir";
  children?: FileTreeNode[] | undefined;
  size?: number | null | undefined;
  status?: FileTreeStatus | undefined;
  /** A residue dir the capture COLLAPSED (node_modules, .git, dist, …): its
   *  contents were never indexed. Cold, expanding it can't list children — the
   *  UI shows an inline "contents on machine" row until the box is warm. */
  truncated?: boolean | undefined;
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
  /** The latest turn-end workspace capture (from `useWorkspaceCapture`). When the
   *  box is NOT warm, the tree paints INSTANTLY from this capture's tree index (the
   *  <200ms cold first paint) instead of blocking on a Channel-A list. A warm box
   *  always wins (live path unchanged). On the cold→warm transition the live list
   *  is merged in place — no remount, no flash (dossier §10.4 / §12-A1/D1). */
  capture?: WorkspaceCaptureManifest | null | undefined;
  /** Called when an OPTIMISTIC mutation is reverted because its background
   *  Channel-A op failed (e.g. a 409 rename collision). The host wires this to a
   *  toast — the tree silently rolls the node back, the user sees why. */
  onMutationError?: ((error: Error, op: string) => void) | undefined;
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
  readFile: (path: string, options?: OpenGeniRequestOptions) => Promise<FsReadResponse>;
  /** Write a file (overwrite, last-writer-wins) — the editor save path.
   *  Optimistic: a brand-new file is spliced into the tree immediately and the
   *  Channel-A write runs in the background; on failure the splice is reverted. */
  writeFile: (
    path: string,
    content: string,
    options?: SandboxWriteFileOptions,
  ) => Promise<FsWriteResponse>;
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
  /** Which source the tree is currently served from: the live box, the turn-end
   *  capture (cold/offline), or neither yet. M5's source badge reads this. */
  source: "live" | "capture" | null;
  /** When the served capture was taken (ISO), when `source === "capture"`. */
  capturedAt: string | null;
  loading: boolean;
  error: Error | null;
};

/** The workspace-relative parent directory of a POSIX path ("" for a root entry). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

/** The leaf name of a POSIX path. */
function leafOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Join a parent dir with a leaf name (handles the root "" parent). */
/** Stable sibling ordering: dirs before files, then case-insensitive by name —
 *  matches a typical depth-1 list so an optimistic insert lands where a real
 *  re-list would put it (no jump when the server reconciles). */
function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function fsNodeToTree(node: FsTreeNode, captureComplete = false): FileTreeNode {
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
    node.children && node.children.length > 0
      ? node.children.map((child) => fsNodeToTree(child, captureComplete))
      : captureComplete && kind === "dir"
        ? []
        : undefined;
  return {
    path: node.path,
    name: node.name,
    kind,
    size: node.sizeBytes,
    ...(kind === "dir" ? { children: mappedChildren } : {}),
    // A collapsed residue dir from the capture index — carried through so the
    // tree can show an inline "contents on machine" row cold instead of nothing.
    ...(kind === "dir" && node.truncated ? { truncated: true } : {}),
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
function replaceChildren(
  nodes: FileTreeNode[],
  targetPath: string,
  children: FileTreeNode[],
): FileTreeNode[] {
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

/** Find a node by exact path (depth-first). */
function findNodeByPath(nodes: FileTreeNode[], path: string): FileTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.kind === "dir" && node.children && path.startsWith(`${node.path}/`)) {
      const hit = findNodeByPath(node.children, path);
      if (hit) return hit;
    }
  }
  return undefined;
}

// ── In-place (optimistic) tree mutations ────────────────────────────────────
// The Pierre mutation-handle analogue. These splice a single node in/out/across
// the immutable tree, PRESERVING every other node's `children` (and therefore the
// FileBrowser's expansion + selection). The old data flow re-listed the whole
// root and `setTree(rootChildren)` — that dropped every expanded dir back to the
// unexpanded marker, which is exactly the "everything refreshes / collapses to
// .config" the user saw. Mutating in place is the fix.
//
// `parent === ""` targets the root list directly. A parent that isn't present in
// the (lazily-loaded) tree means it's collapsed/unloaded — the helpers return the
// tree UNCHANGED in that case (caller treats it as "nothing visible to update",
// which is correct: a collapsed dir re-lists fresh when the user expands it).

/** True when `parent` is the root ("") or a dir node that is actually present in
 *  the loaded tree (so an insert/remove there would be visible). */
function parentIsLoaded(nodes: FileTreeNode[], parent: string): boolean {
  if (parent === "") return true;
  const node = findNodeByPath(nodes, parent);
  return Boolean(node && node.kind === "dir" && node.children !== undefined);
}

/** Insert `child` under `parent` (immutably), keeping siblings sorted. A no-op
 *  (returns the same array) when the parent isn't a loaded dir or the child
 *  already exists. */
function insertNode(nodes: FileTreeNode[], parent: string, child: FileTreeNode): FileTreeNode[] {
  if (parent === "") {
    if (nodes.some((n) => n.path === child.path)) return nodes;
    return sortNodes([...nodes, child]);
  }
  return nodes.map((node) => {
    if (node.path === parent) {
      if (node.kind !== "dir" || node.children === undefined) return node;
      if (node.children.some((n) => n.path === child.path)) return node;
      return { ...node, children: sortNodes([...node.children, child]) };
    }
    if (node.kind === "dir" && node.children && parent.startsWith(`${node.path}/`)) {
      return { ...node, children: insertNode(node.children, parent, child) };
    }
    return node;
  });
}

/** Remove the node at `path` (immutably). No-op when it isn't in the tree. */
function removeNode(nodes: FileTreeNode[], path: string): FileTreeNode[] {
  const parent = parentOf(path);
  if (parent === "") {
    if (!nodes.some((n) => n.path === path)) return nodes;
    return nodes.filter((n) => n.path !== path);
  }
  return nodes.map((node) => {
    if (node.path === parent) {
      if (node.kind !== "dir" || node.children === undefined) return node;
      return { ...node, children: node.children.filter((n) => n.path !== path) };
    }
    if (node.kind === "dir" && node.children && parent.startsWith(`${node.path}/`)) {
      return { ...node, children: removeNode(node.children, path) };
    }
    return node;
  });
}

/** Reconcile a freshly-listed depth-1 set of children against the CURRENT nodes
 *  at the same level, PRESERVING expansion: an existing dir keeps its already-
 *  loaded `children` (so its expanded subtree survives), new entries are added,
 *  and entries the server no longer returns are dropped. This is the in-place
 *  merge a root ("") reconcile needs — a blind replace would collapse every
 *  expanded top-level dir back to the unexpanded marker (the reported bug). */
/** Shallow node equality for identity preservation across a reconcile — same
 *  path/kind/name/size/status (children handled separately by the caller). */
function sameNodeShallow(a: FileTreeNode, b: FileTreeNode): boolean {
  return (
    a.path === b.path &&
    a.kind === b.kind &&
    a.name === b.name &&
    (a.size ?? null) === (b.size ?? null) &&
    (a.status ?? undefined) === (b.status ?? undefined) &&
    (a.truncated ?? false) === (b.truncated ?? false)
  );
}

function mergeChildren(current: FileTreeNode[], listed: FileTreeNode[]): FileTreeNode[] {
  const byPath = new Map(current.map((n) => [n.path, n] as const));
  const merged = listed.map((next) => {
    const existing = byPath.get(next.path);
    if (!existing) return next; // brand-new entry
    // Keep an already-expanded dir's loaded children; otherwise take the listing's
    // marker (undefined = unexpanded). Carry forward size/status from the listing.
    if (existing.kind === "dir" && next.kind === "dir" && existing.children !== undefined) {
      const candidate: FileTreeNode = { ...next, children: existing.children };
      // Preserve identity when nothing observable changed — no remount (§12-D1).
      return sameNodeShallow(existing, candidate) ? existing : candidate;
    }
    // A file or an unexpanded dir: preserve identity when the node is unchanged.
    if (existing.children === next.children && sameNodeShallow(existing, next)) {
      return existing;
    }
    return next;
  });
  return sortNodes(merged);
}

/** Root-level ("") reconcile: merge a fresh depth-1 listing into the root list
 *  without collapsing expanded top-level dirs. */
function mergeRootChildren(nodes: FileTreeNode[], listed: FileTreeNode[]): FileTreeNode[] {
  return mergeChildren(nodes, listed);
}

/** Re-path a subtree rooted at `node` from `fromPrefix` to `toPrefix` (so a moved
 *  dir's descendants keep correct paths without a re-list). */
function repathNode(node: FileTreeNode, fromPrefix: string, toPrefix: string): FileTreeNode {
  const newPath = toPrefix + node.path.slice(fromPrefix.length);
  const next: FileTreeNode = { ...node, path: newPath, name: leafOf(newPath) };
  if (node.children) next.children = node.children.map((c) => repathNode(c, fromPrefix, toPrefix));
  return next;
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeBase64Text(value: string): string {
  return new TextDecoder().decode(decodeBase64Bytes(value));
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function assertCapturedHash(bytes: Uint8Array, expected: string | null): Promise<void> {
  if (!expected) throw new Error("Captured file is missing its integrity hash.");
  if (!globalThis.crypto?.subtle) {
    throw new Error("Captured file integrity verification is unavailable in this browser.");
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buffer));
  const actual = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) throw new Error("Captured file content failed its integrity check.");
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
  const capture = options.capture ?? null;
  const isLive = options.liveness === "warm" || options.liveness === "draining";
  const identityKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${rootPath}`;

  const [tree, setTree] = useState<FileTreeNode[]>([]);
  // A ref mirror of the current tree — lets the optimistic path snapshot the
  // pre-op tree WITHOUT relying on a `setTree` updater (which StrictMode invokes
  // twice, corrupting an in-closure snapshot). Kept in sync on every set below
  // and in a layout effect for any path that sets `tree` directly.
  const treeRef = useRef<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandingPaths, setExpandingPaths] = useState<Set<string>>(new Set());
  const [error, setError] = useState<Error | null>(null);
  const [stateIdentity, setStateIdentity] = useState(identityKey);
  // Which source the tree currently reflects — "capture" (cold paint) or "live".
  const [source, setSource] = useState<"live" | "capture" | null>(null);
  const statusRef = useRef<Map<string, FileTreeStatus>>(new Map());
  // Async reads, event cursors, and debounced work are scoped to the hook's
  // workspace/session/root identity. These refs are reset/fenced at that boundary.
  const refreshGenerationRef = useRef(0);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const identityAbortRef = useRef(new AbortController());
  const identityGenerationRef = useRef(0);
  const lastSeqRef = useRef(0);
  const pendingParentsRef = useRef<Set<string>>(new Set());
  const pendingGitRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Self-emitted fs.changed de-dupe ───────────────────────────────────────
  // Every one of OUR mutations emits an `fs.changed` event back on the live log
  // (source:"write"). The old flow auto-refreshed on EVERY fs.changed, so each
  // edit self-triggered a full root collapse-reload (~5s, lost expansion). We now
  // (a) ignore fs.changed whose `source === "write"` (our own control-plane ops),
  // and (b) belt-and-braces, track the revisions WE caused so even a watch-sourced
  // echo of our own write is suppressed. Only EXTERNAL changes (the agent writing,
  // source:"agent"/"watch" we didn't cause) drive a targeted reconcile.
  const ownRevisionsRef = useRef<Set<number>>(new Set());
  const onMutationError = options.onMutationError;

  // Keep the ref mirror current for the optimistic snapshot path.
  treeRef.current = tree;

  // Overlay the git-status tint onto the tree. IDENTITY-PRESERVING: a node whose
  // tint and children are unchanged is returned by reference (not rebuilt), so a
  // re-tint or a cold→warm reconcile does NOT remount unchanged rows — the
  // no-flicker constraint (dossier §3 #6 / §12-D1). An empty overlay is still
  // meaningful: it strips stale tints after the repository becomes clean.
  const applyStatus = useCallback((nodes: FileTreeNode[]): FileTreeNode[] => {
    const overlay = statusRef.current;
    const walk = (list: FileTreeNode[]): FileTreeNode[] => {
      let changed = false;
      const out = list.map((node) => {
        const nextChildren = node.children ? walk(node.children) : node.children;
        const wantStatus = node.kind === "file" ? overlay.get(node.path) : undefined;
        const childrenChanged = nextChildren !== node.children;
        const statusChanged = (node.status ?? undefined) !== (wantStatus ?? undefined);
        if (!childrenChanged && !statusChanged) return node;
        changed = true;
        const next: FileTreeNode = {
          ...node,
          ...(node.children ? { children: nextChildren } : {}),
        };
        if (wantStatus) next.status = wantStatus;
        else delete next.status;
        return next;
      });
      return changed ? out : list;
    };
    return walk(nodes);
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    refreshAbortRef.current?.abort();
    const refreshAbort = new AbortController();
    refreshAbortRef.current = refreshAbort;
    const generation = (refreshGenerationRef.current += 1);
    setLoading(true);
    setError(null);
    try {
      // Pull the git-status overlay first (best-effort — a non-repo box just
      // returns isRepo:false), then the tree, so the first paint is tinted.
      try {
        const status = await client.gitStatus(
          workspaceId,
          sessionId,
          { path: rootPath },
          { signal: refreshAbort.signal },
        );
        if (refreshGenerationRef.current !== generation) return;
        const overlay = new Map<string, FileTreeStatus>();
        for (const file of status.files) {
          const code = file.worktree ?? file.index;
          const mapped = code ? GIT_STATUS_TO_TREE[code] : undefined;
          if (mapped) overlay.set(file.path, mapped);
        }
        statusRef.current = overlay;
      } catch {
        if (refreshGenerationRef.current !== generation) return;
        statusRef.current = new Map();
      }
      const listed = await client.fsList(
        workspaceId,
        sessionId,
        { path: rootPath, depth: 1 },
        { signal: refreshAbort.signal },
      );
      if (refreshGenerationRef.current !== generation) return;
      const children = (listed.root.children ?? []).map((node) => fsNodeToTree(node));
      // Merge rather than replace so an explicit refresh / cold→warm re-list folds
      // in new entries WITHOUT collapsing the dirs the user already expanded (and,
      // via the identity-preserving merge, WITHOUT remounting unchanged rows — the
      // no-flicker cold→warm reconcile). On a first (empty) load this is a plain set.
      setTree((prev) =>
        applyStatus(prev.length === 0 ? children : mergeRootChildren(prev, children)),
      );
      // Live data is now serving — flip the source off the capture snapshot.
      setSource("live");
    } catch (cause) {
      if (refreshGenerationRef.current !== generation) return;
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (refreshGenerationRef.current === generation) setLoading(false);
      if (refreshAbortRef.current === refreshAbort) refreshAbortRef.current = null;
    }
  }, [client, workspaceId, sessionId, rootPath, applyStatus]);

  // Seed (or re-seed) the tree from a turn-end capture — the COLD/offline paint,
  // zero Channel-A calls. The tree index is workspace-relative (`treeIndex`); the
  // tint overlay comes from the capture's changed `files`. Uses the SAME merge as
  // the live reconcile so a re-seed (a newer capture arriving cold) patches deltas
  // in place instead of remounting the tree (§12-D1). Never runs while warm.
  const seedFromCapture = useCallback(
    (manifest: WorkspaceCaptureManifest) => {
      const overlay = new Map<string, FileTreeStatus>();
      for (const file of manifest.files) {
        if (file.deleted) continue;
        const mapped = GIT_STATUS_TO_TREE[file.status];
        if (mapped) overlay.set(file.path, mapped);
      }
      statusRef.current = overlay;
      // The capture tree is a complete bounded index. Preserve an explicit empty
      // `children: []` as an actually empty directory; the live depth-1 mapper
      // intentionally treats that shape as an unexpanded boundary.
      const children = (manifest.treeIndex.children ?? []).map((node) => fsNodeToTree(node, true));
      setTree((prev) =>
        applyStatus(prev.length === 0 ? children : mergeRootChildren(prev, children)),
      );
      setSource("capture");
      setError(null);
    },
    [applyStatus],
  );

  const expand = useCallback(
    async (path: string) => {
      if (!sessionId) return;
      // Capture browsing is a durable server-side read surface. Never turn a
      // folder click into a Channel-A list while cold; truncated residue already
      // renders a truthful "contents on machine" row.
      if (!isLive && capture) return;
      const identityGeneration = identityGenerationRef.current;
      const identitySignal = identityAbortRef.current.signal;
      // Mark this node as expanding so the FileBrowser can render a spinner while
      // the (often 2-3s) Channel-A fs/list is in flight — the tree never looks
      // frozen on a click.
      setExpandingPaths((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      try {
        const listed = await client.fsList(
          workspaceId,
          sessionId,
          { path, depth: 1 },
          { signal: identitySignal },
        );
        if (identityGenerationRef.current !== identityGeneration) return;
        const children = (listed.root.children ?? []).map((node) => fsNodeToTree(node));
        setTree((prev) => applyStatus(replaceChildren(prev, path, children)));
      } catch (cause) {
        if (identityGenerationRef.current !== identityGeneration) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        if (identityGenerationRef.current === identityGeneration) {
          setExpandingPaths((prev) => {
            if (!prev.has(path)) return prev;
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
        }
      }
    },
    [client, workspaceId, sessionId, capture, isLive, applyStatus],
  );

  const readFile = useCallback(
    async (path: string, requestOptions: OpenGeniRequestOptions = {}) => {
      if (!sessionId) throw new Error("no session");
      const identitySignal = identityAbortRef.current.signal;
      const signal = requestOptions.signal
        ? AbortSignal.any([identitySignal, requestOptions.signal])
        : identitySignal;
      const captured = capture?.files.find((file) => file.path === path && !file.deleted);
      if (!isLive && capture) {
        if (!captured) {
          throw new CapturedFileUnavailableError(path, "not-captured");
        }
        // A passive review of a turn-touched file must stay entirely server-side:
        // mint/read its captured after-image, verify the content hash, and never
        // wake the sandbox. A URL may expire between mint and GET, so retry once
        // through the authenticated API to obtain a fresh scoped URL.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await client.getWorkspaceCaptureFile(
            workspaceId,
            sessionId,
            path,
            capture.revision,
            { signal },
          );
          if (result.path !== path || result.revision !== capture.revision) {
            throw new Error(
              "Captured file identity did not match the requested workspace revision.",
            );
          }
          if (
            result.hash !== captured.hash ||
            result.sizeBytes !== captured.sizeBytes ||
            result.isBinary !== captured.isBinary ||
            result.tooLarge !== captured.tooLarge
          ) {
            throw new Error("Captured file metadata did not match its manifest.");
          }
          if (result.tooLarge) {
            throw new CapturedFileUnavailableError(path, "too-large");
          }

          let bytes: Uint8Array;
          let encoding: "utf8" | "base64";
          let content: string;
          if (result.content !== null && result.encoding !== null) {
            encoding = result.encoding;
            content = result.content;
            bytes =
              encoding === "base64"
                ? decodeBase64Bytes(content)
                : new TextEncoder().encode(content);
          } else if (result.contentUrl) {
            const response = await fetch(result.contentUrl.url, {
              credentials: "omit",
              cache: "no-store",
              referrerPolicy: "no-referrer",
              signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            }).catch(() => null);
            if (!response?.ok) {
              if (
                attempt === 0 &&
                (response === null || response.status === 401 || response.status === 403)
              ) {
                continue;
              }
              throw new Error("Captured file download failed.");
            }
            bytes = new Uint8Array(await response.arrayBuffer());
            encoding = result.isBinary ? "base64" : "utf8";
            content = result.isBinary ? encodeBase64Bytes(bytes) : new TextDecoder().decode(bytes);
          } else {
            throw new CapturedFileUnavailableError(path, "content-missing");
          }

          if (bytes.byteLength !== result.sizeBytes) {
            throw new Error("Captured file size did not match its manifest.");
          }
          await assertCapturedHash(bytes, result.hash);
          return {
            path,
            encoding,
            content,
            sizeBytes: result.sizeBytes,
            truncated: false,
            isBinary: result.isBinary,
            revision: result.revision,
          };
        }
        throw new Error("Captured file download failed after refreshing its URL.");
      }
      return await client.fsRead(workspaceId, sessionId, { path }, { signal });
    },
    [client, workspaceId, sessionId, capture, isLive],
  );

  // TARGETED reconcile of a single directory — re-list ONE parent at depth 1 and
  // splice its children in place via `replaceChildren`, preserving the rest of the
  // tree's expansion. NEVER falls back to a root refresh (that's the collapse).
  // Used to (a) reconcile an optimistic insert against the server's real
  // size/mtime, and (b) fold an EXTERNAL (agent) change into the tree. A reconcile
  // of a parent that isn't loaded (collapsed/unmounted) is a no-op — there's
  // nothing visible to update, and it re-lists fresh when the user expands it.
  const reconcilePath = useCallback(
    async (path: string) => {
      if (!sessionId) return;
      const identityGeneration = identityGenerationRef.current;
      const identitySignal = identityAbortRef.current.signal;
      // Skip parents that aren't currently loaded/expanded in the tree (nothing
      // visible to update; they re-list fresh on the next expand).
      if (!parentIsLoaded(treeRef.current, path)) return;
      try {
        const listed = await client.fsList(
          workspaceId,
          sessionId,
          { path, depth: 1 },
          { signal: identitySignal },
        );
        if (identityGenerationRef.current !== identityGeneration) return;
        const children = (listed.root.children ?? []).map((node) => fsNodeToTree(node));
        if (path === "") setTree((prev) => applyStatus(mergeRootChildren(prev, children)));
        else
          setTree((prev) => {
            const existing = findNodeByPath(prev, path);
            const merged = existing?.children
              ? mergeChildren(existing.children, children)
              : children;
            return applyStatus(replaceChildren(prev, path, merged));
          });
      } catch {
        // A failed reconcile is non-fatal: the optimistic state stands. We never
        // root-refresh here (that would collapse the tree the user is working in).
      }
    },
    [client, workspaceId, sessionId, applyStatus],
  );

  // Run a Channel-A op behind an OPTIMISTIC tree edit. `apply` splices the change
  // in immediately (preserving expansion/selection); the op runs in the
  // background; on failure we revert to the pre-op snapshot and surface a toast.
  // On success we keep the optimistic state and (optionally) reconcile the
  // affected parent(s) to pick up the server's real size/revision — NEVER a full
  // refresh. The returned promise resolves/rejects with the op so callers (the
  // editor save, inline rename) can still await it.
  const runOptimistic = useCallback(
    async <T>(
      opName: string,
      apply: (nodes: FileTreeNode[]) => FileTreeNode[],
      op: () => Promise<T>,
      reconcileParents: string[],
    ): Promise<T> => {
      const identityGeneration = identityGenerationRef.current;
      // Snapshot the pre-op tree from the ref (StrictMode-safe — see treeRef).
      const snapshot = treeRef.current;
      setError(null);
      setTree(applyStatus(apply(snapshot)));
      try {
        const res = await op();
        if (identityGenerationRef.current !== identityGeneration) return res;
        // Remember the revision WE caused so the matching fs.changed echo is
        // ignored by the event effect (no self-triggered refresh).
        if (res && typeof res === "object" && "revision" in res) {
          const rev = (res as { revision?: unknown }).revision;
          if (typeof rev === "number") ownRevisionsRef.current.add(rev);
        }
        // Reconcile loaded parents to fold the server's real metadata. Sequential
        // and best-effort — purely cosmetic over the already-correct optimistic UI.
        for (const parent of reconcileParents) {
          if (identityGenerationRef.current !== identityGeneration) return res;
          await reconcilePath(parent);
        }
        return res;
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause));
        if (identityGenerationRef.current !== identityGeneration) throw err;
        // Revert the optimistic edit to the exact pre-op tree.
        setTree(applyStatus(snapshot));
        // An expected-content conflict belongs to the editor's explicit
        // Reload/Overwrite decision surface. Treating it as a broken file tree
        // would also raise a duplicate host toast and leave a stale global error
        // after the user successfully resolves the conflict.
        if (err instanceof FileWriteConflictError) throw err;
        setError(err);
        onMutationError?.(err, opName);
        throw err;
      }
    },
    [applyStatus, reconcilePath, onMutationError],
  );

  const writeFile = useCallback(
    async (
      path: string,
      content: string,
      writeOptions: SandboxWriteFileOptions = {},
    ): Promise<FsWriteResponse> => {
      if (!sessionId) throw new Error("no session");
      const identityGeneration = identityGenerationRef.current;
      const identitySignal = identityAbortRef.current.signal;
      const parent = parentOf(path);
      // Splice a new file node in immediately ONLY when the path doesn't already
      // exist in a loaded parent (an editor SAVE to an existing file mutates no
      // tree shape — just content — so it needs no optimistic node, no reconcile).
      const exists = Boolean(findNodeByPath(tree, path));
      const node: FileTreeNode = { path, name: leafOf(path), kind: "file", size: content.length };
      return await runOptimistic(
        "write",
        (nodes) => (exists ? nodes : insertNode(nodes, parent, node)),
        async () => {
          if (!writeOptions.force && writeOptions.expectedContent !== undefined) {
            const live = await client.fsRead(
              workspaceId,
              sessionId,
              { path },
              { signal: identitySignal },
            );
            if (identityGenerationRef.current !== identityGeneration) {
              throw new Error("File save cancelled because the workspace changed.");
            }
            const liveContent =
              live.encoding === "base64" ? decodeBase64Text(live.content) : live.content;
            if (live.truncated || live.isBinary || liveContent !== writeOptions.expectedContent) {
              throw new FileWriteConflictError(path, writeOptions.expectedContent, liveContent);
            }
          }
          if (identityGenerationRef.current !== identityGeneration) {
            throw new Error("File save cancelled because the workspace changed.");
          }
          return await client.fsWrite(workspaceId, sessionId, {
            path,
            content,
            overwrite: true,
          });
        },
        exists ? [] : [parent],
      );
    },
    [client, workspaceId, sessionId, tree, runOptimistic],
  );

  const createFile = useCallback(
    async (path: string): Promise<void> => {
      if (!sessionId) throw new Error("no session");
      const parent = parentOf(path);
      const node: FileTreeNode = { path, name: leafOf(path), kind: "file", size: 0 };
      await runOptimistic(
        "create file",
        (nodes) => insertNode(nodes, parent, node),
        () => client.fsWrite(workspaceId, sessionId, { path, content: "", overwrite: false }),
        [parent],
      );
    },
    [client, workspaceId, sessionId, runOptimistic],
  );

  const createDir = useCallback(
    async (path: string): Promise<void> => {
      if (!sessionId) throw new Error("no session");
      const parent = parentOf(path);
      // A freshly-created dir is empty + expanded: children:[] (not undefined, so
      // it doesn't show the lazy-expand marker over a dir we KNOW is empty).
      const node: FileTreeNode = { path, name: leafOf(path), kind: "dir", children: [] };
      await runOptimistic(
        "create folder",
        (nodes) => insertNode(nodes, parent, node),
        () => client.fsMkdir(workspaceId, sessionId, { path, recursive: true }),
        [parent],
      );
    },
    [client, workspaceId, sessionId, runOptimistic],
  );

  const deleteEntry = useCallback(
    async (path: string, recursive = false): Promise<void> => {
      if (!sessionId) throw new Error("no session");
      await runOptimistic(
        "delete",
        (nodes) => removeNode(nodes, path),
        () => client.fsDelete(workspaceId, sessionId, { path, recursive }),
        [parentOf(path)],
      );
    },
    [client, workspaceId, sessionId, runOptimistic],
  );

  const moveEntry = useCallback(
    async (path: string, newPath: string, opts?: { overwrite?: boolean }): Promise<void> => {
      if (!sessionId) throw new Error("no session");
      const from = parentOf(path);
      const to = parentOf(newPath);
      await runOptimistic(
        "move",
        (nodes) => {
          const moving = findNodeByPath(nodes, path);
          if (!moving) return nodes; // not loaded — let the reconcile pick it up
          // Re-path the moved subtree, drop it from its old parent, splice into new.
          const moved = repathNode(moving, path, newPath);
          return insertNode(removeNode(nodes, path), to, moved);
        },
        () =>
          client.fsMove(workspaceId, sessionId, {
            path,
            newPath,
            overwrite: opts?.overwrite ?? false,
          }),
        to === from ? [from] : [from, to],
      );
    },
    [client, workspaceId, sessionId, runOptimistic],
  );

  // Initial paint + reset on identity change. Source selection (dossier §10.4):
  //   • warm/draining box → the LIVE list (unchanged behavior).
  //   • cold/offline box WITH a capture → paint instantly from the capture index
  //     (no Channel-A; the box warms in the background and the warm effect below
  //     reconciles live in place).
  //   • cold box with NO capture → best-effort live list (status quo — never worse).
  // Key the seed on the capture's REVISION (a primitive), not the manifest object
  // — a consumer passing a fresh object each render (or a new revision) must not
  // spin the effect. The latest manifest is read from a ref at run time.
  const captureRef = useRef<WorkspaceCaptureManifest | null>(capture);
  captureRef.current = capture;
  const captureRevision = capture?.revision ?? null;
  const previousIdentityRef = useRef(identityKey);
  useEffect(() => {
    // Any source-selection change supersedes an older root refresh. A true data
    // identity change additionally fences all other async tree work and resets
    // event/debounce state before the event-folding effect runs.
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = null;
    refreshGenerationRef.current += 1;
    const identityChanged = previousIdentityRef.current !== identityKey;
    previousIdentityRef.current = identityKey;
    if (identityChanged || !enabled) {
      identityAbortRef.current.abort();
      identityAbortRef.current = new AbortController();
      identityGenerationRef.current += 1;
      lastSeqRef.current = 0;
      pendingParentsRef.current = new Set();
      pendingGitRef.current = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      ownRevisionsRef.current = new Set();
      statusRef.current = new Map();
      treeRef.current = [];
      setTree([]);
      setStateIdentity(identityKey);
      setExpandingPaths(new Set());
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

  // Re-pull JUST the git-status overlay and re-tint the existing tree in place —
  // no fs re-list, no collapse. This is all a `git.changed` (commit/stage/checkout)
  // needs: the tree SHAPE is unchanged, only the tints move.
  const refreshGitOverlay = useCallback(async () => {
    if (!sessionId) return;
    const identityGeneration = identityGenerationRef.current;
    const identitySignal = identityAbortRef.current.signal;
    try {
      const status = await client.gitStatus(
        workspaceId,
        sessionId,
        { path: rootPath },
        { signal: identitySignal },
      );
      if (identityGenerationRef.current !== identityGeneration) return;
      const overlay = new Map<string, FileTreeStatus>();
      for (const file of status.files) {
        const code = file.worktree ?? file.index;
        const mapped = code ? GIT_STATUS_TO_TREE[code] : undefined;
        if (mapped) overlay.set(file.path, mapped);
      }
      statusRef.current = overlay;
      setTree((prev) => applyStatus(prev));
    } catch {
      /* a non-repo box has no overlay — leave the tree untinted */
    }
  }, [client, workspaceId, sessionId, rootPath, applyStatus]);

  // Auto-reconcile on fs/git change notifications — TARGETED, never a root
  // collapse-reload, and de-duped against our OWN mutations.
  //
  //   • Our own ops (`source:"write"`, or a revision WE caused) are IGNORED —
  //     the optimistic edit already reflects them, so a refresh here would be the
  //     pointless 5s collapse the user reported.
  //   • An EXTERNAL fs.changed (the agent writing files: `source:"agent"`/`watch`)
  //     reconciles ONLY the affected parent directories (in place, expansion
  //     preserved). Bursts are debounced into a single reconcile pass.
  //   • A git.changed just re-tints (refreshes the status overlay) — no fs re-list.
  const events = options.events;

  useEffect(() => {
    if (!enabled || !events) return;
    let sawNew = false;
    for (const event of events) {
      if (event.sequence <= lastSeqRef.current) continue;
      if (event.type === "fs.changed") {
        sawNew = true;
        const payload = event.payload as FsChangedPayload | null;
        if (!payload || typeof payload !== "object") continue;
        // Suppress our own writes: the optimistic tree already shows them.
        if (payload.source === "write") continue;
        if (typeof payload.revision === "number" && ownRevisionsRef.current.has(payload.revision))
          continue;
        for (const change of payload.changes ?? []) {
          pendingParentsRef.current.add(parentOf(change.path));
          if (change.oldPath) pendingParentsRef.current.add(parentOf(change.oldPath));
        }
      } else if (event.type === "git.changed") {
        sawNew = true;
        const payload = event.payload as GitChangedPayload | null;
        // A git.changed our own write triggered (commit/stage from the agent is
        // external; a checkout we caused isn't — but we don't cause git ops here,
        // so any git.changed is external) → re-tint.
        if (
          payload &&
          typeof payload === "object" &&
          typeof payload.revision === "number" &&
          ownRevisionsRef.current.has(payload.revision)
        )
          continue;
        pendingGitRef.current = true;
      }
    }
    // Advance the high-water mark past everything we've folded.
    for (const event of events)
      if (event.sequence > lastSeqRef.current) lastSeqRef.current = event.sequence;
    if (!sawNew) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    const identityGeneration = identityGenerationRef.current;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      if (identityGenerationRef.current !== identityGeneration) return;
      const parents = pendingParentsRef.current;
      pendingParentsRef.current = new Set();
      const wantGit = pendingGitRef.current;
      pendingGitRef.current = false;
      // Reconcile the changed directories (in place). A git change re-tints first
      // so the freshly-listed nodes get the correct overlay.
      void (async () => {
        if (wantGit) await refreshGitOverlay();
        if (identityGenerationRef.current !== identityGeneration) return;
        for (const parent of parents) {
          if (identityGenerationRef.current !== identityGeneration) return;
          await reconcilePath(parent);
        }
      })();
    }, 150);
  }, [enabled, events, reconcilePath, refreshGitOverlay]);

  useEffect(
    () => () => {
      refreshAbortRef.current?.abort();
      identityAbortRef.current.abort();
      identityGenerationRef.current += 1;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

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

  const identityMatches = enabled && stateIdentity === identityKey;
  return {
    tree: identityMatches ? tree : [],
    expand,
    expandingPaths: identityMatches ? expandingPaths : new Set<string>(),
    readFile,
    writeFile,
    createFile,
    createDir,
    deleteEntry,
    moveEntry,
    refresh,
    source: identityMatches ? source : null,
    capturedAt: identityMatches && source === "capture" ? (capture?.capturedAt ?? null) : null,
    loading: identityMatches && loading,
    error: identityMatches ? error : null,
  };
}
