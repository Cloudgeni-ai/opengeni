import type { CreateWorkspaceRequest, UpdateWorkspaceRequest, Workspace } from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeniClient, type ClientOverride } from "../provider";
import { useMutationRunner, usePolledValue } from "./internal";

export type UseWorkspacesOptions = Pick<ClientOverride, "client"> & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseWorkspacesResult = {
  workspaces: Workspace[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (request: CreateWorkspaceRequest) => Promise<Workspace | null>;
  update: (workspaceId: string, request: UpdateWorkspaceRequest) => Promise<Workspace | null>;
  mutating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * The caller's workspaces (workspace switchers, onboarding). Not scoped to
 * the provider's workspace, so it only needs the client.
 */
export function useWorkspaces(options: UseWorkspacesOptions = {}): UseWorkspacesResult {
  const client = useOpenGeniClient(options);
  const load = useCallback(async () => await client.listWorkspaces(), [client]);
  const state = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  const mutation = useMutationRunner();

  const create = useCallback(
    async (request: CreateWorkspaceRequest): Promise<Workspace | null> => {
      const result = await mutation.run(() => client.createWorkspace(request));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, mutation.run, state.refresh],
  );

  const update = useCallback(
    async (workspaceId: string, request: UpdateWorkspaceRequest): Promise<Workspace | null> => {
      const result = await mutation.run(() => client.updateWorkspace(workspaceId, request));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, mutation.run, state.refresh],
  );

  return {
    workspaces: state.data ?? [],
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
    create,
    update,
    mutating: mutation.mutating,
    mutationError: mutation.mutationError,
    clearMutationError: mutation.clearMutationError,
  };
}
