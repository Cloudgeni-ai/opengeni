import type { WorkspaceRealtimeModelCatalogResponse } from "@opengeni/sdk";
import { useEffect, useState } from "react";

type CatalogClient = {
  getWorkspaceRealtimeModelCatalog?: (
    workspaceId: string,
    options?: { signal?: AbortSignal | undefined },
  ) => Promise<WorkspaceRealtimeModelCatalogResponse>;
};

type AvailableVoiceModels = WorkspaceRealtimeModelCatalogResponse["models"];

const CACHE_TTL_MS = 60_000;
const cache = new WeakMap<
  object,
  Map<string, { models: Promise<AvailableVoiceModels>; expiresAt: number }>
>();

function load(client: CatalogClient, workspaceId: string): Promise<AvailableVoiceModels> {
  let byWorkspace = cache.get(client);
  if (!byWorkspace) {
    byWorkspace = new Map();
    cache.set(client, byWorkspace);
  }
  const hit = byWorkspace.get(workspaceId);
  if (hit && hit.expiresAt > Date.now()) return hit.models;
  // A throwing structural client (one without voice) just means no voice.
  const models = Promise.resolve()
    .then(() => client.getWorkspaceRealtimeModelCatalog!(workspaceId))
    .then((catalog) => catalog.models.filter((model) => model.available));
  const entry = { models, expiresAt: Date.now() + CACHE_TTL_MS };
  byWorkspace.set(workspaceId, entry);
  models.catch(() => {
    if (byWorkspace.get(workspaceId) === entry) byWorkspace.delete(workspaceId);
  });
  return models;
}

/**
 * Voice models this user can start right now in the workspace, or an empty
 * list while unknown, disabled, unsupported (older API or proxy), or failed.
 * Availability is advisory; Opengeni still admits and meters every call.
 */
export function useRealtimeVoiceModels(
  client: unknown,
  workspaceId: string,
  enabled: boolean,
): AvailableVoiceModels {
  const [models, setModels] = useState<AvailableVoiceModels>([]);
  useEffect(() => {
    setModels([]);
    const catalogClient = client as CatalogClient;
    if (!enabled || !workspaceId) return;
    if (typeof catalogClient.getWorkspaceRealtimeModelCatalog !== "function") return;
    let live = true;
    load(catalogClient, workspaceId).then(
      (available) => {
        if (live) setModels(available);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId, enabled]);
  return models;
}
