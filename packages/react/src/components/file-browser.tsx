import {
  ChevronRightIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertDialog } from "radix-ui";
import { VList, type VListHandle } from "virtua";
import { cn } from "../lib/cn";
import { type PortalTokenStyle, usePortalTokenStyle } from "../lib/use-portal-token-style";
import { useUnicodeFallbackFonts } from "../lib/use-unicode-fonts";
import type { FileTreeNode, UseSandboxFilesResult } from "../hooks/use-sandbox-files";

export type FileBrowserProps = {
  /** From `useSandboxFiles(...)`. */
  result: UseSandboxFilesResult;
  /**
   * Rendered instead of the built-in tree when the file surface is unavailable
   * (e.g. a `FileSystem.available === false` capability). Default: a quiet notice.
   */
  fallback?: ReactNode | undefined;
  /** Selection callback for the preview pane. */
  onSelectFile?: ((path: string) => void) | undefined;
  selectedPath?: string | undefined;
  /** Render-prop to theme/replace a row entirely (the Pierre-swap escape hatch). */
  renderNode?: ((node: FileTreeNode, depth: number, expanded: boolean) => ReactNode) | undefined;
  /** Shown when the tree is empty (no files / not loaded yet). */
  emptyState?: ReactNode | undefined;
  /**
   * Enable the file-manager affordances (toolbar, context menu, drag-drop move,
   * inline rename, delete, new file/folder). Defaults to `true` when the hook
   * exposes the mutation methods; pass `false` for a strictly read-only tree.
   */
  editable?: boolean | undefined;
  /**
   * Confirm a (recursive) delete before it runs. Return `false` to cancel.
   * The default is an accessible, non-blocking confirmation dialog. Supply this
   * callback to delegate confirmation to a host-owned dialog.
   */
  confirmDelete?: ((node: FileTreeNode) => boolean | Promise<boolean>) | undefined;
  className?: string | undefined;
};

const STATUS_TINT: Record<NonNullable<FileTreeNode["status"]>, string> = {
  added: "text-og-status-idle",
  modified: "text-og-status-running",
  deleted: "text-og-status-failed line-through",
  renamed: "text-og-accent",
  untracked: "text-og-fg-subtle",
};
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Parent dir of a workspace-relative POSIX path ("" for a root entry). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

/** Join a parent dir with a leaf name (handles the root "" parent). */
function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** A stable React key for a flat render item. */
function itemKey(item: RenderItem): string {
  switch (item.type) {
    case "node":
      return item.node.path;
    case "create":
      return `create:${item.parent}`;
    case "skeleton":
      return `skeleton:${item.path}`;
    case "residue":
      return `residue:${item.path}`;
  }
}

