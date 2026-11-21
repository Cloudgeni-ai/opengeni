// The chat's PR tab: the linked pull request at a glance (state, repository,
// title, author, branches, size) with one Merge action, then its Changes,
// Description, Discussion, Commits and Checks. Read through the same
// workspace GitHub App as the Linked status. Merge asks the agent, which uses
// the chat's own GitHub tools, so Can use and approvals apply as for any
// other tool call; this panel never writes to GitHub itself.
import type { SessionLinkWithStatus, SessionPullRequestDetail } from "@opengeni/sdk";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CircleDotIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { WorkbenchChanges } from "../../../components/workbench-changes";
import { Button } from "../../../ui/button";
import { formatRelativeTime } from "../../../ui/time-format";
import { useAppContext } from "../../app-context";
import { cn } from "../../lib/utils";
import { MarkdownText } from "../markdown";

type PullRequestState = SessionPullRequestDetail["state"];

/** The chat's pull request for its PR tab: the newest open one, else the newest. */
export function pullRequestLinkFromLinks(
  links: readonly SessionLinkWithStatus[],
): SessionLinkWithStatus | null {
  let newest: SessionLinkWithStatus | null = null;
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index]!;
    if (link.kind !== "pull_request") continue;
    newest ??= link;
    const state = link.status?.state;
    if (state !== "merged" && state !== "closed") return link;
  }
  return newest;
}

