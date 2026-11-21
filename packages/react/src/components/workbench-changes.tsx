import type { GitFileDiff } from "@opengeni/sdk";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  FileWarningIcon,
  GitPullRequestArrowIcon,
  HistoryIcon,
  Rows2Icon,
} from "lucide-react";
import {
  Component,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { VList, type VListHandle } from "virtua";
import { cn } from "../lib/cn";
import { useUnicodeFallbackFonts } from "../lib/use-unicode-fonts";
import { useThemeType } from "../lib/use-theme-type";
import { formatAsOf } from "../hooks/use-machine-chip";
import type { SandboxGitFileDiff } from "../hooks/use-sandbox-git";
import { useWindowedSections } from "../hooks/use-windowed-sections";
import { PierreDiff } from "./pierre-diff";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";

/* ----------------------------------------------------------------------------
   Changes tab — a PR-review surface.

   A file rail (status glyph, ±counts, grouped by repository when metadata is
   available, otherwise by top-level directory for a large legacy input) on the
   left; a stacked, WINDOWED diff pane on the right. Only
   the file sections inside the visible window ± overscan mount a Pierre/Shiki
   highlighter (the one renderer), so a 40- or 400-file change set never mounts N
   highlighters at once (D2). A per-file size guard (binary / diff too
   large) degrades to an "open live" affordance instead of a diff body.

   Workspace-wide Git results carry an explicit `repoRoot`, so grouping never
   guesses repository ownership from a directory name. Multi-repo results group
   at every size; legacy unscoped inputs group by top-level directory only past
   the threshold.
   -------------------------------------------------------------------------- */

/** Group the rail (and reorder the pane) once the change set is larger than this. */
const GROUP_THRESHOLD = 20;
/** Mount this many sections beyond the visible window on each side. */
const OVERSCAN = 1;
const HEADER_PX = 30;
const LINE_PX = 18;
const GUARD_BODY_PX = 52;
const EMPTY_BODY_PX = 36;
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

const STATUS_WORD = {
  added: "workbenchChanges.added",
  deleted: "workbenchChanges.deleted",
  untracked: "workbenchChanges.new",
} as const;

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
  /** The branch's pull request, when one exists: shows "View on GitHub". */
  pullRequest?: WorkbenchPullRequest | null | undefined;
  /** Ask for a pull request for these changes: shows "Open PR" when there is none. */
  onOpenPullRequest?: (() => void) | undefined;
  /** Controls drawn at the start of the summary row (e.g. a comparison picker). */
  leading?: ReactNode | undefined;
  /** Hide the file rail and stack the diffs (a narrow review surface). */
  hideRail?: boolean | undefined;
  className?: string | undefined;
};

/** A pull request the host knows for the changes on screen. */
export type WorkbenchPullRequest = {
  url: string;
  number?: number | undefined;
};

type RailRow =
  | { kind: "group"; label: string; count: number }
  | { kind: "file"; file: SandboxGitFileDiff; index: number };

type ChangesRailVListProps = {
  children: ReactNode;
  className: string;
  coarsePointer: boolean;
  files: readonly SandboxGitFileDiff[];
  rowCount: number;
};

type ChangesRailVListState = {
  renderedRowCount: number;
  resetVersion: number;
};

type ChangesRailSnapshot = {
  focusedPath: string | null;
  scrollOffset: number;
};

/** Virtua must reset its cached range when the rail shrinks. Keep that remount
 * scoped to shrink transitions and preserve the reader's focus/scroll context. */
class ChangesRailVList extends Component<
  ChangesRailVListProps,
  ChangesRailVListState,
  ChangesRailSnapshot | null
