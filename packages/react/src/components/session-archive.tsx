import type {
  SessionArchiveAction,
  SessionArchiveApplyResponse,
  SessionArchiveBlocker,
  SessionArchiveProjection,
} from "@opengeni/sdk";
import {
  ArchiveIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useSessionArchive } from "../hooks/use-session-archive";
import { cn } from "../lib/cn";
import type { ClientOverride } from "../provider";

const MAX_VISIBLE_BLOCKERS = 20;

type SessionArchiveDialogBaseProps = ClientOverride & {
  sessionId: string;
  sessionTitle?: string | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied?: ((response: SessionArchiveApplyResponse) => void) | undefined;
  className?: string | undefined;
};

export type SessionArchiveDialogProps = SessionArchiveDialogBaseProps &
  ({ action: "archive"; targetSealId?: never } | { action: "unarchive"; targetSealId: string });

export type SessionArchiveBannerProps = {
  archive: SessionArchiveProjection | null | undefined;
  onReviewUnarchive?: (() => void) | undefined;
  className?: string | undefined;
};

function actionTitle(action: SessionArchiveAction): string {
  return action === "archive" ? "Archive this session tree?" : "Unarchive this session tree?";
}

function actionVerb(action: SessionArchiveAction): string {
  return action === "archive" ? "Archive" : "Unarchive";
}

function actionProgressLabel(action: SessionArchiveAction): string {
  return action === "archive" ? "Archiving…" : "Unarchiving…";
}

