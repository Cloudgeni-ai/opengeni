// "For you" — the priority feed. One ranked ledger of root workstreams,
// most expensive inaction first. Structure is typographic (rank numerals,
// hairlines, a mono agent-time column); color is reserved for the status
// dots and the single primary action per row.
import { useChannels, useWorkspaceSessions } from "@opengeni/react";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";

import { creatorHue, creatorInitials } from "@/lib/creator-initials";
import { buildPriorityFeed, formatAgentMinutes, type PriorityEntry } from "@/lib/priority-feed";
import { relativeTimeLabel } from "@/lib/sessions-group";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

export function PriorityRoute({ workspaceId }: { workspaceId: string }) {
  const { sessions, loading, error, refresh } = useWorkspaceSessions({
    limit: 50,
    parentSessionId: null,
    pollIntervalMs: 15_000,
  });
  const { channels } = useChannels({ pollIntervalMs: 60_000 });
  const channelNames = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel.name])),
    [channels],
  );
  const feed = useMemo(() => buildPriorityFeed(sessions), [sessions]);
  const empty =
    feed.blocked.length === 0 &&
    feed.broken.length === 0 &&
    feed.finished.length === 0 &&
    feed.waiting.length === 0;

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  return (
    <div data-workspace-scroll-owner="self-managed" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 pb-16 pt-8">
        <header className="flex items-baseline gap-3 pb-6">
          <h1 className="text-lg font-semibold tracking-[-0.01em]">For you</h1>
          <span className="ml-auto font-mono text-2xs text-fg-subtle">
            sorted by agent-time lost
          </span>
        </header>

        {loading && sessions.length === 0 ? (
          <p className="px-1 py-6 text-sm text-fg-subtle">Loading workstreams…</p>
        ) : error && sessions.length === 0 ? (
          <div role="alert" className="px-1 py-6 text-sm text-fg-subtle">
            Workstreams are unavailable.{" "}
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
                  {feed.healthy.workstreams} workstream{feed.healthy.workstreams === 1 ? "" : "s"} ·{" "}
                  {feed.healthy.agents.toLocaleString()} agent{feed.healthy.agents === 1 ? "" : "s"}
                </span>
              </Link>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function PriorityTierSection(props: {
  title: string;
  hint: string;
  entries: PriorityEntry[];
  workspaceId: string;
  channelNames: ReadonlyMap<string, string>;
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

function sessionTitle(session: Session): string {
  return session.title?.trim() || session.initialMessage?.trim() || "Untitled session";
}

function PriorityRow(props: {
  entry: PriorityEntry;
  first: boolean;
  workspaceId: string;
  channelNames: ReadonlyMap<string, string>;
}) {
  const { entry } = props;
  const session = entry.session;
  const title = sessionTitle(session);
  const channelName = session.channelId ? props.channelNames.get(session.channelId) : undefined;
  const initials = creatorInitials(session.createdBy);
  const creatorLabel = session.createdBy.label?.trim() || session.createdBy.subjectId;
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
        <div className="flex gap-4 pt-0.5">
          <Link
            to="/workspaces/$workspaceId/sessions/$sessionId"
            params={{ workspaceId: props.workspaceId, sessionId: session.id }}
            className="text-xs font-medium text-brand hover:underline"
          >
            Open session
          </Link>
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
        {initials ? (
          <span
            aria-hidden="true"
            title={creatorLabel}
            className="flex size-4.5 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold leading-none text-white/90"
            style={{ background: `oklch(0.45 0.11 ${creatorHue(session.createdBy.subjectId)})` }}
          >
            {initials}
          </span>
        ) : null}
        <span className="font-mono text-2xs tabular-nums text-fg-subtle">
          {relativeTimeLabel(session.updatedAt)}
        </span>
      </div>
    </article>
  );
}