/** Walk the tree to find a node by path. */
function findNode(nodes: FileTreeNode[], path: string): FileTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.kind === "dir" && node.children && path.startsWith(`${node.path}/`)) {
      const hit = findNode(node.children, path);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** A pending inline-create: a phantom input row under `parent`. */
type DraftCreate = { parent: string; kind: "file" | "dir" };
/** A pending inline-rename of an existing node. */
type DraftRename = { path: string };
type ContextMenuState = { node: FileTreeNode | null; x: number; y: number };

/** One virtualized row. Nodes plus the synthetic rows the recursive renderer
 *  used to nest inline. */
type RenderItem =
  | { type: "node"; node: FileTreeNode; depth: number }
  | { type: "create"; parent: string; kind: "file" | "dir"; depth: number }
  | { type: "skeleton"; path: string; depth: number }
  | { type: "residue"; path: string; depth: number };

/**
 * The file MANAGER, fed by the FileSystem service via `useSandboxFiles`. This is
 * a first-class editable tree (not a render-only view): lazy-expand with a
 * spinner on the in-flight node, git-status tinting, full keyboard navigation,
 * selection, and the mutating affordances wired straight to the hook —
 *
 *   • drag-and-drop MOVE  → `moveEntry(from, to)`
 *   • inline RENAME       → `moveEntry(path, newPath)`  (F2 / double-click / menu)
 *   • DELETE              → `deleteEntry(path, recursive)`  (Del / menu, confirmed)
 *   • NEW FILE / FOLDER   → `createFile` / `createDir` (toolbar + menu), then open
 *   • right-click CONTEXT MENU
 *
 * `renderNode` is still honoured as the Pierre-swap escape hatch for the row
 * chrome; the manager scaffolding (toolbar, dnd, menu, inline inputs) wraps it.
 */
export function FileBrowser({
  result,
  fallback,
  onSelectFile,
  selectedPath,
  renderNode,
  emptyState,
  editable = true,
  confirmDelete,
  className,
}: FileBrowserProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [draftCreate, setDraftCreate] = useState<DraftCreate | null>(null);
  const [draftRename, setDraftRename] = useState<DraftRename | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FileTreeNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const treeId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const vlistRef = useRef<VListHandle>(null);
  const portalTokenStyle = usePortalTokenStyle(containerRef);
  const getTreeElement = useCallback(
    () => (typeof document === "undefined" ? null : document.getElementById(treeId)),
    [treeId],
  );

  useBrowserLayoutEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarsePointer(query.matches);
    update();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    if (typeof query.addListener === "function") {
      query.addListener(update);
      return () => query.removeListener(update);
    }
  }, []);

  // The keyboard cursor: an explicitly-navigated node falls back to the
  // externally-selected file so arrow keys pick up where the preview pane is.
  const cursor = active ?? selectedPath ?? null;

  const expand = useCallback(
    async (path: string) => {
      const node = findNode(result.tree, path);
      if (node && node.kind === "dir" && node.children === undefined) {
        setLoadingPaths((prev) => new Set(prev).add(path));
        try {
          await result.expand(path);
        } finally {
          setLoadingPaths((prev) => {
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
        }
      }
    },
    [result],
  );

  const open = useCallback(
    (path: string) => {
      setExpanded((prev) => new Set(prev).add(path));
      void expand(path);
    },
    [expand],
  );

  const toggle = useCallback(
    async (node: FileTreeNode) => {
      if (node.kind !== "dir") return;
      const isOpen = expanded.has(node.path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (isOpen) next.delete(node.path);
        else next.add(node.path);
        return next;
      });
      if (!isOpen) await expand(node.path);
    },
    [expanded, expand],
  );

  // Flatten the VISIBLE (expanded) tree into a single ordered render list — the
  // input to the virtualizer. Interleaves the synthetic rows the recursive
  // renderer used to nest (inline create input, lazy-expand skeleton, and the
  // cold residue "contents on machine" row) so every visual row is one list item.
  const cold = result.source !== "live";
  const renderItems = useMemo(() => {
    const items: RenderItem[] = [];
    if (draftCreate && draftCreate.parent === "") {
      items.push({ type: "create", parent: "", kind: draftCreate.kind, depth: 0 });
    }
    const walk = (nodes: FileTreeNode[], depth: number) => {
      for (const node of nodes) {
        items.push({ type: "node", node, depth });
        if (node.kind !== "dir" || !expanded.has(node.path)) continue;
        if (draftCreate && draftCreate.parent === node.path) {
          items.push({
            type: "create",
            parent: node.path,
            kind: draftCreate.kind,
            depth: depth + 1,
          });
        }
        const childless = node.children === undefined || node.children.length === 0;
        const isLoading = loadingPaths.has(node.path) || result.expandingPaths.has(node.path);
        // A collapsed residue dir (node_modules, .git, …) can't list children from
        // the cold capture — offer to open it live rather than a dead skeleton.
        if (node.truncated && childless && cold && !isLoading) {
          items.push({ type: "residue", path: node.path, depth: depth + 1 });
        } else if (node.children && node.children.length > 0) {
          walk(node.children, depth + 1);
        } else if (isLoading && childless) {
          items.push({ type: "skeleton", path: node.path, depth: depth + 1 });
        }
      }
    };
    walk(result.tree, 0);
    return items;
  }, [result.tree, expanded, draftCreate, loadingPaths, result.expandingPaths, cold]);
  const unicodeFontPaths = useMemo(
    () => renderItems.flatMap((item) => (item.type === "node" ? [item.node.path] : [])),
    [renderItems],
  );
  useUnicodeFallbackFonts(unicodeFontPaths);

  // The visible NODE rows in order — drives keyboard up/down navigation.
  const flatRows = useMemo(
    () =>
      renderItems.flatMap((item) =>
        item.type === "node" ? [{ node: item.node, depth: item.depth }] : [],
      ),
    [renderItems],
  );
  const rowIndexByPath = useMemo(
    () => new Map(flatRows.map((row, index) => [row.node.path, index] as const)),
    [flatRows],
  );
  const treePositionByPath = useMemo(() => {
    const positions = new Map<string, { position: number; setSize: number }>();
    const visit = (nodes: FileTreeNode[]) => {
      nodes.forEach((node, index) => {
        positions.set(node.path, { position: index + 1, setSize: nodes.length });
        if (node.children) visit(node.children);
      });
    };
    visit(result.tree);
    return positions;
  }, [result.tree]);
  const cursorIndex = cursor ? (rowIndexByPath.get(cursor) ?? -1) : -1;
  const activeDescendantId = cursorIndex >= 0 ? `${treeId}-item-${cursorIndex}` : undefined;

  const supportsMutation = editable;

  const performDelete = useCallback(
    async (node: FileTreeNode) => {
      if (!supportsMutation) return;
      const recursive = node.kind === "dir";
      setBusy(true);
      try {
        await result.deleteEntry(node.path, recursive);
      } catch {
        // The hook surfaces the error on `result.error`; the panel renders it.
      } finally {
        setBusy(false);
      }
    },
    [supportsMutation, result],
  );

  const runDelete = useCallback(
    async (node: FileTreeNode, returnFocus?: HTMLElement) => {
      if (!supportsMutation) return;
      setMenu(null);
      if (!confirmDelete) {
        deleteReturnFocusRef.current =
          returnFocus ??
          (typeof document !== "undefined" && document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null);
        setPendingDelete(node);
        return;
      }
      if (await confirmDelete(node)) await performDelete(node);
    },
    [supportsMutation, confirmDelete, performDelete],
  );

  const closePendingDelete = useCallback(
    (restoreTrigger: boolean) => {
      const returnTarget = restoreTrigger ? deleteReturnFocusRef.current : getTreeElement();
      deleteReturnFocusRef.current = null;
      setPendingDelete(null);
      if (typeof window !== "undefined") {
        window.requestAnimationFrame(() => {
          const target = returnTarget?.isConnected ? returnTarget : getTreeElement();
          target?.focus();
        });
      }
    },
    [getTreeElement],
  );

  const commitCreate = useCallback(
    async (name: string) => {
      const draft = draftCreate;
      setDraftCreate(null);
      if (!draft || !supportsMutation) return;
      const trimmed = name.trim().replace(/\/+$/, "");
      if (!trimmed) return;
      const path = joinPath(draft.parent, trimmed);
      setBusy(true);
      try {
        if (draft.kind === "dir") {
          await result.createDir(path);
          open(path);
        } else {
          await result.createFile(path);
          // Open the freshly-created file in the preview/editor pane.
          setActive(path);
          onSelectFile?.(path);
        }
      } catch {
        /* error surfaced via result.error */
      } finally {
        setBusy(false);
      }
    },
    [draftCreate, supportsMutation, result, open, onSelectFile],
  );

  const commitRename = useCallback(
    async (name: string) => {
      const draft = draftRename;
      setDraftRename(null);
      if (!draft || !supportsMutation) return;
      const node = findNode(result.tree, draft.path);
      const trimmed = name.trim().replace(/\/+$/, "");
      if (!node || !trimmed || trimmed === node.name) return;
      const newPath = joinPath(parentOf(draft.path), trimmed);
      setBusy(true);
      try {
        await result.moveEntry(draft.path, newPath);
        if (node.kind === "file" && (selectedPath === draft.path || active === draft.path)) {
          setActive(newPath);
          onSelectFile?.(newPath);
        }
      } catch {
        /* error surfaced via result.error */
      } finally {
        setBusy(false);
      }
    },
    [draftRename, supportsMutation, result, selectedPath, active, onSelectFile],
  );

  // Begin a new file/folder under the active node's directory (or root).
  const startCreate = useCallback(
    (kind: "file" | "dir") => {
      if (!supportsMutation) return;
      const anchor = cursor ? findNode(result.tree, cursor) : undefined;
      const parent = anchor ? (anchor.kind === "dir" ? anchor.path : parentOf(anchor.path)) : "";
      if (parent) open(parent);
      setDraftRename(null);
      setMenu(null);
      setDraftCreate({ parent, kind });
    },
    [supportsMutation, cursor, result.tree, open],
  );

  const startRename = useCallback(
    (node: FileTreeNode) => {
      if (!supportsMutation) return;
      setDraftCreate(null);
      setMenu(null);
      setDraftRename({ path: node.path });
    },
    [supportsMutation],
  );

  // Drag-drop move: drop a node onto a directory (or the root) → moveEntry.
  const onDropOnto = useCallback(
    async (targetDir: string, sourcePath: string) => {
      setDragOver(null);
      if (!supportsMutation || !sourcePath) return;
      const src = findNode(result.tree, sourcePath);
      if (!src) return;
      // No-op drops: onto its own current parent, onto itself, or into its own subtree.
      if (parentOf(sourcePath) === targetDir) return;
      if (targetDir === sourcePath || targetDir.startsWith(`${sourcePath}/`)) return;
      const newPath = joinPath(targetDir, src.name);
      if (newPath === sourcePath) return;
      setBusy(true);
      try {
        await result.moveEntry(sourcePath, newPath);
        if (src.kind === "file" && (selectedPath === sourcePath || active === sourcePath)) {
          setActive(newPath);
          onSelectFile?.(newPath);
        }
      } catch {
        /* 409/collision etc. surfaced via result.error */
      } finally {
        setBusy(false);
      }
    },
    [supportsMutation, result, selectedPath, active, onSelectFile],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (draftCreate || draftRename) return; // inline input owns the keyboard
      if (flatRows.length === 0) return;
      const idx = flatRows.findIndex((r) => r.node.path === cursor);
      const move = (next: number) => {
        const clamped = Math.max(0, Math.min(flatRows.length - 1, next));
        const row = flatRows[clamped];
        if (row) setActive(row.node.path);
        e.preventDefault();
      };
      const cur = idx >= 0 ? flatRows[idx] : undefined;
      switch (e.key) {
        case "ArrowDown":
          move(idx < 0 ? 0 : idx + 1);
          break;
        case "ArrowUp":
          move(idx < 0 ? 0 : idx - 1);
          break;
        case "Home":
          move(0);
          break;
        case "End":
          move(flatRows.length - 1);
          break;
        case "PageDown": {
          const pageSize = Math.max(
            1,
            Math.floor((containerRef.current?.clientHeight || 280) / (coarsePointer ? 44 : 28)) - 1,
          );
          move((idx < 0 ? 0 : idx) + pageSize);
          break;
        }
        case "PageUp": {
          const pageSize = Math.max(
            1,
            Math.floor((containerRef.current?.clientHeight || 280) / (coarsePointer ? 44 : 28)) - 1,
          );
          move((idx < 0 ? 0 : idx) - pageSize);
          break;
        }
        case "ArrowRight":
          if (cur?.node.kind === "dir") {
            if (!expanded.has(cur.node.path)) open(cur.node.path);
            else move(idx + 1);
            e.preventDefault();
          }
          break;
        case "ArrowLeft":
          if (cur) {
            if (cur.node.kind === "dir" && expanded.has(cur.node.path)) {
              setExpanded((prev) => {
                const n = new Set(prev);
                n.delete(cur.node.path);
                return n;
              });
            } else {
              const parent = parentOf(cur.node.path);
              if (parent) setActive(parent);
            }
            e.preventDefault();
          }
          break;
        case "Enter":
          if (cur) {
            if (cur.node.kind === "dir") void toggle(cur.node);
            else onSelectFile?.(cur.node.path);
            e.preventDefault();
          }
          break;
        case "ContextMenu":
        case "F10":
          if (cur && supportsMutation && (e.key === "ContextMenu" || e.shiftKey)) {
            const rowIndex = rowIndexByPath.get(cur.node.path) ?? 0;
            const row = document.getElementById(`${treeId}-item-${rowIndex}`);
            const rect = row?.getBoundingClientRect();
            setMenu({
              node: cur.node,
              x: rect ? rect.left + Math.min(32, rect.width / 2) : 8,
              y: rect ? rect.bottom : 8,
            });
            e.preventDefault();
          } else if (e.key === "F10") {
            break;
          }
          break;
        case "F2":
          if (cur) {
            startRename(cur.node);
            e.preventDefault();
          }
          break;
        case "Delete":
        case "Backspace":
          if (cur && supportsMutation) {
            void runDelete(cur.node);
            e.preventDefault();
          }
          break;
      }
    },
    [
      draftCreate,
      draftRename,
      flatRows,
      cursor,
      expanded,
      open,
      toggle,
      onSelectFile,
      startRename,
      runDelete,
      supportsMutation,
      coarsePointer,
      rowIndexByPath,
      treeId,
    ],
  );

  // Close the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const showErrorEmpty = result.error && result.tree.length === 0 && !draftCreate;
  const showEmpty = !result.loading && result.tree.length === 0 && !draftCreate;
  const showToolbar = supportsMutation || Boolean(result.error) || result.loading;
  const usesVirtualTree = !showErrorEmpty && !showEmpty;

  // Render a SINGLE node row (no recursion — children are separate flat items the
  // virtualizer renders). Returns the row element; the caller assigns the key.
  const renderNodeRow = (node: FileTreeNode, depth: number): ReactNode => {
    const isOpen = expanded.has(node.path);
    if (renderNode) {
      return <div>{renderNode(node, depth, isOpen)}</div>;
    }
    const isDir = node.kind === "dir";
    const isSelected = node.path === selectedPath || node.path === active;
    const isCursor = node.path === cursor;
    const isLoading = loadingPaths.has(node.path) || result.expandingPaths.has(node.path);
    const isRenaming = draftRename?.path === node.path;
    const isDropTarget = dragOver === (isDir ? node.path : parentOf(node.path));
    const dropDir = isDir ? node.path : parentOf(node.path);
    const treePosition = treePositionByPath.get(node.path);

    return (
      <div
        id={`${treeId}-item-${rowIndexByPath.get(node.path) ?? 0}`}
        role="treeitem"
        aria-level={depth + 1}
        aria-posinset={treePosition?.position}
        aria-setsize={treePosition?.setSize}
        aria-expanded={isDir ? isOpen : undefined}
        aria-selected={isCursor || undefined}
        aria-busy={isLoading || undefined}
        onDragOver={
          supportsMutation
            ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOver(dropDir);
              }
            : undefined
        }
        onDragLeave={
          supportsMutation
            ? (e) => {
                e.stopPropagation();
                setDragOver((cur) => (cur === dropDir ? null : cur));
              }
            : undefined
        }
        onDrop={
          supportsMutation
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                const src = e.dataTransfer.getData("text/og-path");
                void onDropOnto(dropDir, src);
              }
            : undefined
        }
      >
        {isRenaming ? (
          <InlineInput
            depth={depth}
            kind={node.kind}
            initialValue={node.name}
            onCommit={(name) => void commitRename(name)}
            onCancel={() => setDraftRename(null)}
          />
        ) : (
          <button
            type="button"
            tabIndex={-1}
            draggable={supportsMutation || undefined}
            onDragStart={
              supportsMutation
                ? (e) => {
                    e.dataTransfer.setData("text/og-path", node.path);
                    e.dataTransfer.effectAllowed = "move";
                  }
                : undefined
            }
            onClick={() => {
              setActive(node.path);
              if (isDir) void toggle(node);
              else onSelectFile?.(node.path);
            }}
            onDoubleClick={() => supportsMutation && startRename(node)}
            onContextMenu={(e) => {
              if (!supportsMutation) return;
              e.preventDefault();
              setActive(node.path);
              setMenu({ node, x: e.clientX, y: e.clientY });
            }}
            className={cn(
              "group relative flex min-h-7 w-full items-center gap-1 truncate rounded-og-sm px-1 py-0.5 text-left text-og-sm pointer-coarse:min-h-11",
              "hover:bg-og-surface-2",
              isSelected && "bg-og-surface-2",
              isCursor && "outline outline-1 -outline-offset-1 outline-og-accent",
              isDropTarget && "bg-og-accent-soft ring-1 ring-inset ring-og-accent",
              // A thin progress shimmer on the expanding row — no per-node spinner.
              isLoading &&
                "after:pointer-events-none after:absolute after:inset-x-1 after:bottom-0 after:h-px after:animate-pulse after:rounded-full after:bg-og-accent-soft",
              node.status ? STATUS_TINT[node.status] : undefined,
            )}
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
          >
            {isDir ? (
              <ChevronRightIcon
                className={cn(
                  "size-3 shrink-0 transition-transform",
                  isOpen && "rotate-90",
                  isLoading && "text-og-accent",
                )}
              />
            ) : (
              <span className="inline-block w-3 shrink-0" />
            )}
            {isDir ? (
              <FolderIcon className="size-3.5 shrink-0" />
            ) : (
              <FileIcon className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{node.name}</span>
            {supportsMutation && (
              <span
                role="button"
                tabIndex={-1}
                aria-label="More actions"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setActive(node.path);
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenu({ node, x: rect.right, y: rect.bottom });
                }}
                className="ml-auto hidden shrink-0 px-1 text-og-fg-subtle hover:text-og-fg group-hover:inline"
              >
                ⋯
              </span>
            )}
          </button>
        )}
      </div>
    );
  };

  // Render one flat list item (node row or a synthetic create/skeleton/residue row).
  const renderItem = (item: RenderItem): ReactNode => {
    switch (item.type) {
      case "node":
        return renderNodeRow(item.node, item.depth);
      case "create":
        return (
          <InlineInput
            depth={item.depth}
            kind={item.kind}
            initialValue=""
            onCommit={(name) => void commitCreate(name)}
            onCancel={() => setDraftCreate(null)}
          />
        );
      case "skeleton":
        return (
          <div
            role="group"
            aria-hidden
            style={{ paddingLeft: `${item.depth * 12 + 4}px` }}
            className="space-y-1 py-1"
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-2.5 animate-pulse rounded-og-sm bg-og-surface-2"
                style={{ width: `${70 - i * 12}%` }}
              />
            ))}
          </div>
        );
      case "residue":
        return (
          <div
            style={{ paddingLeft: `${item.depth * 12 + 4}px` }}
            className="flex items-center gap-1.5 py-0.5 pr-1 text-og-xs italic text-og-fg-subtle"
          >
            <span className="inline-block w-3 shrink-0" />
            <span className="min-w-0 truncate">contents on machine — open when live</span>
          </div>
        );
    }
  };

  // Keep the keyboard cursor's row on screen even though off-screen rows unmount.
  useEffect(() => {
    if (!cursor) return;
    const index = renderItems.findIndex((it) => it.type === "node" && it.node.path === cursor);
    if (index >= 0) vlistRef.current?.scrollToIndex(index);
  }, [cursor, renderItems]);

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", className)}>
      {showToolbar && (
        <div
          role="toolbar"
          aria-label="File actions"
          className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-og-border px-1 py-1"
        >
          {supportsMutation ? (
            <>
              <ToolbarButton label="New file" onClick={() => startCreate("file")} disabled={busy}>
                <FilePlusIcon className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton label="New folder" onClick={() => startCreate("dir")} disabled={busy}>
                <FolderPlusIcon className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                label="Rename"
                onClick={() => {
                  const node = cursor ? findNode(result.tree, cursor) : undefined;
                  if (node) startRename(node);
                }}
                disabled={busy || !cursor}
              >
                <PencilIcon className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                label="Delete"
                onClick={(event) => {
                  const node = cursor ? findNode(result.tree, cursor) : undefined;
                  if (node) void runDelete(node, event.currentTarget);
                }}
                disabled={busy || !cursor}
              >
                <Trash2Icon className="size-3.5" />
              </ToolbarButton>
            </>
          ) : null}
          <span className="ml-auto" />
          <ToolbarButton
            label="Refresh"
            onClick={() => void result.refresh()}
            disabled={busy || result.loading}
          >
            <RefreshCwIcon className={cn("size-3.5", result.loading && "animate-spin")} />
          </ToolbarButton>
        </div>
      )}

      {/* The tree itself. The root is a drop target so a node can be moved to "". */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the tree owns keyboard nav */}
      <div
        ref={containerRef}
        id={usesVirtualTree ? undefined : treeId}
        role={usesVirtualTree ? undefined : "tree"}
        aria-label={usesVirtualTree ? undefined : "Workspace files"}
        aria-activedescendant={usesVirtualTree ? undefined : activeDescendantId}
        tabIndex={usesVirtualTree ? undefined : 0}
        aria-multiselectable={usesVirtualTree ? undefined : false}
        onFocus={(event) => {
          if ((event.target as HTMLElement).id === treeId && cursorIndex < 0) {
            const first = flatRows[0];
            if (first) setActive(first.node.path);
          }
        }}
        onKeyDown={onKeyDown}
        onDragOver={
          supportsMutation
            ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOver("");
              }
            : undefined
        }
        onDrop={
          supportsMutation
            ? (e) => {
                e.preventDefault();
                const src = e.dataTransfer.getData("text/og-path");
                void onDropOnto("", src);
              }
            : undefined
        }
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col p-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent",
          dragOver === "" && "ring-1 ring-inset ring-og-accent",
        )}
        data-opengeni-file-tree
      >
        {showErrorEmpty ? (
          <div className="flex flex-col items-start gap-2 p-2 text-og-sm text-og-fg-subtle">
            <div>
              {fallback ??
                `Could not load files: ${result.error?.message ?? "refresh the file list to try again"}`}
            </div>
            <button
              type="button"
              onClick={() => void result.refresh()}
              disabled={result.loading}
              className="inline-flex items-center gap-1.5 rounded-og-sm border border-og-border px-2 py-1 text-og-xs font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:text-og-fg disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11"
            >
              <RefreshCwIcon
                className={cn("size-3.5", result.loading && "animate-spin")}
                aria-hidden
              />
              Retry
            </button>
          </div>
        ) : showEmpty ? (
          <div className="p-2 text-og-sm text-og-fg-subtle">
            {emptyState ?? "This directory is empty"}
          </div>
        ) : (
          // Virtualized: only the rows in/near the viewport mount, so a 3k-node
          // tree stays responsive. The flat item list already carries the
          // expanded subtree + synthetic (create/skeleton/residue) rows.
          <VList
            ref={vlistRef}
            id={treeId}
            role="tree"
            aria-label="Workspace files"
            aria-activedescendant={activeDescendantId}
            aria-multiselectable={false}
            tabIndex={0}
            className="min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent"
            itemSize={coarsePointer ? 44 : 28}
            ssrCount={Math.min(32, renderItems.length)}
          >
            {renderItems.map((item) => (
              <div key={itemKey(item)} className="min-w-0">
                {renderItem(item)}
              </div>
            ))}
          </VList>
        )}
      </div>

      {menu && menu.node && (
        <ContextMenu
          node={menu.node}
          x={menu.x}
          y={menu.y}
          onRename={() => menu.node && startRename(menu.node)}
          onDelete={() => menu.node && void runDelete(menu.node)}
          onNewFile={() => startCreate("file")}
          onNewFolder={() => startCreate("dir")}
          onClose={() => {
            setMenu(null);
            window.requestAnimationFrame(() => getTreeElement()?.focus());
          }}
        />
      )}
      {pendingDelete ? (
        <DeleteDialog
          node={pendingDelete}
          busy={busy}
          portalTokenStyle={portalTokenStyle}
          onCancel={() => closePendingDelete(true)}
          onConfirm={() => {
            const node = pendingDelete;
            closePendingDelete(false);
            void performDelete(node);
          }}
        />
      ) : null}
    </div>
  );
}

