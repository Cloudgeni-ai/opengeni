import type { ClientModel } from "@/types";
import { useEffect, useState } from "react";
import { useAppContext } from "@/context";

export type CodexConnectionModelState = {
  connected: boolean;
  models: ClientModel[];
};

/**
 * The codex models a workspace can select, fetched from its codex connection
 * status. Empty unless a Codex subscription is connected. Fed into <ModelPicker
 * extraModels> so the picker shows the "Codex subscription · no credits" group
 * alongside the host's deployment models.
 */
export function useCodexConnectionModels(workspaceId: string | null): CodexConnectionModelState {
  const client = useAppContext().client;
  const [state, setState] = useState<CodexConnectionModelState>({
    connected: false,
    models: [],
  });
  useEffect(() => {
    if (!workspaceId) {
      setState({ connected: false, models: [] });
      return;
    }
    let cancelled = false;
    void client
      .codexStatus(workspaceId)
      .then((status) => {
        if (!cancelled) {
          setState({
            connected: status.connected,
            models: status.connected ? (status.models ?? []) : [],
          });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ connected: false, models: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);
  return state;
}

export function useCodexModels(workspaceId: string | null): ClientModel[] {
  return useCodexConnectionModels(workspaceId).models;
}
