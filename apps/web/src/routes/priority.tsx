// "For you" — the priority feed. One ranked ledger of root workstreams,
// most expensive inaction first. Structure is typographic (rank numerals,
// hairlines, a mono agent-time column); color is reserved for the status
// dots and the single primary action per row.
import { useChannels, useWorkspaceSessions } from "@opengeni/react";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { toast } from "sonner";

import { isApiErrorStatus } from "@/api";
import { CreatorMonogram } from "@/components/creator-monogram";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAppContext } from "@/context";
import { buildPriorityFeed, formatAgentMinutes, type PriorityEntry } from "@/lib/priority-feed";
import { hasWorkspacePermission } from "@/lib/permissions";
import { sessionDisplayTitle } from "@/lib/session-rename";
import {
  notifySessionListChanged,
  subscribeToWorkspaceSessionListChanges,
} from "@/lib/session-list-invalidation";
import { relativeTimeLabel } from "@/lib/sessions-group";
import { sessionDescendantCountText } from "@/lib/session-tree-count";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

type PendingStop = {
  session: Session;
  clientEventId: string;
};

type BrokenActions = {
  canControl: boolean;
  dismissing: ReadonlySet<string>;
  onDismiss: (session: Session) => Promise<void>;
  onRequestStop: (session: Session, trigger: HTMLButtonElement) => void;
};