function DeleteDialog({
  node,
  busy,
  portalTokenStyle,
  onCancel,
  onConfirm,
}: {
  node: FileTreeNode;
  busy: boolean;
  portalTokenStyle: PortalTokenStyle;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(true);
  const closeIntentRef = useRef<"cancel" | "confirm">("cancel");
  const settledRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settle = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    if (closeIntentRef.current === "confirm") {
      onConfirm();
    } else {
      onCancel();
    }
  };

  const scheduleSettle = () => {
    if (settleTimerRef.current !== null) return;
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      settle();
    }, 0);
  };

  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    },
    [],
  );

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) {
          setOpen(false);
          scheduleSettle();
        }
      }}
    >
      <AlertDialog.Portal container={typeof document === "undefined" ? null : document.body}>
        <AlertDialog.Overlay className="fixed inset-0 z-[100] bg-black/45 backdrop-blur-[2px]" />
        <AlertDialog.Content
          className="og-root fixed left-1/2 top-1/2 z-[101] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-og-lg border border-og-border-strong bg-og-surface-1 p-4 text-og-fg shadow-2xl outline-none"
          style={portalTokenStyle}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            scheduleSettle();
          }}
          onEscapeKeyDown={(event) => {
            event.stopPropagation();
            if (busy) {
              event.preventDefault();
            } else {
              closeIntentRef.current = "cancel";
            }
          }}
        >
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-og-status-failed/12 text-og-status-failed">
              <Trash2Icon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <AlertDialog.Title className="text-og-sm font-semibold">
                Delete {node.kind === "dir" ? "folder" : "file"}?
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-1 text-og-sm leading-relaxed text-og-fg-muted">
                <span className="break-all font-og-mono text-og-fg">{node.path}</span>
                {node.kind === "dir"
                  ? " and everything inside it will be permanently removed."
                  : " will be permanently removed."}
              </AlertDialog.Description>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                ref={cancelRef}
                type="button"
                onClick={() => {
                  closeIntentRef.current = "cancel";
                }}
                disabled={busy}
                className="min-h-9 rounded-og-md border border-og-border px-3 text-og-sm font-medium text-og-fg hover:bg-og-surface-2 disabled:opacity-50 pointer-coarse:min-h-11"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                onClick={() => {
                  closeIntentRef.current = "confirm";
                }}
                disabled={busy}
                className="min-h-9 rounded-og-md bg-og-status-failed px-3 text-og-sm font-semibold text-white shadow-sm hover:brightness-110 disabled:opacity-50 pointer-coarse:min-h-11"
              >
                Delete permanently
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-og-sm p-1 text-og-fg-muted max-[1023px]:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        "hover:bg-og-surface-2 hover:text-og-fg",
        "disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}

