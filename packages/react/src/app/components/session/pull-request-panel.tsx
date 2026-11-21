// The chat's PR tab: the linked pull request at a glance (state, repository,
// title, author, branches, size) with one Merge action, then its Changes,
// Description, Discussion, Commits and Checks. Read through the same
// workspace GitHub App as the Linked status. Merge asks the agent, which uses
// the chat's own GitHub tools, so Can use and approvals apply as for any
// other tool call; this panel never writes to GitHub itself.
import type { SessionLinkWithStatus, SessionPullRequestDetail } from "@opengeni/sdk";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleXIcon,
  GitBranchIcon,
  EllipsisIcon,
  GitMergeIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { WorkbenchChanges } from "../../../components/workbench-changes";
import { Button } from "../../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
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
    // The PR tab reads GitHub; other providers' links stay in Linked.
    if (link.kind !== "pull_request" || link.provider !== "github") continue;
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

/** The pull request's details, re-read (fresh) when its live status changes
 *  or the person retries. */
function usePullRequestDetail(input: {
  workspaceId: string;
  sessionId: string;
  link: SessionLinkWithStatus;
  attempt: number;
}): PullRequestDetailState {
  const { client } = useAppContext();
  const statusKey = JSON.stringify(input.link.status ?? null);
  const [state, setState] = useState<PullRequestDetailState & { key: string }>({
    key: input.link.id,
    status: "loading",
    detail: null,
  });
  const readLink = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    // The first read may use the shared cache; later ones follow a change
    // GitHub already reported, so they skip it.
    const fresh = readLink.current === input.link.id;
    readLink.current = input.link.id;
    setState((current) =>
      current.key === input.link.id
        ? { ...current, status: current.detail ? "ready" : "loading" }
        : { key: input.link.id, status: "loading", detail: null },
    );
    client
      .getSessionPullRequest(input.workspaceId, input.sessionId, input.link.id, { fresh })
      .then((response) => {
        if (live) setState({ key: input.link.id, status: "ready", detail: response.pullRequest });
      })
      .catch(() => {
        if (live) setState((current) => ({ ...current, key: input.link.id, status: "error" }));
      });
    return () => {
      live = false;
    };
  }, [client, input.workspaceId, input.sessionId, input.link.id, statusKey, input.attempt]);
  return state.key === input.link.id ? state : { status: "loading", detail: null };
}

const STATE_WORD: Record<PullRequestState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

type SubTab = "changes" | "description" | "discussion" | "commits" | "checks";

const VIEW_LABEL: Record<SubTab, string> = {
  changes: "Changes",
  description: "Description",
  discussion: "Discussion",
  commits: "Commits",
  checks: "Checks",
};

/** The PR tab body. `onMerge` is absent when this viewer cannot ask the
 *  agent, and `onRemove` when they cannot edit the chat's links. */
