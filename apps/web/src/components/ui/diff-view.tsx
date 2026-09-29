/* ----------------------------------------------------------------------------
   DiffView - what changed in a piece of text, with enough context to judge it.

   One view for knowledge updates, instruction changes, new skills and
   revision history. Added and removed text is marked with a glyph and a
   screen-reader label as well as colour; changed lines also highlight the
   words that changed.

   Variants:
   - "inline" (default): one column, removed lines above added ones.
   - "split": before and after side by side; stacks on narrow widths.
   - "prose": the text as it reads, with removed words struck through and
     added words highlighted. For short prose like knowledge entries.
   -------------------------------------------------------------------------- */

import { Fragment, useId, useMemo, useState, type ReactNode } from "react";
import { ChevronsUpDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/error-message";
import { Skeleton } from "@/components/ui/skeleton";

/* ============================================================================
   Diff logic (pure)
   ========================================================================== */

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffSegment {
  kind: "same" | "added" | "removed";
  text: string;
}

/** Longest common subsequence table, bottom-up. Inputs are small (a document's lines). */
function lcsMatrix<T>(a: readonly T[], b: readonly T[]): Uint32Array[] {
  const rows: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    const next = rows[i + 1]!;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  return rows;
}

function diffSequence<T>(
  a: readonly T[],
  b: readonly T[],
): Array<{ kind: "same" | "added" | "removed"; value: T }> {
  const table = lcsMatrix(a, b);
  const out: Array<{ kind: "same" | "added" | "removed"; value: T }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", value: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ kind: "removed", value: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "added", value: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: "removed", value: a[i++]! });
  while (j < b.length) out.push({ kind: "added", value: b[j++]! });
  return out;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Line diff of two texts. Within each changed block, removed lines come
 * before added ones, like a reviewer reads them.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const raw = diffSequence(splitLines(before), splitLines(after));
  const out: DiffLine[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    for (const text of removed) out.push({ kind: "removed", text });
    for (const text of added) out.push({ kind: "added", text });
    removed = [];
    added = [];
  };
  for (const step of raw) {
    if (step.kind === "same") {
      flush();
      out.push({ kind: "context", text: step.value });
    } else if (step.kind === "removed") removed.push(step.value);
    else added.push(step.value);
  }
  flush();
  return out;
}

/** Word diff of two lines. Whitespace stays attached so the text reads naturally. */
export function diffWords(before: string, after: string): DiffSegment[] {
  const tokens = (text: string) => text.match(/\s+|[\p{L}\p{N}_'-]+|[^\s\p{L}\p{N}_'-]/gu) ?? [];
  const merged: DiffSegment[] = [];
  for (const step of diffSequence(tokens(before), tokens(after))) {
    const last = merged.at(-1);
    if (last && last.kind === step.kind) last.text += step.value;
    else merged.push({ kind: step.kind, text: step.value });
  }
  // Fold whitespace that sits between two changes of the same kind into them,
  // so "since the 1 Sep storage migration" reads as one change, not six.
  const folded: DiffSegment[] = [];
  for (let index = 0; index < merged.length; index += 1) {
    const segment = merged[index]!;
    const previous = folded.at(-1);
    const next = merged[index + 1];
    const bridging =
      segment.kind === "same" &&
      /^\s+$/.test(segment.text) &&
      previous !== undefined &&
      next !== undefined &&
      previous.kind !== "same" &&
      previous.kind === next.kind;
    if (bridging) {
      previous.text += segment.text;
      continue;
    }
    if (previous && previous.kind === segment.kind) previous.text += segment.text;
    else folded.push({ ...segment });
  }
  return folded;
}

export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added += 1;
    else if (line.kind === "removed") removed += 1;
  }
  return { added, removed };
}

/** A row the views render: a single line, a changed pair, or a run of hidden context. */
export type DiffRow =
  | { type: "line"; line: DiffLine; words?: DiffSegment[] }
  | { type: "collapsed"; lines: DiffLine[]; id: string };

/**
 * Pairs removed and added lines one to one for word highlights, and hides
 * long runs of unchanged lines, keeping `context` lines around each change.
 */
