import {
  toolReviewDetails,
  type ToolActionReview,
  type ToolReviewDetailsPage,
} from "@opengeni/sdk";
import type { PendingApproval } from "../approvals";
import { approvalToolName } from "../approval-review-model";
import type { ToolReviewDetailsLoader } from "./tool-action-review";

type ReviewLoader = (approval: PendingApproval) => Promise<ToolActionReview | null | undefined>;

/**
 * The review loaders a chat gives its approval cards: the host's own review
 * first, and the server's saved review for everything the host leaves to the
 * standard card.
 *
 * Without the saved review a card only has the approval's inline arguments.
 * Programmatic (Code Mode) calls never carry those, since their arguments stay
 * on the server, so a fresh request would read as an older one whose details
 * were lost and offer only Decline.
 *
 * Details pages follow the review they belong to: the server's for its saved
 * review, the host's `loadDetails` for the host's own, and otherwise the
 * approval's inline arguments, as the card shows them without a loader.
 */
export function savedToolReviewLoaders(input: {
  readReview: (approvalId: string) => Promise<ToolActionReview>;
  readDetails: (
    review: ToolActionReview,
    path: string,
    offset: number,
  ) => Promise<ToolReviewDetailsPage>;
  loadReview?: ReviewLoader | undefined;
  loadDetails?: ToolReviewDetailsLoader | undefined;
}): { loadReview: ReviewLoader; loadDetails: ToolReviewDetailsLoader } {
  const { readReview, readDetails, loadReview: hostReview, loadDetails: hostDetails } = input;
  /** Approval id to the digest of the saved review read for it. */
  const saved = new Map<string, string>();
  /** Approvals whose card shows the host's own review. */
  const hosted = new Map<string, PendingApproval>();
  return {
    loadReview: async (approval) => {
      const own = hostReview ? await hostReview(approval) : null;
      if (own) {
        saved.delete(approval.id);
        hosted.set(approval.id, approval);
        return own;
      }
      hosted.delete(approval.id);
      const review = await readReview(approval.id);
      saved.set(approval.id, review.actionDigest);
      return review;
    },
    loadDetails: async (review, path, offset) => {
      if (review.actionDigest && saved.get(review.id) === review.actionDigest)
        return await readDetails(review, path, offset);
      if (hostDetails) return await hostDetails(review, path, offset);
      const approval = hosted.get(review.id);
      return {
        version: 1,
        id: review.id,
        actionDigest: review.actionDigest,
        ...toolReviewDetails(
          approval?.arguments,
          undefined,
          path,
          offset,
          25,
          approval ? approvalToolName(approval) : undefined,
        ),
      };
    },
  };
}
