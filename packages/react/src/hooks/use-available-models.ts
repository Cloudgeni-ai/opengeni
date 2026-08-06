import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useCallback } from "react";
import { projectPickerRows, sortPickerRows, type PickerModelRow } from "../model-policy";
import { useOpenGeniClient, type ClientOverride } from "../provider";
import { usePolledValue } from "./internal";

export type UseAvailableModelsOptions = Pick<ClientOverride, "client"> & {
  /** Refresh interval (ms). Off by default — the host model list rarely moves. */
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseAvailableModelsResult = {
  models: import("@opengeni/sdk").ClientModel[];
  defaultModel: string | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

export type UseWorkspaceModelCatalogOptions = Pick<ClientOverride, "client"> & {
  workspaceId: string | null;
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseWorkspaceModelCatalogResult = {
  models: WorkspaceModelCatalogModel[];
  rows: PickerModelRow[];
  defaultModel: string | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/**
 * The host-exposed model list for a <ModelPicker>: fetches the deployment's
 * public client config (`GET /v1/config/client`) and surfaces the richer
 * provider-grouped `models` plus the `defaultModel` the picker should preselect.
 * Deployment-scoped, so it only needs the client (no workspace).
 */
export function useAvailableModels(
  options: UseAvailableModelsOptions = {},
): UseAvailableModelsResult {
  const client = useOpenGeniClient(options);
  const load = useCallback(async () => await client.getClientConfig(), [client]);
  const state = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  return {
    models: state.data?.models ?? [],
    defaultModel: state.data?.defaultModel ?? null,
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
  };
}

/** Workspace-scoped catalog with selectability and billing-class picker rows. */
export function useWorkspaceModelCatalog(
  options: UseWorkspaceModelCatalogOptions,
): UseWorkspaceModelCatalogResult {
  const client = useOpenGeniClient(options);
  const load = useCallback(async () => {
    if (!options.workspaceId) {
      return { models: [], defaultModel: null };
    }
    const [catalog, config] = await Promise.all([
      client.getWorkspaceModelCatalog(options.workspaceId),
      client.getClientConfig(),
    ]);
    return {
      models: catalog.models,
      defaultModel: config.defaultModel,
    };
  }, [client, options.workspaceId]);
  const state = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled !== false && Boolean(options.workspaceId),
  });
  const rows = sortPickerRows(projectPickerRows(state.data?.models ?? []));
  return {
    models: state.data?.models ?? [],
    rows,
    defaultModel: state.data?.defaultModel ?? null,
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
  };
}