export function buildDiffRows(lines: readonly DiffLine[], context = 3): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === "context") {
      let end = index;
      while (end < lines.length && lines[end]!.kind === "context") end += 1;
      const run = lines.slice(index, end);
      const atStart = index === 0;
      const atEnd = end === lines.length;
      const keepBefore = atStart ? 0 : context;
      const keepAfter = atEnd ? 0 : context;
      if (Number.isFinite(context) && run.length > keepBefore + keepAfter + 1) {
        for (const each of run.slice(0, keepBefore)) rows.push({ type: "line", line: each });
        rows.push({
          type: "collapsed",
          id: `collapsed-${index}`,
          lines: run.slice(keepBefore, run.length - keepAfter),
        });
        for (const each of run.slice(run.length - keepAfter))
          rows.push({ type: "line", line: each });
      } else {
        for (const each of run) rows.push({ type: "line", line: each });
      }
      index = end;
      continue;
    }
    // A changed block: removed lines, then added lines.
    let end = index;
    while (end < lines.length && lines[end]!.kind !== "context") end += 1;
    const block = lines.slice(index, end);
    const removed = block.filter((each) => each.kind === "removed");
    const added = block.filter((each) => each.kind === "added");
    const paired = removed.length === added.length;
    removed.forEach((each, at) =>
      rows.push({
        type: "line",
        line: each,
        words: paired
          ? diffWords(each.text, added[at]!.text).filter((s) => s.kind !== "added")
          : undefined,
      }),
    );
    added.forEach((each, at) =>
      rows.push({
        type: "line",
        line: each,
        words: paired
          ? diffWords(removed[at]!.text, each.text).filter((s) => s.kind !== "removed")
          : undefined,
      }),
    );
    index = end;
  }
  return rows;
}

/* ============================================================================
   Rendering
   ========================================================================== */

export type DiffViewVariant = "inline" | "split" | "prose";
export type DiffFormat = "text" | "markdown" | "code";

export interface DiffViewProps {
  /** Precomputed lines, for example from the server. */
  lines?: readonly DiffLine[];
  /** Or two texts to compare. */
  before?: string;
  after?: string;
  variant?: DiffViewVariant;
  /**
   * "markdown" (default) shows headings and bullets as they read; "text"
   * shows lines as they are; "code" uses the mono face.
   */
  format?: DiffFormat;
  /** "md" is 14px text; "sm" is 12px for lists and review queues. */
  size?: "sm" | "md";
  /** Unchanged lines kept around each change before the rest collapses. Infinity shows all. */
  context?: number;
  /** A heading inside the frame, for example the entry's name. */
  title?: ReactNode;
  /** Quiet line under the title: "From schedule Weekly dependency update PR". */
  meta?: ReactNode;
  /** Buttons on the right of the header: Approve, Restore. */
  actions?: ReactNode;
  /** Hide the added and removed counts. */
  hideStats?: boolean;
  /** Accessible name when there is no title. */
  label?: string;
  loading?: boolean;
  /** What happened, what to do next, and an optional retry. */
  error?: { message: string; detail?: ReactNode; onRetry?: () => void };
  /** Shown when nothing changed. */
  emptyMessage?: ReactNode;
  /** No frame: for use inside a sheet section or a review pane that has its own. */
  bare?: boolean;
  className?: string;
}

const GLYPH: Record<DiffLineKind, string> = { context: "", added: "+", removed: "−" };
const SR_LABEL: Record<DiffLineKind, string> = {
  context: "",
  added: "Added: ",
  removed: "Removed: ",
};

function isBlank(text: string) {
  return text.trim() === "";
}

