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
  FlaskConicalIcon,
  ImageIcon,
  PaletteIcon,
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
const TEST = /(\.|\/|^)(test|spec)s?(\.|\/)|__tests__\//i;
const STYLE = /\.(css|scss|sass|less)$/i;

// File-type hues, mixed with the foreground so they stay soft in both themes.
const tone = (hue: string) => `color-mix(in oklch, ${hue} 72%, var(--og-color-fg))`;
const TONE = {
  code: tone("oklch(0.68 0.13 250)"),
  test: tone("oklch(0.7 0.13 165)"),
  json: tone("oklch(0.75 0.14 75)"),
  style: tone("oklch(0.68 0.14 330)"),
  config: tone("oklch(0.68 0.11 295)"),
  image: tone("oklch(0.7 0.13 25)"),
} as const;

/** A small file-type glyph, tinted by kind, from the file name. */
export function FileGlyph({ path, className }: { path: string; className?: string }) {
  const [Icon, color] = IMAGE.test(path)
    ? [ImageIcon, TONE.image]
    : /\.json$/i.test(path)
      ? [FileJsonIcon, TONE.json]
      : STYLE.test(path)
        ? [PaletteIcon, TONE.style]
        : TEST.test(path) && CODE.test(path)
          ? [FlaskConicalIcon, TONE.test]
          : CODE.test(path)
            ? [FileCode2Icon, TONE.code]
            : CONFIG.test(path)
              ? [FileCogIcon, TONE.config]
              : /\.(md|mdx|txt|rst)$/i.test(path)
                ? [FileTextIcon, undefined]
                : [FileIcon, undefined];
  return (
    <Icon
      aria-hidden
      data-file-glyph=""
      className={cn("size-3.5 shrink-0 text-og-fg-subtle", className)}
      {...(color ? { style: { color } } : {})}
    />
  );
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
        "relative inline-flex h-[3px] w-7 shrink-0 gap-px overflow-hidden rounded-full bg-og-surface-2/70",
        className,
      )}
    >
      <span className="h-full rounded-full bg-og-status-idle/85" style={{ width: `${added}%` }} />
      <span
        className="h-full rounded-full bg-og-status-failed/85"
        style={{ width: `${removed}%` }}
      />
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
  // Hairline guides, one per enclosing folder.
  const guides = (depth: number) =>
    Array.from({ length: depth }, (_, level) => (
      <span
        // Guides are positional by level.
        // oxlint-disable-next-line react/no-array-index-key
        key={level}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-px bg-og-border/60"
        style={{ left: 16 + level * 12 }}
      />
    ));
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
          style={{ paddingLeft: 10 + depth * 12 }}
          className="relative flex min-h-[26px] w-full items-center gap-1.5 pr-3 text-left text-og-xs text-og-fg-subtle transition-colors duration-150 hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent pointer-coarse:min-h-11"
        >
          {guides(depth)}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 opacity-70 transition-transform duration-200 motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 truncate font-medium">{dir.name}</span>
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
          style={{ paddingLeft: 10 + depth * 12 + 16 }}
          className={cn(
            "group/row relative flex min-h-[26px] w-full items-center gap-2 pr-3 text-left transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent motion-reduce:transition-none pointer-coarse:min-h-11",
            "before:absolute before:inset-y-px before:left-1.5 before:right-1.5 before:-z-0 before:rounded-lg before:transition-colors before:duration-150",
            active
              ? "text-og-fg before:bg-og-surface-2 before:shadow-[inset_0_1px_0_color-mix(in_oklch,var(--og-color-fg)_7%,transparent),0_0_0_1px_color-mix(in_oklch,var(--og-color-fg)_6%,transparent)]"
              : "text-og-fg-muted hover:text-og-fg hover:before:bg-og-surface-2/50",
          )}
        >
          {guides(depth)}
          <FileGlyph path={file.path} className="relative" />
          <span
            className={cn(
              "relative min-w-0 flex-1 truncate font-og-mono text-[12px]",
              file.status === "deleted" && "line-through opacity-70",
            )}
          >
            {name}
          </span>
          <FileChangeWords file={file} />
          <ChangeBar
            additions={file.additions}
            deletions={file.deletions}
            className={cn(
              "relative w-5 opacity-60 transition-opacity duration-150 group-hover/row:opacity-100",
              active && "opacity-100",
            )}
          />
        </button>
      );
    }),
  ];
  return (
    <nav
      aria-label={t("workbenchChanges.changedFiles")}
      data-changes-tree=""
      className={cn("isolate overflow-y-auto py-2", className)}
    >
      {render(tree, 0)}
    </nav>
  );
});
