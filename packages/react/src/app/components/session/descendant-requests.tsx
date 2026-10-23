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
import { useCallback, useEffect, useRef, useState } from "react";

import type { PendingApproval } from "../../../approvals";
import type { HumanInputFormProps } from "../../../components/human-input-form";
import { usePolledValue } from "../../../hooks/internal";
import { useHumanInputRequests } from "../../../hooks/use-human-input";
import { ApprovalSurface, HumanInputSurface } from "../../../session-ui";
import { Button } from "../../../ui/button";
import { userErrorText } from "../../../ui/api-error";
import {
  DESCENDANT_REQUEST_EVENT_LIMIT,
  DESCENDANT_REQUEST_EVENT_TYPES,
  descendantRequestActivity,
  subSessionsNeedYouLabel,
} from "../../lib/descendant-requests";
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
  /** Open a sub-session, at the moment its request was raised when known. */
  onOpenSession: (sessionId: string, at: number | null) => void;
  /** Something was answered or decided here: re-read the tree. */
  onResolved?: (() => void) | undefined;
  /** Bumped when the parent learns a sub-session changed; every item re-reads. */
  refreshSignal?: number | undefined;
  loadSkillReview?: HumanInputFormProps["loadSkillReview"];
  allowedSaveTo?: HumanInputFormProps["allowedSaveTo"];
  /** Safety-net re-read while waits are shown (live hints drive the rest). */
  pollIntervalMs?: number | undefined;
};

// The shared-feed mode with an empty feed: no live stream per sub-session.
// The parent's list hints and lineage reads drive refreshes instead.
const NO_EVENTS: SessionEvent[] = [];
const DEFAULT_POLL_MS = 15_000;

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
  const [collapsed, setCollapsedState] = useState(() => collapsedStacks.get(stackKey) ?? false);
  useEffect(() => {
    setCollapsedState(collapsedStacks.get(stackKey) ?? false);
  }, [stackKey]);
  const setCollapsed = (next: boolean) => {
    collapsedStacks.set(stackKey, next);
    setCollapsedState(next);
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
          className={cn(
            "flex flex-col gap-3",
            stacked && "max-h-[min(36rem,55dvh)] overflow-y-auto overscroll-contain",
          )}
          data-descendant-requests-stack=""
        >
          {props.waiting.map((session, index) => (
            <DescendantRequestItem
              key={session.id}
              {...props}
              session={session}
              // Later asks start as compact bars so every one is visible.
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
  onOpenSession,
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
  const loadActivity = useCallback(async () => {
    const page = await client.listEventPage(workspaceId, sessionId, {
      includeTypes: DESCENDANT_REQUEST_EVENT_TYPES,
      direction: "before",
      limit: DESCENDANT_REQUEST_EVENT_LIMIT,
      payloadMode: "full",
    });
    return descendantRequestActivity(page.events);
  }, [client, sessionId, workspaceId]);
  const activity = usePolledValue(loadActivity, { pollIntervalMs });

  // Re-read when the sub-session moved on (a new request, or one settled
  // elsewhere) or the parent saw a change. The first render already reads.
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

  // After this card settles a request, the tree still shows the sub-session
  // waiting until it is re-read (its log can move on before its status does).
  // Say nothing for that wait; a new wait has a new start time.
  const waitKey = session.requiresActionSince ?? `sequence:${session.lastSequence}`;
  const [settledWait, setSettledWait] = useState<string | null>(null);
  const settled = () => {
    setSettledWait(waitKey);
    onResolved?.();
  };

  const title = sessionDisplayTitle(session);
  const requests = humanInput.requests;
  const approvals = activity.data?.approvals ?? [];
  const requestSequences = activity.data?.requestSequences;
  const firstRequest = requests[0];
  const openRequest = () =>
    onOpenSession(sessionId, (firstRequest && requestSequences?.get(firstRequest.id)) ?? null);
  const openApproval = () => onOpenSession(sessionId, activity.data?.approvalSequence ?? null);

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

  if (requests.length > 0) {
    return (
      <div data-descendant-request={sessionId} data-descendant-request-kind="question">
        <ItemSource title={title} verb="is asking" onOpen={openRequest} />
        <HumanInputSurface
          requests={requests}
          loadSkillReview={loadSkillReview}
          allowedSaveTo={allowedSaveTo}
          respondingRequestId={humanInput.respondingRequestId}
          error={humanInput.mutationError?.message}
          // Never take the caret from the parent's composer.
          autoFocus={false}
          decisionButtons
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
    );
  }
  if (approvals.length > 0) {
    return (
      <div data-descendant-request={sessionId} data-descendant-request-kind="approval">
        <ItemSource title={title} verb="needs approval" onOpen={openApproval} />
        <ApprovalSurface
          className="py-0"
          approvals={approvals}
          loadReview={(approval) => client.getToolActionReview(workspaceId, sessionId, approval.id)}
          loadDetails={(review, path, offset) =>
            client.getToolReviewDetails(workspaceId, sessionId, review.id, {
              actionDigest: review.actionDigest,
              path,
              offset,
            })
          }
          onApprove={(approval) => decide(approval, "approve")}
          onReject={(approval) => decide(approval, "reject")}
        />
      </div>
    );
  }
  // Waiting on something only its own page can take (a reconnect, a sign-in):
  // say so once both reads are in, and point there.
  const loaded = !humanInput.loading && (activity.data !== null || activity.error !== null);
  if (!loaded || settledWait === waitKey) return null;
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
      <Button size="sm" variant="outline" onClick={() => onOpenSession(sessionId, null)}>
        Open sub-session
      </Button>
    </div>
  );
}

/** Which sub-session is asking, and the way to it. */
function ItemSource({ title, verb, onOpen }: { title: string; verb: string; onOpen: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5 text-xs leading-[18px]">
      <CornerDownRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
      <p className="m-0 min-w-0 truncate text-fg-muted">
        <span className="font-medium text-fg">{title}</span> {verb}
      </p>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open sub-session: ${title}`}
        className="og-link ml-auto shrink-0 rounded-sm text-xs text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/55 pointer-coarse:min-h-11"
      >
        Open sub-session
      </button>
    </div>
  );
}
