import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionEvent, ToolActionReview } from "@opengeni/sdk";
import { approvalsFromRequiresAction } from "../approvals";

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

/**
 * The saved review for one recorded call, or null while it loads or when it is
 * unavailable (callers then keep their ordinary tool row).
 */
export function useRecordedToolReview(approvalId: string | null): {
  review: ToolActionReview | null;
  onViewDetails: ((path: string) => void) | undefined;
} {
  const history = useContext(History);
  const [review, setReview] = useState<ToolActionReview | null>(null);
  const load = history?.load;
  const revision = history?.revision;
  useEffect(() => {
    if (!load || !approvalId) return;
    let active = true;
    void load(approvalId).then(
      (value) => {
        if (active && value.id === approvalId) setReview(value);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [approvalId, load, revision]);
  const onViewDetails = history?.onViewDetails;
  return {
    review: review && review.id === approvalId ? review : null,
    onViewDetails:
      review && onViewDetails ? (path: string) => onViewDetails(review, path) : undefined,
  };
}
