import type { GitDiffLine, GitFileDiff } from "@opengeni/sdk";
import { type ReactNode } from "react";
import { cn } from "../lib/cn";

/** Theme tokens for the diff line backgrounds. */
export type DiffTheme = {
  addBackground?: string;
  delBackground?: string;
  contextBackground?: string;
  metaForeground?: string;
};

export type DiffViewProps = {
  /** From `useSandboxGit().diff` — the structured per-file hunks. */
  diff: GitFileDiff[];
  /** Rendered instead of the built-in diff (the Pierre-swap escape hatch). */
  fallback?: ReactNode | undefined;
  /** unified | split. Default "unified". */
  layout?: "unified" | "split" | undefined;
  theme?: DiffTheme | undefined;
  onSelectFile?: ((path: string) => void) | undefined;
  /** Distinguishes "no changes" from "no repository mounted". */
  isRepo?: boolean | undefined;
  emptyState?: ReactNode | undefined;
  className?: string | undefined;
};

const STATUS_LABEL: Record<GitFileDiff["status"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  untracked: "untracked",
  ignored: "ignored",
  conflicted: "conflicted",
  typechange: "typechange",
};

/**
 * The diff view, fed by the Git service via `useSandboxGit().diff`. This is our
 * `PierreDiff` boundary: the built-in renderer delivers the same UX (per-file
 * hunks, unified or side-by-side, old/new line numbers, add/del counts), and a
 * consumer with Pierre's `@pierre/diffs` installed can swap it via `fallback`
 * while keeping the same `GitFileDiff[]` data contract from the hook.
 */
export function DiffView({
  diff,
  fallback,
  layout = "unified",
  theme,
  onSelectFile,
  isRepo = true,
  emptyState,
  className,
}: DiffViewProps) {
  if (fallback !== undefined) {
    return <div className={className}>{fallback}</div>;
  }

  if (diff.length === 0) {
    return (
      <div className={cn("p-3 text-xs text-[color:var(--color-fg-subtle,#888)]", className)}>
        {emptyState ?? (isRepo ? "No changes." : "No repository mounted.")}
      </div>
    );
  }

  return (
    <div className={cn("min-w-0 overflow-auto", className)} data-opengeni-diff>
      {diff.map((file) => (
        <FileDiffBlock
          key={file.path}
          file={file}
          layout={layout}
          theme={theme}
          {...(onSelectFile ? { onSelect: () => onSelectFile(file.path) } : {})}
        />
      ))}
    </div>
  );
}

