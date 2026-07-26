import type {
  CapabilityPack,
  EnablePackRequest,
  PackInstallation,
  RegisterCapabilityPackRequest,
  WorkspaceRegisteredPack,
} from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner, usePolledValue } from "./internal";

const EMPTY_INSTALLATIONS: PackInstallation[] = [];

export type UsePacksOptions = ClientOverride & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UsePacksResult = {
  /** Built-in + registered packs available to the workspace. */
  packs: CapabilityPack[];
  /** Enable/disable state per pack. */
  installations: PackInstallation[];
  /** The installation for a pack id, if any. */
  installationFor: (packId: string) => PackInstallation | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Register (or replace) a workspace-scoped pack manifest. */
  register: (manifest: RegisterCapabilityPackRequest) => Promise<WorkspaceRegisteredPack | null>;
  enable: (packId: string, request?: EnablePackRequest) => Promise<PackInstallation | null>;
  /** Unregister a workspace-scoped pack (built-ins cannot be removed). */
  remove: (packId: string) => Promise<boolean>;
  mutating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/** Capability packs: catalog + installations + register/enable/unregister. */
export function usePacks(options: UsePacksOptions = {}): UsePacksResult {
  const { client, workspaceId } = useOpenGeni(options);
  const load = useCallback(async () => await client.listPacks(workspaceId), [client, workspaceId]);
  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  const { run, mutating, mutationError, clearMutationError } = useMutationRunner();

  const register = useCallback(
    async (manifest: RegisterCapabilityPackRequest): Promise<WorkspaceRegisteredPack | null> => {
      const result = await run(() => client.registerPack(workspaceId, manifest));
      if (result) {
        await refresh();
      }
      return result;
    },
    [client, workspaceId, run, refresh],
  );

  const enable = useCallback(
    async (packId: string, request: EnablePackRequest = {}): Promise<PackInstallation | null> => {
      const result = await run(() => client.enablePack(workspaceId, packId, request));
      if (result) {
        await refresh();
      }
      return result;
    },
    [client, workspaceId, run, refresh],
  );

  const remove = useCallback(
    async (packId: string): Promise<boolean> => {
      const result = await run(async () => {
        await client.deletePack(workspaceId, packId);
        return true;
      });
      if (result) {
        await refresh();
      }
      return result === true;
    },
    [client, workspaceId, run, refresh],
  );

  const installations = data?.installations ?? EMPTY_INSTALLATIONS;
  const installationFor = useCallback(
    (packId: string): PackInstallation | null =>
      installations.find((installation) => installation.packId === packId) ?? null,
    [installations],
  );

  return {
    packs: data?.packs ?? [],
    installations,
    installationFor,
    loading,
    error,
    refresh,
    register,
    enable,
    remove,
    mutating,
    mutationError,
    clearMutationError,
  };
}