/** "#142" from a pull request link, or null. */
export function pullRequestNumber(link: Pick<SessionLinkWithStatus, "url">): number | null {
  const number = Number(/\/pull\/(\d+)/.exec(link.url)?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** What Merge asks the agent: its GitHub tools merge, under their approvals. */
export function mergePullRequestMessage(url: string): string {
  return `Merge this pull request: ${url}`;
}

export type PullRequestDetailState =
  | { status: "loading"; detail: SessionPullRequestDetail | null }
  | { status: "ready"; detail: SessionPullRequestDetail | null }
  | { status: "error"; detail: SessionPullRequestDetail | null };

/** The pull request's details, re-read when its live status changes. */
function usePullRequestDetail(input: {
  workspaceId: string;
  sessionId: string;
  link: SessionLinkWithStatus;
}): PullRequestDetailState {
  const { client } = useAppContext();
  const statusKey = JSON.stringify(input.link.status ?? null);
  const [state, setState] = useState<PullRequestDetailState & { key: string }>({
    key: input.link.id,
    status: "loading",
    detail: null,
  });
  useEffect(() => {
    let live = true;
    setState((current) =>
      current.key === input.link.id
        ? { ...current, status: current.detail ? "ready" : "loading" }
        : { key: input.link.id, status: "loading", detail: null },
    );
    client
      .getSessionPullRequest(input.workspaceId, input.sessionId, input.link.id)
      .then((response) => {
        if (live) setState({ key: input.link.id, status: "ready", detail: response.pullRequest });
      })
      .catch(() => {
        if (live) setState((current) => ({ ...current, key: input.link.id, status: "error" }));
      });
    return () => {
      live = false;
    };
  }, [client, input.workspaceId, input.sessionId, input.link.id, statusKey]);
  return state.key === input.link.id ? state : { status: "loading", detail: null };
}

const STATE_LOOK: Record<
  PullRequestState,
  { label: string; icon: typeof GitPullRequestIcon; className: string }
> = {
  open: {
    label: "Open",
    icon: GitPullRequestIcon,
    className: "bg-status-idle/15 text-status-idle",
  },
  draft: {
    label: "Draft",
    icon: GitPullRequestDraftIcon,
    className: "bg-surface-2 text-fg-muted",
  },
  merged: {
    label: "Merged",
    icon: GitMergeIcon,
    className: "bg-accent/15 text-accent",
  },
  closed: {
    label: "Closed",
    icon: GitPullRequestClosedIcon,
    className: "bg-status-failed/15 text-status-failed",
  },
};

function StateBadge({ state }: { state: PullRequestState }) {
  const look = STATE_LOOK[state];
  const Icon = look.icon;
  return (
    <span
      data-pr-state={state}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        look.className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {look.label}
    </span>
  );
}

function statusSummary(detail: SessionPullRequestDetail): string | null {
  const words: string[] = [];
  if (detail.checks === "passing") words.push("Checks passed");
  if (detail.checks === "failing") words.push("Checks failing");
  if (detail.checks === "pending") words.push("Checks running");
  if (detail.review === "approved") words.push("Approved");
  if (detail.review === "changes_requested") words.push("Changes requested");
  if (detail.review === "review_required") words.push("Review requested");
  if (detail.state === "open" && detail.mergeable === false) words.push("Conflicts");
  return words.length > 0 ? words.join(" · ") : null;
}

type SubTab = "changes" | "description" | "discussion" | "commits" | "checks";

/** The PR tab body. `onMerge` is absent when this viewer cannot ask the agent. */
export function SessionPullRequestPanel({
  workspaceId,
  sessionId,
  link,
  onMerge,
}: {
  workspaceId: string;
  sessionId: string;
  link: SessionLinkWithStatus;
  onMerge?: (() => Promise<void>) | undefined;
}) {
  const state = usePullRequestDetail({ workspaceId, sessionId, link });
  return <PullRequestView link={link} state={state} onMerge={onMerge} />;
}

/** Presentational PR view, so harnesses and tests render it with fixed data. */
export function PullRequestView({
  link,
  state,
  onMerge,
}: {
  link: SessionLinkWithStatus;
  state: PullRequestDetailState;
  onMerge?: (() => Promise<void>) | undefined;
}) {
  const detail = state.detail;
  const [tab, setTab] = useState<SubTab>("changes");
  const [merging, setMerging] = useState<"idle" | "asking" | "asked">("idle");
  const number = pullRequestNumber(link);

  if (!detail) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-session-pr-panel="">
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          {link.status && link.status.state !== "done" && link.status.state !== "unknown" ? (
            <StateBadge state={link.status.state} />
          ) : (
            <span />
          )}
          <GitHubLink url={link.url} />
        </div>
        <div className="px-4 pt-2">
          <h2 className="text-base font-semibold text-fg">
            {link.status?.title ?? link.title ?? (number ? `#${number}` : link.url)}
          </h2>
          <p className="mt-2 text-sm text-fg-muted">
            {state.status === "loading" ? (
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
                Loading
              </span>
            ) : state.status === "error" ? (
              "The pull request couldn't be loaded."
            ) : (
              "Opengeni can't read this pull request. Add its repository to the workspace's GitHub App to see it here."
            )}
          </p>
        </div>
      </div>
    );
  }

  const summary = statusSummary(detail);
  const canMerge = Boolean(onMerge) && detail.state === "open";
  const merge = async () => {
    if (!onMerge || merging !== "idle") return;
    setMerging("asking");
    try {
      await onMerge();
      setMerging("asked");
    } catch {
      setMerging("idle");
    }
  };
  const tabs: { id: SubTab; label: string; count?: number | undefined }[] = [
    { id: "changes", label: "Changes", count: detail.changedFiles },
    { id: "description", label: "Description" },
    { id: "discussion", label: "Discussion", count: detail.comments.length },
    { id: "commits", label: "Commits", count: detail.commitCount },
    { id: "checks", label: "Checks", count: detail.checkRuns.length },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col" data-session-pr-panel="">
      <header className="shrink-0 px-4 pt-3">
        <div className="flex items-center justify-between gap-2">
          <StateBadge state={detail.state} />
          <GitHubLink url={detail.url} />
        </div>
        <p className="mt-2 text-xs text-fg-muted">
          {detail.owner}/{detail.repo} · #{detail.number}
        </p>
        <h2 className="mt-0.5 text-base font-semibold leading-snug text-fg">{detail.title}</h2>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
          {detail.author ? <Person person={detail.author} /> : null}
          <span className="inline-flex min-w-0 items-center gap-1 font-mono">
            <span className="truncate rounded bg-surface-2 px-1.5 py-0.5">{detail.base}</span>
            <ArrowLeftIcon aria-label="from" className="size-3 shrink-0" />
            <span className="truncate rounded bg-surface-2 px-1.5 py-0.5">{detail.head}</span>
          </span>
        </div>
        <p className="mt-2 text-xs text-fg-muted">
          {detail.createdAt ? `Opened ${formatRelativeTime(detail.createdAt)} · ` : ""}
          {detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}
          <span className="ml-2 font-mono text-status-idle">+{detail.additions}</span>
          <span className="ml-1 font-mono text-status-failed">−{detail.deletions}</span>
        </p>
        {summary || canMerge ? (
          <div className="mt-3 flex min-h-9 items-center gap-2 border-t border-border pt-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                detail.checks === "failing" || detail.review === "changes_requested"
                  ? "text-status-failed"
                  : "text-fg-muted",
              )}
            >
              {summary}
            </span>
            {canMerge ? (
              <Button
                type="button"
                size="sm"
                onClick={() => void merge()}
                disabled={merging !== "idle"}
                data-pr-merge=""
                title="Ask the agent to merge, with its usual approvals"
                className="shrink-0"
              >
                {merging === "asking" ? (
                  <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
                ) : merging === "asked" ? (
                  <CheckIcon aria-hidden className="size-3.5" />
                ) : (
                  <GitMergeIcon aria-hidden className="size-3.5" />
                )}
                {merging === "asked" ? "Asked" : "Merge"}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div
          role="tablist"
          aria-label="Pull request"
          className="-mx-1 mt-2 flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              data-pr-tab={item.id}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                tab === item.id ? "bg-surface-2 text-fg" : "text-fg-muted hover:text-fg",
              )}
            >
              {item.label}
              {item.count !== undefined && item.count > 0 ? (
                <span className="text-fg-muted">{item.count}</span>
              ) : null}
            </button>
          ))}
        </div>
      </header>
      <div className="mt-1 min-h-0 flex-1 border-t border-border">
        <PullRequestTabBody tab={tab} detail={detail} />
      </div>
    </div>
  );
}