> {
  state: ChangesRailVListState = {
    renderedRowCount: this.props.rowCount,
    resetVersion: 0,
  };

  private host: HTMLDivElement | null = null;
  private listHandle: VListHandle | null = null;
  private pendingFocusedPath: string | null = null;
  private restoreFrame: number | null = null;

  static getDerivedStateFromProps(
    props: ChangesRailVListProps,
    state: ChangesRailVListState,
  ): ChangesRailVListState | null {
    if (props.rowCount === state.renderedRowCount) return null;
    return {
      renderedRowCount: props.rowCount,
      resetVersion:
        props.rowCount < state.renderedRowCount ? state.resetVersion + 1 : state.resetVersion,
    };
  }

  getSnapshotBeforeUpdate(
    _previousProps: ChangesRailVListProps,
    previousState: ChangesRailVListState,
  ): ChangesRailSnapshot | null {
    if (previousState.resetVersion === this.state.resetVersion) return null;
    const scroller = this.host?.firstElementChild;
    if (!(scroller instanceof HTMLElement)) return null;
    const active = document.activeElement;
    const focusedRow =
      active instanceof HTMLElement && scroller.contains(active)
        ? active.closest<HTMLElement>("[data-rail-file-path]")
        : null;
    return {
      focusedPath: focusedRow?.dataset.railFilePath ?? this.pendingFocusedPath,
      scrollOffset: scroller.scrollTop,
    };
  }

  componentDidUpdate(
    _previousProps: ChangesRailVListProps,
    _previousState: ChangesRailVListState,
    snapshot: ChangesRailSnapshot | null,
  ): void {
    if (!snapshot || !this.listHandle) return;
    this.cancelRestoreFrame();
    const maxOffset = Math.max(0, this.listHandle.scrollSize - this.listHandle.viewportSize);
    this.listHandle.scrollTo(Math.min(Math.max(snapshot.scrollOffset, 0), maxOffset));
    const focusedPath = snapshot.focusedPath;
    if (!focusedPath) return;
    this.pendingFocusedPath = focusedPath;
    this.continueFocusRestore();
  }

  componentWillUnmount(): void {
    this.cancelRestoreFrame();
    this.pendingFocusedPath = null;
  }

  private cancelRestoreFrame(): void {
    if (this.restoreFrame === null) return;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.restoreFrame);
    this.restoreFrame = null;
  }

  private continueFocusRestore = (): void => {
    const path = this.pendingFocusedPath;
    if (!path) return;
    if (this.restoreFocusedPath(path)) {
      this.pendingFocusedPath = null;
      return;
    }
    if (this.restoreFrame === null && typeof requestAnimationFrame === "function") {
      this.restoreFrame = requestAnimationFrame(() => {
        this.restoreFrame = null;
        this.continueFocusRestore();
      });
    }
  };

  private restoreFocusedPath(path: string): boolean {
    const host = this.host;
    if (!host) return true;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isConnected && active !== document.body) {
      return true;
    }
    if (!this.props.files.some((file) => file.path === path)) return true;
    const row = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-rail-file-path]")).find(
      (candidate) => candidate.dataset.railFilePath === path,
    );
    if (!row) return false;
    row.focus({ preventScroll: true });
    return true;
  }

  private setHost = (host: HTMLDivElement | null): void => {
    this.host = host;
  };

  private setListHandle = (handle: VListHandle | null): void => {
    this.listHandle = handle;
  };

  render() {
    return (
      <div ref={this.setHost} data-opengeni-changes-rail className={this.props.className}>
        <VList
          key={this.state.resetVersion}
          ref={this.setListHandle}
          className="h-full"
          itemSize={this.props.coarsePointer ? 44 : 28}
          ssrCount={Math.min(30, this.props.rowCount)}
        >
          {this.props.children}
        </VList>
      </div>
    );
  }
}

/** Order the files and build the rail rows (grouped past the threshold). The
 *  returned `orderedFiles` drives BOTH the rail and the diff pane so a rail row's
 *  `index` addresses the matching pane section. Exported for tests. */
