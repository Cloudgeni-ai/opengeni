import type { ClientModel } from "@/types";
import { useEffect, useState } from "react";
import { useAppContext } from "@/context";

/**
 * The codex models a workspace can select, fetched from its codex connection
 * status. Empty unless a Codex subscription is connected. Fed into <ModelPicker
 * extraModels> so the picker shows the "Codex subscription · no credits" group
 * alongside the host's deployment models.
 */
export function useCodexModels(workspaceId: string | null): ClientModel[] {
  const client = useAppContext().client;
  const [models, setModels] = useState<ClientModel[]>([]);
  useEffect(() => {
    if (!workspaceId) {
      setModels([]);
      return;
    }
    let cancelled = false;
    void client
      .codexStatus(workspaceId)
      .then((status) => {
        if (!cancelled) setModels(status.connected ? (status.models ?? []) : []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);
  return models;
}