/** An inline text input for create / rename, indented to match its row depth. */
function InlineInput({
  depth,
  kind,
  initialValue,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: "file" | "dir";
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement | null>(null);
  // Track whether we've already resolved so a blur after Enter/Escape is a no-op.
  const doneRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the basename (excluding any extension) for a rename, like an IDE.
    const dot = initialValue.lastIndexOf(".");
    if (initialValue && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initialValue]);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  return (
    <div
      className="flex items-center gap-1 px-1 py-0.5"
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <span className="inline-block w-3 shrink-0" />
      {kind === "dir" ? (
        <FolderIcon className="size-3.5 shrink-0" />
      ) : (
        <FileIcon className="size-3.5 shrink-0" />
      )}
      <input
        ref={ref}
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-label={kind === "dir" ? "Folder name" : "File name"}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
          }
          e.stopPropagation();
        }}
        className={cn(
          "min-w-0 flex-1 rounded-og-sm border bg-og-bg px-1 py-0 text-og-sm",
          "border-og-accent text-og-fg",
          "outline-none",
        )}
      />
    </div>
  );
}

/** The right-click / kebab context menu, positioned at the click point. */
function ContextMenu({
  node,
  x,
  y,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onClose,
}: {
  node: FileTreeNode;
  x: number;
  y: number;
  onRename: () => void;
  onDelete: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onClose: () => void;
}) {
  const isDir = node.kind === "dir";
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Keep the menu on-screen when opened near the viewport edge.
  const vw = typeof window !== "undefined" ? window.innerWidth : 9999;
  const vh = typeof window !== "undefined" ? window.innerHeight : 9999;
  const left = Math.max(4, Math.min(x, vw - 180));
  const top = Math.max(4, Math.min(y, vh - 160));

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const current = items.findIndex((item) => item === document.activeElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1 + items.length) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  };

  const item = (label: string, icon: ReactNode, onClick: () => void, danger?: boolean) => (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1 text-left text-og-sm pointer-coarse:min-h-11",
        "hover:bg-og-surface-2",
        danger ? "text-og-status-failed" : "text-og-fg",
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${node.name}`}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      style={{ left, top }}
      className={cn(
        "fixed z-50 min-w-[160px] overflow-hidden rounded-md border py-1 shadow-lg",
        "border-og-border",
        "bg-og-surface-1",
      )}
    >
      {isDir && (
        <>
          {item("New file", <FilePlusIcon className="size-3.5" />, onNewFile)}
          {item("New folder", <FolderPlusIcon className="size-3.5" />, onNewFolder)}
          <div role="separator" className="my-1 h-px bg-og-border" />
        </>
      )}
      {item("Rename", <PencilIcon className="size-3.5" />, onRename)}
      {item("Delete", <Trash2Icon className="size-3.5" />, onDelete, true)}
    </div>
  );
}
