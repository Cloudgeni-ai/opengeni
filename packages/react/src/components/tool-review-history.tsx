import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionEvent, ToolActionReview } from "@opengeni/sdk";
import { approvalsFromRequiresAction } from "../approvals";
import { ToolActionReviewCard } from "./tool-action-review";

type HistoryContext = {
  approvalIds: ReadonlySet<string>;
  revision: number;
  load: (approvalId: string) => Promise<ToolActionReview>;
  onViewDetails: (review: ToolActionReview, path: string) => void;
};
const History = createContext<HistoryContext | null>(null);

/** Opt-in, authenticated history for the exact reviewed calls in the visible event window. */
export function ToolReviewHistoryProvider({
  events,
  load,
  onViewDetails,
  children,
}: {
  events: readonly SessionEvent[];
  load: HistoryContext["load"];
  onViewDetails: HistoryContext["onViewDetails"];
  children: ReactNode;
}) {
  const value = useMemo<HistoryContext>(
    () => ({
      approvalIds: new Set(
        events.flatMap((event) =>
          event.type === "session.requiresAction"
            ? approvalsFromRequiresAction(event.payload).map((approval) => approval.id)
            : [],
        ),
      ),
      revision:
        [...events]
          .reverse()
          .find(
            (event) =>
              event.type === "session.requiresAction" ||
              event.type === "agent.toolCall.output" ||
              event.type.startsWith("turn.") ||
              event.type === "user.approvalDecision" ||
              event.type.startsWith("session.control."),
          )?.sequence ?? 0,
      load,
      onViewDetails,
    }),
    [events, load, onViewDetails],
  );
  return <History.Provider value={value}>{children}</History.Provider>;
}
export function useHasToolReview(approvalId: string | null): boolean {
  const history = useContext(History);
  return Boolean(approvalId && history?.approvalIds.has(approvalId));
}

/** Recorded calls have details, never another decision button. */
export function ToolReviewHistoryReceipt({ approvalId }: { approvalId: string }) {
  const history = useContext(History);
  const [review, setReview] = useState<ToolActionReview | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const load = history?.load;
  const revision = history?.revision;
  useEffect(() => {
    if (!load) return;
    let active = true;
    setFailed(false);
    void load(approvalId).then(
      (value) => {
        if (active) {
          if (value.id === approvalId) setReview(value);
          else setFailed(true);
        }
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [approvalId, load, revision, retry]);
  if (!history) return null;
  if (failed)
    return (
      <p className="text-og-sm text-og-fg-muted" role="alert">
        Review details unavailable.{" "}
        <button
          type="button"
          className="min-h-11 underline"
          onClick={() => setRetry((value) => value + 1)}
        >
          Try again
        </button>
      </p>
    );
  if (!review)
    return (
      <p role="status" className="text-og-sm text-og-fg-muted">
        Loading reviewed action…
      </p>
    );
  return (
    <div data-approval-id={approvalId} data-review-origin="history">
      <ToolActionReviewCard
        review={{ ...review, availableActions: [] }}
        onViewDetails={(path) => history.onViewDetails(review, path)}
      />
    </div>
  );
}
