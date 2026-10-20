import { t } from "@/lib/console-text";
import type { DefaultModelSelection, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useAppContext } from "@/context";
import { CREDIT_BALANCE_CHANGED } from "./credit-balance-events";
import { userErrorText } from "@/lib/api-error";
import { projectPickerRows, sortPickerRows, type PickerModelRow } from "@/lib/model-policy";
import { invalidateSharedQueries, useSharedQuery } from "@/lib/shared-query";

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

const EMPTY_MODELS: WorkspaceModelCatalogModel[] = [];

export function useWorkspaceModelCatalog(
  workspaceId: string | null,
  fundingRevision?: string | number,
): WorkspaceModelCatalogState {
  const client = useAppContext().client;
  const query = useSharedQuery(
    client,
    ["model-settings", "workspace-catalog", workspaceId],
    (signal) => client.getWorkspaceModelCatalog(workspaceId!, { signal }),
    { enabled: Boolean(workspaceId), staleTimeMs: 300_000 },
  );
  const refresh = useCallback(async () => {
    if (workspaceId) {
      await invalidateSharedQueries(client, ["model-settings", "workspace-catalog", workspaceId]);
    }
  }, [client, workspaceId]);

  const funding = useRef({ client, workspaceId, fundingRevision });
  useEffect(() => {
    const previous = funding.current;
    funding.current = { client, workspaceId, fundingRevision };
    if (
      previous.client === client &&
      previous.workspaceId === workspaceId &&
      previous.fundingRevision !== fundingRevision
    )
      void refresh();
  }, [client, workspaceId, fundingRevision, refresh]);

  useEffect(() => {
    const changed = () => void refresh();
    // Model-connection changes are invalidated once by the console root.
    window.addEventListener(CREDIT_BALANCE_CHANGED, changed);
    window.addEventListener("focus", changed);
    return () => {
      window.removeEventListener(CREDIT_BALANCE_CHANGED, changed);
      window.removeEventListener("focus", changed);
    };
  }, [refresh]);

  const models = query.data?.models ?? EMPTY_MODELS;
  const rows = useMemo(() => sortPickerRows(projectPickerRows(t, models)), [models]);

  return {
    models,
    rows,
    defaultSelection: query.data?.defaultSelection ?? null,
    creditsSelection: query.data?.creditsSelection ?? null,
    loading: query.loading,
    error: query.error ? userErrorText(query.error) : null,
    refresh,
  };
}