export function PriorityRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const { sessions, nextCursor, loading, error, refresh } = useWorkspaceSessions({
    limit: 50,
    parentSessionId: null,
    pollIntervalMs: 15_000,
  });
  const [locallyHidden, setLocallyHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingStop, setPendingStop] = useState<PendingStop | null>(null);
  const stopTriggerRef = useRef<HTMLElement | null>(null);
  const stopFocusFallbackRef = useRef<HTMLHeadingElement | null>(null);
  const canControl = hasWorkspacePermission(context.accessContext, workspaceId, "sessions:control");
  useEffect(
    () =>
      subscribeToWorkspaceSessionListChanges(workspaceId, (invalidation) => {
        if (invalidation.archived !== undefined) {
          setLocallyHidden((current) => {
            const next = new Set(current);
            if (invalidation.archived) next.add(invalidation.sessionId);
            else next.delete(invalidation.sessionId);
            return next;
          });
        }
        void refresh();
      }),
    [refresh, workspaceId],
  );
  useEffect(() => {
    const listedIds = new Set(sessions.map((session) => session.id));
    setLocallyHidden((current) => {
      const next = new Set([...current].filter((sessionId) => !listedIds.has(sessionId)));
      if (next.size === current.size) return current;
      return next;
    });
  }, [sessions]);
  const { channels } = useChannels({ pollIntervalMs: 60_000 });
  const channelNames = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel.name])),
    [channels],
  );
  const visibleSessions = useMemo(
    () => sessions.filter((session) => !locallyHidden.has(session.id)),
    [locallyHidden, sessions],
  );
  const feed = useMemo(() => buildPriorityFeed(visibleSessions), [visibleSessions]);
  const dismissBroken = useCallback(
    async (session: Session): Promise<void> => {
      if (dismissing.has(session.id)) return;
      setDismissing((current) => new Set(current).add(session.id));
      try {
        const updated = await context.client.updateSessionArchive(workspaceId, session.id, {
          archived: true,
          expectedVersion: session.archiveVersion ?? 0,
        });
        setLocallyHidden((current) => new Set(current).add(session.id));
        notifySessionListChanged({
          workspaceId,
          sessionId: session.id,
          archived: updated.archived,
        });
        toast.success("Removed from For you", {
          description: "You can restore it from Archived.",
        });
      } catch (dismissError) {
        toast.error("Couldn't dismiss the workstream.", {
          description: dismissError instanceof Error ? dismissError.message : String(dismissError),
        });
        void refresh();
      } finally {
        setDismissing((current) => {
          const next = new Set(current);
          next.delete(session.id);
          return next;
        });
      }
    },
    [context.client, dismissing, refresh, workspaceId],
  );
  const stopBroken = useCallback(async (): Promise<boolean> => {
    if (!pendingStop) return false;
    const { session, clientEventId } = pendingStop;
    try {
      await context.client.cancelSession(workspaceId, session.id, {
        clientEventId,
        reason: "Stopped from For you",
        expectedControlEtag: session.effectiveControl.controlEtag,
      });
      // Closing autofocus can run before React removes the hidden row. Clear
      // the doomed opener explicitly so the dialog selects the stable heading
      // instead of briefly focusing a node that is about to disconnect.
      stopTriggerRef.current = null;
      setLocallyHidden((current) => new Set(current).add(session.id));
      notifySessionListChanged({ workspaceId, sessionId: session.id });
      toast.success("Workstream stopped");
      return true;
    } catch (stopError) {
      toast.error("Couldn't stop the workstream.", {
        description: stopError instanceof Error ? stopError.message : String(stopError),
      });
      if (isApiErrorStatus(stopError, 409)) {
        await refresh();
        setPendingStop(null);
      } else {
        void refresh();
      }
      return false;
    }
  }, [context.client, pendingStop, refresh, workspaceId]);
  const requestStop = useCallback((session: Session, trigger: HTMLButtonElement) => {
    stopTriggerRef.current = trigger;
    setPendingStop({ session, clientEventId: crypto.randomUUID() });
  }, []);
  // The date caption changes once a day; don't rebuild the Intl formatter on
  // every 15s poll re-render.
  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
      }),
    [],
  );
  const empty =
    feed.blocked.length === 0 &&
    feed.broken.length === 0 &&
    feed.finished.length === 0 &&
    feed.waiting.length === 0;

  return (
    <div data-workspace-scroll-owner="self-managed" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 pb-16 pt-8">
        <header className="flex items-baseline gap-3 pb-6">
          <h1
            ref={stopFocusFallbackRef}
            tabIndex={-1}
            className="text-lg font-semibold tracking-[-0.01em]"
          >
            For you
          </h1>
          <span className="ml-auto font-mono text-2xs text-fg-subtle">
            sorted by agent-time lost
          </span>
        </header>

        {loading && sessions.length === 0 ? (
          <p className="px-1 py-6 text-sm text-fg-subtle">Loading sessions…</p>
        ) : error && sessions.length === 0 ? (
          <div role="alert" className="px-1 py-6 text-sm text-fg-subtle">
            Sessions are unavailable.{" "}
            <button
              type="button"
              className="underline hover:text-fg"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-baseline border-b border-border pb-1.5">
              <span className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                {today}
                {feed.needsYou > 0 ? ` · ${feed.needsYou} need you` : " · nothing needs you"}
              </span>
              <span className="ml-auto font-mono text-2xs text-fg-subtle">agent-time lost</span>
            </div>

            {empty ? (
              <p className="px-1 py-10 text-sm text-fg-subtle">
                Nothing to look at. New approvals, failures, and finished work land here first.
              </p>
            ) : (
              <>
                <PriorityTierSection
                  title="Blocked on you"
                  hint="agents are stopped until you act"
                  entries={feed.blocked}
                  workspaceId={workspaceId}
                  channelNames={channelNames}
                />
                <PriorityTierSection
                  title="Broken"
                  hint="won't resume on its own"
                  entries={feed.broken}
                  workspaceId={workspaceId}
                  channelNames={channelNames}
                  brokenActions={{
                    canControl,
                    dismissing,
                    onDismiss: dismissBroken,
                    onRequestStop: requestStop,
                  }}
                />
                <PriorityTierSection
                  title="Recently finished"
                  hint="results you may want to look at"
                  entries={feed.finished}
                  workspaceId={workspaceId}
                  channelNames={channelNames}
                />
                <PriorityTierSection
                  title="Waiting, not on you"
                  hint="resumes without your help"
                  entries={feed.waiting}
                  workspaceId={workspaceId}
                  channelNames={channelNames}
                />
              </>
            )}

            {feed.healthy.workstreams > 0 ? (
              <Link
                to="/workspaces/$workspaceId/sessions"
                params={{ workspaceId }}
                className="mt-8 flex w-full items-center gap-2.5 border-t border-border px-3 pt-4 text-sm text-fg-subtle hover:text-fg-muted"
              >
                <ChevronRightIcon className="size-3.5" />
                Running fine without you
                <span className="ml-auto font-mono text-2xs tabular-nums">
                  {feed.healthy.workstreams} session{feed.healthy.workstreams === 1 ? "" : "s"} ·{" "}
                  {feed.healthy.agents.toLocaleString()} agent{feed.healthy.agents === 1 ? "" : "s"}
                </span>
              </Link>
            ) : null}
            {nextCursor ? (
              // Honest truncation: the feed ranks only the most recently
              // active root page, so long-stalled workstreams past it are not
              // ranked here yet.
              <p role="status" className="px-3 pt-3 text-xs text-fg-subtle">
                Ranked over the {sessions.length} most recently active sessions. Older ones are in{" "}
                <Link
                  to="/workspaces/$workspaceId/sessions"
                  params={{ workspaceId }}
                  className="underline hover:text-fg-muted"
                >
                  Sessions
                </Link>
                .
              </p>
            ) : null}
          </>
        )}
      </div>
      <ConfirmDialog
        open={pendingStop !== null}
        onOpenChange={(open) => {
          if (!open) setPendingStop(null);
        }}
        title={<>Stop “{pendingStop ? sessionDisplayTitle(pendingStop.session) : ""}”?</>}
        description={stopDescription(pendingStop?.session ?? null)}
        confirmLabel="Stop workstream"
        cancelAutoFocus
        restoreFocusRef={stopTriggerRef}
        restoreFocusFallbackRef={stopFocusFallbackRef}
        onConfirm={stopBroken}
      />
    </div>
  );
}

