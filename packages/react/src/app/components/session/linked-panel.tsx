// The chat's Linked panel: what this chat works on (issues, pull requests,
// Slack threads, App records, any URL), each with its live status where the
// deployment can read it (Linear and Slack through the viewer's own
// connection, with a quiet Connect when they have none). The agent adds items with session_links_add; a pull
// request the chat opens is added by itself. One quiet row per item: icon,
// title, and a short status line. No stages, no pipeline.
import type {
  SessionEvent,
  SessionLinkConnect,
  SessionLinkLiveStatus,
  SessionLinkWithStatus,
} from "@opengeni/sdk";
import {
  CircleDotIcon,
  FileTextIcon,
  GitPullRequestIcon,
  LinkIcon,
  MessageSquareIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { formatRelativeTime, inSentence } from "../../../ui/time-format";
import { useAppContext } from "../../app-context";
import { cn } from "../../lib/utils";

const POLL_MS = 60_000;

type LinksState = {
  links: SessionLinkWithStatus[];
  status: "loading" | "ready" | "error";
};

/** The chat's current pull request for the workbench: the newest linked one
 *  that is not merged or closed (a merged PR means new changes need a new one). */
export function openPullRequestFromLinks(
  links: readonly SessionLinkWithStatus[],
): { url: string; number?: number } | null {
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index]!;
    if (link.kind !== "pull_request") continue;
    const state = link.status?.state;
    if (state === "merged" || state === "closed") continue;
    const number = Number(/\/pull\/(\d+)/.exec(link.url)?.[1]);
    return Number.isFinite(number) && number > 0 ? { url: link.url, number } : { url: link.url };
  }
  return null;
}

/** What "Open PR" asks the agent; it uses the chat's own GitHub tools and permissions. */
export const OPEN_PULL_REQUEST_MESSAGE = "Open a pull request for the changes on this branch.";

/** The latest `session.links.changed` sequence: a new one re-reads the list. */
export function latestLinksChange(events: readonly Pick<SessionEvent, "type" | "sequence">[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "session.links.changed") return event.sequence;
  }
  return 0;
}

/** The chat's links with live status, re-read on change and every minute while shown. */
export function useSessionLinks(input: {
  workspaceId: string;
  sessionId: string;
  events: readonly SessionEvent[];
}): LinksState & { remove: (linkId: string) => Promise<void>; reload: () => void } {
  const { client } = useAppContext();
  const changed = useMemo(() => latestLinksChange(input.events), [input.events]);
  const [state, setState] = useState<LinksState & { sessionId: string }>({
    sessionId: input.sessionId,
    links: [],
    status: "loading",
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    client
      .listSessionLinks(input.workspaceId, input.sessionId)
      .then((response) => {
        if (live) setState({ sessionId: input.sessionId, links: response.links, status: "ready" });
      })
      .catch(() => {
        if (live)
          setState((current) => ({ ...current, sessionId: input.sessionId, status: "error" }));
      });
    return () => {
      live = false;
    };
  }, [client, input.workspaceId, input.sessionId, changed, tick]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        setTick((value) => value + 1);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);
  const remove = useCallback(
    async (linkId: string) => {
      setState((current) => ({
        ...current,
        links: current.links.filter((link) => link.id !== linkId),
      }));
      await client.removeSessionLink(input.workspaceId, input.sessionId, linkId).catch(() => {
        setTick((value) => value + 1);
      });
    },
    [client, input.workspaceId, input.sessionId],
  );
  const reload = useCallback(() => setTick((value) => value + 1), []);
  const current =
    state.sessionId === input.sessionId
      ? state
      : { sessionId: input.sessionId, links: [], status: "loading" as const };
  return { links: current.links, status: current.status, remove, reload };
}

const STATE_WORDS: Record<SessionLinkLiveStatus["state"], string | null> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
  done: "Done",
  unknown: null,
};

const CHECK_WORDS: Record<NonNullable<SessionLinkLiveStatus["checks"]>, string | null> = {
  passing: "Checks passed",
  failing: "Checks failing",
  pending: "Checks running",
  none: null,
};

const REVIEW_WORDS: Record<NonNullable<SessionLinkLiveStatus["review"]>, string | null> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review requested",
  none: null,
};

/** "3 replies · last reply 2 hours ago" for a thread; null when the status has no reply count. */
function repliesWords(status: SessionLinkLiveStatus, now: Date): string | null {
  if (status.replies === undefined || status.replies === null) return null;
  if (status.replies === 0) return "No replies";
  const count = `${status.replies} ${status.replies === 1 ? "reply" : "replies"}`;
  if (!status.lastReplyAt) return count;
  return `${count} · last reply ${inSentence(formatRelativeTime(status.lastReplyAt, { now }))}`;
}