/** Headings and bullets read as text, not as markdown syntax. */
function renderText(
  text: string,
  format: DiffFormat,
): { node: ReactNode; heading: boolean; bullet: boolean } {
  if (format !== "markdown") return { node: text, heading: false, bullet: false };
  const heading = /^(#{1,6})\s+(.*)$/.exec(text);
  if (heading) return { node: heading[2], heading: true, bullet: false };
  const bullet = /^\s*[-*+]\s+(.*)$/.exec(text);
  if (bullet) return { node: bullet[1], heading: false, bullet: true };
  return { node: text, heading: false, bullet: false };
}

/** Strip the markdown marker from the first segment so word highlights line up. */
function stripMarker(words: DiffSegment[], format: DiffFormat): DiffSegment[] {
  if (format !== "markdown" || words.length === 0) return words;
  const [first, ...rest] = words;
  const stripped = first!.text.replace(/^(#{1,6}\s+|\s*[-*+]\s+)/, "");
  return stripped === "" ? rest : [{ ...first!, text: stripped }, ...rest];
}

function Words({ words, kind }: { words: DiffSegment[]; kind: DiffLineKind }) {
  return (
    <>
      {words.map((segment, index) =>
        segment.kind === "same" ? (
          // oxlint-disable-next-line react/no-array-index-key -- segments never reorder
          <Fragment key={index}>{segment.text}</Fragment>
        ) : kind === "added" ? (
          // oxlint-disable-next-line react/no-array-index-key -- segments never reorder
          <ins key={index} className="rounded-[3px] bg-status-idle/25 no-underline">
            {segment.text}
          </ins>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- segments never reorder
          <del key={index} className="rounded-[3px] bg-danger/25 no-underline">
            {segment.text}
          </del>
        ),
      )}
    </>
  );
}

function LineRow({
  line,
  words,
  format,
  size,
  side,
}: {
  line: DiffLine;
  words?: DiffSegment[];
  format: DiffFormat;
  size: "sm" | "md";
  /** In split view, which column this row is in. */
  side?: "before" | "after";
}) {
  const { node, heading, bullet } = renderText(line.text, format);
  const blank = isBlank(line.text);
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] pr-4",
        size === "sm" ? "text-xs leading-4.5" : "text-sm leading-5",
        line.kind === "added" && "bg-status-idle/[0.08]",
        line.kind === "removed" && "bg-danger/[0.07]",
        blank ? "min-h-2" : "py-0.5",
        heading && "not-first:pt-2.5",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "text-center font-mono select-none",
          line.kind === "added" && "text-status-idle",
          line.kind === "removed" && "text-danger",
        )}
      >
        {side === undefined || line.kind !== "context" ? GLYPH[line.kind] : ""}
      </span>
      <span
        className={cn(
          // "pretty" keeps a lone "1." from dangling after a hyphen break.
          "min-w-0 break-words whitespace-pre-wrap text-pretty",
          format === "code" && "font-mono text-xs leading-5",
          heading && "font-semibold",
          line.kind === "context" ? "text-fg-muted" : "text-fg",
          heading && line.kind === "context" && "text-fg",
          bullet && "relative pl-3.5",
        )}
      >
        {bullet ? (
          <span aria-hidden="true" className="absolute left-0.5 text-fg-subtle">
            •
          </span>
        ) : null}
        {SR_LABEL[line.kind] ? <span className="sr-only">{SR_LABEL[line.kind]}</span> : null}
        {words ? <Words words={stripMarker(words, format)} kind={line.kind} /> : node}
      </span>
    </div>
  );
}

function CollapsedRow({
  count,
  onExpand,
  size,
}: {
  count: number;
  onExpand: () => void;
  size: "sm" | "md";
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className={cn(
        "flex w-full items-center gap-2 bg-surface-2/60 px-4 text-left text-fg-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg pointer-coarse:min-h-11",
        size === "sm" ? "h-7 text-xs" : "h-8 text-xs",
      )}
    >
      <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
      Show {count} unchanged {count === 1 ? "line" : "lines"}
    </button>
  );
}

function Stats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2 text-2xs leading-4 font-medium tabular-nums">
      {added > 0 ? (
        <span className="text-status-idle">
          +{added}
          <span className="sr-only"> added</span>
        </span>
      ) : null}
      {removed > 0 ? (
        <span className="text-danger">
          −{removed}
          <span className="sr-only"> removed</span>
        </span>
      ) : null}
    </span>
  );
}

function InlineBody({
  rows,
  format,
  size,
  expanded,
  expand,
}: {
  rows: DiffRow[];
  format: DiffFormat;
  size: "sm" | "md";
  expanded: Set<string>;
  expand: (id: string) => void;
}) {
  return (
    <div className="py-2">
      {rows.map((row, index) =>
        row.type === "collapsed" ? (
          expanded.has(row.id) ? (
            row.lines.map((line, at) => (
              // oxlint-disable-next-line react/no-array-index-key -- lines never reorder
              <LineRow key={`${row.id}-${at}`} line={line} format={format} size={size} />
            ))
          ) : (
            <CollapsedRow
              key={row.id}
              count={row.lines.length}
              size={size}
              onExpand={() => expand(row.id)}
            />
          )
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- rows never reorder
          <LineRow key={index} line={row.line} words={row.words} format={format} size={size} />
        ),
      )}
    </div>
  );
}

