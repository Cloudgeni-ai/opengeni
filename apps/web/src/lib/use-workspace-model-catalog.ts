import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppContext } from "@/context";
import { displayModel } from "@/lib/format";
import {
  ensureSelectedModelRow,
  projectPickerRows,
  sortPickerRows,
  type PickerModelRow,
} from "@/lib/model-policy";

export type WorkspaceModelCatalogState = {
  models: WorkspaceModelCatalogModel[];
  rows: PickerModelRow[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  rowsForSelection: (selectedModelId: string) => PickerModelRow[];
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
  const rowsForSelection = useCallback(
    (selectedModelId: string) =>
      sortPickerRows(ensureSelectedModelRow(rows, selectedModelId, displayModel(selectedModelId))),
    [rows],
  );

  return {
    models,
    rows,
    loading,
    error,
    refresh,
    rowsForSelection,
  };
}
