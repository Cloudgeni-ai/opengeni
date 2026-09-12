import type { KnowledgeEntryScope, KnowledgeReviewBatch } from "@opengeni/sdk";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MetaChip } from "@/components/ui/meta-chip";
import { useAppContext } from "@/context";
import { relativeTimeLabel } from "@/lib/sessions-group";

/** Review groups describe saved changes, not a second scheduled-task interface. */
export function KnowledgeReviewGroups({
  workspaceId,
  scope,
  refresh,
  onSelect,
}: {
  workspaceId: string;
  scope?: KnowledgeEntryScope;
  refresh: number;
  onSelect: (batch: KnowledgeReviewBatch) => void;
}) {
  const context = useAppContext();
  const [batches, setBatches] = useState<KnowledgeReviewBatch[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const requestGeneration = useRef(0);
  useEffect(() => {
    let current = true;
    ++requestGeneration.current;
    setLoading(true);
    setBatches([]);
    setCursor(null);
    setError(null);
    void context.client
      .listKnowledgeReviewBatches(workspaceId, { scope, limit: 20 })
      .then((result) => {
        if (current) {
          setBatches(result.batches);
          setCursor(result.nextCursor);
        }
      })
      .catch((reason) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidate pending pages on unmount
      ++requestGeneration.current;
    };
  }, [context.client, workspaceId, scope, refresh, retry]);
  async function loadMore() {
    if (!cursor || loading) return;
    const invocation = context.captureWorkspaceInvocation(workspaceId);
    if (!invocation) return;
    const generation = requestGeneration.current;
    const isCurrent = () =>
      generation === requestGeneration.current &&
      context.ownsWorkspaceInvocation(workspaceId, invocation);
    setLoading(true);
    setError(null);
    try {
      const result = await context.client.listKnowledgeReviewBatches(workspaceId, {
        scope,
        cursor,
        limit: 20,
      });
      if (isCurrent()) {
        setBatches((prior) => [...prior, ...result.batches]);
        setCursor(result.nextCursor);
      }
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }
  return (
    <div
      aria-label="Knowledge review groups"
      className="divide-y divide-border border-y border-border"
    >
      {batches.map((batch) => (
        <div key={batch.id} className="flex items-center justify-between gap-4 py-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{batch.title ?? "Saved knowledge"}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <span>
                {batch.scheduledTaskRunId
                  ? "Scheduled run"
                  : batch.sessionId
                    ? "Chat"
                    : "Earlier knowledge"}
              </span>
              <span>{relativeTimeLabel(batch.createdAt)}</span>
              <MetaChip>
                {batch.scope === "personal"
                  ? "Only me"
                  : batch.scope === "organization"
                    ? "Company"
                    : "Workspace"}
              </MetaChip>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => onSelect(batch)}>
            Review {batch.pendingCount} {batch.pendingCount === 1 ? "item" : "items"}
          </Button>
        </div>
      ))}
      {error ? (
        <p role="alert" className="py-4 text-sm text-status-error">
          {error}
          <Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            Try again
          </Button>
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="py-5 text-sm text-fg-muted">
          Loading reviews…
        </p>
      ) : !batches.length && !error ? (
        <p className="py-5 text-sm text-fg-muted">No Knowledge changes need review.</p>
      ) : null}
      {cursor ? (
        <Button
          className="my-4"
          variant="outline"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          More review groups
        </Button>
      ) : null}
    </div>
  );
}
