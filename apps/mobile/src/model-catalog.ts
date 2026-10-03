import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import {
  projectPickerRows,
  sortPickerRows,
  type PickerModelRow,
} from "@opengeni/react/model-policy";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "@/account";

export type WorkspaceModelCatalog = {
  /** Catalog rows with availability truth, in the web picker's order. */
  rows: PickerModelRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/** The workspace model catalog the web picker reads, for the native model sheet. */
export function useWorkspaceModelCatalog(workspaceId: string | null): WorkspaceModelCatalog {
  const { client } = useAccount();
  const [models, setModels] = useState<WorkspaceModelCatalogModel[]>([]);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!workspaceId) return;
    const abort = new AbortController();
    setLoading(true);
    client
      .getWorkspaceModelCatalog(workspaceId, { signal: abort.signal })
      .then((response) => {
        if (abort.signal.aborted) return;
        setModels(response.models);
        setError(null);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setError("Couldn't load models. Check your connection and try again.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [client, workspaceId, generation]);
  const rows = useMemo(() => sortPickerRows(projectPickerRows(models)), [models]);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  return { rows, loading, error, refresh };
}