export function buildRail(
  t: OpenGeniText,
  files: SandboxGitFileDiff[],
): {
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
      ? file.repoRoot || t("workbenchChanges.workspace")
      : slash > 0
        ? file.path.slice(0, slash)
        : t("workbenchChanges.root");
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

/** A rename or mode change with no hunks: Pierre would draw nothing without its
 *  own file header, so a one-line note stands in for the diff body. */
function hasNoHunks(file: GitFileDiff): boolean {
  return !isGuarded(file) && file.hunks.length === 0;
}

/** Estimate a section's rendered height for the windowing math. Line-count based,
 *  so it is close enough that the first paint barely shifts as real heights land. */
function estimateSectionHeight(file: GitFileDiff, collapsed = false): number {
  if (collapsed) return HEADER_PX;
  if (isGuarded(file)) return HEADER_PX + GUARD_BODY_PX;
  if (hasNoHunks(file)) return HEADER_PX + EMPTY_BODY_PX;
  let lines = 0;
  for (const hunk of file.hunks) lines += hunk.lines.length + 1;
  return HEADER_PX + Math.max(lines, 1) * LINE_PX + 8;
}

export const WorkbenchChanges = memo(function WorkbenchChanges({
  diff,
  source,
  capturedAt,
  captureRevision,
  themeType,
  onOpenFile,
  pullRequest,
  onOpenPullRequest,
  leading,
  hideRail = false,
  className,
}: WorkbenchChangesProps) {
  const t = useOpenGeniText();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const resolvedTheme = useThemeType(themeType);
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCollapsed = useCallback((path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const pickerId = useId();

  const unicodeFontPaths = useMemo(
    () => diff.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path])),
    [diff],
  );
  useUnicodeFallbackFonts(unicodeFontPaths);

  const { orderedFiles, rows, grouped } = useMemo(() => buildRail(t, diff), [diff, t]);
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
      return file
        ? estimateSectionHeight(file, collapsedPaths.has(file.path))
        : HEADER_PX + LINE_PX;
    },
    [orderedFiles, collapsedPaths],
  );

  const windowed = useWindowedSections({
    count: orderedFiles.length,
    estimateHeight,
    overscan: OVERSCAN,
  });

  // Rail jumps read the latest layout through refs, so the callback (and every
  // rail row holding it) stays stable while sections measure in.
  const layoutRef = useRef({ orderedFiles, offsets: windowed.offsets });
  layoutRef.current = { orderedFiles, offsets: windowed.offsets };
  // The section a rail click jumped to. While set, the pane stays pinned to it
  // as sections above it replace their estimated heights with measured ones,
  // and the rail keeps it selected even when the pane cannot scroll that far.
  const anchorRef = useRef<number | null>(null);
  const scrollToIndex = windowed.scrollToIndex;
  const scrollToIndexRef = useRef(scrollToIndex);
  scrollToIndexRef.current = scrollToIndex;
  const jumpTo = useCallback((index: number) => {
    anchorRef.current = index;
    setActivePath(layoutRef.current.orderedFiles[index]?.path ?? null);
    scrollToIndexRef.current(index);
  }, []);

  useChangesLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    scrollToIndex(anchor);
  }, [windowed.offsets, scrollToIndex]);

  // Track which section is at the top of the pane so the rail highlights it.
  const onPaneScroll = useCallback(() => {
    if (anchorRef.current !== null) return;
    const el = windowed.scrollRef.current;
    if (!el) {
      return;
    }
    const top = el.scrollTop;
    const { offsets, orderedFiles: files } = layoutRef.current;
    let idx = 0;
    for (let i = 0; i < files.length; i++) {
      if ((offsets[i] ?? 0) <= top + 4) idx = i;
      else break;
    }
    const nextPath = files[idx]?.path ?? null;
    setActivePath((previous) => (previous === nextPath ? previous : nextPath));
  }, [windowed.scrollRef]);

  useEffect(() => {
    const el = windowed.scrollRef.current;
    if (!el) return;
    // Any reader-driven scroll releases the jump anchor.
    const release = () => {
      anchorRef.current = null;
    };
    el.addEventListener("scroll", onPaneScroll, { passive: true });
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("touchstart", release, { passive: true });
    el.addEventListener("keydown", release);
    el.addEventListener("pointerdown", release);
    return () => {
      el.removeEventListener("scroll", onPaneScroll);
      el.removeEventListener("wheel", release);
      el.removeEventListener("touchstart", release);
      el.removeEventListener("keydown", release);
      el.removeEventListener("pointerdown", release);
    };
  }, [windowed.scrollRef, onPaneScroll]);

  const sourceBadge = describeSource(t, source, capturedAt, captureRevision ?? null);
  const activeFile = orderedFiles[activeIndex] ?? orderedFiles[0];
  const onToggle = toggleCollapsed;
  const stacked = compact || hideRail;

  return (
    <div
      ref={rootRef}
      className={cn("flex h-full min-h-0 min-w-0 flex-col", className)}
      data-workbench-changes-layout={compact ? "compact" : hideRail ? "stacked" : "rail"}
    >
      {/* One quiet row: optional host controls, the summary, then actions. */}
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-og-border px-3 py-1">
        {leading}
        <span
          role="status"
          aria-atomic="true"
          aria-live="polite"
          data-contrast-audited
          className="min-w-0 text-og-xs text-og-fg-muted"
        >
          {t("workbenchChanges.filesChanged", { count: diff.length })}
          <span data-contrast-audited className="ml-2 font-og-mono text-og-status-idle">
            +{additions}
          </span>
          <span data-contrast-audited className="ml-1 font-og-mono text-og-status-failed">
            −{deletions}
          </span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {source === "capture" && capturedAt ? (
            <SourceBadge capturedAt={capturedAt} label={sourceBadge} />
          ) : null}
          {compact ? null : <LayoutToggle layout={layout} onChange={setLayout} />}
          <PullRequestAction pullRequest={pullRequest} onOpenPullRequest={onOpenPullRequest} />
        </div>
      </div>

      {compact ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-og-border p-2">
            <label className="sr-only" htmlFor={pickerId}>
              {t("workbenchChanges.changedFile")}
            </label>
            <select
              id={pickerId}
              aria-label={t("workbenchChanges.changedFile")}
              value={activeIndex}
              onChange={(event) => {
                const index = Number(event.currentTarget.value);
                setActivePath(orderedFiles[index]?.path ?? null);
              }}
              title={activeFile?.path}
              data-compact-file-picker
              className="h-11 w-full rounded-og-md border border-og-border bg-og-bg px-3 font-og-mono text-og-sm text-og-fg outline-hidden transition-colors focus:border-og-accent focus:ring-2 focus:ring-og-accent-soft"
            >
              {orderedFiles.map((file, index) => (
                <option key={file.path} value={index}>
                  {compactFileLabel(file)}
                </option>
              ))}
            </select>
          </div>
          <div
            aria-label={t("workbenchChanges.changedFileDiff")}
            className="min-h-0 min-w-0 flex-1 overflow-auto outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent"
            data-opengeni-changes-pane
            role="region"
            tabIndex={0}
          >
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
          {stacked ? null : (
            <ChangesRailVList
              rowCount={rows.length}
              coarsePointer={coarsePointer}
              files={orderedFiles}
              className="w-[clamp(12rem,28%,15rem)] shrink-0 border-r border-og-border"
            >
              {rows.map((row) =>
                row.kind === "group" ? (
                  <div
                    key={`g:${row.label}`}
                    data-rail-group
                    className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-og-xs font-medium text-og-fg-subtle"
                  >
                    <span className="min-w-0 truncate">{row.label}</span>
                    <span className="shrink-0">{row.count}</span>
                  </div>
                ) : (
                  <RailFileRow
                    key={row.file.path}
                    file={row.file}
                    index={row.index}
                    grouped={grouped}
                    active={row.index === activeIndex}
                    onSelect={jumpTo}
                  />
                ),
              )}
            </ChangesRailVList>
          )}

          {/* Diff pane — windowed file sections. Only the sections inside the
            visible window ± overscan are in the DOM; the container reserves the
            full scroll height so scrolling + the rail-jump stay accurate. */}
          <div
            ref={windowed.scrollRef}
            aria-label={t("workbenchChanges.changedFilesDiff")}
            className="min-h-0 min-w-0 flex-1 overflow-auto outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent"
            data-opengeni-changes-pane
            role="region"
            tabIndex={0}
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
                      collapsed={collapsedPaths.has(file.path)}
                      onToggle={onToggle}
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
});

