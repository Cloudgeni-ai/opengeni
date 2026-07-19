import type { GitFileDiff } from "@opengeni/sdk";
import { ArrowUpRightIcon, FileWarningIcon, HistoryIcon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { VList } from "virtua";
import { cn } from "../lib/cn";
import { useUnicodeFallbackFonts } from "../lib/use-unicode-fonts";
import { useThemeType } from "../lib/use-theme-type";
import { formatAsOf } from "../hooks/use-machine-chip";
import type { SandboxGitFileDiff } from "../hooks/use-sandbox-git";
import { useWindowedSections } from "../hooks/use-windowed-sections";
import { PierreDiff } from "./pierre-diff";

/* ----------------------------------------------------------------------------
   Changes tab — a PR-review surface.

   A file rail (status glyph, ±counts, grouped by repository when metadata is
   available, otherwise by top-level directory for a large legacy input) on the
   left; a stacked, WINDOWED diff pane on the right. Only
   the file sections inside the visible window ± overscan mount a Pierre/Shiki
   highlighter (the one renderer), so a 40- or 400-file change set never mounts N
   highlighters at once (dossier §10.7, D2). A per-file >guard (binary / diff too
   large) degrades to an "open live" affordance instead of a diff body.

   Workspace-wide Git results carry an explicit `repoRoot`, so grouping never
   guesses repository ownership from a directory name. Multi-repo results group
   at every size; legacy unscoped inputs group by top-level directory only past
   the threshold.
   -------------------------------------------------------------------------- */

/** Group the rail (and reorder the pane) once the change set is larger than this. */
const GROUP_THRESHOLD = 20;
/** Mount this many sections beyond the visible window on each side. */
const OVERSCAN = 2;
const HEADER_PX = 30;
const LINE_PX = 18;
const GUARD_BODY_PX = 52;
const COMPACT_SURFACE_PX = 560;
const useChangesLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

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

function compactFileLabel(file: SandboxGitFileDiff): string {
  const slash = file.path.lastIndexOf("/");
  const basename = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const parent = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  return `${STATUS_LETTER[file.status]} · ${basename}${parent ? ` — ${parent}` : ""}`;
}

export type WorkbenchChangesProps = {
  /** The changed files (`useSandboxGit().diff`). Assumed non-empty by the caller. */
  diff: SandboxGitFileDiff[];
  /** Which source the diff came from — drives the "live" vs "as of turn" badge. */
  source: "live" | "capture" | null;
  /** When the served capture was taken (ISO), when `source === "capture"`. */
  capturedAt: string | null;
  /** The capture's turn revision, for the "as of turn N" badge. */
  captureRevision?: number | null | undefined;
  themeType?: "dark" | "light" | undefined;
  /** Route a guarded binary/oversize file into the live Files surface. */
  onOpenFile?: ((path: string) => void) | undefined;
  className?: string | undefined;
};

type RailRow =
  | { kind: "group"; label: string; count: number }
  | { kind: "file"; file: SandboxGitFileDiff; index: number };

/** Order the files and build the rail rows (grouped past the threshold). The
 *  returned `orderedFiles` drives BOTH the rail and the diff pane so a rail row's
 *  `index` addresses the matching pane section. Exported for tests. */
export function buildRail(files: SandboxGitFileDiff[]): {
  orderedFiles: SandboxGitFileDiff[];
  rows: RailRow[];
  grouped: boolean;
} {
  const roots = new Set(
    files.flatMap((file) => (file.repoRoot === undefined ? [] : [file.repoRoot])),
  );
  const groupByRepo = roots.size > 1;
  if (!groupByRepo && files.length <= GROUP_THRESHOLD) {
    return {
      orderedFiles: files,
      rows: files.map((file, index) => ({ kind: "file", file, index })),
      grouped: false,
    };
  }
  const groups = new Map<string, SandboxGitFileDiff[]>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    const key = groupByRepo
      ? file.repoRoot || "(workspace)"
      : slash > 0
        ? file.path.slice(0, slash)
        : "(root)";
    const bucket = groups.get(key);
    if (bucket) bucket.push(file);
    else groups.set(key, [file]);
  }
  const labels = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const orderedFiles: SandboxGitFileDiff[] = [];
  const rows: RailRow[] = [];
  for (const label of labels) {
    const bucket = (groups.get(label) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
    rows.push({ kind: "group", label, count: bucket.length });
    for (const file of bucket) {
      rows.push({ kind: "file", file, index: orderedFiles.length });
      orderedFiles.push(file);
    }
  }
  return { orderedFiles, rows, grouped: true };
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
  onOpenFile,
  className,
}: WorkbenchChangesProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const resolvedTheme = useThemeType(themeType);
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [activePath, setActivePath] = useState<string | null>(null);
  const pickerId = useId();

  const unicodeFontPaths = useMemo(
    () => diff.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path])),
    [diff],
  );
  useUnicodeFallbackFonts(unicodeFontPaths);

  const { orderedFiles, rows, grouped } = useMemo(() => buildRail(diff), [diff]);
  const selectedIndex = orderedFiles.findIndex((file) => file.path === activePath);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : 0;

  useChangesLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const update = (width: number) => {
      // DOM test environments report a zero geometry. Keep the deterministic
      // desktop/SSR branch until the observer has a real measurement.
      if (width > 0) setCompact(width < COMPACT_SURFACE_PX);
    };
    update(root.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      update(entries[0]?.contentRect.width ?? root.getBoundingClientRect().width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useChangesLayoutEffect(() => {
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
      setActivePath(orderedFiles[index]?.path ?? null);
      windowed.scrollToIndex(index);
    },
    [orderedFiles, windowed],
  );

  // Track which section is at the top of the pane so the rail highlights it.
  const onPaneScroll = useCallback(() => {
    const el = windowed.scrollRef.current;
    if (!el) {
      return;
    }
    const top = el.scrollTop;
    const offsets = windowed.offsets;
    let idx = 0;
    for (let i = 0; i < orderedFiles.length; i++) {
      if ((offsets[i] ?? 0) <= top + 4) idx = i;
      else break;
    }
    const nextPath = orderedFiles[idx]?.path ?? null;
    setActivePath((previous) => (previous === nextPath ? previous : nextPath));
  }, [windowed, orderedFiles]);

  useEffect(() => {
    const el = windowed.scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", onPaneScroll, { passive: true });
    return () => el.removeEventListener("scroll", onPaneScroll);
  }, [windowed.scrollRef, onPaneScroll]);

  const sourceBadge = describeSource(source, capturedAt, captureRevision ?? null);
  const activeFile = orderedFiles[activeIndex] ?? orderedFiles[0];

  return (
    <div
      ref={rootRef}
      className={cn("flex h-full min-h-0 min-w-0 flex-col", className)}
      data-workbench-changes-layout={compact ? "compact" : "rail"}
    >
      {/* Summary + source badge + layout toggle. */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-between gap-2 border-b border-og-border px-3 py-1.5",
          compact && source === "capture" && "flex-col items-stretch gap-1.5 py-2",
        )}
      >
        <span
          role="status"
          aria-atomic="true"
          aria-live="polite"
          data-contrast-audited
          className="min-w-0 text-og-xs text-og-fg-muted"
        >
          {diff.length} {diff.length === 1 ? "file" : "files"} changed
          <span data-contrast-audited className="ml-2 text-og-status-idle">
            +{additions}
          </span>
          <span data-contrast-audited className="ml-1 text-og-status-failed">
            −{deletions}
          </span>
        </span>
        <div
          className={cn(
            "flex shrink-0 items-center gap-2",
            compact && source === "capture" && "self-start",
          )}
        >
          {compact ? null : <LayoutToggle layout={layout} onChange={setLayout} />}
          <SourceBadge source={source} capturedAt={capturedAt} label={sourceBadge} />
        </div>
      </div>

      {compact ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-og-border bg-og-surface-1 p-2">
            <label className="sr-only" htmlFor={pickerId}>
              Changed file
            </label>
            <select
              id={pickerId}
              aria-label="Changed file"
              value={activeIndex}
              onChange={(event) => {
                const index = Number(event.currentTarget.value);
                setActivePath(orderedFiles[index]?.path ?? null);
              }}
              title={activeFile?.path}
              data-compact-file-picker
              className="h-11 w-full rounded-og-md border border-og-border bg-og-bg px-3 font-og-mono text-og-sm text-og-fg outline-none transition-colors focus:border-og-accent focus:ring-2 focus:ring-og-accent-soft"
            >
              {orderedFiles.map((file, index) => (
                <option key={file.path} value={index}>
                  {compactFileLabel(file)}
                </option>
              ))}
            </select>
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-auto" data-opengeni-changes-pane>
            {activeFile ? (
              <DiffSection
                file={activeFile}
                layout="unified"
                themeType={resolvedTheme}
                {...(onOpenFile ? { onOpenFile } : {})}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* File rail — virtualized (virtua): a dense change set is fine. */}
          <div className="w-[clamp(12rem,28%,15rem)] shrink-0 border-r border-og-border bg-og-surface-1/35">
            <VList
              className="h-full"
              itemSize={coarsePointer ? 44 : 28}
              ssrCount={Math.min(30, rows.length)}
            >
              {rows.map((row) =>
                row.kind === "group" ? (
                  <div
                    key={`g:${row.label}`}
                    data-rail-group
                    className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-og-xs font-medium uppercase tracking-wide text-og-fg-subtle"
                  >
                    <span className="min-w-0 truncate">{row.label}</span>
                    <span className="shrink-0">{row.count}</span>
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
                  <MeasuredSection
                    key={file.path}
                    index={index}
                    top={windowed.offsets[index] ?? 0}
                    onMeasure={windowed.measure}
                  >
                    <DiffSection
                      file={file}
                      layout={layout}
                      themeType={resolvedTheme}
                      {...(onOpenFile ? { onOpenFile } : {})}
                    />
                  </MeasuredSection>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The data-source badge. "live" stays understated (the header chip already
 * carries machine liveness) — but a capture-served diff is honestly labelled
 * historical: a muted clock + the "as of turn N · <time>" so the reviewer always
 * knows they are looking at a turn-end snapshot, not the live tree.
 */
function SourceBadge({
  source,
  capturedAt,
  label,
}: {
  source: "live" | "capture" | null;
  capturedAt: string | null;
  label: string;
}) {
  if (source === "capture" && capturedAt) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-og-xs border border-og-border px-1.5 py-px text-og-xs text-og-fg-muted"
        title={new Date(capturedAt).toLocaleString()}
      >
        <HistoryIcon className="size-3 shrink-0 text-og-status-running" aria-hidden />
        {label}
      </span>
    );
  }
  return (
    <span className="rounded-og-xs bg-og-surface-2 px-1.5 py-px text-og-xs text-og-fg-subtle">
      {label}
    </span>
  );
}

/** "Live diff" · "as of turn 7 · 14:32" · "as of 14:32" (no revision). */
function describeSource(
  source: "live" | "capture" | null,
  capturedAt: string | null,
  revision: number | null,
): string {
  if (source !== "capture" || !capturedAt) return "Live diff";
  const time = formatAsOf(capturedAt, Date.now());
  return revision !== null ? `as of turn ${revision} · ${time}` : `as of ${time}`;
}

function RailFileRow({
  file,
  grouped,
  active,
  onClick,
}: {
  file: SandboxGitFileDiff;
  grouped: boolean;
  active: boolean;
  onClick: () => void;
}) {
  // A real repository group strips the exact repo root. Legacy top-directory
  // grouping strips only that first segment.
  const repoPrefix = file.repoRoot ? `${file.repoRoot}/` : null;
  const shown = grouped
    ? file.repoRoot !== undefined
      ? repoPrefix && file.path.startsWith(repoPrefix)
        ? file.path.slice(repoPrefix.length)
        : file.path
      : file.path.slice(file.path.indexOf("/") + 1) || file.path
    : file.path;
  return (
    <button
      type="button"
      onClick={onClick}
      title={file.path}
      data-rail-file
      className={cn(
        "relative flex min-h-7 w-full items-center gap-1.5 truncate px-2 py-0.5 text-left text-og-sm transition-colors hover:bg-og-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent pointer-coarse:min-h-11",
        grouped && "pl-3",
        active &&
          "bg-og-accent-soft text-og-fg before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-r-full before:bg-og-accent",
      )}
    >
      <span
        data-contrast-audited
        className={cn("w-3 shrink-0 text-center font-og-mono text-og-xs", STATUS_TINT[file.status])}
      >
        {STATUS_LETTER[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate">{shown}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 font-og-mono text-og-xs">
        <span data-contrast-audited className="text-og-status-idle">
          +{file.additions}
        </span>
        <span data-contrast-audited className="text-og-status-failed">
          −{file.deletions}
        </span>
      </span>
    </button>
  );
}

/** A windowed section wrapper. Absolutely positioned at `top`; a ResizeObserver
 *  reports its real height back so the layout refines as Pierre's async Shiki
 *  render grows (else short estimates would overlap sections). */
function MeasuredSection({
  index,
  top,
  onMeasure,
  children,
}: {
  index: number;
  top: number;
  onMeasure: (index: number, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onMeasure(index, el.offsetHeight);
    report();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(report) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [index, onMeasure]);
  return (
    <div
      ref={ref}
      data-diff-section
      data-diff-index={index}
      style={{ position: "absolute", top, left: 0, right: 0 }}
    >
      {children}
    </div>
  );
}

function DiffSection({
  file,
  layout,
  themeType,
  onOpenFile,
}: {
  file: GitFileDiff;
  layout: "unified" | "split";
  themeType: "dark" | "light";
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  // The guard files (binary / over-cap) get a minimal header + "open live" body
  // since Pierre has nothing to render; real diffs use Pierre's own sticky file
  // header (one header — no redundant chrome).
  if (isGuarded(file)) {
    const renamed = file.oldPath && file.oldPath !== file.path;
    return (
      <section className="border-b border-og-border pb-1">
        <header className="flex items-center justify-between gap-2 bg-og-surface-1 px-3 py-1.5 text-og-sm">
          <span className="min-w-0 truncate font-og-mono text-og-xs">
            {renamed ? `${file.oldPath} → ${file.path}` : file.path}
          </span>
          <span className="flex shrink-0 items-center gap-2 font-og-mono text-og-xs">
            <span className="text-og-status-idle">+{file.additions}</span>
            <span className="text-og-status-failed">−{file.deletions}</span>
          </span>
        </header>
        <GuardBody file={file} {...(onOpenFile ? { onOpenFile } : {})} />
      </section>
    );
  }
  return (
    <section data-pierre-section className="border-b border-og-border pb-2">
      <PierreDiff diff={[file]} layout={layout} themeType={themeType} className="px-1" />
    </section>
  );
}

/** The per-file guard: a binary file or an over-cap diff opens live rather than
 *  inlining a body we don't (fully) have. */
function GuardBody({
  file,
  onOpenFile,
}: {
  file: GitFileDiff;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const reason = file.isBinary ? "Binary file" : "Diff too large to show here";
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-og-sm text-og-fg-subtle">
      <FileWarningIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{reason}.</span>
      {onOpenFile ? (
        <button
          type="button"
          onClick={() => onOpenFile(file.path)}
          className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-og-sm border border-og-border px-2 py-1 text-og-xs font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:bg-og-surface-2 hover:text-og-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-11"
        >
          Open in Files
          <ArrowUpRightIcon className="size-3.5" aria-hidden />
        </button>
      ) : null}
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
            "min-h-7 rounded-og-xs px-1.5 py-0.5 text-og-xs capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent max-[1023px]:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
            layout === value
              ? "bg-og-accent-soft text-og-fg"
              : "text-og-fg-subtle hover:text-og-fg",
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}
