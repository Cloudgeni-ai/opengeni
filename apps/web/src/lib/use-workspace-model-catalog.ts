import type { DefaultModelSelection, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/context";
import { projectPickerRows, sortPickerRows, type PickerModelRow } from "@/lib/model-policy";

export type WorkspaceModelCatalogState = {
  models: WorkspaceModelCatalogModel[];
  /** Real catalog projection only — never invents rows for a missing selection. */
  rows: PickerModelRow[];
  /** Server-resolved default for new chats and scheduled tasks; null until known. */
  defaultSelection: DefaultModelSelection | null;
  /** What the default becomes once the organization holds OpenGeni credits. */
  creditsSelection: DefaultModelSelection | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export function useWorkspaceModelCatalog(workspaceId: string | null): WorkspaceModelCatalogState {
  const client = useAppContext().client;
  const [models, setModels] = useState<WorkspaceModelCatalogModel[]>([]);
  const [defaults, setDefaults] = useState<{
    defaultSelection: DefaultModelSelection | null;
    creditsSelection: DefaultModelSelection | null;
  }>({ defaultSelection: null, creditsSelection: null });
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState<string | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (requestAbort: AbortController): Promise<void> => {
      if (!workspaceId) {
        setModels([]);
        setDefaults({ defaultSelection: null, creditsSelection: null });
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
        setDefaults({
          defaultSelection: response.defaultSelection ?? null,
          creditsSelection: response.creditsSelection ?? null,
        });
        setError(null);
      } catch (caught) {
        if (requestAbort.signal.aborted) return;
        setModels([]);
        setDefaults({ defaultSelection: null, creditsSelection: null });
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
      const currentRequestAbort = requestAbortRef.current;
      currentRequestAbort?.abort();
      if (requestAbortRef.current === currentRequestAbort) requestAbortRef.current = null;
    };
  }, [beginLoad]);

  useEffect(() => {
    const changed = () => {
      void refresh();
    };
    window.addEventListener("model-connections-changed", changed);
    return () => window.removeEventListener("model-connections-changed", changed);
  }, [refresh]);

  const rows = useMemo(() => sortPickerRows(projectPickerRows(models)), [models]);

  return {
    models,
    rows,
    defaultSelection: defaults.defaultSelection,
    creditsSelection: defaults.creditsSelection,
    loading,
    error,
    refresh,
  };
}