function PullRequestTabBody({ tab, detail }: { tab: SubTab; detail: SessionPullRequestDetail }) {
  const files = useMemo(() => detail.files, [detail.files]);
  if (tab === "changes") {
    if (files.length === 0) return <Empty>No file changes.</Empty>;
    return <WorkbenchChanges diff={files} source={null} capturedAt={null} hideRail />;
  }
  return (
    <div className="h-full overflow-y-auto">
      {tab === "description" ? (
        detail.body ? (
          <div className="px-4 py-3 text-sm">
            <MarkdownText text={detail.body} compact />
          </div>
        ) : (
          <Empty>No description.</Empty>
        )
      ) : tab === "discussion" ? (
        detail.comments.length === 0 ? (
          <Empty>No discussion yet.</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {detail.comments.map((comment) => (
              <li key={comment.id} className="px-4 py-3">
                <div className="flex items-center gap-2 text-xs text-fg-muted">
                  {comment.author ? <Person person={comment.author} /> : null}
                  {comment.reviewState === "approved" ? (
                    <span className="text-status-idle">approved</span>
                  ) : comment.reviewState === "changes_requested" ? (
                    <span className="text-status-failed">requested changes</span>
                  ) : null}
                  {comment.createdAt ? (
                    <span className="ml-auto">{formatRelativeTime(comment.createdAt)}</span>
                  ) : null}
                </div>
                {comment.body ? (
                  <div className="mt-1.5 text-sm">
                    <MarkdownText text={comment.body} compact />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : tab === "commits" ? (
        detail.commits.length === 0 ? (
          <Empty>No commits.</Empty>
        ) : (
          <ul className="flex flex-col py-1">
            {detail.commits.map((commit) => (
              <li key={commit.sha} className="flex min-w-0 items-baseline gap-3 px-4 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">
                    {commit.message.split("\n")[0]}
                  </span>
                  <span className="text-xs text-fg-muted">
                    {[commit.author, commit.date ? formatRelativeTime(commit.date) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-xs text-fg-muted">
                  {commit.sha.slice(0, 7)}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : detail.checkRuns.length === 0 ? (
        <Empty>No checks.</Empty>
      ) : (
        <ul className="flex flex-col py-1">
          {detail.checkRuns.map((run, index) => (
            // Check names repeat across matrix jobs; position keeps them distinct.
            // oxlint-disable-next-line react/no-array-index-key
            <li key={`${run.name}:${index}`}>
              <CheckRow run={run} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CheckRow({ run }: { run: SessionPullRequestDetail["checkRuns"][number] }) {
  const icon =
    run.state === "passing" ? (
      <CheckIcon aria-hidden className="size-3.5 text-status-idle" />
    ) : run.state === "failing" ? (
      <XIcon aria-hidden className="size-3.5 text-status-failed" />
    ) : run.state === "pending" ? (
      <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-status-waiting" />
    ) : (
      <CircleDotIcon aria-hidden className="size-3.5 text-fg-muted" />
    );
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm text-fg">{run.name}</span>
      <span className="shrink-0 text-xs text-fg-muted">{run.state}</span>
    </>
  );
  const className = "flex min-w-0 items-center gap-2 px-4 py-1.5";
  return run.url ? (
    <a
      href={run.url}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(className, "hover:bg-surface-2")}
    >
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}

function Person({ person }: { person: { login: string; avatarUrl: string | null } }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {person.avatarUrl ? (
        <img src={person.avatarUrl} alt="" className="size-4 shrink-0 rounded-full" />
      ) : null}
      <span className="truncate">{person.login}</span>
    </span>
  );
}

function GitHubLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      data-pr-github=""
      className="inline-flex items-center gap-0.5 rounded px-1 text-xs text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
    >
      GitHub
      <ArrowUpRightIcon aria-hidden className="size-3" />
    </a>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-fg-muted">{children}</p>;
}