function FileDiffBlock({
  file,
  layout,
  theme,
  onSelect,
}: {
  file: GitFileDiff;
  layout: "unified" | "split";
  theme: DiffTheme | undefined;
  onSelect?: (() => void) | undefined;
}) {
  return (
    <section className="mb-2 overflow-hidden rounded border border-[color:var(--color-border,#2a2a2a)]">
      <header
        className={cn(
          "flex items-center justify-between gap-2 border-b border-[color:var(--color-border,#2a2a2a)] bg-[color:var(--color-bg-subtle,#161616)] px-2 py-1 text-xs",
          onSelect && "cursor-pointer",
        )}
        onClick={onSelect}
      >
        <span className="truncate font-mono">
          {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded bg-[color:var(--color-bg,#0d0d0d)] px-1 py-0.5 text-[10px] uppercase tracking-wide text-[color:var(--color-fg-subtle,#888)]">
            {STATUS_LABEL[file.status]}
          </span>
          <span className="text-[color:var(--color-success,#3fb950)]">+{file.additions}</span>
          <span className="text-[color:var(--color-danger,#f85149)]">−{file.deletions}</span>
        </span>
      </header>
      {file.isBinary ? (
        <div className="px-2 py-3 text-xs text-[color:var(--color-fg-subtle,#888)]">Binary file not shown.</div>
      ) : file.truncated ? (
        <div className="px-2 py-3 text-xs text-[color:var(--color-fg-subtle,#888)]">Diff too large — truncated.</div>
      ) : layout === "split" ? (
        <SplitHunks file={file} theme={theme} />
      ) : (
        <UnifiedHunks file={file} theme={theme} />
      )}
    </section>
  );
}

function lineBg(type: GitDiffLine["type"], theme: DiffTheme | undefined): string | undefined {
  if (type === "add") return theme?.addBackground ?? "var(--color-diff-add, rgba(63,185,80,0.15))";
  if (type === "del") return theme?.delBackground ?? "var(--color-diff-del, rgba(248,81,73,0.15))";
  if (type === "meta") return undefined;
  return theme?.contextBackground;
}

function marker(type: GitDiffLine["type"]): string {
  if (type === "add") return "+";
  if (type === "del") return "−";
  return " ";
}

function UnifiedHunks({ file, theme }: { file: GitFileDiff; theme: DiffTheme | undefined }) {
  return (
    <div className="font-mono text-[11px] leading-tight">
      {file.hunks.map((hunk, hi) => (
        <div key={`${file.path}-h${hi}`}>
          <div
            className="px-2 py-0.5 text-[color:var(--color-info,#58a6ff)]"
            style={{ color: theme?.metaForeground }}
          >
            {hunk.header}
          </div>
          {hunk.lines.map((line, li) => (
            <div
              key={`${file.path}-h${hi}-l${li}`}
              className="flex"
              style={{ backgroundColor: lineBg(line.type, theme) }}
            >
              <span className="w-10 shrink-0 select-none px-1 text-right text-[color:var(--color-fg-subtle,#666)]">
                {line.oldNo ?? ""}
              </span>
              <span className="w-10 shrink-0 select-none px-1 text-right text-[color:var(--color-fg-subtle,#666)]">
                {line.newNo ?? ""}
              </span>
              <span className="w-4 shrink-0 select-none text-center text-[color:var(--color-fg-subtle,#888)]">
                {marker(line.type)}
              </span>
              <span className="whitespace-pre-wrap break-all px-1">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SplitHunks({ file, theme }: { file: GitFileDiff; theme: DiffTheme | undefined }) {
  return (
    <div className="font-mono text-[11px] leading-tight">
      {file.hunks.map((hunk, hi) => {
        // Pair del/add lines side-by-side; context spans both columns.
        const left: (GitDiffLine | null)[] = [];
        const right: (GitDiffLine | null)[] = [];
        for (const line of hunk.lines) {
          if (line.type === "context" || line.type === "meta") {
            left.push(line);
            right.push(line);
          } else if (line.type === "del") {
            left.push(line);
          } else {
            right.push(line);
          }
        }
        const rows = Math.max(left.length, right.length);
        return (
          <div key={`${file.path}-h${hi}`}>
            <div className="px-2 py-0.5 text-[color:var(--color-info,#58a6ff)]" style={{ color: theme?.metaForeground }}>
              {hunk.header}
            </div>
            {Array.from({ length: rows }).map((_, ri) => {
              const l = left[ri] ?? null;
              const r = right[ri] ?? null;
              return (
                <div key={`${file.path}-h${hi}-r${ri}`} className="flex">
                  <span
                    className="flex w-1/2 min-w-0"
                    style={{ backgroundColor: l ? lineBg(l.type, theme) : undefined }}
                  >
                    <span className="w-10 shrink-0 select-none px-1 text-right text-[color:var(--color-fg-subtle,#666)]">
                      {l?.oldNo ?? ""}
                    </span>
                    <span className="whitespace-pre-wrap break-all px-1">{l?.text ?? ""}</span>
                  </span>
                  <span
                    className="flex w-1/2 min-w-0 border-l border-[color:var(--color-border,#2a2a2a)]"
                    style={{ backgroundColor: r ? lineBg(r.type, theme) : undefined }}
                  >
                    <span className="w-10 shrink-0 select-none px-1 text-right text-[color:var(--color-fg-subtle,#666)]">
                      {r?.newNo ?? ""}
                    </span>
                    <span className="whitespace-pre-wrap break-all px-1">{r?.text ?? ""}</span>
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
