import type { DefaultModelSelection, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/context";
import { CREDIT_BALANCE_CHANGED } from "./credit-balance-events";
import { userErrorText } from "@/lib/api-error";
import { projectPickerRows, sortPickerRows, type PickerModelRow } from "@/lib/model-policy";

export type WorkspaceModelCatalogState = {
  models: WorkspaceModelCatalogModel[];
  /** Real catalog projection only — never invents rows for a missing selection. */
  rows: PickerModelRow[];
  /** Server-resolved default for new chats and scheduled tasks; null until known. */
  defaultSelection: DefaultModelSelection | null;
  /** Hypothetical default after a general-credit purchase. */
  creditsSelection: DefaultModelSelection | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export function useWorkspaceModelCatalog(
  workspaceId: string | null,
  fundingRevision?: string | number,
): WorkspaceModelCatalogState {
  const client = useAppContext().client;
  const [models, setModels] = useState<WorkspaceModelCatalogModel[]>([]);
  const [defaults, setDefaults] = useState<{
    defaultSelection: DefaultModelSelection | null;
    creditsSelection: DefaultModelSelection | null;
  }>({ defaultSelection: null, creditsSelection: null });
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState<string | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const loadedWorkspaceRef = useRef<string | null>(null);

  const load = useCallback(
    async (requestAbort: AbortController, background: boolean): Promise<void> => {
      if (!workspaceId) {
        setModels([]);
        setDefaults({ defaultSelection: null, creditsSelection: null });
        setLoading(false);
        setError(null);
        if (requestAbortRef.current === requestAbort) requestAbortRef.current = null;
        return;
      }
      // Refresh funding without unmounting the open picker or losing its focus.
      // A different workspace still gets an initial loading state.
      if (!background || loadedWorkspaceRef.current !== workspaceId) setLoading(true);
      try {
        const response = await client.getWorkspaceModelCatalog(workspaceId, {
          signal: requestAbort.signal,
        });
        if (requestAbort.signal.aborted) return;
        loadedWorkspaceRef.current = workspaceId;
        setModels(response.models);
        setDefaults({
          defaultSelection: response.defaultSelection ?? null,
          creditsSelection: response.creditsSelection ?? null,
        });
        setError(null);
      } catch (caught) {
        if (requestAbort.signal.aborted) return;
        loadedWorkspaceRef.current = null;
        setModels([]);
        setDefaults({ defaultSelection: null, creditsSelection: null });
        // Shown in the model picker: what to do, never the raw API message.
        setError(userErrorText(caught));
      } finally {
        if (!requestAbort.signal.aborted) setLoading(false);
        if (requestAbortRef.current === requestAbort) requestAbortRef.current = null;
      }
    },
    [client, workspaceId],
  );

  const beginLoad = useCallback(
    (background = false) => {
      requestAbortRef.current?.abort();
      const requestAbort = new AbortController();
      requestAbortRef.current = requestAbort;
      return { requestAbort, promise: load(requestAbort, background) };
    },
    [load],
  );

  const refresh = useCallback(async (): Promise<void> => {
    await beginLoad(true).promise;
  }, [beginLoad]);

  useEffect(() => {
    const request = beginLoad(true);
    void request.promise;
    return () => {
      const currentRequestAbort = requestAbortRef.current;
      currentRequestAbort?.abort();
      if (requestAbortRef.current === currentRequestAbort) requestAbortRef.current = null;
    };
  }, [beginLoad, fundingRevision]);

  useEffect(() => {
    const changed = () => {
      void refresh();
    };
    window.addEventListener("model-connections-changed", changed);
    window.addEventListener(CREDIT_BALANCE_CHANGED, changed);
    window.addEventListener("focus", changed);
    return () => {
      window.removeEventListener("model-connections-changed", changed);
      window.removeEventListener(CREDIT_BALANCE_CHANGED, changed);
      window.removeEventListener("focus", changed);
    };
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