function pluralizeSessions(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "session" : "sessions"}`;
}

function blockerLabel(blocker: SessionArchiveBlocker): string {
  return blocker.code
    .split("_")
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function trapTab(event: KeyboardEvent<HTMLDivElement>, dialog: HTMLDivElement): void {
  if (event.key !== "Tab") {
    return;
  }
  const focusable = [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Recursive archive/unarchive confirmation. It always obtains a fresh dry-run
 * plan, names blockers, and never presents unarchive as a resume operation.
 */
export function SessionArchiveDialog(props: SessionArchiveDialogProps) {
  const { action, sessionId, sessionTitle, open, onOpenChange, onApplied, className } = props;
  const archive = useSessionArchive(sessionId, action, {
    ...(props.client ? { client: props.client } : {}),
    ...(props.workspaceId ? { workspaceId: props.workspaceId } : {}),
    ...(action === "unarchive" ? { targetSealId: props.targetSealId } : {}),
  });
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { prepare, reset } = archive;

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    void prepare();
  }, [open, prepare, reset]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => returnFocus?.focus();
  }, [open]);

  if (!open) {
    return null;
  }

  const plannedRoot = archive.plan?.roots[0] ?? null;
  const memberCount = plannedRoot?.memberCount ?? 0;
  const blockers = plannedRoot?.blockers ?? [];
  const canApply = archive.plan?.canApply === true && blockers.length === 0;
  const busy = archive.planning || archive.applying;
  const close = () => {
    if (!archive.applying) {
      onOpenChange(false);
    }
  };
  const confirm = async () => {
    const response = await archive.apply();
    if (response) {
      onApplied?.(response);
      onOpenChange(false);
    }
  };

  return (
    <div
      className="og-root fixed inset-0 z-50 grid place-items-center bg-og-bg/75 p-4 backdrop-blur-sm"
      data-session-archive-overlay
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
          }
          if (dialogRef.current) trapTab(event, dialogRef.current);
        }}
        className={cn(
          "flex max-h-[calc(100dvh-2rem)] w-[min(calc(100vw-2rem),32rem)] flex-col overflow-y-auto rounded-og-lg border border-og-border bg-og-surface-1 shadow-og-md",
          className,
        )}
      >
        <div className="flex items-start gap-3 border-b border-og-border px-4 py-4 sm:px-5">
          <span
            className={cn(
              "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full",
              action === "archive"
                ? "bg-og-status-failed/15 text-og-status-failed"
                : "bg-og-accent/15 text-og-accent",
            )}
          >
            {action === "archive" ? (
              <ArchiveIcon className="size-4.5" aria-hidden />
            ) : (
              <RotateCcwIcon className="size-4.5" aria-hidden />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-og-md font-semibold text-og-fg">
              {actionTitle(action)}
            </h2>
            <p id={descriptionId} className="mt-1 text-og-sm leading-5 text-og-fg-muted">
              {action === "archive" ? (
                <>
                  This adds an audited execution fence to the complete descendant tree. It keeps
                  history and evidence; it does not delete, pause, cancel, or stop live work.
                </>
              ) : (
                <>
                  This releases only the selected archive seal. It will not resume work, restart a
                  goal, schedule, job, wait, workflow, or sandbox.
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close archive review"
            disabled={archive.applying}
            onClick={close}
            className="flex size-9 shrink-0 items-center justify-center rounded-og-sm text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            <XIcon className="size-4" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
          <div className="rounded-og-md border border-og-border bg-og-surface-2 px-3 py-2.5">
            <p className="truncate text-og-sm font-medium text-og-fg">
              {sessionTitle?.trim() || `Session ${sessionId.slice(0, 8)}`}
            </p>
            <p className="mt-1 font-og-mono text-og-xs text-og-fg-subtle">{sessionId}</p>
          </div>

          <div aria-live="polite" aria-busy={archive.planning || undefined}>
            {archive.planning ? (
              <p className="flex items-center gap-2 text-og-sm text-og-fg-muted">
                <LoaderCircleIcon className="size-4 animate-og-spin" aria-hidden />
                Checking the exact recursive tree and live-work blockers…
              </p>
            ) : plannedRoot ? (
              <div className="flex flex-col gap-2">
                <p className="text-og-sm text-og-fg">
                  The current plan covers <strong>{pluralizeSessions(memberCount)}</strong>.
                </p>
                <p className="break-all font-og-mono text-og-xs text-og-fg-subtle">
                  {archive.plan?.manifestChecksum}
                </p>
              </div>
            ) : null}
          </div>

          {blockers.length > 0 ? (
            <div
              role="status"
              className="rounded-og-md border border-og-status-failed/35 bg-og-status-failed/10 p-3"
            >
              <p className="flex items-start gap-2 text-og-sm font-medium text-og-status-failed">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                Settle {blockers.length.toLocaleString()} live-work{" "}
                {blockers.length === 1 ? "blocker" : "blockers"}, then check again.
              </p>
              <ul
                aria-label="Archive blockers"
                tabIndex={0}
                className="mt-2 max-h-44 space-y-1.5 overflow-y-auto pl-6 text-og-xs text-og-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent"
              >
                {blockers.slice(0, MAX_VISIBLE_BLOCKERS).map((blocker, index) => (
                  <li key={`${blocker.code}:${blocker.sessionId}:${blocker.resourceId ?? index}`}>
                    <span className="font-medium text-og-fg">{blockerLabel(blocker)}</span>
                    {blocker.state ? ` · ${blocker.state}` : ""} · session{" "}
                    {blocker.sessionId.slice(0, 8)}
                  </li>
                ))}
              </ul>
              {blockers.length > MAX_VISIBLE_BLOCKERS ? (
                <p className="mt-2 pl-6 text-og-xs text-og-fg-subtle">
                  And {(blockers.length - MAX_VISIBLE_BLOCKERS).toLocaleString()} more blockers.
                </p>
              ) : null}
            </div>
          ) : plannedRoot && canApply ? (
            <p className="text-og-sm text-og-fg-muted">
              No live-work blockers were found. Apply still rechecks the exact tree, revisions, and
              archive state atomically.
            </p>
          ) : null}

          {archive.error ? (
            <div
              role="alert"
              className="rounded-og-md border border-og-status-failed/35 bg-og-status-failed/10 px-3 py-2 text-og-sm text-og-status-failed"
            >
              {archive.error.message}
            </div>
          ) : null}

          {action === "unarchive" ? (
            <p className="rounded-og-md border border-og-border bg-og-bg px-3 py-2 text-og-xs text-og-fg-muted">
              Another overlapping seal may keep some or all members archived. Use a separate,
              authorized Resume command only when you intend to restart work.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-og-border px-4 py-3 sm:flex-row sm:justify-end sm:px-5">
          <button
            ref={cancelRef}
            type="button"
            disabled={archive.applying}
            onClick={close}
            className="min-h-11 rounded-og-sm border border-og-border px-3 py-2 text-og-sm font-medium text-og-fg-muted hover:border-og-border-strong hover:text-og-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-session-archive-confirm
            disabled={!canApply || busy}
            onClick={() => void confirm()}
            className={cn(
              "min-h-11 rounded-og-sm px-3 py-2 text-og-sm font-semibold disabled:cursor-not-allowed disabled:border disabled:border-og-border disabled:bg-og-surface-3 disabled:text-og-fg",
              action === "archive"
                ? "bg-og-fg text-og-bg ring-1 ring-inset ring-og-status-failed"
                : "bg-og-fg text-og-bg",
            )}
          >
            {archive.applying
              ? actionProgressLabel(action)
              : memberCount > 0
                ? `${actionVerb(action)} ${pluralizeSessions(memberCount)}`
                : actionVerb(action)}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Read-only banner for an authorized exact lookup of an archived session. */
export function SessionArchiveBanner({
  archive,
  onReviewUnarchive,
  className,
}: SessionArchiveBannerProps) {
  if (!archive?.archived) {
    return null;
  }
  return (
    <section
      aria-label="Archived session"
      className={cn(
        "og-root flex flex-col gap-3 border-b border-og-border bg-og-surface-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <ArchiveIcon className="mt-0.5 size-4 shrink-0 text-og-fg-muted" aria-hidden />
        <div className="min-w-0">
          <p className="text-og-sm font-medium text-og-fg">Archived — execution is fenced</p>
          <p className="mt-0.5 text-og-xs text-og-fg-muted">
            Durable history and evidence remain available. Unarchive does not resume this session.
          </p>
          {archive.nearestFence ? (
            <p className="mt-1 truncate font-og-mono text-og-xs text-og-fg-subtle">
              seal {archive.nearestFence.sealId} · revision {archive.archiveRevision}
            </p>
          ) : null}
        </div>
      </div>
      {onReviewUnarchive ? (
        <button
          type="button"
          onClick={onReviewUnarchive}
          className="min-h-11 shrink-0 rounded-og-sm border border-og-border px-3 py-2 text-og-sm font-medium text-og-fg hover:border-og-border-strong hover:bg-og-surface-3"
        >
          Review unarchive
        </button>
      ) : null}
    </section>
  );
}
