import type {
  CreateVariableSetRequest,
  UpdateVariableSetRequest,
  VariableSet,
  VariableSetVariableMetadata,
} from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner, usePolledValue } from "./internal";

export type UseVariableSetsOptions = ClientOverride & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseVariableSetsResult = {
  variableSets: VariableSet[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (request: CreateVariableSetRequest) => Promise<VariableSet | null>;
  update: (variableSetId: string, request: UpdateVariableSetRequest) => Promise<VariableSet | null>;
  remove: (variableSetId: string) => Promise<boolean>;
  /** Set/rotate a variable. Values are write-only — reads expose metadata only. */
  setVariable: (variableSetId: string, name: string, value: string) => Promise<VariableSetVariableMetadata | null>;
  deleteVariable: (variableSetId: string, name: string) => Promise<boolean>;
  mutating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * Variable sets (named, encrypted variable sets attached to sessions
 * and scheduled tasks). Variable values are write-only end to end: this hook
 * never sees a value after it is sent.
 */
export function useVariableSets(options: UseVariableSetsOptions = {}): UseVariableSetsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const load = useCallback(async () => await client.listVariableSets(workspaceId), [client, workspaceId]);
  const state = usePolledValue(load, { pollIntervalMs: options.pollIntervalMs, enabled: options.enabled });
  const mutation = useMutationRunner();

  const create = useCallback(
    async (request: CreateVariableSetRequest): Promise<VariableSet | null> => {
      const result = await mutation.run(() => client.createVariableSet(workspaceId, request));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  const update = useCallback(
    async (variableSetId: string, request: UpdateVariableSetRequest): Promise<VariableSet | null> => {
      const result = await mutation.run(() => client.updateVariableSet(workspaceId, variableSetId, request));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  const remove = useCallback(
    async (variableSetId: string): Promise<boolean> => {
      const result = await mutation.run(async () => {
        await client.deleteVariableSet(workspaceId, variableSetId);
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
    async (variableSetId: string, name: string, value: string): Promise<VariableSetVariableMetadata | null> => {
      const result = await mutation.run(() => client.setVariableSetVariable(workspaceId, variableSetId, name, value));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  const deleteVariable = useCallback(
    async (variableSetId: string, name: string): Promise<boolean> => {
      const result = await mutation.run(async () => {
        await client.deleteVariableSetVariable(workspaceId, variableSetId, name);
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
    variableSets: state.data ?? [],
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

/** @deprecated use UseVariableSetsOptions */
export type UseEnvironmentsOptions = UseVariableSetsOptions;
/** @deprecated use UseVariableSetsResult */
export type UseEnvironmentsResult = UseVariableSetsResult & { environments: VariableSet[] };
/** @deprecated use useVariableSets */
export function useEnvironments(options: UseEnvironmentsOptions = {}): UseEnvironmentsResult {
  const legacyClient = options.client
    ? {
      ...options.client,
      listVariableSets: options.client.listVariableSets ?? options.client.listEnvironments,
      createVariableSet: options.client.createVariableSet ?? options.client.createEnvironment,
      updateVariableSet: options.client.updateVariableSet ?? options.client.updateEnvironment,
      deleteVariableSet: options.client.deleteVariableSet ?? options.client.deleteEnvironment,
      setVariableSetVariable: options.client.setVariableSetVariable ?? options.client.setEnvironmentVariable,
      deleteVariableSetVariable: options.client.deleteVariableSetVariable ?? options.client.deleteEnvironmentVariable,
    }
    : undefined;
  const result = useVariableSets({ ...options, ...(legacyClient ? { client: legacyClient } : {}) });
  return { ...result, environments: result.variableSets };
}