/** A capture-served diff is honestly labelled historical: a muted clock and
 *  "as of turn N · <time>". A live diff carries no badge (the machine chip in
 *  the dock already says the workspace is live). */
function SourceBadge({ capturedAt, label }: { capturedAt: string; label: string }) {
  const t = useOpenGeniText();
  return (
    <span
      className="inline-flex items-center gap-1 px-1 text-og-xs text-og-fg-muted"
      title={new Date(capturedAt).toLocaleString(t.locale)}
    >
      <HistoryIcon className="size-3 shrink-0 text-og-status-running" aria-hidden />
      {label}
    </span>
  );
}

/** "Live diff" · "as of turn 7 · 14:32" · "as of 14:32" (no revision). */
function describeSource(
  t: OpenGeniText,
  source: "live" | "capture" | null,
  capturedAt: string | null,
  revision: number | null,
): string {
  if (source !== "capture" || !capturedAt) return t("workbenchChanges.liveDiff");
  const time = formatAsOf(t, capturedAt, Date.now());
  return revision !== null
    ? t("workbenchChanges.asOfTurnRevisionTime", { revision, time })
    : `as of ${time}`;
}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  return slash >= 0
    ? { name: path.slice(slash + 1), dir: path.slice(0, slash) }
    : { name: path, dir: "" };
}

