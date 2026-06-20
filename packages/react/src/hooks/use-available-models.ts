import type { ClientModel } from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeniClient, type ClientOverride } from "../provider";
import { usePolledValue } from "./internal";

export type UseAvailableModelsOptions = Pick<ClientOverride, "client"> & {
  /** Refresh interval (ms). Off by default — the host model list rarely moves. */
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseAvailableModelsResult = {
  /** The provider-grouped models the host exposes (empty until loaded). */
  models: ClientModel[];
  /** The deployment's default model id, null until loaded. */
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
export function useAvailableModels(options: UseAvailableModelsOptions = {}): UseAvailableModelsResult {
  const client = useOpenGeniClient(options);
  const load = useCallback(async () => await client.getClientConfig(), [client]);
  const state = usePolledValue(load, { pollIntervalMs: options.pollIntervalMs, enabled: options.enabled });
  return {
    models: state.data?.models ?? [],
    defaultModel: state.data?.defaultModel ?? null,
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
  };
}
