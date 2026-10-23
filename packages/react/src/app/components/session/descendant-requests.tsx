// The parent session's view of its sub-sessions' waits: every question and
// tool approval a descendant is blocked on, pinned above the composer and
// answered in place. Answers and decisions go to the sub-session itself,
// through the same requests its own page sends, so the agent cannot tell the
// difference and the server's permission checks apply unchanged.
import type {
  OpenGeniClient,
  SessionEvent,
  SessionSummary,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { ChevronDownIcon, CornerDownRightIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { PendingApproval } from "../../../approvals";
import type { HumanInputFormProps } from "../../../components/human-input-form";
import { usePolledValue } from "../../../hooks/internal";
import { useHumanInputRequests } from "../../../hooks/use-human-input";
import {
  ApprovalSurface,
  HumanInputSurface,
  type ToolReviewDetailsLoader,
} from "../../../session-ui";
import { buttonVariants } from "../../../ui/button";
import { userErrorText } from "../../../ui/api-error";
import {
  DESCENDANT_REQUEST_EVENT_LIMIT,
  DESCENDANT_REQUEST_EVENT_TYPES,
  descendantRequestActivity,
  subSessionsNeedYouLabel,
} from "../../lib/descendant-requests";
import { Link } from "../../lib/navigation";
import { sessionDisplayTitle } from "../../lib/session-rename";
import { toast } from "../../lib/toast";
import { cn } from "../../lib/utils";

/** The exact client surface the card reads and answers through. */
export type DescendantRequestsClient = Pick<
  OpenGeniClient,
  | "getSession"
  | "streamEvents"
  | "listHumanInputRequests"
  | "submitHumanInputResponse"
  | "listEventPage"
  | "sendApprovalDecision"
  | "getToolActionReview"
  | "getToolReviewDetails"
>;

export type DescendantRequestsProps = {
  client: DescendantRequestsClient;
  workspaceId: string;
  /** The session whose page shows the card; keys the collapsed preference. */
  parentSessionId: string;
  /** Descendants waiting on the person, longest-waiting first. */
  waiting: readonly SessionSummary[];
  /** Something was answered or decided here: re-read the tree. */
  onResolved?: (() => void) | undefined;
  /** Bumped when this session's agent answered or steered a sub-session; every item re-reads. */
  refreshSignal?: number | undefined;
  loadSkillReview?: HumanInputFormProps["loadSkillReview"];
  allowedSaveTo?: HumanInputFormProps["allowedSaveTo"];
  /** Safety-net re-read of questions while shown (live hints drive the rest). */
  pollIntervalMs?: number | undefined;
};

// The shared-feed mode with an empty feed: no live stream per sub-session.
// The parent's list hints and lineage reads drive refreshes instead.
const NO_EVENTS: SessionEvent[] = [];
const DEFAULT_POLL_MS = 15_000;
// Approvals are rebuilt from an event page, a heavier read than the question
// list; it is re-read on every change the tree sees, so its own poll is slow.
const ACTIVITY_POLL_FACTOR = 3;

// Whether a parent's stack was collapsed, for this tab: it stays collapsed
// after opening a sub-session and coming back.
const collapsedStacks = new Map<string, boolean>();

export function resetDescendantRequestsStateForTests(): void {
  collapsedStacks.clear();
}

/**
 * Pending questions and approvals from a session's sub-sessions. One waiting
 * sub-session shows its request directly; several stack under one line that
 * collapses them ("3 sub-sessions need you"). Each request names the
 * sub-session asking and links to it.
 */
export function DescendantRequests(props: DescendantRequestsProps) {
  const stackKey = `${props.workspaceId}\u0000${props.parentSessionId}`;
  // Read from the map on every render, so switching parents never shows the
  // previous parent's choice for a frame.
  const [, rerender] = useState(0);
  const stackId = useId();
  const collapsed = collapsedStacks.get(stackKey) ?? false;
  const setCollapsed = (next: boolean) => {
    collapsedStacks.set(stackKey, next);
    rerender((value) => value + 1);
  };
  const count = props.waiting.length;
  if (count === 0) return null;
  const stacked = count > 1;
  const label = subSessionsNeedYouLabel(count);
  return (
    <section aria-label={label} data-descendant-requests="" className="mb-2 flex flex-col gap-2">
      {stacked ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={stackId}
          onClick={() => setCollapsed(!collapsed)}
          className="flex min-h-10 w-full items-center gap-2.5 rounded-lg border border-status-waiting/35 bg-status-waiting/5 px-3 text-left transition-colors duration-[120ms] hover:hover-layer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/55 pointer-coarse:min-h-11"
          data-descendant-requests-toggle=""
        >
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-status-waiting" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{label}</span>
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-fg-muted transition-transform duration-[120ms] motion-reduce:transition-none",
              !collapsed && "rotate-180",
            )}
          />
        </button>
      ) : null}
      {stacked && collapsed ? null : (
        <div
          id={stackId}
          className={cn(
            "flex flex-col gap-3",
            stacked && "max-h-[min(36rem,55dvh)] overflow-y-auto overscroll-contain",
          )}
          data-descendant-requests-stack=""
        >
          {props.waiting.map((session, index) => (
            // Later asks start as compact bars so every one is visible.
            <DescendantRequestItem
              key={session.id}
              {...props}
              session={session}
              compact={stacked && index > 0}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default DescendantRequests;

function DescendantRequestItem({
  client,
  workspaceId,
  session,
  compact,
  onResolved,
  refreshSignal = 0,
  loadSkillReview,
  allowedSaveTo,
  pollIntervalMs = DEFAULT_POLL_MS,
}: DescendantRequestsProps & { session: SessionSummary; compact: boolean }) {
  const sessionId = session.id;
  const humanInput = useHumanInputRequests(sessionId, {
    client,
    workspaceId,
    events: NO_EVENTS,
    pollIntervalMs,
  });
  // The SDK's event page read takes no abort signal; an unmounted item's
  // last read finishes and is dropped.
  const loadActivity = useCallback(async () => {
    const page = await client.listEventPage(workspaceId, sessionId, {
      includeTypes: DESCENDANT_REQUEST_EVENT_TYPES,
      direction: "before",
      limit: DESCENDANT_REQUEST_EVENT_LIMIT,
      payloadMode: "full",
    });
    return descendantRequestActivity(page.events);
  }, [client, sessionId, workspaceId]);
  const activity = usePolledValue(loadActivity, {
    pollIntervalMs: pollIntervalMs * ACTIVITY_POLL_FACTOR,
  });

  // Re-read when the sub-session moved on (a new request, or one settled
  // elsewhere) or this session's agent answered one. The first render reads.
  const refreshHumanInput = humanInput.refresh;
  const refreshActivity = activity.refresh;
  const seen = useRef({ lastSequence: session.lastSequence, refreshSignal });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { lastSequence: session.lastSequence, refreshSignal };
    if (previous.lastSequence === session.lastSequence && previous.refreshSignal === refreshSignal)
      return;
    void refreshHumanInput();
    void refreshActivity();
  }, [refreshActivity, refreshHumanInput, refreshSignal, session.lastSequence]);

  const title = sessionDisplayTitle(session);
  const requests = humanInput.requests;
  const approvals = activity.data?.approvals ?? [];
  const requestSequences = activity.data?.requestSequences;
  const firstRequest = requests[0];
  const hasRequest = requests.length > 0 || approvals.length > 0;

  // Once this wait showed a question or an approval, its end is the request
  // settling (here, on the sub-session's page or by an agent). The tree still
  // shows the sub-session waiting until it is re-read, so say nothing for the
  // rest of that wait; a new wait has a new start time.
  const waitKey = session.requiresActionSince ?? `sequence:${session.lastSequence}`;
  const [handledWait, setHandledWait] = useState<string | null>(null);
  useEffect(() => {
    if (hasRequest) setHandledWait(waitKey);
  }, [hasRequest, waitKey]);
  const settled = () => {
    setHandledWait(waitKey);
    onResolved?.();
  };

  // Stable, so a re-render never reloads a review that is already shown.
  const loadReview = useCallback(
    (approval: PendingApproval) => client.getToolActionReview(workspaceId, sessionId, approval.id),
    [client, sessionId, workspaceId],
  );
  const loadDetails = useCallback<ToolReviewDetailsLoader>(
    (review, path, offset) =>
      client.getToolReviewDetails(workspaceId, sessionId, review.id, {
        actionDigest: review.actionDigest,
        path,
        offset,
      }),
    [client, sessionId, workspaceId],
  );

  const decide = async (approval: PendingApproval, decision: "approve" | "reject") => {
    try {
      await client.sendApprovalDecision(workspaceId, sessionId, {
        approvalId: approval.id,
        decision,
      });
    } catch (error) {
      toast.error("Couldn't submit the decision", { description: userErrorText(error) });
      throw error instanceof Error ? error : new Error(String(error));
    }
    settled();
    await refreshActivity();
  };

  if (hasRequest) {
    return (
      <div
        data-descendant-request={sessionId}
        data-descendant-request-kind={requests.length > 0 ? "question" : "approval"}
        className="flex flex-col gap-2"
      >
        {requests.length > 0 ? (
          <div>
            <ItemSource
              title={title}
              verb="is asking"
              link={
                <SubSessionLink
                  workspaceId={workspaceId}
                  sessionId={sessionId}
                  title={title}
                  at={(firstRequest && requestSequences?.get(firstRequest.id)) ?? null}
                />
              }
            />
            <HumanInputSurface
              // The form reads `defaultCollapsed` once: remount only the form
              // when an item moves up the stack (a lone item left after the
              // others settle shows its request directly). The item and its
              // reads stay mounted.
              key={compact ? "compact" : "full"}
              requests={requests}
              loadSkillReview={loadSkillReview}
              allowedSaveTo={allowedSaveTo}
              respondingRequestId={humanInput.respondingRequestId}
              error={humanInput.mutationError?.message}
              // Never take the caret from the parent's composer.
              autoFocus={false}
              defaultCollapsed={compact}
              onSubmit={async (requestId, response: SubmitHumanInputResponseRequest) => {
                // A failed send resolves null. Reject so the form keeps what was
                // typed (and its draft) for a retry, as on the sub-session's page.
                if (!(await humanInput.respond(requestId, response))) {
                  throw new Error("Your answer wasn't sent. Try again.");
                }
                settled();
              }}
            />
          </div>
        ) : null}
        {approvals.length > 0 ? (
          <div data-descendant-request-approvals="">
            <ItemSource
              title={title}
              verb="needs approval"
              link={
                <SubSessionLink
                  workspaceId={workspaceId}
                  sessionId={sessionId}
                  title={title}
                  at={activity.data?.approvalSequence ?? null}
                />
              }
            />
            <ApprovalSurface
              className="py-0"
              approvals={approvals}
              loadReview={loadReview}
              loadDetails={loadDetails}
              onApprove={(approval) => decide(approval, "approve")}
              onReject={(approval) => decide(approval, "reject")}
            />
          </div>
        ) : null}
      </div>
    );
  }
  // Waiting on something only its own page can take (a reconnect, a sign-in):
  // say so once both reads are in, and point there.
  const loaded = !humanInput.loading && (activity.data !== null || activity.error !== null);
  if (!loaded || handledWait === waitKey) return null;
  return (
    <div
      data-descendant-request={sessionId}
      data-descendant-request-kind="other"
      className="flex min-h-12 items-center gap-3 rounded-lg border border-status-waiting/35 bg-status-waiting/5 px-3 py-2"
    >
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-status-waiting" />
      <p className="m-0 min-w-0 flex-1 truncate text-sm text-fg-muted">
        <span className="font-medium text-fg">{title}</span> needs you
      </p>
      <SubSessionLink
        workspaceId={workspaceId}
        sessionId={sessionId}
        title={title}
        at={null}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
      />
    </div>
  );
}

/** Which sub-session is asking, and the way to it. */
function ItemSource({ title, verb, link }: { title: string; verb: string; link: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5 text-xs leading-[18px]">
      <CornerDownRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
      <p className="m-0 min-w-0 truncate text-fg-muted">
        <span className="font-medium text-fg">{title}</span> {verb}
      </p>
      {link}
    </div>
  );
}

/** Opens the sub-session, scrolled to where it asked when that is known. */
function SubSessionLink({
  workspaceId,
  sessionId,
  title,
  at,
  className,
}: {
  workspaceId: string;
  sessionId: string;
  title: string;
  at: number | null;
  className?: string | undefined;
}) {
  return (
    <Link
      to="/workspaces/$workspaceId/sessions/$sessionId"
      params={{ workspaceId, sessionId }}
      search={at !== null ? { at } : {}}
      aria-label={`Open sub-session: ${title}`}
      data-descendant-request-link=""
      className={
        className ??
        "og-link ml-auto inline-flex min-h-8 shrink-0 items-center rounded-sm text-xs text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/55 pointer-coarse:min-h-11"
      }
    >
      Open sub-session
    </Link>
  );
}
