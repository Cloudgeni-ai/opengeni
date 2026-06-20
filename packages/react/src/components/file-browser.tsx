import { ChevronRightIcon, FileIcon, FolderIcon } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
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
  className?: string | undefined;
};

const STATUS_TINT: Record<NonNullable<FileTreeNode["status"]>, string> = {
  added: "text-[color:var(--color-success,#3fb950)]",
  modified: "text-[color:var(--color-warning,#d29922)]",
  deleted: "text-[color:var(--color-danger,#f85149)] line-through",
  renamed: "text-[color:var(--color-info,#58a6ff)]",
  untracked: "text-[color:var(--color-fg-subtle,#888)]",
};

/**
 * The file browser, fed by the FileSystem service via `useSandboxFiles`. This is
 * our `PierreTree` boundary: the built-in renderer below delivers the same UX
 * (fast lazy-expand on dir click, git-status tinting), and a consumer who has
 * Pierre's `@pierre/trees` installed can wire it in behind `renderNode` /
 * `fallback` — the hook is the reusable part, the tree chrome is swappable.
 */
export function FileBrowser({
  result,
  fallback,
  onSelectFile,
  selectedPath,
  renderNode,
  emptyState,
  className,
}: FileBrowserProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

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
      // Lazy-load children on first open.
      if (!isOpen && node.children === undefined) {
        setLoadingPaths((prev) => new Set(prev).add(node.path));
        try {
          await result.expand(node.path);
        } finally {
          setLoadingPaths((prev) => {
            const next = new Set(prev);
            next.delete(node.path);
            return next;
          });
        }
      }
    },
    [expanded, result],
  );

  if (result.error && result.tree.length === 0) {
    return (
      <div className={cn("p-3 text-xs text-[color:var(--color-fg-subtle,#888)]", className)}>
        {fallback ?? `Files unavailable: ${result.error.message}`}
      </div>
    );
  }

  if (!result.loading && result.tree.length === 0) {
    return (
      <div className={cn("p-3 text-xs text-[color:var(--color-fg-subtle,#888)]", className)}>
        {emptyState ?? "No files."}
      </div>
    );
  }

  const renderRow = (node: FileTreeNode, depth: number): ReactNode => {
    const isOpen = expanded.has(node.path);
    if (renderNode) {
      return <div key={node.path}>{renderNode(node, depth, isOpen)}</div>;
    }
    const isDir = node.kind === "dir";
    const isSelected = node.path === selectedPath;
    const isLoading = loadingPaths.has(node.path);
    return (
      <div key={node.path} role="treeitem" aria-expanded={isDir ? isOpen : undefined}>
        <button
          type="button"
          onClick={() => (isDir ? void toggle(node) : onSelectFile?.(node.path))}
          className={cn(
            "flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-xs hover:bg-[color:var(--color-bg-subtle,#1c1c1c)]",
            isSelected && "bg-[color:var(--color-bg-subtle,#1c1c1c)]",
            node.status ? STATUS_TINT[node.status] : undefined,
          )}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          {isDir ? (
            <ChevronRightIcon
              className={cn("size-3 shrink-0 transition-transform", isOpen && "rotate-90")}
            />
          ) : (
            <span className="inline-block w-3 shrink-0" />
          )}
          {isDir ? <FolderIcon className="size-3.5 shrink-0" /> : <FileIcon className="size-3.5 shrink-0" />}
          <span className="truncate">{node.name}</span>
          {isLoading && <span className="ml-1 text-[10px] opacity-60">…</span>}
        </button>
        {isDir && isOpen && node.children && node.children.length > 0 && (
          <div role="group">{node.children.map((child) => renderRow(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div role="tree" className={cn("min-w-0 overflow-auto p-1", className)} data-opengeni-file-tree>
      {result.tree.map((node) => renderRow(node, 0))}
    </div>
  );
}
