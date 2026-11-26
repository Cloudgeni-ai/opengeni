import type { DefaultModelSelection, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useShowPurchasePrompts } from "@opengeni/react/app/lib/purchase-presentation";
import type { PickerModelRow } from "@opengeni/react/model-policy";
import { useOpenGeniText } from "@opengeni/react/messages";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "@/account";
import { workspacePickerRows } from "@/model-picker-rows";

export type WorkspaceModelCatalog = {
  /** Catalog rows with availability truth, in the web picker's order. */
  rows: PickerModelRow[];
  /** What a new chat in this workspace uses when the person picks nothing. */
  defaultSelection: DefaultModelSelection | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/** The workspace model catalog the web picker reads, for the native model sheet. */
export function useWorkspaceModelCatalog(workspaceId: string | null): WorkspaceModelCatalog {
  const t = useOpenGeniText();
  const showPurchasePrompts = useShowPurchasePrompts();
  const { client } = useAccount();
  const [models, setModels] = useState<WorkspaceModelCatalogModel[]>([]);
  const [defaultSelection, setDefaultSelection] = useState<DefaultModelSelection | null>(null);
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
        setDefaultSelection(response.defaultSelection ?? null);
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
  const rows = useMemo(
    () => workspacePickerRows(t, models, { showPurchasePrompts }),
    [t, models, showPurchasePrompts],
  );
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  return { rows, defaultSelection, loading, error, refresh };
}
