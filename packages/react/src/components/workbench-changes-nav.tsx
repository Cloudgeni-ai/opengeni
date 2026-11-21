// Ways to move between the files of a change set, for WorkbenchChanges:
// a change bar and file glyph shared by all of them, a jump menu with a
// stepper (one file at a time), a slim outline beside one continuous diff,
// and a quiet tree. Each is a presentational piece; WorkbenchChanges owns the
// selection and the scrolling.
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileCode2Icon,
  FileCogIcon,
  FileIcon,
  FileJsonIcon,
  FileTextIcon,
  ImageIcon,
} from "lucide-react";
import { createContext, memo, type ReactNode, useMemo, useState } from "react";
import type { SandboxGitFileDiff } from "../hooks/use-sandbox-git";
import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/** How the person moves between changed files. */
export type WorkbenchChangesNavigation = "rail" | "focus" | "stream" | "tree";

/** The navigation for every WorkbenchChanges below, unless one passes its own. */
export const WorkbenchChangesNavigationContext = createContext<
  WorkbenchChangesNavigation | undefined
>(undefined);

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

/* ------------------------------------------------------------------ focus */

/** One file at a time: the file's name opens a jump menu of every file, and a
 *  stepper moves to the previous or next one. */
export function FocusFileSwitcher({
  files,
  index,
  onSelect,
}: {
  files: readonly SandboxGitFileDiff[];
  index: number;
  onSelect: (index: number) => void;
}) {
  const file = files[index];
  if (!file) return null;
  const { name, dir } = splitFilePath(file.path);
  const step = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < files.length) onSelect(next);
  };
  const stepClass =
    "inline-flex size-6 items-center justify-center rounded-og-sm text-og-fg-muted transition-colors hover:bg-og-surface-2 hover:text-og-fg disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:size-11";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1" data-focus-switcher="">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-focus-file-menu=""
            title={file.path}
            className="group inline-flex min-h-7 min-w-0 items-center gap-2 rounded-og-sm px-1.5 text-left transition-colors hover:bg-og-surface-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent data-[state=open]:bg-og-surface-2 pointer-coarse:min-h-11"
          >
            <FileGlyph path={file.path} />
            <span
              className={cn(
                "truncate font-og-mono text-[12px] font-medium text-og-fg",
                file.status === "deleted" && "line-through",
              )}
            >
              {name}
            </span>
            <FileChangeWords file={file} />
            {dir ? <span className="truncate text-og-xs text-og-fg-subtle">{dir}</span> : null}
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-og-fg-subtle" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-[60vh] w-[min(26rem,90vw)] overflow-y-auto"
        >
          {files.map((each, position) => {
            const parts = splitFilePath(each.path);
            return (
              <DropdownMenuItem
                key={each.path}
                onSelect={() => onSelect(position)}
                data-focus-file-option={each.path}
                className={cn(position === index && "bg-og-surface-2")}
              >
                <FileGlyph path={each.path} />
                <span className="min-w-0 flex-1 truncate">
                  <span
                    className={cn(
                      "font-og-mono text-[12px] text-og-fg",
                      each.status === "deleted" && "line-through",
                    )}
                  >
                    {parts.name}
                  </span>
                  <FileChangeWords file={each} />
                  {parts.dir ? (
                    <span className="ml-2 text-og-xs text-og-fg-subtle">{parts.dir}</span>
                  ) : null}
                </span>
                <ChangeBar additions={each.additions} deletions={each.deletions} />
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangeBar additions={file.additions} deletions={file.deletions} className="ml-1" />
      <div className="ml-auto flex shrink-0 items-center text-og-xs tabular-nums text-og-fg-subtle">
        <button
          type="button"
          aria-label="Previous file"
          title="Previous file ( [ )"
          data-focus-prev=""
          disabled={index === 0}
          onClick={() => step(-1)}
          className={stepClass}
        >
          <ChevronLeftIcon aria-hidden className="size-3.5" />
        </button>
        <span className="min-w-[3.25rem] text-center" data-focus-position="">
          {index + 1} of {files.length}
        </span>
        <button
          type="button"
          aria-label="Next file"
          title="Next file ( ] )"
          data-focus-next=""
          disabled={index >= files.length - 1}
          onClick={() => step(1)}
          className={stepClass}
        >
          <ChevronRightIcon aria-hidden className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- stream */

/** A slim outline at the pane's edge: one mark per file, sized by its place in
 *  the diff and tinted by what changed. Hover or focus opens the file names. */
export const StreamOutline = memo(function StreamOutline({
  files,
  offsets,
  totalHeight,
  activeIndex,
  onSelect,
}: {
  files: readonly SandboxGitFileDiff[];
  offsets: readonly number[];
  totalHeight: number;
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  const total = Math.max(1, totalHeight);
  return (
    <nav
      aria-label="Files"
      data-stream-outline=""
      className="group/outline relative flex w-4 shrink-0 flex-col items-center gap-[3px] py-2"
    >
      {files.map((file, index) => {
        const top = offsets[index] ?? 0;
        const bottom = offsets[index + 1] ?? totalHeight;
        const share = Math.max(0.02, (bottom - top) / total);
        const active = index === activeIndex;
        return (
          <button
            key={file.path}
            type="button"
            aria-label={file.path}
            aria-current={active ? "true" : undefined}
            data-stream-mark={file.path}
            onClick={() => onSelect(index)}
            style={{ flexGrow: share }}
            className={cn(
              "min-h-1.5 w-1 rounded-full transition-[background-color,width] duration-150 hover:w-1.5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent motion-reduce:transition-none",
              active ? "w-1.5 bg-og-accent" : "bg-og-fg-subtle/30 hover:bg-og-fg-muted",
            )}
          />
        );
      })}
      {/* The file names, shown beside the marks while the outline has hover or focus. */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-5 top-2 z-30 hidden w-64 flex-col gap-0.5 rounded-og-md bg-og-surface-1/95 p-1.5 shadow-lg ring-1 ring-og-border backdrop-blur-sm group-hover/outline:flex group-focus-within/outline:flex"
      >
        {files.map((file, index) => {
          const { name } = splitFilePath(file.path);
          return (
            <span
              key={file.path}
              className={cn(
                "flex items-center gap-2 rounded-og-sm px-1.5 py-0.5 text-og-xs",
                index === activeIndex ? "bg-og-surface-2 text-og-fg" : "text-og-fg-muted",
              )}
            >
              <FileGlyph path={file.path} className="size-3" />
              <span className="min-w-0 flex-1 truncate font-og-mono">{name}</span>
              <ChangeBar additions={file.additions} deletions={file.deletions} className="w-5" />
            </span>
          );
        })}
      </div>
    </nav>
  );
});

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
      aria-label="Changed files"
      data-changes-tree=""
      className={cn("overflow-y-auto py-1.5", className)}
    >
      {render(tree, 0)}
    </nav>
  );
});