function stopDescription(session: Session | null): string {
  const descendants = session?.treeStats?.totalDescendants ?? 0;
  const truncated = session?.treeStats?.truncated ?? false;
  const formattedDescendants = sessionDescendantCountText(descendants, false);
  return descendants > 0
    ? `This permanently stops the workstream and ${
        truncated ? `at least ${formattedDescendants}` : `its ${formattedDescendants}`
      } spawned session${
        descendants === 1 && !truncated ? "" : "s"
      }. You won't be able to continue them.`
    : "This permanently stops the workstream. You won't be able to continue it.";
}

function PriorityTierSection(props: {
  title: string;
  hint: string;
  entries: PriorityEntry[];
  workspaceId: string;
  channelNames: ReadonlyMap<string, string>;
  brokenActions?: BrokenActions;
}) {
  if (props.entries.length === 0) return null;
  return (
    <section className="pt-7">
      <div className="flex items-baseline gap-2.5 pb-1">
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">
          {props.title}
        </h2>
        <span className="font-mono text-2xs tabular-nums text-fg-subtle">
          {props.entries.length}
        </span>
        <span className="ml-auto text-xs text-fg-subtle">{props.hint}</span>
      </div>
      <div role="list">
        {props.entries.map((entry, index) => (
          <PriorityRow
            key={entry.session.id}
            entry={entry}
            first={index === 0}
            workspaceId={props.workspaceId}
            channelNames={props.channelNames}
            brokenActions={props.brokenActions}
          />
        ))}
      </div>
    </section>
  );
}

const DOT_TONE: Record<PriorityEntry["tier"], string> = {
  blocked: "bg-status-waiting",
  broken: "bg-status-failed",
  finished: "bg-status-idle",
  waiting: "bg-status-cancelled",
};

function ledgerFigure(entry: PriorityEntry): {
  figure: string;
  quiet: boolean;
  basis: string | null;
} {
  if (entry.tier === "blocked") {
    return {
      figure: formatAgentMinutes(entry.costMinutes),
      quiet: false,
      basis:
        entry.waitingAgents > 1
          ? `${entry.waitingAgents} waiting × ${formatAgentMinutes(entry.waitingMinutes)}`
          : `waiting ${formatAgentMinutes(entry.waitingMinutes)}`,
    };
  }
  if (entry.tier === "broken") {
    return {
      figure: formatAgentMinutes(entry.waitingMinutes),
      quiet: false,
      basis: "since failure",
    };
  }
  if (entry.tier === "finished") {
    return {
      figure: `${formatAgentMinutes(entry.waitingMinutes)} ago`,
      quiet: true,
      basis: `${entry.waitingAgents} agent${entry.waitingAgents === 1 ? "'s" : "s'"} work`,
    };
  }
  return { figure: "—", quiet: true, basis: null };
}

