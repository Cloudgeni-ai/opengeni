import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceBackgroundCommand } from "@opengeni/sdk";
import { useOpenGeni, type ClientOverride } from "../provider";
import { usePolledValue } from "./internal";

/** Live workspace projection; Stop remains the existing session command action. */
export function useWorkspaceBackgroundCommands(
  options: ClientOverride & { enabled?: boolean; pollIntervalMs?: number } = {},
) {
  const { client, workspaceId } = useOpenGeni(options);
  const [pages, setPages] = useState(1);
  const enabled = options.enabled ?? true;
  useEffect(() => setPages(1), [client, workspaceId]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!client.listWorkspaceBackgroundCommands)
        throw new Error("The configured client does not support workspace commands");
      const commands = new Map<string, WorkspaceBackgroundCommand>();
      let cursor: string | undefined;
      for (let page = 0; page < pages; page += 1) {
        signal?.throwIfAborted();
        const result = await client.listWorkspaceBackgroundCommands(workspaceId, {
          ...(cursor ? { cursor } : {}),
          ...(signal ? { signal } : {}),
        });
        for (const command of result.commands) commands.set(command.id, command);
        cursor = result.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return { commands: [...commands.values()], hasMore: Boolean(cursor) };
    },
    [client, workspaceId, pages],
  );
  const state = usePolledValue(load, { enabled, pollIntervalMs: options.pollIntervalMs ?? 5_000 });
  const { data, refresh } = state;
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, [client, workspaceId, enabled]);
  const cancel = useCallback(
    async (commandId: string) => {
      const command = data?.commands.find((item) => item.id === commandId);
      if (!command || !enabled) return;
      if (!client.cancelSessionBackgroundCommand)
        throw new Error("The configured client does not support stopping commands");
      const ticket = generation.current;
      await client.cancelSessionBackgroundCommand(workspaceId, command.sessionId, commandId);
      if (ticket === generation.current) await refresh();
    },
    [client, workspaceId, enabled, data, refresh],
  );
  return {
    commands: enabled && !state.error ? (state.data?.commands ?? []) : [],
    loading: enabled && state.loading,
    error: enabled ? state.error : null,
    refresh: state.refresh,
    cancel,
    hasMore: enabled && !state.error && (state.data?.hasMore ?? false),
    loadMore: () => setPages((value) => value + 1),
  };
}