function SplitBody({
  rows,
  format,
  size,
  expanded,
  expand,
}: {
  rows: DiffRow[];
  format: DiffFormat;
  size: "sm" | "md";
  expanded: Set<string>;
  expand: (id: string) => void;
}) {
  // Align each changed block: removed on the left, added on the right.
  type Pair =
    | { key: string; before?: DiffRow & { type: "line" }; after?: DiffRow & { type: "line" } }
    | { collapsed: DiffRow & { type: "collapsed" } };
  const pairs: Pair[] = [];
  const key = () => `row-${pairs.length}`;
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.type === "collapsed") {
      if (expanded.has(row.id)) {
        for (const line of row.lines) {
          const each = { type: "line" as const, line };
          pairs.push({ key: key(), before: each, after: each });
        }
      } else pairs.push({ collapsed: row });
      index += 1;
      continue;
    }
    if (row.line.kind === "context") {
      pairs.push({ key: key(), before: row, after: row });
      index += 1;
      continue;
    }
    const removed: Array<DiffRow & { type: "line" }> = [];
    const added: Array<DiffRow & { type: "line" }> = [];
    while (index < rows.length) {
      const next = rows[index]!;
      if (next.type !== "line" || next.line.kind === "context") break;
      if (next.line.kind === "removed") removed.push(next);
      else added.push(next);
      index += 1;
    }
    for (let at = 0; at < Math.max(removed.length, added.length); at += 1) {
      pairs.push({ key: key(), before: removed[at], after: added[at] });
    }
  }
  const column = (side: "before" | "after") => (
    <div className="min-w-0 py-2">
      <div className="px-4 pb-1.5 text-xs leading-4.5 font-medium text-fg-subtle">
        {side === "before" ? "Before" : "After"}
      </div>
      {pairs.map((pair) => {
        if ("collapsed" in pair) {
          return (
            <CollapsedRow
              key={pair.collapsed.id}
              count={pair.collapsed.lines.length}
              size={size}
              onExpand={() => expand(pair.collapsed.id)}
            />
          );
        }
        const row = side === "before" ? pair.before : pair.after;
        if (!row) {
          return (
            <div
              key={pair.key}
              aria-hidden="true"
              className={cn(size === "sm" ? "h-[22px]" : "h-6", "bg-surface-2/40")}
            />
          );
        }
        return (
          <LineRow
            key={pair.key}
            line={row.line}
            words={row.words}
            format={format}
            size={size}
            side={side}
          />
        );
      })}
    </div>
  );
  return (
    <div className="grid min-w-0 divide-y divide-border @xl/diff:grid-cols-2 @xl/diff:divide-x @xl/diff:divide-y-0">
      {column("before")}
      {column("after")}
    </div>
  );
}

function ProseBody({
  lines,
  format,
  size,
}: {
  lines: readonly DiffLine[];
  format: DiffFormat;
  size: "sm" | "md";
}) {
  // Pair changes into single flowing lines where possible.
  const rows = buildDiffRows(lines, Number.POSITIVE_INFINITY);
  const out: ReactNode[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.type !== "line") {
      index += 1;
      continue;
    }
    const next = rows[index + 1];
    const pairedRemoved =
      row.line.kind === "removed" &&
      next?.type === "line" &&
      next.line.kind === "added" &&
      row.words;
    if (pairedRemoved && next.type === "line") {
      const words = stripMarker(diffWords(row.line.text, next.line.text), format);
      const { heading, bullet } = renderText(next.line.text, format);
      out.push(
        <p
          key={index}
          className={cn(
            "min-w-0 break-words text-fg",
            heading && "font-semibold",
            bullet && "relative pl-3.5",
          )}
        >
          {bullet ? (
            <span aria-hidden="true" className="absolute left-0.5 text-fg-subtle">
              •
            </span>
          ) : null}
          <span className="sr-only">Changed: </span>
          {words.map((segment, at) =>
            segment.kind === "same" ? (
              // oxlint-disable-next-line react/no-array-index-key -- segments never reorder
              <Fragment key={at}>{segment.text}</Fragment>
            ) : segment.kind === "added" ? (
              // oxlint-disable-next-line react/no-array-index-key -- segments never reorder
              <ins key={at} className="rounded-[3px] bg-status-idle/20 px-0.5 text-fg no-underline">
                <span className="sr-only">added </span>
                {segment.text}
              </ins>
            ) : (
              // oxlint-disable-next-line react/no-array-index-key -- segments never reorder
              <del key={at} className="rounded-[3px] px-0.5 text-danger decoration-danger/60">
                <span className="sr-only">removed </span>
                {segment.text}
              </del>
            ),
          )}
        </p>,
      );
      index += 2;
      continue;
    }
    const { node, heading, bullet } = renderText(row.line.text, format);
    if (isBlank(row.line.text)) {
      index += 1;
      continue;
    }
    out.push(
      <p
        key={index}
        className={cn(
          "min-w-0 break-words",
          heading && "font-semibold",
          bullet && "relative pl-3.5",
          row.line.kind === "context" && "text-fg-muted",
          heading && row.line.kind === "context" && "text-fg",
        )}
      >
        {bullet ? (
          <span aria-hidden="true" className="absolute left-0.5 text-fg-subtle">
            •
          </span>
        ) : null}
        {row.line.kind === "added" ? (
          <ins className="rounded-[3px] bg-status-idle/20 px-0.5 text-fg no-underline">
            <span className="sr-only">Added: </span>
            {node}
          </ins>
        ) : row.line.kind === "removed" ? (
          <del className="rounded-[3px] px-0.5 text-danger decoration-danger/60">
            <span className="sr-only">Removed: </span>
            {node}
          </del>
        ) : (
          node
        )}
      </p>,
    );
    index += 1;
  }
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 px-4 py-3",
        size === "sm" ? "text-xs leading-4.5" : "text-sm leading-5",
        format === "code" && "font-mono",
      )}
    >
      {out}
    </div>
  );
}

