import type {
  CreateVariableSetRequest,
  UpdateVariableSetRequest,
  VariableSet,
  VariableSetVariableMetadata,
} from "@opengeni/sdk";
import { useCallback, useMemo } from "react";
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
  setVariable: (
    variableSetId: string,
    name: string,
    value: string,
  ) => Promise<VariableSetVariableMetadata | null>;
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
  const load = useCallback(
    async () => await client.listVariableSets(workspaceId),
    [client, workspaceId],
  );
  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  const { run, mutating, mutationError, clearMutationError } = useMutationRunner();

  const create = useCallback(
    async (request: CreateVariableSetRequest): Promise<VariableSet | null> => {
      const result = await run(() => client.createVariableSet(workspaceId, request));
      if (result) {
        await refresh();
      }
      return result;
    },
    [client, workspaceId, run, refresh],
  );

  const update = useCallback(
    async (
      variableSetId: string,
      request: UpdateVariableSetRequest,
    ): Promise<VariableSet | null> => {
      const result = await run(() => client.updateVariableSet(workspaceId, variableSetId, request));
      if (result) {
        await refresh();
      }
      return result;
    },
    [client, workspaceId, run, refresh],
  );

  const remove = useCallback(
    async (variableSetId: string): Promise<boolean> => {
      const result = await run(async () => {
        await client.deleteVariableSet(workspaceId, variableSetId);
        return true;
      });
      if (result) {
        await refresh();
      }
      return result === true;
    },
    [client, workspaceId, run, refresh],
  );

  const setVariable = useCallback(
    async (
      variableSetId: string,
      name: string,
      value: string,
    ): Promise<VariableSetVariableMetadata | null> => {
      const result = await run(() =>
        client.setVariableSetVariable(workspaceId, variableSetId, name, value),
      );
      if (result) {
        await refresh();
      }
      return result;
    },
    [client, workspaceId, run, refresh],
  );

  const deleteVariable = useCallback(
    async (variableSetId: string, name: string): Promise<boolean> => {
      const result = await run(async () => {
        await client.deleteVariableSetVariable(workspaceId, variableSetId, name);
        return true;
      });
      if (result) {
        await refresh();
      }
      return result === true;
    },
    [client, workspaceId, run, refresh],
  );

  return {
    variableSets: data ?? [],
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    setVariable,
    deleteVariable,
    mutating,
    mutationError,
    clearMutationError,
  };
}

/** @deprecated use UseVariableSetsOptions */
export type UseEnvironmentsOptions = UseVariableSetsOptions;
/** @deprecated use UseVariableSetsResult */
export type UseEnvironmentsResult = UseVariableSetsResult & { environments: VariableSet[] };
/** @deprecated use useVariableSets */
export function useEnvironments(options: UseEnvironmentsOptions = {}): UseEnvironmentsResult {
  const legacyClient = useMemo(() => {
    if (!options.client) {
      return undefined;
    }
    return {
      ...options.client,
      listVariableSets: options.client.listEnvironments ?? options.client.listVariableSets,
      createVariableSet: options.client.createEnvironment ?? options.client.createVariableSet,
      updateVariableSet: options.client.updateEnvironment ?? options.client.updateVariableSet,
      deleteVariableSet: options.client.deleteEnvironment ?? options.client.deleteVariableSet,
      setVariableSetVariable:
        options.client.setEnvironmentVariable ?? options.client.setVariableSetVariable,
      deleteVariableSetVariable:
        options.client.deleteEnvironmentVariable ?? options.client.deleteVariableSetVariable,
    };
  }, [options.client]);
  const result = useVariableSets({ ...options, ...(legacyClient ? { client: legacyClient } : {}) });
  return { ...result, environments: result.variableSets };
}
