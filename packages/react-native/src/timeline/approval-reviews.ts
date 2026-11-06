// The review presentations a host loads for pending approvals, one read per
// approval, the way the web approval surface reads them through `loadReview`.
// A presentation only changes what the card says; the approval decided is the
// one the runtime sent, whatever the loader returns.
import { OpenGeniApiError, type ToolActionReview } from "@opengeni/sdk";
import type { PendingApproval } from "@opengeni/react/session";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads the review a pending approval shows: the same hook and the same
 * `ToolActionReview` as the web `ApprovalSurface`'s `loadReview`, either the
 * server's (`client.getToolActionReview`) or one the host writes. Resolve
 * `null`, or reject with a 404 `OpenGeniApiError`, to keep the standard card
 * for an approval the host has no presentation for.
 */
export type ApprovalReviewLoader = (
  approval: PendingApproval,
) => Promise<ToolActionReview | null | undefined>;

export type ApprovalReviewState =
  /** No loader, or a server's question: the standard card. */
  | { status: "none" }
  | { status: "loading" }
  | { status: "loaded"; review: ToolActionReview }
  /** The loader has no presentation for this approval: the standard card. */
  | { status: "missing" }
  /** The read failed: the standard card, with a way to try again. */
  | { status: "failed" };

type Read = { facts: string; loader: ApprovalReviewLoader; attempt: number };
type Outcome = Exclude<ApprovalReviewState, { status: "none" } | { status: "loading" }>;

// Event projection recreates equal approvals on unrelated timeline updates;
// they share one read. Changed facts read again.
const factsOf = (approval: PendingApproval) => JSON.stringify(approval);

function outcomeOf(
  approval: PendingApproval,
  review: ToolActionReview | null | undefined,
): Outcome {
  if (review === null || review === undefined) return { status: "missing" };
  // A review of another action never stands in for this one.
  return review.id === approval.id ? { status: "loaded", review } : { status: "failed" };
}

/**
 * Reads each pending approval's review once per facts, loader and retry. A
 * question from the approval's MCP server is answered from the approval
 * itself, so it is never read.
 */
export function useApprovalReviews(
  approvals: readonly PendingApproval[],
  loadReview: ApprovalReviewLoader | undefined,
): { state: (approval: PendingApproval) => ApprovalReviewState; retry: (id: string) => void } {
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const [outcomes, setOutcomes] = useState<Record<string, { read: Read; outcome: Outcome }>>({});
  const started = useRef(new Map<string, Read>());
  useEffect(() => {
    const live = new Set(approvals.map((approval) => approval.id));
    for (const id of started.current.keys()) if (!live.has(id)) started.current.delete(id);
    if (!loadReview) return;
    for (const approval of approvals) {
      if (approval.elicitation) continue;
      const read: Read = {
        facts: factsOf(approval),
        loader: loadReview,
        attempt: attempts[approval.id] ?? 0,
      };
      const previous = started.current.get(approval.id);
      if (
        previous &&
        previous.facts === read.facts &&
        previous.loader === read.loader &&
        previous.attempt === read.attempt
      )
        continue;
      started.current.set(approval.id, read);
      const settle = (outcome: Outcome) => {
        // Only the latest read for this approval may answer.
        if (started.current.get(approval.id) !== read) return;
        setOutcomes((current) => ({ ...current, [approval.id]: { read, outcome } }));
      };
      void Promise.resolve()
        .then(() => loadReview(approval))
        .then(
          (review) => settle(outcomeOf(approval, review)),
          (error: unknown) =>
            settle(
              // 404: no saved review (an older or non-connector action).
              error instanceof OpenGeniApiError && error.status === 404
                ? { status: "missing" }
                : { status: "failed" },
            ),
        );
    }
  }, [approvals, loadReview, attempts]);
  useEffect(() => {
    const reads = started.current;
    return () => reads.clear();
  }, []);
  const state = useCallback(
    (approval: PendingApproval): ApprovalReviewState => {
      if (!loadReview || approval.elicitation) return { status: "none" };
      const settled = outcomes[approval.id];
      // Hide a stale answer during render, before the next read starts.
      return settled &&
        settled.read.loader === loadReview &&
        settled.read.attempt === (attempts[approval.id] ?? 0) &&
        settled.read.facts === factsOf(approval)
        ? settled.outcome
        : { status: "loading" };
    },
    [loadReview, outcomes, attempts],
  );
  const retry = useCallback(
    (id: string) => setAttempts((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 })),
    [],
  );
  return { state, retry };
}
