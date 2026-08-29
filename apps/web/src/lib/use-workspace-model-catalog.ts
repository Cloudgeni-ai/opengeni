import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/context";
import { projectPickerRows, sortPickerRows, type PickerModelRow } from "@/lib/model-policy";

export type WorkspaceModelCatalogState = {
  models: WorkspaceModelCatalogModel[];
  /** Real catalog projection only — never invents rows for a missing selection. */
  rows: PickerModelRow[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export function useWorkspaceModelCatalog(workspaceId: string | null): WorkspaceModelCatalogState {
  const client = useAppContext().client;
  const [models, setModels] = useState<WorkspaceModelCatalogModel[]>([]);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState<string | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (requestAbort: AbortController): Promise<void> => {
      if (!workspaceId) {
        setModels([]);
        setLoading(false);
        setError(null);
        if (requestAbortRef.current === requestAbort) requestAbortRef.current = null;
        return;
      }
      setLoading(true);
      try {
        const response = await client.getWorkspaceModelCatalog(workspaceId, {
          signal: requestAbort.signal,
        });
        if (requestAbort.signal.aborted) return;
        setModels(response.models);
        setError(null);
      } catch (caught) {
        if (requestAbort.signal.aborted) return;
        setModels([]);
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!requestAbort.signal.aborted) setLoading(false);
        if (requestAbortRef.current === requestAbort) requestAbortRef.current = null;
      }
    },
    [client, workspaceId],
  );

  const beginLoad = useCallback(() => {
    requestAbortRef.current?.abort();
    const requestAbort = new AbortController();
    requestAbortRef.current = requestAbort;
    return { requestAbort, promise: load(requestAbort) };
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    await beginLoad().promise;
  }, [beginLoad]);

  useEffect(() => {
    const request = beginLoad();
    void request.promise;
    return () => {
      request.requestAbort.abort();
      if (requestAbortRef.current === request.requestAbort) requestAbortRef.current = null;
    };
  }, [beginLoad]);

  const rows = useMemo(() => sortPickerRows(projectPickerRows(models)), [models]);

  return {
    models,
    rows,
    loading,
    error,
    refresh,
  };
}
