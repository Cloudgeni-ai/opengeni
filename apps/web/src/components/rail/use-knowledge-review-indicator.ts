import { useEffect, useState } from "react";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";

const REVIEW_UPDATED = "opengeni:knowledge-review-updated";
export function notifyKnowledgeReviewUpdated() {
  window.dispatchEvent(new Event(REVIEW_UPDATED));
}

/** Bounded existence query: no knowledge text or exhaustive count in navigation. */
export function useKnowledgeReviewIndicator(workspaceId: string, enabled = true) {
  const { client, accessContext } = useAppContext();
  const canReview =
    enabled &&
    hasWorkspacePermission(accessContext, workspaceId, "documents:search") &&
    hasWorkspacePermission(accessContext, workspaceId, "documents:manage");
  const identity = `${accessContext?.subjectId}:${workspaceId}`;
  const [result, setResult] = useState<{ identity: string; pending: boolean } | null>(null);
  useEffect(() => {
    setResult(null);
    if (!canReview) return;
    let current = true;
    let generation = 0;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      const request = ++generation;
      void client
        .listKnowledgeEntries(workspaceId, { view: "needs_review", limit: 1 })
        .then((page) => {
          if (current && request === generation) {
            setResult({ identity, pending: page.entries.length > 0 });
          }
        })
        .catch(() => {
          // Keep a known pending indicator on a transient failure; retry on focus/poll.
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener(REVIEW_UPDATED, refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(REVIEW_UPDATED, refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [client, workspaceId, canReview, identity]);
  return canReview && result?.identity === identity && result.pending;
}
