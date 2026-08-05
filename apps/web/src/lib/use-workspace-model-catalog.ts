import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

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

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setModels([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const response = await client.getWorkspaceModelCatalog(workspaceId);
      setModels(response.models);
      setError(null);
    } catch (caught) {
      setModels([]);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!workspaceId) {
        if (!cancelled) {
          setModels([]);
          setLoading(false);
          setError(null);
        }
        return;
      }
      setLoading(true);
      try {
        const response = await client.getWorkspaceModelCatalog(workspaceId);
        if (!cancelled) {
          setModels(response.models);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setModels([]);
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);

  const rows = useMemo(() => sortPickerRows(projectPickerRows(models)), [models]);

  return {
    models,
    rows,
    loading,
    error,
    refresh,
  };
}
