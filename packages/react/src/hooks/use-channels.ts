import type { Channel, CreateChannelRequest, Session, UpdateChannelRequest } from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner, usePolledValue } from "./internal";

export type UseChannelsOptions = ClientOverride & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseChannelsResult = {
  channels: Channel[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (request: CreateChannelRequest) => Promise<Channel | null>;
  update: (channelId: string, request: UpdateChannelRequest) => Promise<Channel | null>;
  reorder: (channelIds: string[]) => Promise<Channel[] | null>;
  remove: (channelId: string) => Promise<boolean>;
  /** Re-file a session into a channel; null moves it back to the inbox. */
  moveSession: (sessionId: string, channelId: string | null) => Promise<Session | null>;
  mutating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * Workspace-shared channels: rail organization for root sessions
 * ("workstreams") by work type. Pure metadata — filing a session into a
 * channel never affects execution.
 */
export function useChannels(options: UseChannelsOptions = {}): UseChannelsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const load = useCallback(
    async () => await client.listChannels(workspaceId),
    [client, workspaceId],
  );
  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  const { run, mutating, mutationError, clearMutationError } = useMutationRunner();

  const create = useCallback(
    async (request: CreateChannelRequest): Promise<Channel | null> => {
      const result = await run(() => client.createChannel(workspaceId, request));
      if (result) {
        await refresh();
      }
      return result;
    },
    [client, workspaceId, run, refresh],
  );

  const update = useCallback(
    async (channelId: string, request: UpdateChannelRequest): Promise<Channel | null> => {
      const result = await run(() => client.updateChannel(workspaceId, channelId, request));
      if (result) {
        await refresh();
      }
      return result;
    },
    [client, workspaceId, run, refresh],
  );

  const remove = useCallback(
    async (channelId: string): Promise<boolean> => {
      const result = await run(async () => {
        await client.deleteChannel(workspaceId, channelId);
        return true;
      });
      if (result) {
        await refresh();
      }
      return result === true;
    },
    [client, workspaceId, run, refresh],
  );

  const reorder = useCallback(
    async (channelIds: string[]): Promise<Channel[] | null> => {
      const result = await run(() => client.reorderChannels(workspaceId, { channelIds }));
      if (result) await refresh();
      return result;
    },
    [client, workspaceId, run, refresh],
  );

  const moveSession = useCallback(
    async (sessionId: string, channelId: string | null): Promise<Session | null> => {
      return await run(() => client.updateSessionChannel(workspaceId, sessionId, { channelId }));
    },
    [client, workspaceId, run],
  );

  return {
    channels: data ?? [],
    loading,
    error,
    refresh,
    create,
    update,
    reorder,
    remove,
    moveSession,
    mutating,
    mutationError,
    clearMutationError,
  };
}
