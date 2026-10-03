/* ----------------------------------------------------------------------------
   RevisionHistory - every saved version of a text, what each one changed, and
   Restore. Shared by knowledge entries, workspace instructions and
   organization identity.

   Restoring never deletes anything: it saves the old text as a new version,
   so it's reversible and confirms with a toast and Undo, not a dialog.

   Layouts:
   - "stacked" (default): a timeline; each version opens in place to show its
     changes. Fits a 520px sheet.
   - "split": versions on the left, the selected version's changes on the
     right. For pages and wide sheets.
   -------------------------------------------------------------------------- */

import { useId, useState, type ReactNode } from "react";
import { ChevronRightIcon, LoaderCircleIcon, RotateCcwIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DiffView,
  failedLoadParts,
  type DiffFormat,
  type FailedLoad,
} from "@/components/ui/diff-view";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { ErrorMessage } from "@/components/ui/error-message";
import { MetaChip } from "@/components/ui/meta-chip";
import { RelativeTime } from "@/components/ui/relative-time";
import { InlineDisabledReason } from "@/components/ui/select-menu";
import { Skeleton } from "@/components/ui/skeleton";

export interface Revision {
  id: string;
  /** Who saved it: a person, or "OpenGeni" for an approved agent change. */
  author: string;
  /** When, as an ISO time. Shown as "3 days ago" with the exact time on hover. */
  createdAt?: string;
  /** Or a ready label, when there's no timestamp: "Created 18 Sep". */
  createdLabel?: string;
  /** One line: "Added: Prefer small PRs." */
  summary: string;
  /** The full text of this version. */
  content: string;
}

export type RevisionHistoryLayout = "stacked" | "split";

export interface RevisionHistoryProps {
  /** Newest first. The first one is the current version. */
  revisions: readonly Revision[];
  layout?: RevisionHistoryLayout;
  format?: DiffFormat;
  /** Restores a version by saving it again as the newest. Return a promise for the saving state. */
  onRestore?: (revision: Revision) => void | Promise<unknown>;
  /** Why versions can't be restored here, and who can. */
  restoreDisabledReason?: string;
  /** Which version starts open (stacked) or selected (split). Defaults to the newest. */
  defaultRevisionId?: string;
  /** The clock for "3 days ago". */
  now?: Date;
  /** Accessible name: "Workspace instructions history". */
  label?: string;
  loading?: boolean;
  /** What happened, what to do next, and an optional retry. */
  error?: FailedLoad;
  className?: string;
}

/** The text a version replaced: the one saved right before it, or nothing for the first. */
export function previousContent(revisions: readonly Revision[], index: number): string {
  return revisions[index + 1]?.content ?? "";
}

function When({ revision, now }: { revision: Revision; now?: Date }) {
  if (revision.createdAt) {
    return <RelativeTime date={revision.createdAt} now={now} focusable={false} />;
  }
  return <span>{revision.createdLabel}</span>;
}

function RestoreButton({
  revision,
  onRestore,
  disabledReason,
}: {
  revision: Revision;
  onRestore?: (revision: Revision) => void | Promise<unknown>;
  disabledReason?: string;
}) {
  const [pending, setPending] = useState(false);
  if (!onRestore) return null;
  const restore = async () => {
    const result = onRestore(revision);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      setPending(true);
      try {
        await result;
      } finally {
        setPending(false);
      }
    }
  };
  // Not allowed: still focusable, and the reason shows on hover, focus and tap.
  return (
    <DisabledReason reason={disabledReason ?? ""} disabled={Boolean(disabledReason)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-label={`Restore this version: ${revision.summary}`}
        onClick={() => void restore()}
        className="shrink-0 pointer-coarse:min-h-11"
      >
        {pending ? (
          <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
        ) : (
          <RotateCcwIcon aria-hidden="true" />
        )}
        {pending ? "Restoring…" : "Restore"}
      </Button>
    </DisabledReason>
  );
}

/** "Current" is a fact about the version, not a health status: a quiet chip. */
function CurrentTag() {
  return <MetaChip variant="outline">Current</MetaChip>;
}

