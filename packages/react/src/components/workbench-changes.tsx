import type { GitFileDiff } from "@opengeni/sdk";
import { FileWarningIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { VList } from "virtua";
import { cn } from "../lib/cn";
import { useThemeType } from "../lib/use-theme-type";
import { formatAsOf } from "../hooks/use-machine-chip";
import { useWindowedSections } from "../hooks/use-windowed-sections";
import { PierreDiff } from "./pierre-diff";

/* ----------------------------------------------------------------------------
   Changes tab — a PR-review surface.

   A file rail (status glyph, ±counts, grouped by top-level dir when the change
   set is large) on the left; a stacked, WINDOWED diff pane on the right. Only
   the file sections inside the visible window ± overscan mount a Pierre/Shiki
   highlighter (the one renderer), so a 40- or 400-file change set never mounts N
   highlighters at once (dossier §10.7, D2). A per-file >guard (binary / diff too
   large) degrades to an "open live" affordance instead of a diff body.

   `git.diff` is a single flat scope, so "group by repo then directory" here means
   "group by top-level directory" — which is exactly the repo dir in a multi-repo
   workspace and the top folder otherwise. Grouping only kicks in past the
   threshold; a small change set stays a flat list.
   -------------------------------------------------------------------------- */

/** Group the rail (and reorder the pane) once the change set is larger than this. */
const GROUP_THRESHOLD = 20;
/** Mount this many sections beyond the visible window on each side. */
const OVERSCAN = 2;
const HEADER_PX = 30;
const LINE_PX = 18;
const GUARD_BODY_PX = 52;

const STATUS_TINT: Record<GitFileDiff["status"], string> = {
  added: "text-og-status-idle",
  modified: "text-og-status-running",
  deleted: "text-og-status-failed",
  renamed: "text-og-accent",
  copied: "text-og-accent",
  untracked: "text-og-fg-subtle",
  ignored: "text-og-fg-subtle",
  conflicted: "text-og-status-failed",
  typechange: "text-og-status-running",
};

const STATUS_LETTER: Record<GitFileDiff["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  ignored: "I",
  conflicted: "!",
  typechange: "T",
};

export type WorkbenchChangesProps = {
  /** The changed files (`useSandboxGit().diff`). Assumed non-empty by the caller. */
  diff: GitFileDiff[];
  /** Which source the diff came from — drives the "live" vs "as of turn" badge. */
  source: "live" | "capture" | null;
  /** When the served capture was taken (ISO), when `source === "capture"`. */
  capturedAt: string | null;
  /** The capture's turn revision, for the "as of turn N" badge. */
  captureRevision?: number | null | undefined;
  themeType?: "dark" | "light" | undefined;
  className?: string | undefined;
};

type RailRow =
  | { kind: "group"; label: string; count: number }
  | { kind: "file"; file: GitFileDiff; index: number };

/** Order the files and build the rail rows (grouped past the threshold). The
 *  returned `orderedFiles` drives BOTH the rail and the diff pane so a rail row's
 *  `index` addresses the matching pane section. */
function buildRail(files: GitFileDiff[]): { orderedFiles: GitFileDiff[]; rows: RailRow[] } {
  if (files.length <= GROUP_THRESHOLD) {
    return { orderedFiles: files, rows: files.map((file, index) => ({ kind: "file", file, index })) };
  }
  const groups = new Map<string, GitFileDiff[]>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    const key = slash > 0 ? file.path.slice(0, slash) : "(root)";
    const bucket = groups.get(key);
    if (bucket) bucket.push(file);
    else groups.set(key, [file]);
  }
  const labels = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const orderedFiles: GitFileDiff[] = [];
  const rows: RailRow[] = [];
  for (const label of labels) {
    const bucket = (groups.get(label) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
    rows.push({ kind: "group", label, count: bucket.length });
    for (const file of bucket) {
      rows.push({ kind: "file", file, index: orderedFiles.length });
      orderedFiles.push(file);
    }
  }
  return { orderedFiles, rows };
}

/** A file's diff body is "too large to inline" when it's binary or the diff guard
 *  tripped (the backend omits hunks past its size cap) — open it live instead. */
function isGuarded(file: GitFileDiff): boolean {
  return file.isBinary || file.truncated;
}

/** Estimate a section's rendered height for the windowing math. Line-count based,
 *  so it is close enough that the first paint barely shifts as real heights land. */
function estimateSectionHeight(file: GitFileDiff): number {
  if (isGuarded(file)) return HEADER_PX + GUARD_BODY_PX;
  let lines = 0;
  for (const hunk of file.hunks) lines += hunk.lines.length + 1;
  return HEADER_PX + Math.max(lines, 1) * LINE_PX + 8;
}

export function WorkbenchChanges({
  diff,
  source,
  capturedAt,
  captureRevision,
  themeType,
  className,
}: WorkbenchChangesProps) {
  const resolvedTheme = useThemeType(themeType);
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [activeIndex, setActiveIndex] = useState(0);

  const { orderedFiles, rows } = useMemo(() => buildRail(diff), [diff]);
  const grouped = diff.length > GROUP_THRESHOLD;

  const additions = useMemo(() => diff.reduce((sum, f) => sum + f.additions, 0), [diff]);
  const deletions = useMemo(() => diff.reduce((sum, f) => sum + f.deletions, 0), [diff]);

  const estimateHeight = useCallback(
    (index: number) => {
      const file = orderedFiles[index];
      return file ? estimateSectionHeight(file) : HEADER_PX + LINE_PX;
    },
    [orderedFiles],
  );

  const windowed = useWindowedSections({
    count: orderedFiles.length,
    estimateHeight,
    overscan: OVERSCAN,
  });

  const jumpTo = useCallback(
    (index: number) => {
      setActiveIndex(index);
      windowed.scrollToIndex(index);
    },
    [windowed],
  );

  // Track which section is at the top of the pane so the rail highlights it.
  const onPaneScroll = useCallback(() => {
    const el = windowed.scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const offsets = windowed.offsets;
    let idx = 0;
    for (let i = 0; i < orderedFiles.length; i++) {
      if ((offsets[i] ?? 0) <= top + 4) idx = i;
      else break;
    }
    setActiveIndex((prev) => (prev === idx ? prev : idx));
  }, [windowed, orderedFiles.length]);

  useEffect(() => {
    const el = windowed.scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", onPaneScroll, { passive: true });
    return () => el.removeEventListener("scroll", onPaneScroll);
  }, [windowed.scrollRef, onPaneScroll]);

  const sourceBadge = describeSource(source, capturedAt, captureRevision ?? null);

  return (
    <div className={cn("flex h-full min-h-0 min-w-0 flex-col", className)}>
      {/* Summary + source badge + layout toggle. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-og-border px-3 py-1.5">
        <span className="min-w-0 truncate text-og-xs text-og-fg-muted">
          {diff.length} {diff.length === 1 ? "file" : "files"} changed
          <span className="ml-2 text-og-status-idle">+{additions}</span>
          <span className="ml-1 text-og-status-failed">−{deletions}</span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <LayoutToggle layout={layout} onChange={setLayout} />
          <span
            className="rounded-og-xs bg-og-surface-2 px-1.5 py-px text-2xs text-og-fg-subtle"
            title={source === "capture" && capturedAt ? new Date(capturedAt).toLocaleString() : undefined}
          >
            {sourceBadge}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* File rail — virtualized (virtua): a dense change set is fine. */}
        <div className="w-[240px] shrink-0 border-r border-og-border max-[560px]:w-[168px]">
          <VList className="h-full" itemSize={26}>
            {rows.map((row) =>
              row.kind === "group" ? (
                <div
                  key={`g:${row.label}`}
                  className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-2xs font-medium uppercase tracking-wide text-og-fg-subtle"
                >
                  <span className="min-w-0 truncate">{row.label}</span>
                  <span className="shrink-0 opacity-70">{row.count}</span>
                </div>
              ) : (
                <RailFileRow
                  key={row.file.path}
                  file={row.file}
                  grouped={grouped}
                  active={row.index === activeIndex}
                  onClick={() => jumpTo(row.index)}
                />
              ),
            )}
          </VList>
        </div>

        {/* Diff pane — windowed file sections. Only the sections inside the
            visible window ± overscan are in the DOM; the container reserves the
            full scroll height so scrolling + the rail-jump stay accurate. */}
        <div
          ref={windowed.scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-auto"
          data-opengeni-changes-pane
        >
          <div style={{ position: "relative", height: windowed.totalHeight }}>
            {orderedFiles.map((file, index) => {
              if (index < windowed.range.start || index >= windowed.range.end) return null;
              return (
                <div
                  key={file.path}
                  ref={(node) => windowed.measure(index, node)}
                  data-diff-section
                  data-diff-index={index}
                  style={{ position: "absolute", top: windowed.offsets[index] ?? 0, left: 0, right: 0 }}
                >
                  <DiffSection file={file} layout={layout} themeType={resolvedTheme} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** "live" · "as of turn 7 · 14:32" · "as of 14:32" (no revision). */
function describeSource(
  source: "live" | "capture" | null,
  capturedAt: string | null,
  revision: number | null,
): string {
  if (source !== "capture" || !capturedAt) return "live";
  const time = formatAsOf(capturedAt, Date.now());
  return revision !== null ? `as of turn ${revision} · ${time}` : `as of ${time}`;
}

function RailFileRow({
  file,
  grouped,
  active,
  onClick,
}: {
  file: GitFileDiff;
  grouped: boolean;
  active: boolean;
  onClick: () => void;
}) {
  // In a grouped rail the top-level dir is the group header, so show the path
  // beneath it; otherwise show the whole path.
  const shown = grouped ? file.path.slice(file.path.indexOf("/") + 1) || file.path : file.path;
  return (
    <button
      type="button"
      onClick={onClick}
      title={file.path}
      className={cn(
        "flex w-full items-center gap-1.5 truncate px-2 py-0.5 text-left text-og-sm hover:bg-og-surface-2 pointer-coarse:min-h-10",
        grouped && "pl-3",
        active && "bg-og-surface-2",
      )}
    >
      <span className={cn("w-3 shrink-0 text-center font-og-mono text-og-xs", STATUS_TINT[file.status])}>
        {STATUS_LETTER[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate">{shown}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 font-og-mono text-2xs">
        <span className="text-og-status-idle">+{file.additions}</span>
        <span className="text-og-status-failed">−{file.deletions}</span>
      </span>
    </button>
  );
}

function DiffSection({
  file,
  layout,
  themeType,
}: {
  file: GitFileDiff;
  layout: "unified" | "split";
  themeType: "dark" | "light";
}) {
  const renamed = file.oldPath && file.oldPath !== file.path;
  return (
    <section className="border-b border-og-border pb-2">
      <header className="flex items-center justify-between gap-2 bg-og-surface-1/80 px-3 py-1.5 text-og-sm backdrop-blur">
        <span className="min-w-0 truncate font-og-mono text-og-xs">
          {renamed ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="flex shrink-0 items-center gap-2 font-og-mono text-2xs">
          <span className="text-og-status-idle">+{file.additions}</span>
          <span className="text-og-status-failed">−{file.deletions}</span>
        </span>
      </header>
      {isGuarded(file) ? (
        <GuardBody file={file} />
      ) : (
        <PierreDiff diff={[file]} layout={layout} themeType={themeType} className="px-1" />
      )}
    </section>
  );
}

/** The per-file guard: a binary file or an over-cap diff opens live rather than
 *  inlining a body we don't (fully) have. */
function GuardBody({ file }: { file: GitFileDiff }) {
  const reason = file.isBinary ? "Binary file" : "Diff too large to show here";
  return (
    <div className="flex items-center gap-2 px-3 py-3 text-og-sm text-og-fg-subtle">
      <FileWarningIcon className="size-3.5 shrink-0" />
      <span className="min-w-0">
        {reason} — open it on the machine to view.
      </span>
    </div>
  );
}

function LayoutToggle({
  layout,
  onChange,
}: {
  layout: "unified" | "split";
  onChange: (next: "unified" | "split") => void;
}) {
  return (
    <div className="inline-flex items-center rounded-og-sm border border-og-border p-0.5">
      {(["unified", "split"] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={cn(
            "rounded-og-xs px-1.5 py-0.5 text-2xs capitalize pointer-coarse:min-h-10",
            layout === value ? "bg-og-accent-soft text-og-fg" : "text-og-fg-subtle hover:text-og-fg",
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}