/** The short status line for a link, or null for title only. */
export function sessionLinkStatusLine(
  status: SessionLinkLiveStatus | null,
  now: Date = new Date(),
): {
  text: string;
  tone: "good" | "bad" | "pending" | "neutral";
} | null {
  if (!status) return null;
  const words = [
    status.label ?? STATE_WORDS[status.state],
    status.assignee ?? null,
    repliesWords(status, now),
    status.checks ? CHECK_WORDS[status.checks] : null,
    status.review ? REVIEW_WORDS[status.review] : null,
  ].filter((word): word is string => Boolean(word));
  if (words.length === 0) return null;
  const tone =
    status.checks === "failing" || status.review === "changes_requested"
      ? "bad"
      : status.state === "merged" || status.state === "done"
        ? "good"
        : status.checks === "pending"
          ? "pending"
          : "neutral";
  return { text: words.join(" · "), tone };
}

function LinkKindIcon({ link }: { link: SessionLinkWithStatus }) {
  const className = "size-4 shrink-0 text-fg-muted";
  switch (link.kind) {
    case "pull_request":
      return <GitPullRequestIcon aria-hidden className={className} />;
    case "issue":
      return <CircleDotIcon aria-hidden className={className} />;
    case "thread":
      return <MessageSquareIcon aria-hidden className={className} />;
    case "record":
      return <FileTextIcon aria-hidden className={className} />;
    default:
      return <LinkIcon aria-hidden className={className} />;
  }
}

/** The name a link shows: its live or given title, else its reference or host. */
export function sessionLinkTitle(link: SessionLinkWithStatus): string {
  const title = link.status?.title ?? link.title;
  if (title) return title;
  if (link.ref) return link.ref;
  try {
    const url = new URL(link.url);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return link.url;
  }
}

/** The Linked panel's list; presentational, so stories and tests render it directly. */
export function LinkedList({
  links,
  status,
  onRemove,
  connectHref,
}: {
  links: readonly SessionLinkWithStatus[];
  status: LinksState["status"];
  onRemove?: ((linkId: string) => void) | undefined;
  /** Where Connect goes for a link the viewer can't read yet; without it no Connect shows. */
  connectHref?: ((connect: SessionLinkConnect) => string) | undefined;
}) {
  if (links.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-fg-muted">
        {status === "loading"
          ? "Loading…"
          : status === "error"
            ? "Linked items couldn't be loaded."
            : "Nothing linked yet."}
      </p>
    );
  }
  return (
    <ul data-session-linked-list="" className="flex flex-col gap-0.5 p-2">
      {links.map((link) => {
        const line = sessionLinkStatusLine(link.status);
        const title = sessionLinkTitle(link);
        return (
          <li key={link.id} className="group relative">
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer noopener"
              className="flex min-w-0 items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="mt-0.5">
                <LinkKindIcon link={link} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-fg">{title}</span>
                {line || (link.ref && title !== link.ref) ? (
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
                    {line ? (
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          line.tone === "good" && "bg-status-idle",
                          line.tone === "bad" && "bg-status-failed",
                          line.tone === "pending" && "bg-status-waiting",
                          line.tone === "neutral" && "bg-status-running",
                        )}
                      />
                    ) : null}
                    <span className="truncate">
                      {[link.ref && title !== link.ref ? link.ref : null, line?.text]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                ) : null}
              </span>
            </a>
            {link.connect && connectHref ? (
              <a
                href={connectHref(link.connect)}
                data-session-link-connect={link.connect.name}
                className="og-link mb-1 ml-9 block w-fit text-xs text-fg-muted"
              >
                Connect {link.connect.name}
              </a>
            ) : null}
            {onRemove ? (
              <button
                type="button"
                aria-label={`Remove ${title}`}
                title="Remove"
                onClick={() => onRemove(link.id)}
                className="absolute top-2 right-2 hidden size-6 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg group-focus-within:flex group-hover:flex"
              >
                <XIcon aria-hidden className="size-3.5" />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The Linked dock tab: the chat's links, live. The host owns the hook so its tab can show a count. */
export function SessionLinkedPanel({
  state,
  canEdit,
  connectHref,
}: {
  state: ReturnType<typeof useSessionLinks>;
  canEdit: boolean;
  connectHref?: ((connect: SessionLinkConnect) => string) | undefined;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-session-linked-panel="">
      <LinkedList
        links={state.links}
        status={state.status}
        onRemove={canEdit ? (id) => void state.remove(id) : undefined}
        connectHref={connectHref}
      />
    </div>
  );
}