function Stacked({
  revisions,
  format,
  onRestore,
  restoreDisabledReason,
  defaultRevisionId,
  now,
}: RevisionHistoryProps & { format: DiffFormat }) {
  const [open, setOpen] = useState<Set<string>>(
    () => new Set([defaultRevisionId ?? revisions[0]?.id ?? ""]),
  );
  const baseId = useId();
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ol className="flex min-w-0 flex-col">
      {revisions.map((revision, index) => {
        const isOpen = open.has(revision.id);
        const current = index === 0;
        const last = index === revisions.length - 1;
        const panelId = `${baseId}-${index}`;
        return (
          <li
            key={revision.id}
            className="relative grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3"
          >
            {/* The timeline: a dot per version, joined by a line. */}
            <span aria-hidden="true" className="relative flex justify-center">
              <span
                className={cn(
                  "relative z-10 mt-[18px] size-2.5 rounded-full border-2",
                  current ? "border-brand bg-brand" : "border-border-strong bg-surface",
                )}
              />
              {!last ? <span className="absolute top-[30px] bottom-0 w-px bg-border" /> : null}
              {index > 0 ? <span className="absolute top-0 h-[18px] w-px bg-border" /> : null}
            </span>
            <div className={cn("min-w-0", !last && "pb-2")}>
              <div className="flex min-w-0 items-start gap-3 py-2">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => toggle(revision.id)}
                  className="group/rev -mx-2 flex min-w-0 flex-1 items-start gap-2 rounded-[10px] px-2 py-1 text-left transition-colors duration-[120ms] hover:bg-surface-2 pointer-coarse:min-h-11"
                >
                  <ChevronRightIcon
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 size-4 shrink-0 text-fg-subtle transition-transform duration-[120ms]",
                      isOpen && "rotate-90",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fg">{revision.summary}</span>
                    <span className="block text-xs leading-4.5 text-fg-muted">
                      {revision.author} · <When revision={revision} now={now} />
                    </span>
                  </span>
                </button>
                <div className="flex shrink-0 items-center pt-1">
                  {current ? (
                    <CurrentTag />
                  ) : (
                    <RestoreButton
                      revision={revision}
                      onRestore={onRestore}
                      disabledReason={restoreDisabledReason}
                    />
                  )}
                </div>
              </div>
              {isOpen ? (
                <div id={panelId} className="pb-2 pl-6">
                  <DiffView
                    before={previousContent(revisions, index)}
                    after={revision.content}
                    format={format}
                    size="sm"
                    hideStats
                    label={`Changes in: ${revision.summary}`}
                  />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Split({
  revisions,
  format,
  onRestore,
  restoreDisabledReason,
  defaultRevisionId,
  now,
}: RevisionHistoryProps & { format: DiffFormat }) {
  const [selectedId, setSelectedId] = useState(defaultRevisionId ?? revisions[0]?.id);
  const index = Math.max(
    0,
    revisions.findIndex((revision) => revision.id === selectedId),
  );
  const selected = revisions[index];
  const listId = useId();
  return (
    <div className="grid min-w-0 gap-4 @2xl/history:grid-cols-[15rem_minmax(0,1fr)]">
      <div
        role="listbox"
        id={listId}
        aria-label="Versions"
        aria-orientation="vertical"
        className="flex min-w-0 flex-col gap-0.5"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const next = Math.min(
            revisions.length - 1,
            Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)),
          );
          setSelectedId(revisions[next]!.id);
          (event.currentTarget.children[next] as HTMLElement | undefined)?.focus();
        }}
      >
        {revisions.map((revision, at) => {
          const active = at === index;
          return (
            <div
              key={revision.id}
              role="option"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setSelectedId(revision.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedId(revision.id);
                }
              }}
              className={cn(
                "relative min-w-0 cursor-pointer rounded-[10px] px-3 py-2 transition-colors duration-[120ms] pointer-coarse:min-h-11",
                active ? "bg-surface-2" : "hover:bg-surface-2/70",
              )}
            >
              {active ? (
                // The selected marker every list uses (ListRow, nav): 2 x 16px brand bar.
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand"
                />
              ) : null}
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-fg">
                  {revision.summary}
                </span>
              </span>
              <span className="block truncate text-xs leading-4.5 text-fg-muted">
                {revision.author} · <When revision={revision} now={now} />
                {at === 0 ? " · Current" : ""}
              </span>
            </div>
          );
        })}
      </div>
      {selected ? (
        <DiffView
          before={previousContent(revisions, index)}
          after={selected.content}
          format={format}
          title={selected.summary}
          meta={
            <>
              {selected.author} · <When revision={selected} now={now} />
            </>
          }
          actions={
            index === 0 ? (
              <CurrentTag />
            ) : (
              <RestoreButton
                revision={selected}
                onRestore={onRestore}
                disabledReason={restoreDisabledReason}
              />
            )
          }
        />
      ) : null}
    </div>
  );
}

/** Every saved version of a text, what each changed, and Restore. */
export function RevisionHistory(props: RevisionHistoryProps) {
  const {
    layout = "stacked",
    format = "markdown",
    revisions,
    restoreDisabledReason,
    loading,
    error,
    label = "History",
    className,
  } = props;
  let body: ReactNode;
  if (loading) {
    body = (
      <div aria-hidden="true" className="flex flex-col gap-4 py-2">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3">
            <Skeleton className="size-2.5 rounded-full bg-surface-3" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-48 max-w-[70%] rounded-full bg-surface-3" />
              <Skeleton className="h-3 w-32 max-w-[50%] rounded-full bg-surface-3" />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (error) {
    const failure = failedLoadParts(error);
    body = (
      <ErrorMessage
        title={error.message}
        details={failure.details}
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
      >
        {failure.detail}
      </ErrorMessage>
    );
  } else if (revisions.length === 0) {
    body = <p className="text-sm text-fg-muted">No versions yet. Saving creates the first one.</p>;
  } else {
    body =
      layout === "split" ? (
        <Split {...props} format={format} />
      ) : (
        <Stacked {...props} format={format} />
      );
  }
  return (
    <section
      aria-label={label}
      aria-busy={loading || undefined}
      data-layout={layout}
      className={cn("@container/history min-w-0", className)}
    >
      {body}
      {restoreDisabledReason && !loading && !error && revisions.length > 1 ? (
        <div className="mt-3">
          <InlineDisabledReason>{restoreDisabledReason}</InlineDisabledReason>
        </div>
      ) : null}
    </section>
  );
}
