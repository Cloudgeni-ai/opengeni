import {
  ChevronRightIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn";
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
   * Defaults to `window.confirm`. Pass a no-op returning `true` to skip.
   */
  confirmDelete?: ((node: FileTreeNode) => boolean | Promise<boolean>) | undefined;
  className?: string | undefined;
};

const STATUS_TINT: Record<NonNullable<FileTreeNode["status"]>, string> = {
  added: "text-[color:var(--og-color-status-idle,var(--color-success,#3fb950))]",
  modified: "text-[color:var(--og-color-status-running,var(--color-warning,#d29922))]",
  deleted: "text-[color:var(--og-color-danger,var(--color-danger,#f85149))] line-through",
  renamed: "text-[color:var(--og-color-accent,var(--color-info,#58a6ff))]",
  untracked: "text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]",
};

/** Parent dir of a workspace-relative POSIX path ("" for a root entry). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

/** Join a parent dir with a leaf name (handles the root "" parent). */
function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
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
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

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

  // The visible rows in DOM order — drives keyboard up/down navigation.
  const flatRows = useMemo(() => {
    const rows: { node: FileTreeNode; depth: number }[] = [];
    const walk = (nodes: FileTreeNode[], depth: number) => {
      for (const node of nodes) {
        rows.push({ node, depth });
        if (node.kind === "dir" && expanded.has(node.path) && node.children?.length) {
          walk(node.children, depth + 1);
        }
      }
    };
    walk(result.tree, 0);
    return rows;
  }, [result.tree, expanded]);

  const supportsMutation = editable;

  const runDelete = useCallback(
    async (node: FileTreeNode) => {
      if (!supportsMutation) return;
      const recursive = node.kind === "dir";
      const confirmFn =
        confirmDelete ??
        ((n: FileTreeNode) =>
          typeof window !== "undefined" && typeof window.confirm === "function"
            ? window.confirm(
                `Delete ${n.kind === "dir" ? "folder" : "file"} "${n.name}"${recursive ? " and its contents" : ""}?`,
              )
            : true);
      const ok = await confirmFn(node);
      if (!ok) return;
      setBusy(true);
      try {
        await result.deleteEntry(node.path, recursive);
      } catch {
        // The hook surfaces the error on `result.error`; the panel renders it.
      } finally {
        setBusy(false);
      }
    },
    [supportsMutation, confirmDelete, result],
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
    [draftCreate, draftRename, flatRows, cursor, expanded, open, toggle, onSelectFile, startRename, runDelete, supportsMutation],
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

  if (result.error && result.tree.length === 0) {
    return (
      <div className={cn("p-3 text-xs text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]", className)}>
        {fallback ?? `Files unavailable: ${result.error.message}`}
      </div>
    );
  }

  const showEmpty = !result.loading && result.tree.length === 0 && !draftCreate;

  const renderRow = (node: FileTreeNode, depth: number): ReactNode => {
    const isOpen = expanded.has(node.path);
    if (renderNode) {
      return <div key={node.path}>{renderNode(node, depth, isOpen)}</div>;
    }
    const isDir = node.kind === "dir";
    const isSelected = node.path === selectedPath || node.path === active;
    const isCursor = node.path === cursor;
    const isLoading = loadingPaths.has(node.path) || result.expandingPaths.has(node.path);
    const isRenaming = draftRename?.path === node.path;
    const isDropTarget = dragOver === (isDir ? node.path : parentOf(node.path));
    const showSkeleton = isDir && isOpen && isLoading && (node.children === undefined || node.children.length === 0);
    const dropDir = isDir ? node.path : parentOf(node.path);

    return (
      <div
        key={node.path}
        role="treeitem"
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
              "group flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-xs",
              "hover:bg-[color:var(--og-color-surface-2,var(--color-bg-subtle,#1c1c1c))]",
              isSelected && "bg-[color:var(--og-color-surface-2,var(--color-bg-subtle,#1c1c1c))]",
              isCursor &&
                "outline outline-1 -outline-offset-1 outline-[color:var(--og-color-accent,var(--color-info,#58a6ff))]",
              isDropTarget &&
                "ring-1 ring-inset ring-[color:var(--og-color-accent,var(--color-info,#58a6ff))] bg-[color:var(--og-color-accent-soft,rgba(88,166,255,0.12))]",
              node.status ? STATUS_TINT[node.status] : undefined,
            )}
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
          >
            {isDir ? (
              isLoading ? (
                <Loader2Icon
                  className="size-3 shrink-0 animate-spin text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]"
                  aria-label="Loading"
                />
              ) : (
                <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", isOpen && "rotate-90")} />
              )
            ) : (
              <span className="inline-block w-3 shrink-0" />
            )}
            {isDir ? <FolderIcon className="size-3.5 shrink-0" /> : <FileIcon className="size-3.5 shrink-0" />}
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
                className="ml-auto hidden shrink-0 px-1 text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))] hover:text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))] group-hover:inline"
              >
                ⋯
              </span>
            )}
          </button>
        )}

        {/* Inline create input nested directly under an expanded directory. */}
        {draftCreate?.parent === node.path && isDir && isOpen && (
          <InlineInput
            depth={depth + 1}
            kind={draftCreate.kind}
            initialValue=""
            onCommit={(name) => void commitCreate(name)}
            onCancel={() => setDraftCreate(null)}
          />
        )}

        {showSkeleton && (
          <div
            role="group"
            aria-hidden
            style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}
            className="space-y-1 py-1"
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-2.5 animate-pulse rounded bg-[color:var(--og-color-surface-2,var(--color-bg-subtle,#1c1c1c))]"
                style={{ width: `${70 - i * 12}%` }}
              />
            ))}
          </div>
        )}
        {isDir && isOpen && node.children && node.children.length > 0 && (
          <div role="group">{node.children.map((child) => renderRow(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      {supportsMutation && (
        <div className="flex shrink-0 items-center gap-0.5 border-b border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] px-1 py-1">
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
            onClick={() => {
              const node = cursor ? findNode(result.tree, cursor) : undefined;
              if (node) void runDelete(node);
            }}
            disabled={busy || !cursor}
          >
            <Trash2Icon className="size-3.5" />
          </ToolbarButton>
          <span className="ml-auto" />
          <ToolbarButton label="Refresh" onClick={() => void result.refresh()} disabled={busy || result.loading}>
            <RefreshCwIcon className={cn("size-3.5", result.loading && "animate-spin")} />
          </ToolbarButton>
        </div>
      )}

      {/* The tree itself. The root is a drop target so a node can be moved to "". */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the tree owns keyboard nav */}
      <div
        ref={containerRef}
        role="tree"
        tabIndex={0}
        aria-multiselectable={false}
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
          "min-w-0 flex-1 overflow-auto p-1 outline-none",
          dragOver === "" && "ring-1 ring-inset ring-[color:var(--og-color-accent,var(--color-info,#58a6ff))]",
        )}
        data-opengeni-file-tree
      >
        {/* A root-level create input sits above the rows. */}
        {draftCreate?.parent === "" && (
          <InlineInput
            depth={0}
            kind={draftCreate.kind}
            initialValue=""
            onCommit={(name) => void commitCreate(name)}
            onCancel={() => setDraftCreate(null)}
          />
        )}
        {showEmpty ? (
          <div className="p-2 text-xs text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
            {emptyState ?? "No files."}
          </div>
        ) : (
          result.tree.map((node) => renderRow(node, 0))
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
        />
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
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
        "inline-flex items-center justify-center rounded p-1 text-[color:var(--og-color-fg-muted,var(--color-fg-muted,#aaa))]",
        "hover:bg-[color:var(--og-color-surface-2,var(--color-bg-subtle,#1c1c1c))] hover:text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]",
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
    <div className="flex items-center gap-1 px-1 py-0.5" style={{ paddingLeft: `${depth * 12 + 4}px` }}>
      <span className="inline-block w-3 shrink-0" />
      {kind === "dir" ? <FolderIcon className="size-3.5 shrink-0" /> : <FileIcon className="size-3.5 shrink-0" />}
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
          "min-w-0 flex-1 rounded border bg-[color:var(--og-color-bg,var(--color-bg,#0d0d0d))] px-1 py-0 text-xs",
          "border-[color:var(--og-color-accent,var(--color-info,#58a6ff))] text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]",
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
}: {
  node: FileTreeNode;
  x: number;
  y: number;
  onRename: () => void;
  onDelete: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}) {
  const isDir = node.kind === "dir";
  // Keep the menu on-screen when opened near the viewport edge.
  const vw = typeof window !== "undefined" ? window.innerWidth : 9999;
  const vh = typeof window !== "undefined" ? window.innerHeight : 9999;
  const left = Math.min(x, vw - 180);
  const top = Math.min(y, vh - 160);

  const item = (label: string, icon: ReactNode, onClick: () => void, danger?: boolean) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs",
        "hover:bg-[color:var(--og-color-surface-2,var(--color-bg-subtle,#1c1c1c))]",
        danger
          ? "text-[color:var(--og-color-danger,var(--color-danger,#f85149))]"
          : "text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]",
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      style={{ left, top }}
      className={cn(
        "fixed z-50 min-w-[160px] overflow-hidden rounded-md border py-1 shadow-lg",
        "border-[color:var(--og-color-border,var(--color-border,#2a2a2a))]",
        "bg-[color:var(--og-color-surface-1,var(--color-surface,#161616))]",
      )}
    >
      {isDir && (
        <>
          {item("New file", <FilePlusIcon className="size-3.5" />, onNewFile)}
          {item("New folder", <FolderPlusIcon className="size-3.5" />, onNewFolder)}
          <div className="my-1 h-px bg-[color:var(--og-color-border,var(--color-border,#2a2a2a))]" />
        </>
      )}
      {item("Rename", <PencilIcon className="size-3.5" />, onRename)}
      {item("Delete", <Trash2Icon className="size-3.5" />, onDelete, true)}
    </div>
  );
}
