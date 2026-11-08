import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AutomationList,
  type AutomationsClient,
  cachedAutomationList,
  keepAutomationList,
  loadAutomationList,
} from "@/automations";

/* The list's React state, apart from the model so the model loads (and is
   tested) without React. */

export interface AutomationListState {
  list: AutomationList | undefined;
  /** The last read failed; the kept list (if any) still shows. */
  error: Error | null;
  refresh(): Promise<void>;
}

/** The workspace's automations, from the kept list first, refreshed on demand. */
export function useAutomationList(
  client: AutomationsClient,
  workspaceId: string,
): AutomationListState {
  const [list, setList] = useState<AutomationList | undefined>(() =>
    cachedAutomationList(workspaceId),
  );
  const [error, setError] = useState<Error | null>(null);
  const current = useRef(workspaceId);
  current.current = workspaceId;
  useEffect(() => {
    setList(cachedAutomationList(workspaceId));
    setError(null);
  }, [workspaceId]);
  const refresh = useCallback(async () => {
    const target = workspaceId;
    try {
      const next = await loadAutomationList(client, target);
      keepAutomationList(target, next);
      if (current.current !== target) return;
      setList(next);
      setError(null);
    } catch (caught) {
      if (current.current !== target) return;
      setList(cachedAutomationList(target));
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    }
  }, [client, workspaceId]);
  return { list, error, refresh };
}
