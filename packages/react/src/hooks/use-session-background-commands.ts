import type { SessionBackgroundCommand } from "@opengeni/sdk";
import { useCallback } from "react";

import { useOpenGeni, type ClientOverride } from "../provider";
import { usePolledValue } from "./internal";

export type UseSessionBackgroundCommandsOptions = ClientOverride & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseSessionBackgroundCommandsResult = {
  commands: SessionBackgroundCommand[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  cancel: (commandId: string) => Promise<void>;
};

export function useSessionBackgroundCommands(
  sessionId: string | null | undefined,
  options: UseSessionBackgroundCommandsOptions = {},
): UseSessionBackgroundCommandsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const load = useCallback(async () => {
    if (!sessionId) return { commands: [] };
    if (!client.listSessionBackgroundCommands) {
      throw new Error("The configured OpenGeni client does not support background commands");
    }
    return await client.listSessionBackgroundCommands(workspaceId, sessionId);
  }, [client, workspaceId, sessionId]);
  const state = usePolledValue(load, {
    enabled,
    pollIntervalMs: options.pollIntervalMs,
  });
  const refresh = state.refresh;
  const cancel = useCallback(
    async (commandId: string): Promise<void> => {
      if (!sessionId) return;
      if (!client.cancelSessionBackgroundCommand) {
        throw new Error("The configured OpenGeni client does not support background commands");
      }
      await client.cancelSessionBackgroundCommand(workspaceId, sessionId, commandId);
      await refresh();
    },
    [client, workspaceId, sessionId, refresh],
  );
  return {
    commands: state.data?.commands ?? [],
    loading: state.loading,
    error: state.error,
    refresh,
    cancel,
  };
}
