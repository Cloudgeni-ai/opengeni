import { useEffect, useState } from "react";
import type { RealtimeControllerClient, RealtimeModelOption } from "../realtime/session-realtime";

/**
 * Voice models this user can start in the workspace, or an empty list while
 * disabled, unsupported or unknown. Shares the stock voice control's catalog
 * cache, without eagerly loading voice code for a text-only embed.
 */
export function useRealtimeVoiceModels(
  client: unknown,
  workspaceId: string,
  enabled: boolean,
): RealtimeModelOption[] {
  const [snapshot, setSnapshot] = useState<{
    client: unknown;
    workspaceId: string;
    models: RealtimeModelOption[];
  } | null>(null);
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    const controller = new AbortController();
    void import("../realtime/session-realtime")
      .then(async ({ loadRealtimeModelCatalog }) => {
        const models = await loadRealtimeModelCatalog(
          client as RealtimeControllerClient,
          workspaceId,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setSnapshot({
            client,
            workspaceId,
            models: models?.filter((model) => model.available) ?? [],
          });
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, workspaceId, enabled]);
  return enabled &&
    snapshot !== null &&
    snapshot.client === client &&
    snapshot.workspaceId === workspaceId
    ? snapshot.models
    : [];
}