const RailFileRow = memo(function RailFileRow({
  file,
  index,
  grouped,
  active,
  onSelect,
}: {
  file: SandboxGitFileDiff;
  index: number;
  grouped: boolean;
  active: boolean;
  onSelect: (index: number) => void;
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
  const { name, dir } = splitPath(shown);
  return (
    <button
      type="button"
      onClick={() => onSelect(index)}
      title={file.path}
      data-rail-file
      data-rail-file-path={file.path}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex min-h-7 w-full items-center gap-1.5 truncate px-2 py-0.5 text-left text-og-sm text-og-fg-muted transition-colors hover:bg-og-surface-2 hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent pointer-coarse:min-h-11",
        grouped && "pl-3",
        active && "bg-og-surface-2 text-og-fg",
      )}
    >
      <span
        data-contrast-audited
        className={cn("w-3 shrink-0 text-center font-og-mono text-og-xs", STATUS_TINT[file.status])}
      >
        {STATUS_LETTER[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {name}
        {dir ? <span className="ml-1.5 text-og-xs text-og-fg-subtle">{dir}</span> : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 font-og-mono text-og-xs">
        {file.additions > 0 ? (
          <span data-contrast-audited className="text-og-status-idle">
            +{file.additions}
          </span>
        ) : null}
        {file.deletions > 0 ? (
          <span data-contrast-audited className="text-og-status-failed">
            −{file.deletions}
          </span>
        ) : null}
      </span>
    </button>
  );
});

/** A windowed section wrapper. Absolutely positioned at `top`; a ResizeObserver
 *  reports its real height back so the layout refines as Pierre's async Shiki
 *  render grows (else short estimates would overlap sections). */
const MeasuredSection = memo(function MeasuredSection({
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
});

const DiffSection = memo(function DiffSection({
  file,
  layout,
  themeType,
  collapsed = false,
  onToggle,
  onOpenFile,
}: {
  file: GitFileDiff;
  layout: "unified" | "split";
  themeType: "dark" | "light";
  collapsed?: boolean | undefined;
  onToggle?: ((path: string) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  // One header per file, drawn here so every file (diffable or guarded) folds
  // the same way; Pierre's own file header is turned off to avoid a second one.
  const guarded = isGuarded(file);
  const empty = hasNoHunks(file);
  const diff = useMemo(() => [file], [file]);
  return (
    <section
      data-diff-file={file.path}
      data-diff-collapsed={collapsed ? "" : undefined}
      {...(guarded || empty || collapsed ? {} : { "data-pierre-section": "" })}
      className={cn(!collapsed && "pb-2")}
    >
      <DiffFileHeader file={file} collapsed={collapsed} onToggle={onToggle} />
      {collapsed ? null : guarded ? (
        <GuardBody file={file} {...(onOpenFile ? { onOpenFile } : {})} />
      ) : empty ? (
        <NoHunksBody />
      ) : (
        <PierreDiff
          diff={diff}
          layout={layout}
          themeType={themeType}
          disableFileHeader
          className="px-1"
        />
      )}
    </section>
  );
});

function DiffFileHeader({
  file,
  collapsed,
  onToggle,
}: {
  file: GitFileDiff;
  collapsed: boolean;
  onToggle?: ((path: string) => void) | undefined;
}) {
  const t = useOpenGeniText();
  const renamed = file.oldPath && file.oldPath !== file.path;
  const label = renamed ? `${file.oldPath} → ${file.path}` : file.path;
  const { name, dir } = splitPath(file.path);
  const Chevron = collapsed ? ChevronRightIcon : ChevronDownIcon;
  const body = (
    <>
      {onToggle ? <Chevron className="size-3.5 shrink-0 text-og-fg-subtle" aria-hidden /> : null}
      <span className="min-w-0 flex-1 truncate text-left" title={label}>
        <span className="font-medium text-og-fg">{name}</span>
        {dir ? <span className="ml-1.5 text-og-xs text-og-fg-subtle">{dir}</span> : null}
        {renamed ? (
          <span className="ml-1.5 text-og-xs text-og-fg-subtle">← {file.oldPath}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 font-og-mono text-og-xs">
        {file.additions > 0 ? <span className="text-og-status-idle">+{file.additions}</span> : null}
        {file.deletions > 0 ? (
          <span className="text-og-status-failed">−{file.deletions}</span>
        ) : null}
        {file.status === "added" || file.status === "deleted" || file.status === "untracked" ? (
          <span className={cn("font-og-sans", STATUS_TINT[file.status])}>
            {t(STATUS_WORD[file.status])}
          </span>
        ) : null}
      </span>
    </>
  );
  const className =
    "sticky top-0 z-10 flex w-full items-center gap-2 border-b border-og-border bg-og-bg px-3 py-1.5 text-og-sm text-og-fg";
  if (!onToggle) return <header className={className}>{body}</header>;
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={() => onToggle(file.path)}
      className={cn(
        className,
        "hover:bg-og-surface-1 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent pointer-coarse:min-h-11",
      )}
    >
      {body}
    </button>
  );
}

/** One pull-request action for the change set: View on GitHub when a PR
 *  exists, otherwise Open PR when the host can ask for one. */
function PullRequestAction({
  pullRequest,
  onOpenPullRequest,
}: {
  pullRequest?: WorkbenchPullRequest | null | undefined;
  onOpenPullRequest?: (() => void) | undefined;
}) {
  const t = useOpenGeniText();
  const className =
    "inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-og-sm px-2 py-0.5 text-og-xs font-medium text-og-fg-muted transition-colors hover:bg-og-surface-2 hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-11";
  if (pullRequest?.url) {
    return (
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noreferrer noopener"
        data-workbench-pr-action="view"
        className={className}
        {...(pullRequest.number ? { title: `#${pullRequest.number}` } : {})}
      >
        {t("workbenchChanges.viewOnGitHub")}
        <ArrowUpRightIcon className="size-3.5" aria-hidden />
      </a>
    );
  }
  if (!onOpenPullRequest) return null;
  return (
    <button
      type="button"
      onClick={onOpenPullRequest}
      data-workbench-pr-action="open"
      className={cn(className, "border border-og-border")}
    >
      <GitPullRequestArrowIcon className="size-3.5" aria-hidden />
      {t("workbenchChanges.openPullRequest")}
    </button>
  );
}

/** The per-file guard: a binary file or an over-cap diff opens live rather than
 *  inlining a body we don't (fully) have. */
function NoHunksBody() {
  const t = useOpenGeniText();
  return (
    <div className="px-3 py-2 text-og-sm text-og-fg-subtle">
      {t("workbenchChanges.noContentChanges")}
    </div>
  );
}

function GuardBody({
  file,
  onOpenFile,
}: {
  file: GitFileDiff;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const t = useOpenGeniText();
  const reason = file.isBinary
    ? t("workbenchChanges.binaryFile")
    : t("workbenchChanges.diffTooLargeToShow");
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-og-sm text-og-fg-subtle">
      <FileWarningIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{reason}.</span>
      {onOpenFile ? (
        <button
          type="button"
          onClick={() => onOpenFile(file.path)}
          className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-og-sm border border-og-border px-2 py-1 text-og-xs font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:bg-og-surface-2 hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-11"
        >
          {t("workbenchChanges.openInFiles")}
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
  const t = useOpenGeniText();
  const next = layout === "unified" ? "split" : "unified";
  const label =
    next === "split" ? t("workbenchChanges.showSplitDiff") : t("workbenchChanges.showUnifiedDiff");
  const Icon = next === "split" ? Columns2Icon : Rows2Icon;
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      title={label}
      aria-label={label}
      data-diff-layout={layout}
      className="inline-flex size-7 items-center justify-center rounded-og-sm text-og-fg-subtle transition-colors hover:bg-og-surface-2 hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:size-11"
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}
