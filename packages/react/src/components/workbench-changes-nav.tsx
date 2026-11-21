// The quiet tree of changed files for WorkbenchChanges, with the change bar
// and file glyph it shares with the diff headers. Presentational only;
// WorkbenchChanges owns the selection and the scrolling.
import {
  ChevronRightIcon,
  FileCode2Icon,
  FileCogIcon,
  FileIcon,
  FileJsonIcon,
  FileTextIcon,
  ImageIcon,
} from "lucide-react";
import { memo, type ReactNode, useMemo, useState } from "react";
import type { SandboxGitFileDiff } from "../hooks/use-sandbox-git";
import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";

/** How the person moves between changed files. */
export type WorkbenchChangesNavigation = "rail" | "tree";

export function splitFilePath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  return slash >= 0
    ? { name: path.slice(slash + 1), dir: path.slice(0, slash) }
    : { name: path, dir: "" };
}

const CODE =
  /\.(tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|sql|vue|svelte|css|scss|html)$/i;
const CONFIG = /(\.(ya?ml|toml|ini|tf|tfvars|env|lock|conf)|Dockerfile|Makefile)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;

/** A small file-type glyph, muted, from the file name. */
export function FileGlyph({ path, className }: { path: string; className?: string }) {
  const Icon = IMAGE.test(path)
    ? ImageIcon
    : /\.json$/i.test(path)
      ? FileJsonIcon
      : CODE.test(path)
        ? FileCode2Icon
        : CONFIG.test(path)
          ? FileCogIcon
          : /\.(md|mdx|txt|rst)$/i.test(path)
            ? FileTextIcon
            : FileIcon;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-og-fg-subtle", className)} />;
}

/** The file's size of change at a glance: a slim bar whose filled length
 *  grows with the lines touched, split into added and removed. */
export const ChangeBar = memo(function ChangeBar({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  const total = additions + deletions;
  // Log scale: a 3-line fix and a 300-line rewrite both stay readable.
  const fill = total === 0 ? 0 : Math.min(1, Math.log10(total + 1) / Math.log10(400));
  const added = total === 0 ? 0 : (additions / total) * fill * 100;
  const removed = total === 0 ? 0 : (deletions / total) * fill * 100;
  return (
    <span
      aria-hidden
      title={`+${additions} −${deletions}`}
      data-change-bar=""
      className={cn(
        "relative inline-flex h-1 w-7 shrink-0 overflow-hidden rounded-full bg-og-surface-2",
        className,
      )}
    >
      <span className="h-full bg-og-status-idle" style={{ width: `${added}%` }} />
      <span className="h-full bg-og-status-failed" style={{ width: `${removed}%` }} />
    </span>
  );
});

/** The file's change in words, for screen readers (the bar and strikethrough
 *  carry it visually): "Deleted, 0 added, 12 removed". */
export function FileChangeWords({
  file,
}: {
  file: Pick<SandboxGitFileDiff, "status" | "additions" | "deletions">;
}) {
  const t = useOpenGeniText();
  const status =
    file.status === "added" || file.status === "untracked"
      ? t("workbenchChanges.statusAdded")
      : file.status === "deleted"
        ? t("workbenchChanges.statusDeleted")
        : file.status === "renamed" || file.status === "copied"
          ? t("workbenchChanges.statusRenamed")
          : t("workbenchChanges.statusModified");
  return (
    <span className="sr-only">
      {", "}
      {t("workbenchChanges.fileChange", {
        status,
        additions: file.additions,
        deletions: file.deletions,
      })}
    </span>
  );
}

/* ------------------------------------------------------------------- tree */

type TreeNode = {
  name: string;
  path: string;
  dirs: TreeNode[];
  files: { file: SandboxGitFileDiff; index: number }[];
};

/** Folders with a single child folder fold into one row ("apps/api/src"). */
export function buildChangesTree(files: readonly SandboxGitFileDiff[]): TreeNode {
  const root: TreeNode = { name: "", path: "", dirs: [], files: [] };
  files.forEach((file, index) => {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.find((dir) => dir.name === part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push({ file, index });
  });
  const fold = (node: TreeNode): TreeNode => {
    let current = node;
    while (current.files.length === 0 && current.dirs.length === 1 && current.path) {
      const only = current.dirs[0]!;
      current = { ...only, name: `${current.name}/${only.name}` };
    }
    return { ...current, dirs: current.dirs.map(fold) };
  };
  return { ...root, dirs: root.dirs.map(fold) };
}

/** A quiet tree of the changed files: folders, glyphs and change bars, no boxes. */
export const ChangesTree = memo(function ChangesTree({
  files,
  activeIndex,
  onSelect,
  className,
}: {
  files: readonly SandboxGitFileDiff[];
  activeIndex: number;
  onSelect: (index: number) => void;
  className?: string;
}) {
  const t = useOpenGeniText();
  const tree = useMemo(() => buildChangesTree(files), [files]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (path: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const render = (node: TreeNode, depth: number): ReactNode[] => [
    ...node.dirs.flatMap((dir) => {
      const open = !closed.has(dir.path);
      return [
        <button
          key={`d:${dir.path}`}
          type="button"
          aria-expanded={open}
          onClick={() => toggle(dir.path)}
          data-tree-dir={dir.path}
          style={{ paddingLeft: 8 + depth * 10 }}
          className="flex min-h-6 w-full items-center gap-1.5 pr-2 text-left text-og-xs text-og-fg-subtle transition-colors hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent pointer-coarse:min-h-11"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          />
          <span className="min-w-0 truncate">{dir.name}</span>
        </button>,
        ...(open ? render(dir, depth + 1) : []),
      ];
    }),
    ...node.files.map(({ file, index }) => {
      const active = index === activeIndex;
      const { name } = splitFilePath(file.path);
      return (
        <button
          key={`f:${file.path}`}
          type="button"
          onClick={() => onSelect(index)}
          title={file.path}
          data-rail-file=""
          data-rail-file-path={file.path}
          aria-current={active ? "true" : undefined}
          style={{ paddingLeft: 8 + depth * 10 + 14 }}
          className={cn(
            "relative flex min-h-6 w-full items-center gap-1.5 pr-2 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent pointer-coarse:min-h-11",
            active
              ? "bg-og-accent-soft text-og-fg before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-og-accent"
              : "text-og-fg-muted hover:bg-og-surface-2/60 hover:text-og-fg",
          )}
        >
          <FileGlyph path={file.path} className={cn(active && "text-og-fg-muted")} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-og-mono text-[12px]",
              file.status === "deleted" && "line-through opacity-70",
            )}
          >
            {name}
          </span>
          <FileChangeWords file={file} />
          <ChangeBar additions={file.additions} deletions={file.deletions} className="w-5" />
        </button>
      );
    }),
  ];
  return (
    <nav
      aria-label={t("workbenchChanges.changedFiles")}
      data-changes-tree=""
      className={cn("overflow-y-auto py-1.5", className)}
    >
      {render(tree, 0)}
    </nav>
  );
});