/** Loading placeholder lines, shaped like a short document. */
function LoadingBody() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2.5 px-4 py-3.5">
      {["w-40", "w-4/5", "w-3/5", "w-2/3"].map((width) => (
        <Skeleton key={width} className={cn("h-3 rounded-full bg-surface-3", width)} />
      ))}
    </div>
  );
}

/** Inline added and removed text with context. */
export function DiffView({
  lines: linesProp,
  before = "",
  after = "",
  variant = "inline",
  format = "markdown",
  size = "md",
  context = 3,
  title,
  meta,
  actions,
  hideStats,
  label,
  loading,
  error,
  emptyMessage = "No changes. This version matches the one before it.",
  bare,
  className,
}: DiffViewProps) {
  const titleId = useId();
  const lines = useMemo(() => {
    const all = linesProp ?? diffLines(before, after);
    // Blank lines only space out markdown; as diff rows they'd be empty "+" rows.
    return format === "markdown" ? all.filter((line) => !isBlank(line.text)) : all;
  }, [after, before, format, linesProp]);
  const rows = useMemo(() => buildDiffRows(lines, context), [context, lines]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const expand = (id: string) => setExpanded((current) => new Set(current).add(id));
  const stats = diffStats(lines);
  const unchanged = !loading && !error && stats.added === 0 && stats.removed === 0;
  const hasHeader = Boolean(
    title || meta || actions || (!hideStats && !loading && !error && !unchanged),
  );

  return (
    <figure
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : (label ?? "Changes")}
      aria-busy={loading || undefined}
      data-variant={variant}
      className={cn(
        "@container/diff m-0 min-w-0 overflow-hidden",
        !bare && "rounded-[14px] border border-border bg-surface",
        className,
      )}
    >
      {hasHeader ? (
        <figcaption
          className={cn(
            "flex min-w-0 flex-col gap-3 px-4 py-3 @lg/diff:flex-row @lg/diff:items-start @lg/diff:justify-between @lg/diff:gap-4",
            !bare && "border-b border-border",
            bare && "px-0 pt-0",
          )}
        >
          <div className="min-w-0 flex-1">
            {title ? (
              <div id={titleId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 text-sm font-semibold text-fg">{title}</span>
                {!hideStats && !loading && !error && !unchanged ? <Stats {...stats} /> : null}
              </div>
            ) : !hideStats && !loading && !error && !unchanged ? (
              <Stats {...stats} />
            ) : null}
            {meta ? <div className="mt-0.5 text-xs leading-4.5 text-fg-muted">{meta}</div> : null}
          </div>
          {actions ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2 @lg/diff:shrink-0 @lg/diff:justify-end">
              {actions}
            </div>
          ) : null}
        </figcaption>
      ) : null}
      {loading ? (
        <>
          <span className="sr-only">Loading the changes</span>
          <LoadingBody />
        </>
      ) : error ? (
        <ErrorMessage
          title={error.message}
          action={
            error.onRetry ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={error.onRetry}
                className="pointer-coarse:min-h-11"
              >
                Try again
              </Button>
            ) : undefined
          }
          className="px-4 py-4"
        >
          {error.detail}
        </ErrorMessage>
      ) : unchanged ? (
        <p className="px-4 py-4 text-sm text-fg-muted">{emptyMessage}</p>
      ) : variant === "prose" ? (
        <ProseBody lines={lines} format={format} size={size} />
      ) : variant === "split" ? (
        <SplitBody rows={rows} format={format} size={size} expanded={expanded} expand={expand} />
      ) : (
        <InlineBody rows={rows} format={format} size={size} expanded={expanded} expand={expand} />
      )}
    </figure>
  );
}
