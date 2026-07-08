import type {
  CreateWorkspaceEnvironmentRequest,
  UpdateWorkspaceEnvironmentRequest,
  WorkspaceEnvironment,
  WorkspaceEnvironmentVariableMetadata,
} from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner, usePolledValue } from "./internal";

export type UseEnvironmentsOptions = ClientOverride & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseEnvironmentsResult = {
  environments: WorkspaceEnvironment[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (request: CreateWorkspaceEnvironmentRequest) => Promise<WorkspaceEnvironment | null>;
  update: (
    environmentId: string,
    request: UpdateWorkspaceEnvironmentRequest,
  ) => Promise<WorkspaceEnvironment | null>;
  remove: (environmentId: string) => Promise<boolean>;
  /** Set/rotate a variable. Values are write-only — reads expose metadata only. */
  setVariable: (
    environmentId: string,
    name: string,
    value: string,
  ) => Promise<WorkspaceEnvironmentVariableMetadata | null>;
  deleteVariable: (environmentId: string, name: string) => Promise<boolean>;
  mutating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * Workspace environments (named, encrypted variable sets attached to sessions
 * and scheduled tasks). Variable values are write-only end to end: this hook
 * never sees a value after it is sent.
 */
export function useEnvironments(options: UseEnvironmentsOptions = {}): UseEnvironmentsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const load = useCallback(
    async () => await client.listEnvironments(workspaceId),
    [client, workspaceId],
  );
  const state = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  const mutation = useMutationRunner();

  const create = useCallback(
    async (request: CreateWorkspaceEnvironmentRequest): Promise<WorkspaceEnvironment | null> => {
      const result = await mutation.run(() => client.createEnvironment(workspaceId, request));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  const update = useCallback(
    async (
      environmentId: string,
      request: UpdateWorkspaceEnvironmentRequest,
    ): Promise<WorkspaceEnvironment | null> => {
      const result = await mutation.run(() =>
        client.updateEnvironment(workspaceId, environmentId, request),
      );
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  const remove = useCallback(
    async (environmentId: string): Promise<boolean> => {
      const result = await mutation.run(async () => {
        await client.deleteEnvironment(workspaceId, environmentId);
        return true;
      });
      if (result) {
        await state.refresh();
      }
      return result === true;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  const setVariable = useCallback(
    async (
      environmentId: string,
      name: string,
      value: string,
    ): Promise<WorkspaceEnvironmentVariableMetadata | null> => {
      const result = await mutation.run(() =>
        client.setEnvironmentVariable(workspaceId, environmentId, name, value),
      );
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  const deleteVariable = useCallback(
    async (environmentId: string, name: string): Promise<boolean> => {
      const result = await mutation.run(async () => {
        await client.deleteEnvironmentVariable(workspaceId, environmentId, name);
        return true;
      });
      if (result) {
        await state.refresh();
      }
      return result === true;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  return {
    environments: state.data ?? [],
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
    create,
    update,
    remove,
    setVariable,
    deleteVariable,
    mutating: mutation.mutating,
    mutationError: mutation.mutationError,
    clearMutationError: mutation.clearMutationError,
  };
}