function PriorityRow(props: {
  entry: PriorityEntry;
  first: boolean;
  workspaceId: string;
  channelNames: ReadonlyMap<string, string>;
  brokenActions?: BrokenActions;
}) {
  const { entry } = props;
  const session = entry.session;
  const title = sessionDisplayTitle(session);
  const channelName = session.channelId ? props.channelNames.get(session.channelId) : undefined;
  const { figure, quiet, basis } = ledgerFigure(entry);
  // The single loudest thing on the page is the #1 figure; the product's
  // accent-bar idiom marks that same row as "start here".
  const top = entry.rank === 1 && entry.tier === "blocked";

  return (
    <article
      role="listitem"
      className={cn(
        "relative flex items-start gap-4 px-2.5 py-3.5",
        !props.first && "border-t border-border",
      )}
    >
      {top ? (
        <span className="absolute -left-0.5 bottom-4 top-4 w-0.5 rounded-full bg-brand" />
      ) : null}
      <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-xs tabular-nums text-fg-subtle">
        {entry.rank ?? "·"}
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <Link
            to="/workspaces/$workspaceId/sessions/$sessionId"
            params={{ workspaceId: props.workspaceId, sessionId: session.id }}
            className="truncate text-sm font-semibold hover:underline"
          >
            {title}
          </Link>
          {channelName ? (
            <span className="shrink-0 text-xs text-fg-subtle"># {channelName}</span>
          ) : null}
        </div>
        <p className="flex items-center gap-2 text-xs leading-normal text-fg-muted">
          <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", DOT_TONE[entry.tier])}
          />
          {entry.reason}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5">
          <Link
            to="/workspaces/$workspaceId/sessions/$sessionId"
            params={{ workspaceId: props.workspaceId, sessionId: session.id }}
            className="inline-flex min-h-7 items-center text-xs font-medium text-brand hover:underline pointer-coarse:min-h-11"
          >
            Open session
          </Link>
          {entry.tier === "broken" && props.brokenActions?.canControl ? (
            <button
              type="button"
              className="inline-flex min-h-7 items-center text-xs font-medium text-status-failed hover:underline pointer-coarse:min-h-11"
              onClick={(event: MouseEvent<HTMLButtonElement>) =>
                props.brokenActions?.onRequestStop(session, event.currentTarget)
              }
            >
              Stop workstream
            </button>
          ) : null}
          {entry.tier === "broken" && props.brokenActions ? (
            <button
              type="button"
              className="inline-flex min-h-7 items-center text-xs font-medium text-fg-subtle hover:text-fg-muted hover:underline disabled:cursor-wait disabled:opacity-50 pointer-coarse:min-h-11"
              title="Remove from For you and move to Archived"
              disabled={props.brokenActions.dismissing.has(session.id)}
              onClick={() => void props.brokenActions?.onDismiss(session)}
            >
              {props.brokenActions.dismissing.has(session.id) ? "Dismissing…" : "Dismiss"}
            </button>
          ) : null}
        </div>
      </div>
      <div className="grid w-32 shrink-0 gap-0.5 pt-0.5 text-right">
        <span
          className={cn(
            "font-mono tabular-nums tracking-tight",
            quiet ? "text-xs text-fg-subtle" : "text-sm font-semibold text-fg",
            top && "text-lg",
          )}
        >
          {figure}
        </span>
        {basis ? <span className="text-2xs text-fg-subtle">{basis}</span> : null}
      </div>
      <div className="flex w-20 shrink-0 items-center justify-end gap-1.5 pt-1">
        <CreatorMonogram createdBy={session.createdBy} className="size-4.5" />
        <span className="font-mono text-2xs tabular-nums text-fg-subtle">
          {relativeTimeLabel(session.updatedAt)}
        </span>
      </div>
    </article>
  );
}