export function SessionPullRequestPanel({
  workspaceId,
  sessionId,
  link,
  onMerge,
  onRemove,
}: {
  workspaceId: string;
  sessionId: string;
  link: SessionLinkWithStatus;
  onMerge?: (() => Promise<void>) | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const [attempt, setAttempt] = useState(0);
  const state = usePullRequestDetail({ workspaceId, sessionId, link, attempt });
  return (
    <PullRequestView
      link={link}
      state={state}
      onMerge={onMerge}
      onRemove={onRemove}
      onRetry={() => setAttempt((count) => count + 1)}
    />
  );
}

/** Presentational PR view, so harnesses and tests render it with fixed data.
 *  Essentials only: the title, one muted line, one primary action (Merge, or
 *  View on GitHub) and one menu for the other views. */
export function PullRequestView({
  link,
  state,
  onMerge,
  onRemove,
  onRetry,
}: {
  link: SessionLinkWithStatus;
  state: PullRequestDetailState;
  onMerge?: (() => Promise<void>) | undefined;
  onRemove?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const detail = state.detail;
  const [view, setView] = useState<SubTab>("changes");
  const [merging, setMerging] = useState<"idle" | "asking" | "asked">("idle");
  const number = pullRequestNumber(link);

  if (!detail) {
    const title = link.status?.title ?? link.title ?? (number ? `#${number}` : link.url);
    return (
      <div className="flex h-full min-h-0 flex-col" data-session-pr-panel="">
        <header className="flex shrink-0 items-start gap-2 px-4 pt-3">
          <h2 className="min-w-0 flex-1 text-sm font-semibold leading-snug text-fg">{title}</h2>
          <GitHubLink url={link.url} />
        </header>
        <p className="px-4 pt-1 text-xs text-fg-muted">
          {state.status === "loading" ? (
            <span className="inline-flex items-center gap-1.5">
              <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
              Loading
            </span>
          ) : state.status === "error" ? (
            <span>
              Couldn't load it.{" "}
              {onRetry ? (
                <button
                  type="button"
                  onClick={onRetry}
                  data-pr-retry=""
                  className="font-medium text-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Retry
                </button>
              ) : null}
            </span>
          ) : (
            "Can't read this pull request here."
          )}
        </p>
      </div>
    );
  }

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
  const counts: Partial<Record<SubTab, number>> = {
    discussion: detail.comments.length,
    commits: detail.commitCount,
    checks: detail.checkRuns.length,
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-session-pr-panel="">
      <header className="flex shrink-0 items-start gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <h2
            className="truncate text-[15px] font-semibold leading-snug tracking-[-0.01em] text-fg"
            title={detail.title}
          >
            {detail.title}
          </h2>
          <PullRequestFacts detail={detail} />
        </div>
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
        ) : (
          <GitHubLink url={detail.url} />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More"
              title="More"
              data-pr-menu=""
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-surface-2"
            >
              <EllipsisIcon aria-hidden className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[11rem]">
            <DropdownMenuRadioGroup value={view} onValueChange={(next) => setView(next as SubTab)}>
              {(Object.keys(VIEW_LABEL) as SubTab[]).map((id) => (
                <DropdownMenuRadioItem key={id} value={id} data-pr-tab={id}>
                  <span className="min-w-0 flex-1">{VIEW_LABEL[id]}</span>
                  {counts[id] ? (
                    <span className="shrink-0 text-xs text-fg-muted">{counts[id]}</span>
                  ) : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {canMerge || onRemove ? <DropdownMenuSeparator /> : null}
            {canMerge ? (
              <DropdownMenuItem asChild>
                <a href={detail.url} target="_blank" rel="noreferrer noopener" data-pr-github="">
                  View on GitHub
                  <ArrowUpRightIcon aria-hidden className="ml-auto size-3.5" />
                </a>
              </DropdownMenuItem>
            ) : null}
            {onRemove ? (
              <DropdownMenuItem onSelect={onRemove} data-pr-remove="">
                Remove link
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {view === "changes" ? null : (
        <div className="flex shrink-0 items-center gap-1 px-4 pb-1 text-xs text-fg-muted">
          <button
            type="button"
            onClick={() => setView("changes")}
            data-pr-back=""
            className="rounded hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
          >
            Changes
          </button>
          <span aria-hidden>›</span>
          <span className="text-fg">{VIEW_LABEL[view]}</span>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <PullRequestTabBody tab={view} detail={detail} />
      </div>
    </div>
  );
}

const STATE_TONE: Record<PullRequestState, { dot: string; text: string }> = {
  open: { dot: "bg-status-success", text: "text-status-success" },
  draft: { dot: "bg-fg-subtle", text: "text-fg-muted" },
  merged: { dot: "bg-og-accent", text: "text-og-accent" },
  closed: { dot: "bg-status-failed", text: "text-status-failed" },
};

/** The status line under the title: state, branch and checks, each with its
 *  own small mark rather than one string of words. */
function PullRequestFacts({ detail }: { detail: SessionPullRequestDetail }) {
  const tone = STATE_TONE[detail.state];
  const checks =
    detail.checks === "passing"
      ? { Icon: CircleCheckIcon, text: "Checks passed", className: "text-status-success" }
      : detail.checks === "failing"
        ? { Icon: CircleXIcon, text: "Checks failing", className: "text-status-failed" }
        : detail.checks === "pending"
          ? { Icon: CircleDashedIcon, text: "Checks running", className: "text-fg-muted" }
          : null;
  const review =
    detail.review === "approved"
      ? { text: "Approved", className: "text-status-success" }
      : detail.review === "changes_requested"
        ? { text: "Changes requested", className: "text-status-failed" }
        : detail.review === "review_required"
          ? { text: "Review requested", className: "text-fg-muted" }
          : null;
  return (
    <div
      className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted"
      data-pr-state={detail.state}
    >
      <span className={cn("inline-flex items-center gap-1.5 font-medium", tone.text)}>
        <span aria-hidden className={cn("size-1.5 rounded-full", tone.dot)} />
        {STATE_WORD[detail.state]}
      </span>
      <span
        className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px]"
        title={`${detail.head} into ${detail.base}`}
      >
        <GitBranchIcon aria-hidden className="size-3 shrink-0 text-fg-subtle" />
        <span className="truncate text-fg">{detail.head}</span>
        <span aria-hidden className="text-fg-subtle">→</span>
        <span className="truncate">{detail.base}</span>
      </span>
      {checks ? (
        <span className={cn("inline-flex items-center gap-1", checks.className)}>
          <checks.Icon aria-hidden className="size-3.5" />
          {checks.text}
        </span>
      ) : null}
      {review ? <span className={review.className}>{review.text}</span> : null}
      {detail.state === "open" && detail.mergeable === false ? (
        <span className="text-status-failed">Conflicts</span>
      ) : null}
    </div>
  );
}

function PullRequestTabBody({ tab, detail }: { tab: SubTab; detail: SessionPullRequestDetail }) {
  const files = useMemo(() => detail.files, [detail.files]);
  if (tab === "changes") {
    if (files.length === 0) return <Empty>No file changes.</Empty>;
    return (
      <div className="flex h-full min-h-0 flex-col">
        {detail.filesTruncated ? (
          <p className="shrink-0 px-4 pt-2 text-xs text-fg-muted" data-pr-files-truncated="">
            {files.length} of {detail.changedFiles} files.{" "}
            <a
              href={`${detail.url}/files`}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-fg underline-offset-2 hover:underline"
            >
              All on GitHub
            </a>
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          <WorkbenchChanges diff={files} source={null} capturedAt={null} hideSummary />
        </div>
      </div>
    );
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
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
    >
      View on GitHub
      <ArrowUpRightIcon aria-hidden className="size-3.5" />
    </a>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-fg-muted">{children}</p>;
}
