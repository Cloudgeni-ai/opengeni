import type {
  KnowledgeEntryListRequest,
  KnowledgeEntryListResponse,
  KnowledgeEntryScope,
  KnowledgeEntrySummary,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { notifyKnowledgeReviewUpdated } from "@/components/rail/use-knowledge-review-indicator";
import { showUndoToast } from "@/components/ui/destructive-confirm";
import { useAppContext } from "@/context";

export function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export interface KnowledgeListState {
  entries: KnowledgeEntrySummary[];
  cursor: string | null;
  loading: boolean;
  error: string | null;
  fallbackReason: KnowledgeEntryListResponse["fallbackReason"];
  loadMore: () => Promise<void>;
  reload: () => void;
}

/**
 * One page of Knowledge entries for a request, with Load more. A new request
 * (or `refresh`) drops the old rows before they can show under new filters.
 * Pass `null` to skip loading.
 */
export function useKnowledgeList(
  workspaceId: string,
  request: KnowledgeEntryListRequest | null,
  refresh = 0,
): KnowledgeListState {
  const context = useAppContext();
  const requestKey = request ? JSON.stringify(request) : null;
  const [entries, setEntries] = useState<KnowledgeEntrySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(request !== null);
  const [error, setError] = useState<string | null>(null);
  const [fallbackReason, setFallbackReason] =
    useState<KnowledgeEntryListResponse["fallbackReason"]>();
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setEntries([]);
    setCursor(null);
    setError(null);
    setFallbackReason(undefined);
    if (!requestKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void context.client
      .listKnowledgeEntries(workspaceId, JSON.parse(requestKey) as KnowledgeEntryListRequest)
      .then((result) => {
        if (generation.current !== current) return;
        setEntries(result.entries);
        setCursor(result.nextCursor);
        setFallbackReason(result.fallbackReason);
      })
      .catch((reason: unknown) => {
        if (generation.current === current) setError(errorText(reason));
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      // Invalidate a pending page when the request changes or the list unmounts.
      generation.current += 1;
    };
  }, [context.client, workspaceId, requestKey, refresh, retry]);

  const loadMore = useCallback(async () => {
    if (!cursor || loading || !requestKey) return;
    const invocation = context.captureWorkspaceInvocation(workspaceId);
    if (!invocation) return;
    const current = generation.current;
    const isCurrent = () =>
      generation.current === current && context.ownsWorkspaceInvocation(workspaceId, invocation);
    setLoading(true);
    try {
      const result = await context.client.listKnowledgeEntries(workspaceId, {
        ...(JSON.parse(requestKey) as KnowledgeEntryListRequest),
        cursor,
      });
      if (isCurrent()) {
        setEntries((prior) => [
          ...prior,
          ...result.entries.filter((entry) => !prior.some((each) => each.id === entry.id)),
        ]);
        setCursor(result.nextCursor);
      }
    } catch (reason) {
      if (isCurrent()) setError(errorText(reason));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [context, cursor, loading, requestKey, workspaceId]);

  const reload = useCallback(() => setRetry((value) => value + 1), []);
  return { entries, cursor, loading, error, fallbackReason, loadMore, reload };
}

/**
 * Archive is reversible, so it has no confirmation: a toast with Undo that
 * restores the version that was published before.
 */
export function useArchiveKnowledge(workspaceId: string, onChanged: () => void) {
  const { client } = useAppContext();
  return useCallback(
    async (entry: {
      id: string;
      title: string;
      version: number;
      publishedRevisionId: string | null;
    }) => {
      try {
        const receipt = await client.archiveKnowledgeEntry(workspaceId, entry.id, {
          operationId: crypto.randomUUID(),
          expectedVersion: entry.version,
        });
        notifyKnowledgeReviewUpdated();
        onChanged();
        const restoreTo = entry.publishedRevisionId;
        if (receipt.outcome === "pending") {
          toast(`Asked to archive ${entry.title}`, {
            description: "It waits in Review because Knowledge is set to Review first.",
          });
          return receipt;
        }
        showUndoToast({
          title: `Archived ${entry.title}`,
          description: "Agents stop using it. Find it under Filter › Archived.",
          onUndo: () => {
            if (!restoreTo) return;
            void client
              .restoreKnowledgeEntry(workspaceId, {
                operationId: crypto.randomUUID(),
                entryId: entry.id,
                revisionId: restoreTo,
                expectedVersion: receipt.version,
              })
              .then(() => {
                onChanged();
                toast(`Restored ${entry.title}`);
              })
              .catch((reason: unknown) =>
                toast.error(`Couldn't restore ${entry.title}`, { description: errorText(reason) }),
              );
          },
        });
        return receipt;
      } catch (reason) {
        toast.error(`Couldn't archive ${entry.title}`, { description: errorText(reason) });
        return null;
      }
    },
    [client, workspaceId, onChanged],
  );
}

/** The scope words used everywhere on the page. */
export function scopeFilterValue(
  scope: KnowledgeEntryScope | "all",
): KnowledgeEntryScope | undefined {
  return scope === "all" ? undefined : scope;
}
